// ===========================================
// Pong Engine — Server-Authoritative Game State
// ===========================================
// Runs at 60 ticks/sec. Server owns all physics via PongSim.
// Clients only send input; server broadcasts state.

const PongSim = require('../public/js/pong-sim');
const Match = require('../models/Match');
const User = require('../models/User');
const { payoutWinner, STAKE_TIERS } = require('../solana/utils');

const TICK_RATE = 1000 / 60;
const READY_TIMEOUT_MS = 30000; // 30 seconds to ready up
const INPUT_RATE_LIMIT = 30;    // max direction changes/sec per player

class PongEngine {
  constructor(gameId, player1, player2, tier, io, activeGames, customStake) {
    this.gameId = gameId;
    this.player1 = player1;
    this.player2 = player2;
    this.tier = tier;
    this.io = io;
    this.activeGames = activeGames;
    this.customStake = customStake || null;
    this.tickCount = 0;
    this.broadcastInterval = 1; // broadcast every tick = 60Hz
    this.pendingSounds = [];

    // Ready system
    this.readyPhase = true;
    this.p1Ready = false;
    this.p2Ready = false;
    this.readyTimeout = null;
    this.gameStarted = false;

    // In-game chat messages (last 20)
    this.chatMessages = [];

    // Simulation state via PongSim
    this.simState = PongSim.createState();

    this.input = {
      [player1.wallet]: 'stop',
      [player2.wallet]: 'stop',
    };

    // Anti-cheat: input rate limiting (sliding window)
    this._inputTimestamps = {
      [player1.wallet]: [],
      [player2.wallet]: [],
    };

    this.interval = null;
    this.disconnected = new Set();
  }

  // Getter so external code (matchmaking.js, server.js) can read game.state
  get state() {
    return PongSim.serializeState(this.simState);
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

  getStakeAmount() {
    if (this.customStake) return this.customStake;
    return STAKE_TIERS[this.tier] || 0;
  }

  // =============================================
  // READY PHASE
  // =============================================
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

    this.readyTimeout = setTimeout(() => {
      if (!this.p1Ready || !this.p2Ready) {
        this.cancelReadyTimeout();
      }
    }, READY_TIMEOUT_MS);
  }

  playerReady(wallet) {
    if (!this.readyPhase) return;

    if (wallet === this.player1.wallet) this.p1Ready = true;
    if (wallet === this.player2.wallet) this.p2Ready = true;

    this.emit('ready-status', {
      gameId: this.gameId,
      p1Ready: this.p1Ready,
      p2Ready: this.p2Ready,
    });

    if (this.p1Ready && this.p2Ready) {
      if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
      this.readyPhase = false;

      this.emit('ready-countdown', { gameId: this.gameId, seconds: 5 });
      setTimeout(() => this.start(), 5000);
    }
  }

  cancelReadyTimeout() {
    this.readyPhase = false;
    if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
    this.emit('ready-expired', {
      gameId: this.gameId,
      reason: 'Not all players readied up in time. Game cancelled.',
    });
    Match.findOneAndUpdate({ gameId: this.gameId }, { status: 'cancelled' }).catch(() => {});
    this.activeGames.delete(this.gameId);
  }

  // =============================================
  // GAME START
  // =============================================
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

    this._launchBall();
    this.interval = setInterval(() => this.tick(), TICK_RATE);
  }

  hasPlayer(wallet) {
    return this.player1.wallet === wallet || this.player2.wallet === wallet;
  }

  // =============================================
  // INPUT HANDLING + ANTI-CHEAT
  // =============================================
  handleInput(wallet, direction) {
    // Validate player identity
    if (wallet !== this.player1.wallet && wallet !== this.player2.wallet) return;

    // Validate direction value
    if (direction !== 'up' && direction !== 'down' && direction !== 'stop') return;

    // Rate limit: max INPUT_RATE_LIMIT direction changes per second
    const now = Date.now();
    const timestamps = this._inputTimestamps[wallet];
    if (timestamps) {
      // Remove entries older than 1 second
      while (timestamps.length > 0 && now - timestamps[0] > 1000) {
        timestamps.shift();
      }
      if (timestamps.length >= INPUT_RATE_LIMIT) return; // drop input
      timestamps.push(now);
    }

    this.input[wallet] = direction;
  }

  // =============================================
  // CHAT
  // =============================================
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

  // =============================================
  // TICK — main game loop (60Hz)
  // =============================================
  tick() {
    if (this.simState.status !== 'playing') return;
    this.simState.sound = null;
    this.tickCount++;
    const isBroadcastTick = (this.tickCount % this.broadcastInterval === 0);

    // --- Always allow paddle movement, even during pause ---
    const p1Dir = this.input[this.player1.wallet];
    const p2Dir = this.input[this.player2.wallet];
    PongSim.applyInput(this.simState, 1, p1Dir);
    PongSim.applyInput(this.simState, 2, p2Dir);

    // --- Score pause countdown ---
    if (this.simState.pauseTicks > 0) {
      const pauseEnded = PongSim.tickPause(this.simState);
      if (pauseEnded) {
        this._launchBall();
      }
      if (isBroadcastTick) this.broadcastState();
      return;
    }

    // --- Step ball physics ---
    const result = PongSim.stepBall(this.simState);
    if (result.sound) {
      this.simState.sound = result.sound;
    }

    // --- Handle scoring ---
    if (result.scored) {
      if (result.scored === 2) {
        this.simState.score.p2++;
        this.simState.sound = 'score';
        if (this.simState.score.p2 >= PongSim.WIN_SCORE) { this.endGame(this.player2.wallet); return; }
      } else {
        this.simState.score.p1++;
        this.simState.sound = 'score';
        if (this.simState.score.p1 >= PongSim.WIN_SCORE) { this.endGame(this.player1.wallet); return; }
      }
      PongSim.resetBallAfterScore(this.simState);
      this.broadcastState();
      return;
    }

    // Accumulate sounds for next broadcast
    if (this.simState.sound && !this.pendingSounds.includes(this.simState.sound)) {
      this.pendingSounds.push(this.simState.sound);
    }

    if (isBroadcastTick) this.broadcastState();
  }

  // =============================================
  // BALL LAUNCH — random angle/dir generated HERE
  // =============================================
  _launchBall() {
    const angle = (Math.random() - 0.5) * Math.PI / 3;
    const dir = Math.random() > 0.5 ? 1 : -1;
    PongSim.launchBall(this.simState, angle, dir);
  }

  // =============================================
  // BROADCAST
  // =============================================
  broadcastState() {
    const sounds = this.pendingSounds.length > 0 ? this.pendingSounds.slice() : [];
    if (this.simState.sound && !sounds.includes(this.simState.sound)) {
      sounds.push(this.simState.sound);
    }
    this.pendingSounds = [];

    this.emit('game-state', {
      gameId: this.gameId,
      state: PongSim.serializeState(this.simState),
      tick: this.tickCount,
      sounds,
    });
  }

  // =============================================
  // END GAME
  // =============================================
  async endGame(winnerWallet) {
    clearInterval(this.interval);
    this.simState.status = 'finished';
    this.simState.winner = winnerWallet;

    const loserWallet = winnerWallet === this.player1.wallet
      ? this.player2.wallet
      : this.player1.wallet;

    this.emit('game-over', {
      gameId: this.gameId,
      winner: winnerWallet,
      loser: loserWallet,
      score: this.simState.score,
      player1: { wallet: this.player1.wallet, username: this.player1.username },
      player2: { wallet: this.player2.wallet, username: this.player2.username },
    });

    try {
      const stakeAmount = this.getStakeAmount();
      const totalPot = stakeAmount * 2;
      const result = await payoutWinner(winnerWallet, totalPot);

      await Match.findOneAndUpdate({ gameId: this.gameId }, {
        winner: winnerWallet,
        score: { player1: this.simState.score.p1, player2: this.simState.score.p2 },
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

    // Keep for post-game chat, clean up after 5 minutes
    setTimeout(() => {
      this.activeGames.delete(this.gameId);
    }, 300000);
  }

  // =============================================
  // FORFEIT
  // =============================================
  forfeit(disconnectedWallet) {
    const winnerWallet = disconnectedWallet === this.player1.wallet
      ? this.player2.wallet
      : this.player1.wallet;
    clearInterval(this.interval);
    if (this.readyTimeout) { clearTimeout(this.readyTimeout); this.readyTimeout = null; }
    this.emit('game-forfeit', { gameId: this.gameId, winner: winnerWallet, reason: 'opponent disconnected' });
    this.endGame(winnerWallet);
  }

  // =============================================
  // EMIT TO BOTH PLAYERS
  // =============================================
  emit(event, data) {
    this.io.to(this.player1.socketId).emit(event, data);
    this.io.to(this.player2.socketId).emit(event, data);
  }
}

module.exports = { PongEngine, STAKE_TIERS, WIN_SCORE: PongSim.WIN_SCORE, CANVAS_W: PongSim.CANVAS_W, CANVAS_H: PongSim.CANVAS_H, READY_TIMEOUT_MS };
