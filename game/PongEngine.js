// ===========================================
// Pong Engine — Server-Authoritative Game State
// ===========================================
// Runs at 60 ticks/sec. Server owns all physics.
// Clients only send input; server broadcasts state.

const Match = require('../models/Match');
const User = require('../models/User');
const { payoutWinner, STAKE_TIERS } = require('../solana/utils');

const CANVAS_W = 800;
const CANVAS_H = 600;
const PADDLE_W = 12;
const PADDLE_H = 100;
const PADDLE_SPEED = 6;
const BALL_SIZE = 10;
const BALL_SPEED_INITIAL = 5;
const BALL_SPEED_INCREMENT = 0.3;  // speed up after each hit
const WIN_SCORE = 5;
const TICK_RATE = 1000 / 60; // ~16ms

class PongEngine {
  constructor(gameId, player1, player2, tier, io, activeGames) {
    this.gameId = gameId;
    this.player1 = player1; // { wallet, username, socketId }
    this.player2 = player2;
    this.tier = tier;
    this.io = io;
    this.activeGames = activeGames;

    // Game state
    this.state = {
      ball: { x: CANVAS_W / 2, y: CANVAS_H / 2, vx: BALL_SPEED_INITIAL, vy: BALL_SPEED_INITIAL },
      paddle1: { y: CANVAS_H / 2 - PADDLE_H / 2 }, // left
      paddle2: { y: CANVAS_H / 2 - PADDLE_H / 2 }, // right
      score: { p1: 0, p2: 0 },
      status: 'playing',
      winner: null,
    };

    // Input state
    this.input = {
      [player1.wallet]: 'stop', // 'up' | 'down' | 'stop'
      [player2.wallet]: 'stop',
    };

    // Randomize initial ball direction
    this.state.ball.vx *= Math.random() > 0.5 ? 1 : -1;
    this.state.ball.vy *= Math.random() > 0.5 ? 1 : -1;

    this.interval = null;
  }

  start() {
    // Notify both players
    this.emit('game-start', {
      gameId: this.gameId,
      player1: { wallet: this.player1.wallet, username: this.player1.username },
      player2: { wallet: this.player2.wallet, username: this.player2.username },
      tier: this.tier,
      stake: STAKE_TIERS[this.tier],
    });

    // Start game loop
    this.interval = setInterval(() => this.tick(), TICK_RATE);
  }

  hasPlayer(wallet) {
    return this.player1.wallet === wallet || this.player2.wallet === wallet;
  }

  handleInput(wallet, direction) {
    if (direction === 'up' || direction === 'down' || direction === 'stop') {
      this.input[wallet] = direction;
    }
  }

  tick() {
    if (this.state.status !== 'playing') return;

    // --- Move paddles based on input ---
    const p1Input = this.input[this.player1.wallet];
    const p2Input = this.input[this.player2.wallet];

    if (p1Input === 'up')   this.state.paddle1.y = Math.max(0, this.state.paddle1.y - PADDLE_SPEED);
    if (p1Input === 'down') this.state.paddle1.y = Math.min(CANVAS_H - PADDLE_H, this.state.paddle1.y + PADDLE_SPEED);
    if (p2Input === 'up')   this.state.paddle2.y = Math.max(0, this.state.paddle2.y - PADDLE_SPEED);
    if (p2Input === 'down') this.state.paddle2.y = Math.min(CANVAS_H - PADDLE_H, this.state.paddle2.y + PADDLE_SPEED);

    // --- Move ball ---
    const ball = this.state.ball;
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Top/bottom wall bounce
    if (ball.y <= 0 || ball.y >= CANVAS_H - BALL_SIZE) {
      ball.vy = -ball.vy;
      ball.y = Math.max(0, Math.min(CANVAS_H - BALL_SIZE, ball.y));
    }

    // Left paddle collision (player 1)
    if (
      ball.x <= PADDLE_W + 10 &&
      ball.y + BALL_SIZE >= this.state.paddle1.y &&
      ball.y <= this.state.paddle1.y + PADDLE_H &&
      ball.vx < 0
    ) {
      ball.vx = -ball.vx + BALL_SPEED_INCREMENT;
      ball.x = PADDLE_W + 10;
      // Add spin based on where ball hits paddle
      const hitPos = (ball.y - this.state.paddle1.y) / PADDLE_H;
      ball.vy = (hitPos - 0.5) * 10;
    }

    // Right paddle collision (player 2)
    if (
      ball.x + BALL_SIZE >= CANVAS_W - PADDLE_W - 10 &&
      ball.y + BALL_SIZE >= this.state.paddle2.y &&
      ball.y <= this.state.paddle2.y + PADDLE_H &&
      ball.vx > 0
    ) {
      ball.vx = -(ball.vx + BALL_SPEED_INCREMENT);
      ball.x = CANVAS_W - PADDLE_W - 10 - BALL_SIZE;
      const hitPos = (ball.y - this.state.paddle2.y) / PADDLE_H;
      ball.vy = (hitPos - 0.5) * 10;
    }

    // --- Scoring ---
    if (ball.x < 0) {
      // Player 2 scores
      this.state.score.p2++;
      this.resetBall(-1);
    } else if (ball.x > CANVAS_W) {
      // Player 1 scores
      this.state.score.p1++;
      this.resetBall(1);
    }

    // --- Check win condition ---
    if (this.state.score.p1 >= WIN_SCORE) {
      this.endGame(this.player1.wallet);
      return;
    }
    if (this.state.score.p2 >= WIN_SCORE) {
      this.endGame(this.player2.wallet);
      return;
    }

    // --- Broadcast state to both players ---
    this.emit('game-state', {
      gameId: this.gameId,
      state: this.state,
    });
  }

  resetBall(direction) {
    this.state.ball = {
      x: CANVAS_W / 2,
      y: CANVAS_H / 2,
      vx: BALL_SPEED_INITIAL * direction,
      vy: (Math.random() - 0.5) * 6,
    };
  }

  async endGame(winnerWallet) {
    clearInterval(this.interval);
    this.state.status = 'finished';
    this.state.winner = winnerWallet;

    const loserWallet = winnerWallet === this.player1.wallet
      ? this.player2.wallet
      : this.player1.wallet;

    this.emit('game-over', {
      gameId: this.gameId,
      winner: winnerWallet,
      score: this.state.score,
    });

    // Process payout on-chain
    try {
      const totalPot = STAKE_TIERS[this.tier] * 2;
      const result = await payoutWinner(winnerWallet, totalPot);

      // Update match record
      await Match.findOneAndUpdate({ gameId: this.gameId }, {
        winner: winnerWallet,
        score: { player1: this.state.score.p1, player2: this.state.score.p2 },
        payoutTx: result.payoutTx,
        status: 'completed',
        completedAt: new Date(),
      });

      // Update user stats
      await User.findOneAndUpdate({ wallet: winnerWallet }, {
        $inc: { 'stats.wins': 1, 'stats.totalEarnings': result.winnerShare }
      });
      await User.findOneAndUpdate({ wallet: loserWallet }, {
        $inc: { 'stats.losses': 1 }
      });

      this.emit('payout-complete', {
        gameId: this.gameId,
        winner: winnerWallet,
        payoutTx: result.payoutTx,
        winnerShare: result.winnerShare,
        burned: result.burnShare,
      });
    } catch (err) {
      console.error('Payout failed:', err.message);
      this.emit('payout-error', { gameId: this.gameId, error: err.message });
    }

    // Clean up
    this.activeGames.delete(this.gameId);
  }

  forfeit(disconnectedWallet) {
    const winnerWallet = disconnectedWallet === this.player1.wallet
      ? this.player2.wallet
      : this.player1.wallet;
    clearInterval(this.interval);
    this.emit('game-forfeit', { gameId: this.gameId, winner: winnerWallet, reason: 'opponent disconnected' });
    this.endGame(winnerWallet);
  }

  emit(event, data) {
    // Send to both player sockets
    this.io.to(this.player1.socketId).emit(event, data);
    this.io.to(this.player2.socketId).emit(event, data);
  }
}

module.exports = { PongEngine, STAKE_TIERS, WIN_SCORE, CANVAS_W, CANVAS_H };
