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
const PADDLE_W = 14;
const PADDLE_H = 110;
const PADDLE_SPEED = 7;
const BALL_SIZE = 12;
const BALL_SPEED_INITIAL = 4;   // start a bit slower
const BALL_SPEED_INCREMENT = 0.2;
const BALL_MAX_SPEED = 12;
const WIN_SCORE = 5;
const TICK_RATE = 1000 / 60;
const SCORE_PAUSE_TICKS = 90;   // 1.5 second pause after scoring

class PongEngine {
  constructor(gameId, player1, player2, tier, io, activeGames) {
    this.gameId = gameId;
    this.player1 = player1;
    this.player2 = player2;
    this.tier = tier;
    this.io = io;
    this.activeGames = activeGames;
    this.pauseTicks = 0; // countdown for score pause

    this.state = {
      ball: { x: CANVAS_W / 2, y: CANVAS_H / 2, vx: 0, vy: 0 },
      paddle1: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      paddle2: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      score: { p1: 0, p2: 0 },
      status: 'playing',
      winner: null,
      paused: false, // tells client to show "Get Ready" between points
    };

    this.input = {
      [player1.wallet]: 'stop',
      [player2.wallet]: 'stop',
    };

    this.interval = null;
  }

  start() {
    this.emit('game-start', {
      gameId: this.gameId,
      player1: { wallet: this.player1.wallet, username: this.player1.username },
      player2: { wallet: this.player2.wallet, username: this.player2.username },
      tier: this.tier,
      stake: STAKE_TIERS[this.tier],
    });

    // Start with a brief pause then launch ball
    this.launchBall();
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

    // --- Always allow paddle movement, even during pause ---
    const p1Input = this.input[this.player1.wallet];
    const p2Input = this.input[this.player2.wallet];

    if (p1Input === 'up')   this.state.paddle1.y = Math.max(0, this.state.paddle1.y - PADDLE_SPEED);
    if (p1Input === 'down') this.state.paddle1.y = Math.min(CANVAS_H - PADDLE_H, this.state.paddle1.y + PADDLE_SPEED);
    if (p2Input === 'up')   this.state.paddle2.y = Math.max(0, this.state.paddle2.y - PADDLE_SPEED);
    if (p2Input === 'down') this.state.paddle2.y = Math.min(CANVAS_H - PADDLE_H, this.state.paddle2.y + PADDLE_SPEED);

    // --- Score pause countdown ---
    if (this.pauseTicks > 0) {
      this.pauseTicks--;
      this.state.paused = true;
      if (this.pauseTicks === 0) {
        this.state.paused = false;
        this.launchBall();
      }
      this.broadcastState();
      return;
    }

    // --- Move ball (swept collision detection) ---
    const ball = this.state.ball;
    const oldX = ball.x;
    const oldY = ball.y;

    ball.x += ball.vx;
    ball.y += ball.vy;

    // Top/bottom wall bounce
    if (ball.y <= 0) {
      ball.vy = Math.abs(ball.vy);
      ball.y = 0;
    }
    if (ball.y >= CANVAS_H - BALL_SIZE) {
      ball.vy = -Math.abs(ball.vy);
      ball.y = CANVAS_H - BALL_SIZE;
    }

    // --- Left paddle collision (player 1) — swept detection ---
    const p1Right = 10 + PADDLE_W;
    if (ball.vx < 0) {
      // Check if ball's left edge crossed the paddle's right edge this tick
      const oldLeft = oldX;
      const newLeft = ball.x;
      if (newLeft <= p1Right && oldLeft >= p1Right) {
        // Parametric time of crossing: when did left edge == p1Right?
        const t = (oldLeft - p1Right) / (oldLeft - newLeft);
        const hitY = oldY + ball.vy * t;
        // Check Y overlap at the moment of crossing
        if (hitY + BALL_SIZE >= this.state.paddle1.y &&
            hitY <= this.state.paddle1.y + PADDLE_H) {
          const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = speed;
          ball.x = p1Right;
          ball.y = hitY;
          const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle1.y) / PADDLE_H;
          ball.vy = (hitPos - 0.5) * speed * 1.5;
        }
      } else if (ball.x <= p1Right && ball.x + BALL_SIZE >= 10 &&
                 ball.y + BALL_SIZE >= this.state.paddle1.y &&
                 ball.y <= this.state.paddle1.y + PADDLE_H) {
        // Standard overlap fallback (ball already inside paddle zone)
        const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
        ball.vx = speed;
        ball.x = p1Right;
        const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle1.y) / PADDLE_H;
        ball.vy = (hitPos - 0.5) * speed * 1.5;
      }
    }

    // --- Right paddle collision (player 2) — swept detection ---
    const p2Left = CANVAS_W - 10 - PADDLE_W;
    if (ball.vx > 0) {
      // Check if ball's right edge crossed the paddle's left edge this tick
      const oldRight = oldX + BALL_SIZE;
      const newRight = ball.x + BALL_SIZE;
      if (newRight >= p2Left && oldRight <= p2Left) {
        // Parametric time of crossing
        const t = (p2Left - oldRight) / (newRight - oldRight);
        const hitY = oldY + ball.vy * t;
        // Check Y overlap at the moment of crossing
        if (hitY + BALL_SIZE >= this.state.paddle2.y &&
            hitY <= this.state.paddle2.y + PADDLE_H) {
          const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = -speed;
          ball.x = p2Left - BALL_SIZE;
          ball.y = hitY;
          const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle2.y) / PADDLE_H;
          ball.vy = (hitPos - 0.5) * speed * 1.5;
        }
      } else if (ball.x + BALL_SIZE >= p2Left && ball.x <= CANVAS_W - 10 &&
                 ball.y + BALL_SIZE >= this.state.paddle2.y &&
                 ball.y <= this.state.paddle2.y + PADDLE_H) {
        // Standard overlap fallback
        const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
        ball.vx = -speed;
        ball.x = p2Left - BALL_SIZE;
        const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle2.y) / PADDLE_H;
        ball.vy = (hitPos - 0.5) * speed * 1.5;
      }
    }

    // --- Scoring ---
    if (ball.x + BALL_SIZE < 0) {
      this.state.score.p2++;
      if (this.state.score.p2 >= WIN_SCORE) { this.endGame(this.player2.wallet); return; }
      this.resetBall();
      this.broadcastState();
      return;
    }
    if (ball.x > CANVAS_W) {
      this.state.score.p1++;
      if (this.state.score.p1 >= WIN_SCORE) { this.endGame(this.player1.wallet); return; }
      this.resetBall();
      this.broadcastState();
      return;
    }

    this.broadcastState();
  }

  resetBall() {
    // Center ball, zero velocity — pause before launching
    this.state.ball = {
      x: CANVAS_W / 2 - BALL_SIZE / 2,
      y: CANVAS_H / 2 - BALL_SIZE / 2,
      vx: 0,
      vy: 0,
    };
    this.pauseTicks = SCORE_PAUSE_TICKS;
    this.state.paused = true;
  }

  launchBall() {
    const angle = (Math.random() - 0.5) * Math.PI / 3; // -30 to +30 degrees
    const dir = Math.random() > 0.5 ? 1 : -1;
    this.state.ball.vx = Math.cos(angle) * BALL_SPEED_INITIAL * dir;
    this.state.ball.vy = Math.sin(angle) * BALL_SPEED_INITIAL;
  }

  broadcastState() {
    this.emit('game-state', {
      gameId: this.gameId,
      state: this.state,
    });
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

    try {
      const totalPot = STAKE_TIERS[this.tier] * 2;
      const result = await payoutWinner(winnerWallet, totalPot);

      await Match.findOneAndUpdate({ gameId: this.gameId }, {
        winner: winnerWallet,
        score: { player1: this.state.score.p1, player2: this.state.score.p2 },
        payoutTx: result.payoutTx,
        status: 'completed',
        completedAt: new Date(),
      });

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
    this.io.to(this.player1.socketId).emit(event, data);
    this.io.to(this.player2.socketId).emit(event, data);
  }
}

module.exports = { PongEngine, STAKE_TIERS, WIN_SCORE, CANVAS_W, CANVAS_H };
