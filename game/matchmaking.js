// ===========================================
// Matchmaking — Tier-Based Queue + Duel System
// ===========================================

const { PongEngine } = require('./PongEngine');
const { STAKE_TIERS, buildEscrowTransaction, buildCustomEscrowTransaction, verifyEscrowTx, refundPlayer } = require('../solana/utils');
const Match = require('../models/Match');
const User = require('../models/User');
const Skin = require('../models/Skin');
const crypto = require('crypto');

/**
 * Look up a player's equipped skin data from DB.
 */
async function getPlayerSkin(wallet) {
  try {
    const user = await User.findOne({ wallet }).select('equippedSkin');
    if (!user || !user.equippedSkin || user.equippedSkin === 'default') return null;
    const skin = await Skin.findOne({ skinId: user.equippedSkin });
    if (!skin) return null;
    return { skinId: skin.skinId, name: skin.name, type: skin.type, cssValue: skin.cssValue, imageUrl: skin.imageUrl };
  } catch {
    return null;
  }
}

const SKIP_ESCROW = process.env.SKIP_ESCROW === 'true';
if (SKIP_ESCROW) console.log('⚠ SKIP_ESCROW mode: games start without token escrow');

// Queues per tier
const queues = { low: [], medium: [], high: [] };

// Pending matches waiting for escrow
const pendingEscrow = new Map();

// Pending duel invites: duelId -> { challenger, target, stakeAmount, createdAt }
const pendingDuels = new Map();

// Open custom-stake lobbies: lobbyId -> { wallet, username, socketId, stakeAmount, createdAt }
const openLobbies = new Map();

/**
 * Broadcast current lobby list to all connected sockets.
 */
function broadcastLobbies(io) {
  const list = [];
  for (const [lobbyId, lobby] of openLobbies) {
    list.push({
      lobbyId,
      wallet: lobby.wallet,
      username: lobby.username,
      stakeAmount: lobby.stakeAmount,
      createdAt: lobby.createdAt,
    });
  }
  io.emit('lobby-update', { lobbies: list });
}

/**
 * Shared helper to start a custom-stake match between two players.
 * Used by duel-accept, lobby-join, and escrow-submit flows.
 */
async function startCustomStakeMatch(io, p1, p2, stakeAmount, activeGames) {
  const gameId = crypto.randomUUID();

  await Match.create({
    gameId,
    player1: p1.wallet,
    player2: p2.wallet,
    player1Username: p1.username,
    player2Username: p2.username,
    tier: 'duel',
    stakeAmount,
    status: SKIP_ESCROW ? 'in-progress' : 'pending-escrow',
  });

  if (SKIP_ESCROW) {
    const [p1Skin, p2Skin] = await Promise.all([
      getPlayerSkin(p1.wallet),
      getPlayerSkin(p2.wallet),
    ]);
    p1.skin = p1Skin;
    p2.skin = p2Skin;

    const game = new PongEngine(gameId, p1, p2, 'duel', io, activeGames, stakeAmount);
    activeGames.set(gameId, game);

    const countdownData = {
      gameId, seconds: 30, tier: 'duel',
      player1: { wallet: p1.wallet, username: p1.username, skin: p1Skin },
      player2: { wallet: p2.wallet, username: p2.username, skin: p2Skin },
      stakeAmount,
      useReadySystem: true,
    };
    io.to(p1.socketId).emit('game-countdown', countdownData);
    io.to(p2.socketId).emit('game-countdown', countdownData);

    game.startReadyPhase();
    return;
  }

  // Production: build escrow transactions
  let p1Tx, p2Tx;
  try {
    p1Tx = await buildCustomEscrowTransaction(p1.wallet, stakeAmount);
  } catch (err) {
    io.to(p1.socketId).emit('match-error', { error: err.message });
    io.to(p2.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }
  try {
    p2Tx = await buildCustomEscrowTransaction(p2.wallet, stakeAmount);
  } catch (err) {
    io.to(p2.socketId).emit('match-error', { error: err.message });
    io.to(p1.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }

  pendingEscrow.set(gameId, {
    player1: p1,
    player2: p2,
    tier: 'duel',
    stakeAmount,
    p1Escrowed: false,
    p2Escrowed: false,
  });

  io.to(p1.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: p2.wallet, username: p2.username },
    tier: 'duel',
    stake: stakeAmount,
    escrowTransaction: p1Tx.transaction,
    yourSlot: 'p1',
  });

  io.to(p2.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: p1.wallet, username: p1.username },
    tier: 'duel',
    stake: stakeAmount,
    escrowTransaction: p2Tx.transaction,
    yourSlot: 'p2',
  });

  setTimeout(() => {
    if (pendingEscrow.has(gameId)) {
      pendingEscrow.delete(gameId);
      Match.findOneAndUpdate({ gameId }, { status: 'cancelled' }).catch(() => {});
      io.to(p1.socketId).emit('match-cancelled', { gameId, reason: 'Escrow timeout' });
      io.to(p2.socketId).emit('match-cancelled', { gameId, reason: 'Escrow timeout' });
    }
  }, 60000);
}

function setupMatchmaking(io, socket, onlineUsers, activeGames) {

  // Player joins a matchmaking queue
  socket.on('queue-join', async ({ tier }) => {
    if (!['low', 'medium', 'high'].includes(tier)) {
      return socket.emit('queue-error', { error: 'Invalid tier' });
    }
    if (!socket.wallet) {
      return socket.emit('queue-error', { error: 'Not authenticated' });
    }

    // Prevent double-queueing
    for (const t of Object.keys(queues)) {
      queues[t] = queues[t].filter(p => p.wallet !== socket.wallet);
    }

    // Auto-cancel any open lobby when joining queue
    for (const [lobbyId, lobby] of openLobbies) {
      if (lobby.wallet === socket.wallet) {
        openLobbies.delete(lobbyId);
        socket.emit('lobby-cancelled');
        broadcastLobbies(io);
        break;
      }
    }

    const player = {
      wallet: socket.wallet,
      username: socket.username || 'Anon',
      socketId: socket.id,
      tier
    };

    queues[tier].push(player);
    socket.emit('queue-joined', { tier, position: queues[tier].length });
    console.log(`${player.username} joined ${tier} queue (${queues[tier].length} in queue)`);

    if (queues[tier].length >= 2) {
      const p1 = queues[tier].shift();
      const p2 = queues[tier].shift();
      createMatch(io, p1, p2, tier, activeGames);
    }
  });

  // Player leaves queue
  socket.on('queue-leave', () => {
    for (const tier of Object.keys(queues)) {
      queues[tier] = queues[tier].filter(p => p.wallet !== socket.wallet);
    }
    socket.emit('queue-left');
  });

  // Player submits escrow transaction
  socket.on('escrow-submit', async ({ gameId, txSignature }) => {
    const pending = pendingEscrow.get(gameId);
    if (!pending) return socket.emit('escrow-error', { error: 'No pending match' });

    const isP1 = socket.wallet === pending.player1.wallet;
    const isP2 = socket.wallet === pending.player2.wallet;
    if (!isP1 && !isP2) return;

    const who = isP1 ? 'p1' : 'p2';
    io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'verifying' });
    io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'verifying' });

    const stakeAmount = pending.stakeAmount || STAKE_TIERS[pending.tier];
    console.log(`Verifying escrow tx for ${socket.wallet}: ${txSignature}`);
    const verified = await verifyEscrowTx(txSignature, stakeAmount, socket.wallet);
    if (!verified) {
      io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'failed' });
      io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'failed' });
      return socket.emit('escrow-error', { error: 'Transaction failed on-chain. Make sure you have enough $PONG and SOL.' });
    }

    if (isP1) pending.p1Escrowed = true;
    if (isP2) pending.p2Escrowed = true;

    const update = isP1
      ? { player1EscrowTx: txSignature }
      : { player2EscrowTx: txSignature };
    await Match.findOneAndUpdate({ gameId }, update);

    io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'confirmed' });
    io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'confirmed' });

    if (pending.p1Escrowed && pending.p2Escrowed) {
      pendingEscrow.delete(gameId);

      const [p1Skin, p2Skin] = await Promise.all([
        getPlayerSkin(pending.player1.wallet),
        getPlayerSkin(pending.player2.wallet),
      ]);
      pending.player1.skin = p1Skin;
      pending.player2.skin = p2Skin;

      const customStake = pending.stakeAmount || null;
      const game = new PongEngine(
        gameId,
        pending.player1,
        pending.player2,
        pending.tier,
        io,
        activeGames,
        customStake
      );
      activeGames.set(gameId, game);
      await Match.findOneAndUpdate({ gameId }, { status: 'in-progress' });

      const countdownData = {
        gameId, seconds: 30, tier: pending.tier,
        player1: { wallet: pending.player1.wallet, username: pending.player1.username, skin: p1Skin },
        player2: { wallet: pending.player2.wallet, username: pending.player2.username, skin: p2Skin },
        stakeAmount: customStake || STAKE_TIERS[pending.tier],
        useReadySystem: true,
      };
      io.to(pending.player1.socketId).emit('game-countdown', countdownData);
      io.to(pending.player2.socketId).emit('game-countdown', countdownData);

      // Start ready phase instead of auto-start
      game.startReadyPhase();
    }
  });

  // Player cancels pending escrow
  socket.on('escrow-cancel', async ({ gameId }) => {
    const pending = pendingEscrow.get(gameId);
    if (!pending) return;
    pendingEscrow.delete(gameId);
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });

    if (pending.p1Escrowed && socket.wallet !== pending.player1.wallet) {
      const stakeAmount = pending.stakeAmount || STAKE_TIERS[pending.tier];
      refundPlayer(pending.player1.wallet, stakeAmount).catch(err => {
        console.error('Refund P1 failed:', err.message);
      });
      io.to(pending.player1.socketId).emit('match-cancelled', { gameId, reason: 'Opponent cancelled. Your $PONG is being refunded.' });
    } else {
      io.to(pending.player1.socketId).emit('match-cancelled', { gameId, reason: 'Match cancelled' });
    }

    if (pending.p2Escrowed && socket.wallet !== pending.player2.wallet) {
      const stakeAmount = pending.stakeAmount || STAKE_TIERS[pending.tier];
      refundPlayer(pending.player2.wallet, stakeAmount).catch(err => {
        console.error('Refund P2 failed:', err.message);
      });
      io.to(pending.player2.socketId).emit('match-cancelled', { gameId, reason: 'Opponent cancelled. Your $PONG is being refunded.' });
    } else {
      io.to(pending.player2.socketId).emit('match-cancelled', { gameId, reason: 'Match cancelled' });
    }
  });

  // === READY SYSTEM ===
  socket.on('player-ready', ({ gameId }) => {
    const game = activeGames.get(gameId);
    if (!game || !game.readyPhase) return;
    if (!socket.wallet) return;
    game.playerReady(socket.wallet);
  });

  // === IN-GAME CHAT ===
  // Rate limit: 1 msg/sec per player
  const chatLastSent = new Map();

  socket.on('game-chat', ({ gameId, text }) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    if (!socket.wallet || !game.hasPlayer(socket.wallet)) return;
    if (!text || typeof text !== 'string') return;

    const now = Date.now();
    const lastSent = chatLastSent.get(socket.wallet) || 0;
    if (now - lastSent < 1000) return; // rate limit
    chatLastSent.set(socket.wallet, now);

    game.handleChat(socket.wallet, text.substring(0, 100));
  });

  // === DUEL INVITE SYSTEM ===
  socket.on('duel-invite', async ({ targetWallet, stakeAmount }) => {
    if (!socket.wallet) return socket.emit('duel-error', { error: 'Not authenticated' });
    if (!targetWallet || !stakeAmount) return socket.emit('duel-error', { error: 'Missing parameters' });
    if (stakeAmount <= 0) return socket.emit('duel-error', { error: 'Invalid stake amount' });

    // Check if target is online
    const targetInfo = onlineUsers.get(targetWallet);
    if (!targetInfo) return socket.emit('duel-error', { error: 'Player is offline' });

    // Check if both are friends
    const [user, target] = await Promise.all([
      User.findOne({ wallet: socket.wallet }),
      User.findOne({ wallet: targetWallet })
    ]);
    if (!user || !target) return socket.emit('duel-error', { error: 'User not found' });
    if (!user.friends.includes(targetWallet)) return socket.emit('duel-error', { error: 'You must be friends to duel' });

    // Check neither is in an active game
    for (const [, game] of activeGames) {
      if (game.hasPlayer(socket.wallet) && game.state.status === 'playing') {
        return socket.emit('duel-error', { error: 'You are already in a game' });
      }
      if (game.hasPlayer(targetWallet) && game.state.status === 'playing') {
        return socket.emit('duel-error', { error: 'Opponent is already in a game' });
      }
    }

    const duelId = crypto.randomUUID();
    pendingDuels.set(duelId, {
      challenger: { wallet: socket.wallet, username: socket.username, socketId: socket.id },
      target: { wallet: targetWallet, username: targetInfo.username, socketId: targetInfo.socketId },
      stakeAmount,
      createdAt: Date.now(),
    });

    // Notify target
    io.to(targetInfo.socketId).emit('duel-incoming', {
      duelId,
      from: socket.wallet,
      fromUsername: socket.username,
      stakeAmount,
    });

    socket.emit('duel-sent', { duelId, targetUsername: targetInfo.username });

    // Timeout duel invite after 30s
    setTimeout(() => {
      if (pendingDuels.has(duelId)) {
        pendingDuels.delete(duelId);
        socket.emit('duel-expired', { duelId });
        io.to(targetInfo.socketId).emit('duel-expired', { duelId });
      }
    }, 30000);
  });

  socket.on('duel-accept', async ({ duelId }) => {
    const duel = pendingDuels.get(duelId);
    if (!duel) return socket.emit('duel-error', { error: 'Duel invite expired or not found' });
    if (socket.wallet !== duel.target.wallet) return;

    pendingDuels.delete(duelId);

    // Update socket IDs (may have changed)
    const challengerInfo = onlineUsers.get(duel.challenger.wallet);
    if (challengerInfo) duel.challenger.socketId = challengerInfo.socketId;

    await startCustomStakeMatch(io, duel.challenger, duel.target, duel.stakeAmount, activeGames);
  });

  socket.on('duel-decline', ({ duelId }) => {
    const duel = pendingDuels.get(duelId);
    if (!duel) return;
    if (socket.wallet !== duel.target.wallet) return;
    pendingDuels.delete(duelId);

    io.to(duel.challenger.socketId).emit('duel-declined', {
      duelId,
      byUsername: duel.target.username,
    });
  });

  // === CUSTOM STAKE LOBBIES ===

  socket.on('lobby-create', async ({ stakeAmount }) => {
    if (!socket.wallet) return socket.emit('lobby-error', { error: 'Not authenticated' });
    if (!stakeAmount || stakeAmount <= 0) return socket.emit('lobby-error', { error: 'Invalid stake amount' });

    // Check not already in a lobby
    for (const [, lobby] of openLobbies) {
      if (lobby.wallet === socket.wallet) {
        return socket.emit('lobby-error', { error: 'You already have an open lobby' });
      }
    }

    // Check not in queue
    for (const t of Object.keys(queues)) {
      if (queues[t].some(p => p.wallet === socket.wallet)) {
        return socket.emit('lobby-error', { error: 'Leave the queue before creating a lobby' });
      }
    }

    // Check not in active game
    for (const [, game] of activeGames) {
      if (game.hasPlayer(socket.wallet) && game.state.status === 'playing') {
        return socket.emit('lobby-error', { error: 'You are already in a game' });
      }
    }

    const lobbyId = crypto.randomUUID();
    openLobbies.set(lobbyId, {
      wallet: socket.wallet,
      username: socket.username || 'Anon',
      socketId: socket.id,
      stakeAmount,
      createdAt: Date.now(),
    });

    socket.emit('lobby-created', { lobbyId });
    broadcastLobbies(io);
    console.log(`${socket.username} created lobby ${lobbyId} for ${stakeAmount} base units`);
  });

  socket.on('lobby-cancel', ({ lobbyId }) => {
    const lobby = openLobbies.get(lobbyId);
    if (!lobby || lobby.wallet !== socket.wallet) return;
    openLobbies.delete(lobbyId);
    socket.emit('lobby-cancelled');
    broadcastLobbies(io);
    console.log(`${socket.username} cancelled lobby ${lobbyId}`);
  });

  socket.on('lobby-join', async ({ lobbyId }) => {
    if (!socket.wallet) return socket.emit('lobby-error', { error: 'Not authenticated' });

    const lobby = openLobbies.get(lobbyId);
    if (!lobby) return socket.emit('lobby-error', { error: 'Lobby no longer exists' });
    if (lobby.wallet === socket.wallet) return socket.emit('lobby-error', { error: 'Cannot join your own lobby' });

    // Check not in active game
    for (const [, game] of activeGames) {
      if (game.hasPlayer(socket.wallet) && game.state.status === 'playing') {
        return socket.emit('lobby-error', { error: 'You are already in a game' });
      }
    }

    // Remove lobby
    openLobbies.delete(lobbyId);

    // Also cancel any lobby the joiner has open
    for (const [id, l] of openLobbies) {
      if (l.wallet === socket.wallet) {
        openLobbies.delete(id);
        socket.emit('lobby-cancelled');
        break;
      }
    }

    broadcastLobbies(io);

    // Notify lobby creator their lobby was cancelled (they're entering a match)
    const creatorInfo = onlineUsers.get(lobby.wallet);
    if (creatorInfo) lobby.socketId = creatorInfo.socketId;
    io.to(lobby.socketId).emit('lobby-cancelled');

    const p1 = { wallet: lobby.wallet, username: lobby.username, socketId: lobby.socketId };
    const p2 = { wallet: socket.wallet, username: socket.username || 'Anon', socketId: socket.id };

    await startCustomStakeMatch(io, p1, p2, lobby.stakeAmount, activeGames);
  });

  socket.on('lobby-list-request', () => {
    const list = [];
    for (const [lobbyId, lobby] of openLobbies) {
      list.push({
        lobbyId,
        wallet: lobby.wallet,
        username: lobby.username,
        stakeAmount: lobby.stakeAmount,
        createdAt: lobby.createdAt,
      });
    }
    socket.emit('lobby-list', { lobbies: list });
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    for (const tier of Object.keys(queues)) {
      queues[tier] = queues[tier].filter(p => p.wallet !== socket.wallet);
    }
    // Remove any open lobbies from disconnecting player
    let lobbyCleaned = false;
    for (const [lobbyId, lobby] of openLobbies) {
      if (lobby.wallet === socket.wallet) {
        openLobbies.delete(lobbyId);
        lobbyCleaned = true;
      }
    }
    if (lobbyCleaned) broadcastLobbies(io);
  });
}

async function createMatch(io, player1, player2, tier, activeGames) {
  const gameId = crypto.randomUUID();

  await Match.create({
    gameId,
    player1: player1.wallet,
    player2: player2.wallet,
    player1Username: player1.username,
    player2Username: player2.username,
    tier,
    stakeAmount: STAKE_TIERS[tier],
    status: SKIP_ESCROW ? 'in-progress' : 'pending-escrow'
  });

  if (SKIP_ESCROW) {
    const [p1Skin, p2Skin] = await Promise.all([
      getPlayerSkin(player1.wallet),
      getPlayerSkin(player2.wallet),
    ]);
    player1.skin = p1Skin;
    player2.skin = p2Skin;

    const game = new PongEngine(gameId, player1, player2, tier, io, activeGames);
    activeGames.set(gameId, game);

    const countdownData = {
      gameId, seconds: 30, tier,
      player1: { wallet: player1.wallet, username: player1.username, skin: p1Skin },
      player2: { wallet: player2.wallet, username: player2.username, skin: p2Skin },
      stakeAmount: STAKE_TIERS[tier],
      useReadySystem: true,
    };
    io.to(player1.socketId).emit('game-countdown', countdownData);
    io.to(player2.socketId).emit('game-countdown', countdownData);

    game.startReadyPhase();
    return;
  }

  // PRODUCTION: build escrow transactions
  let p1Tx, p2Tx;
  try {
    p1Tx = await buildEscrowTransaction(player1.wallet, tier);
  } catch (err) {
    console.error('P1 escrow build failed:', err.message);
    io.to(player1.socketId).emit('match-error', { error: err.message });
    io.to(player2.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }
  try {
    p2Tx = await buildEscrowTransaction(player2.wallet, tier);
  } catch (err) {
    console.error('P2 escrow build failed:', err.message);
    io.to(player2.socketId).emit('match-error', { error: err.message });
    io.to(player1.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }

  pendingEscrow.set(gameId, {
    player1, player2, tier,
    p1Escrowed: false, p2Escrowed: false,
  });

  io.to(player1.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player2.wallet, username: player2.username },
    tier,
    stake: STAKE_TIERS[tier],
    escrowTransaction: p1Tx.transaction,
    yourSlot: 'p1',
  });

  io.to(player2.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player1.wallet, username: player1.username },
    tier,
    stake: STAKE_TIERS[tier],
    escrowTransaction: p2Tx.transaction,
    yourSlot: 'p2',
  });

  setTimeout(() => {
    if (pendingEscrow.has(gameId)) {
      pendingEscrow.delete(gameId);
      Match.findOneAndUpdate({ gameId }, { status: 'cancelled' }).catch(() => {});
      io.to(player1.socketId).emit('match-cancelled', { gameId, reason: 'Escrow timeout' });
      io.to(player2.socketId).emit('match-cancelled', { gameId, reason: 'Escrow timeout' });
    }
  }, 60000);
}

module.exports = { setupMatchmaking };
