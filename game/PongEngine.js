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
const PADDLE_W = 26;
const PADDLE_H = 110;
const PADDLE_SPEED = 6;
const BALL_SIZE = 16;
const BALL_SPEED_INITIAL = 6;
const BALL_SPEED_INCREMENT = 0.25;
const BALL_MAX_SPEED = 14;
const WIN_SCORE = 5;
const TICK_RATE = 1000 / 60;
const SCORE_PAUSE_TICKS = 90;   // 1.5 second pause after scoring
const READY_TIMEOUT_MS = 30000; // 30 seconds to ready up

class PongEngine {
  constructor(gameId, player1, player2, tier, io, activeGames, customStake) {
    this.gameId = gameId;
    this.player1 = player1;
    this.player2 = player2;
    this.tier = tier;
    this.io = io;
    this.activeGames = activeGames;
    this.pauseTicks = 0;
    this.customStake = customStake || null; // for duel matches
    this.tickCount = 0;
    this.broadcastInterval = 3; // broadcast every 3rd tick = ~20Hz
    this.pendingSounds = [];    // accumulate sounds between broadcasts

    // Ready system
    this.readyPhase = true;
    this.p1Ready = false;
    this.p2Ready = false;
    this.readyTimeout = null;
    this.gameStarted = false;

    // In-game chat messages (last 20)
    this.chatMessages = [];

    this.state = {
      ball: { x: CANVAS_W / 2, y: CANVAS_H / 2, vx: 0, vy: 0 },
      paddle1: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      paddle2: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      score: { p1: 0, p2: 0 },
      status: 'playing',
      winner: null,
      paused: false,
      sound: null,
    };

    this.input = {
      [player1.wallet]: 'stop',
      [player2.wallet]: 'stop',
    };

    this.interval = null;
    this.disconnected = new Set();
  }

  setDisconnect(wallet) {
    this.disconnected.add(wallet);
  }

  clearDisconnect(wallet) {
    this.disconnected.delete(wallet);
  }

  isDisconnected(wallet) {
    return this.disconnected.has(wallet);
  }

  /** Get the stake amount (custom for duels, tier-based otherwise) */
  getStakeAmount() {
    if (this.customStake) return this.customStake;
    return STAKE_TIERS[this.tier] || 0;
  }

  /** Begin the ready phase — both players must press READY within 30s */
  startReadyPhase() {
    this.readyPhase = true;
    this.p1Ready = false;
    this.p2Ready = false;

    this.emit('ready-phase', {
      gameId: this.gameId,
      p1Ready: false,
      p2Ready: false,
      timeout: READY_TIMEOUT_MS / 1000,
    });

    // 30s timeout — if both not ready, cancel game
    this.readyTimeout = setTimeout(() => {
      if (!this.p1Ready || !this.p2Ready) {
        this.cancelReadyTimeout();
      }
    }, READY_TIMEOUT_MS);
  }

  /** Handle a player marking themselves as ready */
  playerReady(wallet) {
    if (!this.readyPhase) return;

    if (wallet === this.player1.wallet) this.p1Ready = true;
    if (wallet === this.player2.wallet) this.p2Ready = true;

    this.emit('ready-status', {
      gameId: this.gameId,
      p1Ready: this.p1Ready,
      p2Ready: this.p2Ready,
    });

    // Both ready — start 3-second countdown then game
    if (this.p1Ready && this.p2Ready) {
      if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
      this.readyPhase = false;

      this.emit('ready-countdown', { gameId: this.gameId, seconds: 3 });
      setTimeout(() => this.start(), 3000);
    }
  }

  /** Cancel game if ready timeout expires */
  cancelReadyTimeout() {
    this.readyPhase = false;
    if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
    this.emit('ready-expired', {
      gameId: this.gameId,
      reason: 'Not all players readied up in time. Game cancelled.',
    });
    // Mark match as cancelled
    Match.findOneAndUpdate({ gameId: this.gameId }, { status: 'cancelled' }).catch(() => {});
    this.activeGames.delete(this.gameId);
  }

  start() {
    if (this.gameStarted) return;
    this.gameStarted = true;

    const stakeAmount = this.getStakeAmount();
    this.emit('game-start', {
      gameId: this.gameId,
      player1: { wallet: this.player1.wallet, username: this.player1.username, skin: this.player1.skin || null },
      player2: { wallet: this.player2.wallet, username: this.player2.username, skin: this.player2.skin || null },
      tier: this.tier,
      stake: stakeAmount,
    });

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

  /** Handle in-game chat message */
  handleChat(wallet, text) {
    if (!text || text.length > 100) return;
    const username = wallet === this.player1.wallet
      ? this.player1.username
      : this.player2.username;

    const msg = { from: wallet, username, text, time: Date.now() };
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 20) this.chatMessages.shift();

    this.emit('game-chat-msg', {
      gameId: this.gameId,
      from: wallet,
      username,
      text,
    });
  }

  tick() {
    if (this.state.status !== 'playing') return;
    this.state.sound = null;
    this.tickCount++;
    const isBroadcastTick = (this.tickCount % this.broadcastInterval === 0);

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
      if (isBroadcastTick) this.broadcastState();
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
      this.state.sound = 'wall';
    }
    if (ball.y >= CANVAS_H - BALL_SIZE) {
      ball.vy = -Math.abs(ball.vy);
      ball.y = CANVAS_H - BALL_SIZE;
      this.state.sound = 'wall';
    }

    // --- Left paddle collision (player 1) — swept detection ---
    const p1Right = 10 + PADDLE_W;
    if (ball.vx < 0) {
      const oldLeft = oldX;
      const newLeft = ball.x;
      if (newLeft <= p1Right && oldLeft >= p1Right) {
        const t = (oldLeft - p1Right) / (oldLeft - newLeft);
        const hitY = oldY + ball.vy * t;
        if (hitY + BALL_SIZE >= this.state.paddle1.y &&
            hitY <= this.state.paddle1.y + PADDLE_H) {
          const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = speed;
          ball.x = p1Right;
          ball.y = hitY;
          const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle1.y) / PADDLE_H;
          ball.vy = (hitPos - 0.5) * speed * 1.5;
          this.state.sound = 'paddle';
        }
      } else if (ball.x <= p1Right && ball.x + BALL_SIZE >= 10 &&
                 ball.y + BALL_SIZE >= this.state.paddle1.y &&
                 ball.y <= this.state.paddle1.y + PADDLE_H) {
        const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
        ball.vx = speed;
        ball.x = p1Right;
        const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle1.y) / PADDLE_H;
        ball.vy = (hitPos - 0.5) * speed * 1.5;
        this.state.sound = 'paddle';
      }
    }

    // --- Right paddle collision (player 2) — swept detection ---
    const p2Left = CANVAS_W - 10 - PADDLE_W;
    if (ball.vx > 0) {
      const oldRight = oldX + BALL_SIZE;
      const newRight = ball.x + BALL_SIZE;
      if (newRight >= p2Left && oldRight <= p2Left) {
        const t = (p2Left - oldRight) / (newRight - oldRight);
        const hitY = oldY + ball.vy * t;
        if (hitY + BALL_SIZE >= this.state.paddle2.y &&
            hitY <= this.state.paddle2.y + PADDLE_H) {
          const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = -speed;
          ball.x = p2Left - BALL_SIZE;
          ball.y = hitY;
          const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle2.y) / PADDLE_H;
          ball.vy = (hitPos - 0.5) * speed * 1.5;
          this.state.sound = 'paddle';
        }
      } else if (ball.x + BALL_SIZE >= p2Left && ball.x <= CANVAS_W - 10 &&
                 ball.y + BALL_SIZE >= this.state.paddle2.y &&
                 ball.y <= this.state.paddle2.y + PADDLE_H) {
        const speed = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
        ball.vx = -speed;
        ball.x = p2Left - BALL_SIZE;
        const hitPos = (ball.y + BALL_SIZE / 2 - this.state.paddle2.y) / PADDLE_H;
        ball.vy = (hitPos - 0.5) * speed * 1.5;
        this.state.sound = 'paddle';
      }
    }

    // --- Scoring ---
    if (ball.x + BALL_SIZE < 0) {
      this.state.score.p2++;
      this.state.sound = 'score';
      if (this.state.score.p2 >= WIN_SCORE) { this.endGame(this.player2.wallet); return; }
      this.resetBall();
      this.broadcastState(); // always broadcast score events immediately
      return;
    }
    if (ball.x > CANVAS_W) {
      this.state.score.p1++;
      this.state.sound = 'score';
      if (this.state.score.p1 >= WIN_SCORE) { this.endGame(this.player1.wallet); return; }
      this.resetBall();
      this.broadcastState(); // always broadcast score events immediately
      return;
    }

    // Accumulate sounds for next broadcast
    if (this.state.sound && !this.pendingSounds.includes(this.state.sound)) {
      this.pendingSounds.push(this.state.sound);
    }

    if (isBroadcastTick) this.broadcastState();
  }

  resetBall() {
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
    const angle = (Math.random() - 0.5) * Math.PI / 3;
    const dir = Math.random() > 0.5 ? 1 : -1;
    this.state.ball.vx = Math.cos(angle) * BALL_SPEED_INITIAL * dir;
    this.state.ball.vy = Math.sin(angle) * BALL_SPEED_INITIAL;
  }

  broadcastState() {
    // Include any sounds accumulated since last broadcast
    const sounds = this.pendingSounds.length > 0 ? this.pendingSounds.slice() : [];
    if (this.state.sound && !sounds.includes(this.state.sound)) {
      sounds.push(this.state.sound);
    }
    this.pendingSounds = [];

    this.emit('game-state', {
      gameId: this.gameId,
      state: this.state,
      tick: this.tickCount,
      sounds,
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
      loser: loserWallet,
      score: this.state.score,
      player1: { wallet: this.player1.wallet, username: this.player1.username },
      player2: { wallet: this.player2.wallet, username: this.player2.username },
    });

    try {
      const stakeAmount = this.getStakeAmount();
      const totalPot = stakeAmount * 2;
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

    // Don't delete from activeGames immediately — keep for post-game chat
    // Clean up after 5 minutes
    setTimeout(() => {
      this.activeGames.delete(this.gameId);
    }, 300000);
  }

  forfeit(disconnectedWallet) {
    const winnerWallet = disconnectedWallet === this.player1.wallet
      ? this.player2.wallet
      : this.player1.wallet;
    clearInterval(this.interval);
    if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
    this.emit('game-forfeit', { gameId: this.gameId, winner: winnerWallet, reason: 'opponent disconnected' });
    this.endGame(winnerWallet);
  }

  emit(event, data) {
    this.io.to(this.player1.socketId).emit(event, data);
    this.io.to(this.player2.socketId).emit(event, data);
  }
}

module.exports = { PongEngine, STAKE_TIERS, WIN_SCORE, CANVAS_W, CANVAS_H, READY_TIMEOUT_MS };
