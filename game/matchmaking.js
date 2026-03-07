// ===========================================
// Matchmaking — Tier-Based Queue + Duel + Tournament System
// ===========================================

const { PongEngine } = require('./PongEngine');
const { STAKE_TIERS, buildEscrowTransaction, buildCustomEscrowTransaction, verifyEscrowTx, refundPlayer, payoutWinner } = require('../solana/utils');
const Match = require('../models/Match');
const User = require('../models/User');
const Skin = require('../models/Skin');
const Tournament = require('../models/Tournament');
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

// Valid tiers: USD-based tiers + legacy tiers
const VALID_TIERS = ['t5', 't10', 't25', 't50', 't100', 't250', 't500', 't1000', 'low', 'medium', 'high', 'duel'];

// Queues per tier (created dynamically)
const queues = {};
VALID_TIERS.forEach(t => { queues[t] = []; });

// Pending matches waiting for escrow
const pendingEscrow = new Map();

// Pending duel invites: duelId -> { challenger, target, stakeAmount, createdAt }
const pendingDuels = new Map();

// Open custom-stake lobbies: lobbyId -> { wallet, username, socketId, stakeAmount, createdAt }
const openLobbies = new Map();

// Open tournaments: tournamentId -> tournament doc (in-memory mirror)
const openTournaments = new Map();

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
  socket.on('queue-join', async ({ tier, pongAmount }) => {
    if (!VALID_TIERS.includes(tier)) {
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

    // Calculate stake: use pongAmount from client for USD tiers, or legacy STAKE_TIERS
    let stakeAmount;
    if (pongAmount && pongAmount > 0) {
      // Client sends PONG display units, convert to base units
      stakeAmount = pongAmount * (10 ** 6); // PONG has 6 decimals
    } else {
      stakeAmount = STAKE_TIERS[tier] || 0;
    }

    const player = {
      wallet: socket.wallet,
      username: socket.username || 'Anon',
      socketId: socket.id,
      tier,
      stakeAmount,
    };

    queues[tier].push(player);
    socket.emit('queue-joined', { tier, position: queues[tier].length });
    console.log(`${player.username} joined ${tier} queue (${queues[tier].length} in queue, stake: ${stakeAmount})`);

    if (queues[tier].length >= 2) {
      const p1 = queues[tier].shift();
      const p2 = queues[tier].shift();
      // Use the custom stake amount for USD-based tiers
      try {
        await createMatch(io, p1, p2, tier, activeGames, p1.stakeAmount);
      } catch (err) {
        console.error('createMatch failed:', err.message);
        io.to(p1.socketId).emit('match-error', { error: 'Match creation failed. Please try again.' });
        io.to(p2.socketId).emit('match-error', { error: 'Match creation failed. Please try again.' });
      }
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

  // === TOURNAMENT SOCKET HANDLERS ===

  socket.on('tournament-create', async ({ stakeAmount, maxPlayers }) => {
    if (!socket.wallet) return socket.emit('tournament-error', { error: 'Not authenticated' });
    if (!stakeAmount || stakeAmount <= 0) return socket.emit('tournament-error', { error: 'Invalid stake amount' });
    if (!maxPlayers || maxPlayers < 2) return socket.emit('tournament-error', { error: 'Need at least 2 players' });

    // Check not already in a tournament
    for (const [, t] of openTournaments) {
      if (t.status === 'waiting' && t.players.some(p => p.wallet === socket.wallet)) {
        return socket.emit('tournament-error', { error: 'You are already in a tournament' });
      }
    }

    const tournamentId = crypto.randomUUID();
    const tournament = await Tournament.create({
      tournamentId,
      creator: socket.wallet,
      creatorUsername: socket.username || 'Anon',
      maxPlayers,
      stakeAmount,
      status: 'waiting',
      players: [{
        wallet: socket.wallet,
        username: socket.username || 'Anon',
        socketId: socket.id,
        escrowed: false,
        seed: 0,
      }],
    });

    openTournaments.set(tournamentId, tournament);
    socket.emit('tournament-created', { tournamentId });
    broadcastTournaments(io);
    console.log(`${socket.username} created tournament ${tournamentId} (${maxPlayers} players, ${stakeAmount} stake)`);
  });

  socket.on('tournament-join', async ({ tournamentId }) => {
    if (!socket.wallet) return socket.emit('tournament-error', { error: 'Not authenticated' });

    const tournament = openTournaments.get(tournamentId);
    if (!tournament) return socket.emit('tournament-error', { error: 'Tournament not found' });
    if (tournament.status !== 'waiting') return socket.emit('tournament-error', { error: 'Tournament already started' });
    if (tournament.players.length >= tournament.maxPlayers) return socket.emit('tournament-error', { error: 'Tournament is full' });
    if (tournament.players.some(p => p.wallet === socket.wallet)) return socket.emit('tournament-error', { error: 'Already in this tournament' });

    // Check not in another tournament
    for (const [, t] of openTournaments) {
      if (t.tournamentId !== tournamentId && (t.status === 'waiting' || t.status === 'escrow' || t.status === 'in-progress') && t.players.some(p => p.wallet === socket.wallet)) {
        return socket.emit('tournament-error', { error: 'You are already in another tournament' });
      }
    }

    tournament.players.push({
      wallet: socket.wallet,
      username: socket.username || 'Anon',
      socketId: socket.id,
      escrowed: false,
      seed: tournament.players.length,
    });

    await Tournament.findOneAndUpdate({ tournamentId }, { players: tournament.players });
    broadcastTournaments(io);

    // Notify all tournament players
    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-joined', {
        tournamentId,
        players: tournament.players.map(pp => ({ wallet: pp.wallet, username: pp.username })),
      });
    });

    // If full, start escrow phase
    if (tournament.players.length >= tournament.maxPlayers) {
      await startTournamentEscrow(io, tournament, onlineUsers, activeGames);
    }
  });

  socket.on('tournament-leave', async ({ tournamentId }) => {
    if (!socket.wallet) return;
    const tournament = openTournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'waiting') return;

    // Creator leaving = cancel
    if (tournament.creator === socket.wallet) {
      tournament.status = 'cancelled';
      await Tournament.findOneAndUpdate({ tournamentId }, { status: 'cancelled' });
      openTournaments.delete(tournamentId);
      tournament.players.forEach(p => {
        io.to(p.socketId).emit('tournament-cancelled', { tournamentId, reason: 'Creator left' });
      });
      broadcastTournaments(io);
      return;
    }

    tournament.players = tournament.players.filter(p => p.wallet !== socket.wallet);
    await Tournament.findOneAndUpdate({ tournamentId }, { players: tournament.players });
    broadcastTournaments(io);

    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-joined', {
        tournamentId,
        players: tournament.players.map(pp => ({ wallet: pp.wallet, username: pp.username })),
      });
    });
  });

  socket.on('tournament-cancel', async ({ tournamentId }) => {
    if (!socket.wallet) return;
    const tournament = openTournaments.get(tournamentId);
    if (!tournament) return;
    if (tournament.creator !== socket.wallet) return socket.emit('tournament-error', { error: 'Only the creator can cancel' });
    if (tournament.status !== 'waiting') return socket.emit('tournament-error', { error: 'Cannot cancel after tournament started' });

    tournament.status = 'cancelled';
    await Tournament.findOneAndUpdate({ tournamentId }, { status: 'cancelled' });
    openTournaments.delete(tournamentId);
    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-cancelled', { tournamentId, reason: 'Cancelled by creator' });
    });
    broadcastTournaments(io);
  });

  socket.on('tournament-escrow-submit', async ({ tournamentId, txSignature }) => {
    if (!socket.wallet) return;
    const tournament = openTournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'escrow') return socket.emit('tournament-error', { error: 'Not in escrow phase' });

    const player = tournament.players.find(p => p.wallet === socket.wallet);
    if (!player) return;
    if (player.escrowed) return;

    // Notify verifying
    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-escrow-status', { tournamentId, wallet: socket.wallet, status: 'verifying' });
    });

    const verified = await verifyEscrowTx(txSignature, tournament.stakeAmount, socket.wallet);
    if (!verified) {
      tournament.players.forEach(p => {
        io.to(p.socketId).emit('tournament-escrow-status', { tournamentId, wallet: socket.wallet, status: 'failed' });
      });
      return socket.emit('tournament-error', { error: 'Escrow verification failed' });
    }

    player.escrowed = true;
    player.escrowTx = txSignature;

    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-escrow-status', { tournamentId, wallet: socket.wallet, status: 'confirmed' });
    });

    await Tournament.findOneAndUpdate({ tournamentId }, { players: tournament.players });

    // Check if all escrowed
    if (tournament.players.every(p => p.escrowed)) {
      await startTournament(io, tournament, activeGames, onlineUsers);
    }
  });

  socket.on('tournament-list-request', () => {
    const list = getTournamentList();
    socket.emit('tournament-list', { tournaments: list });
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

    // Handle tournament disconnect (waiting phase only — in-game DC handled by PongEngine)
    if (socket.wallet) {
      for (const [tournamentId, t] of openTournaments) {
        if (t.status !== 'waiting') continue;
        const idx = t.players.findIndex(p => p.wallet === socket.wallet);
        if (idx === -1) continue;

        if (t.creator === socket.wallet) {
          // Creator DC = cancel
          t.status = 'cancelled';
          Tournament.findOneAndUpdate({ tournamentId }, { status: 'cancelled' }).catch(() => {});
          openTournaments.delete(tournamentId);
          t.players.forEach(p => {
            io.to(p.socketId).emit('tournament-cancelled', { tournamentId, reason: 'Creator disconnected' });
          });
          broadcastTournaments(io);
        } else {
          t.players.splice(idx, 1);
          Tournament.findOneAndUpdate({ tournamentId }, { players: t.players }).catch(() => {});
          broadcastTournaments(io);
          t.players.forEach(p => {
            io.to(p.socketId).emit('tournament-joined', {
              tournamentId,
              players: t.players.map(pp => ({ wallet: pp.wallet, username: pp.username })),
            });
          });
        }
      }
    }
  });
}

async function createMatch(io, player1, player2, tier, activeGames, customStakeAmount) {
  const gameId = crypto.randomUUID();
  const stakeAmount = customStakeAmount || STAKE_TIERS[tier] || 0;

  await Match.create({
    gameId,
    player1: player1.wallet,
    player2: player2.wallet,
    player1Username: player1.username,
    player2Username: player2.username,
    tier,
    stakeAmount,
    status: SKIP_ESCROW ? 'in-progress' : 'pending-escrow'
  });

  if (SKIP_ESCROW) {
    const [p1Skin, p2Skin] = await Promise.all([
      getPlayerSkin(player1.wallet),
      getPlayerSkin(player2.wallet),
    ]);
    player1.skin = p1Skin;
    player2.skin = p2Skin;

    const game = new PongEngine(gameId, player1, player2, tier, io, activeGames, stakeAmount);
    activeGames.set(gameId, game);

    const countdownData = {
      gameId, seconds: 30, tier,
      player1: { wallet: player1.wallet, username: player1.username, skin: p1Skin },
      player2: { wallet: player2.wallet, username: player2.username, skin: p2Skin },
      stakeAmount,
      useReadySystem: true,
    };
    io.to(player1.socketId).emit('game-countdown', countdownData);
    io.to(player2.socketId).emit('game-countdown', countdownData);

    game.startReadyPhase();
    return;
  }

  // PRODUCTION: build escrow transactions using custom stake amount
  let p1Tx, p2Tx;
  try {
    p1Tx = await buildCustomEscrowTransaction(player1.wallet, stakeAmount);
  } catch (err) {
    console.error('P1 escrow build failed:', err.message);
    io.to(player1.socketId).emit('match-error', { error: err.message });
    io.to(player2.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }
  try {
    p2Tx = await buildCustomEscrowTransaction(player2.wallet, stakeAmount);
  } catch (err) {
    console.error('P2 escrow build failed:', err.message);
    io.to(player2.socketId).emit('match-error', { error: err.message });
    io.to(player1.socketId).emit('match-error', { error: 'Opponent cannot stake. Match cancelled.' });
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });
    return;
  }

  pendingEscrow.set(gameId, {
    player1, player2, tier, stakeAmount,
    p1Escrowed: false, p2Escrowed: false,
  });

  io.to(player1.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player2.wallet, username: player2.username },
    tier,
    stake: stakeAmount,
    escrowTransaction: p1Tx.transaction,
    yourSlot: 'p1',
  });

  io.to(player2.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player1.wallet, username: player1.username },
    tier,
    stake: stakeAmount,
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

// ===========================================
// TOURNAMENT HELPERS
// ===========================================

function getTournamentList() {
  const list = [];
  for (const [tournamentId, t] of openTournaments) {
    if (t.status === 'waiting' || t.status === 'escrow' || t.status === 'in-progress') {
      list.push({
        tournamentId,
        creator: t.creator,
        creatorUsername: t.creatorUsername,
        maxPlayers: t.maxPlayers,
        currentPlayers: t.players.length,
        stakeAmount: t.stakeAmount,
        status: t.status,
        players: t.players.map(p => ({ wallet: p.wallet, username: p.username })),
        createdAt: t.createdAt,
      });
    }
  }
  return list;
}

function broadcastTournaments(io) {
  io.emit('tournament-update', { tournaments: getTournamentList() });
}

async function startTournamentEscrow(io, tournament, onlineUsers, activeGames) {
  tournament.status = 'escrow';
  await Tournament.findOneAndUpdate({ tournamentId: tournament.tournamentId }, { status: 'escrow' });
  broadcastTournaments(io);

  if (SKIP_ESCROW) {
    // Auto-confirm all players in dev mode
    tournament.players.forEach(p => { p.escrowed = true; });
    await Tournament.findOneAndUpdate({ tournamentId: tournament.tournamentId }, { players: tournament.players });
    tournament.players.forEach(p => {
      io.to(p.socketId).emit('tournament-escrow-status', { tournamentId: tournament.tournamentId, wallet: p.wallet, status: 'confirmed' });
    });
    // Start tournament directly after brief delay
    setTimeout(() => {
      startTournament(io, tournament, activeGames, onlineUsers);
    }, 1000);
    return;
  }

  // Build escrow transactions for each player
  for (const player of tournament.players) {
    try {
      const tx = await buildCustomEscrowTransaction(player.wallet, tournament.stakeAmount);
      io.to(player.socketId).emit('tournament-escrow-required', {
        tournamentId: tournament.tournamentId,
        escrowTransaction: tx.transaction,
        stakeAmount: tournament.stakeAmount,
      });
    } catch (err) {
      console.error(`Tournament escrow build failed for ${player.wallet}:`, err.message);
      io.to(player.socketId).emit('tournament-error', { error: 'Failed to build escrow transaction' });
    }
  }

  // 90s escrow timeout
  setTimeout(async () => {
    const t = openTournaments.get(tournament.tournamentId);
    if (!t || t.status !== 'escrow') return;

    // Cancel if not all escrowed
    if (!t.players.every(p => p.escrowed)) {
      await cancelTournamentWithRefunds(io, t);
    }
  }, 90000);
}

async function startTournament(io, tournament, activeGames, onlineUsers) {
  tournament.status = 'in-progress';
  tournament.startedAt = new Date();
  tournament.totalPot = tournament.stakeAmount * tournament.players.length;

  // Shuffle players randomly for seeding
  const shuffled = [...tournament.players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.forEach((p, i) => { p.seed = i; });
  tournament.players = shuffled;

  // Generate bracket with byes
  const bracket = generateBracket(shuffled);
  tournament.bracket = bracket;
  tournament.currentRound = 0;

  await Tournament.findOneAndUpdate({ tournamentId: tournament.tournamentId }, {
    status: 'in-progress',
    startedAt: tournament.startedAt,
    totalPot: tournament.totalPot,
    players: tournament.players,
    bracket: tournament.bracket,
    currentRound: 0,
  });

  broadcastTournaments(io);

  // Notify all players
  tournament.players.forEach(p => {
    // Update socketId from onlineUsers
    const info = onlineUsers.get(p.wallet);
    if (info) p.socketId = info.socketId;

    io.to(p.socketId).emit('tournament-starting', {
      tournamentId: tournament.tournamentId,
      bracket: sanitizeBracket(tournament.bracket),
      players: tournament.players.map(pp => ({ wallet: pp.wallet, username: pp.username, seed: pp.seed })),
      currentRound: 0,
    });
  });

  // Process byes in round 0, then start actual matches
  processRoundByes(tournament);

  // Start round matches after a short delay
  setTimeout(() => {
    startRoundMatches(tournament, io, activeGames, onlineUsers);
  }, 3000);
}

/**
 * Generate single-elimination bracket with byes for non-power-of-2 counts.
 * Returns array of rounds, where each round is an array of match objects.
 */
function generateBracket(players) {
  const n = players.length;
  // Find next power of 2
  let bracketSize = 1;
  while (bracketSize < n) bracketSize *= 2;

  const totalRounds = Math.log2(bracketSize);
  const bracket = [];

  // Round 0: pair players, add byes where needed
  const numByes = bracketSize - n;
  const round0 = [];

  for (let i = 0; i < bracketSize / 2; i++) {
    const p1Index = i;
    const p2Index = bracketSize - 1 - i;

    const p1 = p1Index < n ? players[p1Index] : null;
    const p2 = p2Index < n ? players[p2Index] : null;

    if (p1 && p2) {
      round0.push({
        player1Wallet: p1.wallet,
        player2Wallet: p2.wallet,
        player1Username: p1.username,
        player2Username: p2.username,
        gameId: null,
        winner: null,
        status: 'pending',
      });
    } else if (p1 && !p2) {
      // p1 gets a bye
      round0.push({
        player1Wallet: p1.wallet,
        player2Wallet: null,
        player1Username: p1.username,
        player2Username: 'BYE',
        gameId: null,
        winner: p1.wallet,
        status: 'bye',
      });
    } else if (!p1 && p2) {
      // p2 gets a bye
      round0.push({
        player1Wallet: null,
        player2Wallet: p2.wallet,
        player1Username: 'BYE',
        player2Username: p2.username,
        gameId: null,
        winner: p2.wallet,
        status: 'bye',
      });
    }
  }
  bracket.push(round0);

  // Create empty slots for subsequent rounds
  for (let r = 1; r < totalRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r + 1);
    const round = [];
    for (let i = 0; i < matchesInRound; i++) {
      round.push({
        player1Wallet: null,
        player2Wallet: null,
        player1Username: null,
        player2Username: null,
        gameId: null,
        winner: null,
        status: 'pending',
      });
    }
    bracket.push(round);
  }

  return bracket;
}

function processRoundByes(tournament) {
  const round = tournament.bracket[tournament.currentRound];
  // Advance bye winners to next round
  round.forEach((match, matchIndex) => {
    if (match.status === 'bye' && match.winner) {
      advanceWinnerToNextRound(tournament, matchIndex, match.winner);
    }
  });
}

function advanceWinnerToNextRound(tournament, matchIndex, winnerWallet) {
  const nextRound = tournament.currentRound + 1;
  if (nextRound >= tournament.bracket.length) return; // was the final

  const nextMatchIndex = Math.floor(matchIndex / 2);
  const nextMatch = tournament.bracket[nextRound][nextMatchIndex];
  if (!nextMatch) return;

  const winnerPlayer = tournament.players.find(p => p.wallet === winnerWallet);
  const winnerUsername = winnerPlayer ? winnerPlayer.username : 'Unknown';

  if (matchIndex % 2 === 0) {
    nextMatch.player1Wallet = winnerWallet;
    nextMatch.player1Username = winnerUsername;
  } else {
    nextMatch.player2Wallet = winnerWallet;
    nextMatch.player2Username = winnerUsername;
  }
}

async function startRoundMatches(tournament, io, activeGames, onlineUsers) {
  const round = tournament.bracket[tournament.currentRound];
  const pendingMatches = round.filter(m => m.status === 'pending' && m.player1Wallet && m.player2Wallet);

  if (pendingMatches.length === 0) {
    // All matches in this round are done or byes — check if we can advance
    checkRoundComplete(tournament, io, activeGames, onlineUsers);
    return;
  }

  for (const match of pendingMatches) {
    await startTournamentMatch(tournament, match, io, activeGames, onlineUsers);
  }
}

async function startTournamentMatch(tournament, match, io, activeGames, onlineUsers) {
  const gameId = crypto.randomUUID();
  match.gameId = gameId;
  match.status = 'in-progress';

  const p1Info = onlineUsers.get(match.player1Wallet);
  const p2Info = onlineUsers.get(match.player2Wallet);

  if (!p1Info) {
    // p1 offline — p2 wins by forfeit
    match.winner = match.player2Wallet;
    match.status = 'completed';
    const matchIndex = tournament.bracket[tournament.currentRound].indexOf(match);
    advanceWinnerToNextRound(tournament, matchIndex, match.winner);
    await saveTournamentState(tournament);
    checkRoundComplete(tournament, io, activeGames, onlineUsers);
    return;
  }
  if (!p2Info) {
    match.winner = match.player1Wallet;
    match.status = 'completed';
    const matchIndex = tournament.bracket[tournament.currentRound].indexOf(match);
    advanceWinnerToNextRound(tournament, matchIndex, match.winner);
    await saveTournamentState(tournament);
    checkRoundComplete(tournament, io, activeGames, onlineUsers);
    return;
  }

  const p1 = { wallet: match.player1Wallet, username: match.player1Username, socketId: p1Info.socketId };
  const p2 = { wallet: match.player2Wallet, username: match.player2Username, socketId: p2Info.socketId };

  // Get skins
  const [p1Skin, p2Skin] = await Promise.all([getPlayerSkin(p1.wallet), getPlayerSkin(p2.wallet)]);
  p1.skin = p1Skin;
  p2.skin = p2Skin;

  // Create match record
  await Match.create({
    gameId,
    player1: p1.wallet,
    player2: p2.wallet,
    player1Username: p1.username,
    player2Username: p2.username,
    tier: 'tournament',
    stakeAmount: tournament.stakeAmount,
    tournamentId: tournament.tournamentId,
    status: 'in-progress',
  });

  const matchIndex = tournament.bracket[tournament.currentRound].indexOf(match);

  // Create PongEngine with skipPayout
  const game = new PongEngine(gameId, p1, p2, 'tournament', io, activeGames, tournament.stakeAmount, {
    skipPayout: true,
    tournamentId: tournament.tournamentId,
    onTournamentMatchEnd: (winnerWallet, completedGameId) => {
      handleTournamentMatchEnd(tournament, matchIndex, winnerWallet, io, activeGames, onlineUsers);
    },
  });
  activeGames.set(gameId, game);

  await saveTournamentState(tournament);

  // Broadcast bracket update
  broadcastBracketUpdate(tournament, io);

  // Emit game countdown to both players
  const countdownData = {
    gameId, seconds: 30, tier: 'tournament',
    player1: { wallet: p1.wallet, username: p1.username, skin: p1Skin },
    player2: { wallet: p2.wallet, username: p2.username, skin: p2Skin },
    stakeAmount: tournament.stakeAmount,
    useReadySystem: true,
    tournamentId: tournament.tournamentId,
    roundNumber: tournament.currentRound,
  };
  io.to(p1.socketId).emit('game-countdown', countdownData);
  io.to(p2.socketId).emit('game-countdown', countdownData);

  game.startReadyPhase();
}

async function handleTournamentMatchEnd(tournament, matchIndex, winnerWallet, io, activeGames, onlineUsers) {
  const round = tournament.bracket[tournament.currentRound];
  const match = round[matchIndex];

  match.winner = winnerWallet;
  match.status = 'completed';

  // Mark loser as eliminated
  const loserWallet = match.player1Wallet === winnerWallet ? match.player2Wallet : match.player1Wallet;
  const loserPlayer = tournament.players.find(p => p.wallet === loserWallet);
  if (loserPlayer) loserPlayer.eliminatedRound = tournament.currentRound;

  // Advance winner
  advanceWinnerToNextRound(tournament, matchIndex, winnerWallet);

  await saveTournamentState(tournament);
  broadcastBracketUpdate(tournament, io);

  // Notify winner they're advancing (if not finals)
  if (tournament.currentRound < tournament.bracket.length - 1) {
    const winnerInfo = onlineUsers.get(winnerWallet);
    if (winnerInfo) {
      io.to(winnerInfo.socketId).emit('tournament-waiting', {
        tournamentId: tournament.tournamentId,
        message: 'You won! Waiting for other matches to finish...',
      });
    }
  }

  checkRoundComplete(tournament, io, activeGames, onlineUsers);
}

function checkRoundComplete(tournament, io, activeGames, onlineUsers) {
  const round = tournament.bracket[tournament.currentRound];
  const allDone = round.every(m => m.status === 'completed' || m.status === 'bye');
  if (!allDone) return;

  // Check if this was the final round
  if (tournament.currentRound >= tournament.bracket.length - 1) {
    // Tournament complete!
    const finalMatch = round[0];
    finishTournament(tournament, finalMatch.winner, io);
    return;
  }

  // Advance to next round
  tournament.currentRound++;

  // Process any byes in the new round
  processRoundByes(tournament);

  broadcastBracketUpdate(tournament, io);

  // Notify players about next round
  tournament.players.forEach(p => {
    if (p.eliminatedRound != null) return;
    const info = onlineUsers.get(p.wallet);
    if (info) {
      io.to(info.socketId).emit('tournament-bracket-update', {
        tournamentId: tournament.tournamentId,
        bracket: sanitizeBracket(tournament.bracket),
        currentRound: tournament.currentRound,
      });
    }
  });

  // Start next round matches after 10s delay
  setTimeout(() => {
    saveTournamentState(tournament).then(() => {
      startRoundMatches(tournament, io, activeGames, onlineUsers);
    });
  }, 10000);
}

async function finishTournament(tournament, winnerWallet, io) {
  tournament.status = 'completed';
  tournament.winner = winnerWallet;
  tournament.completedAt = new Date();

  const winnerPlayer = tournament.players.find(p => p.wallet === winnerWallet);
  tournament.winnerUsername = winnerPlayer ? winnerPlayer.username : 'Unknown';

  let payoutResult = null;
  try {
    payoutResult = await payoutWinner(winnerWallet, tournament.totalPot);
    tournament.payoutTx = payoutResult.payoutTx;

    // Update winner earnings
    await User.findOneAndUpdate({ wallet: winnerWallet }, {
      $inc: { 'stats.totalEarnings': payoutResult.winnerShare },
    });
  } catch (err) {
    console.error('Tournament payout failed:', err.message);
  }

  await saveTournamentState(tournament);
  openTournaments.delete(tournament.tournamentId);
  broadcastTournaments(io);

  // Notify all players
  tournament.players.forEach(p => {
    const info = p.socketId;
    io.to(info).emit('tournament-complete', {
      tournamentId: tournament.tournamentId,
      winner: winnerWallet,
      winnerUsername: tournament.winnerUsername,
      totalPot: tournament.totalPot,
      payoutTx: payoutResult ? payoutResult.payoutTx : null,
      winnerShare: payoutResult ? payoutResult.winnerShare : 0,
      bracket: sanitizeBracket(tournament.bracket),
    });
  });

  console.log(`Tournament ${tournament.tournamentId} complete! Winner: ${tournament.winnerUsername} (${tournament.totalPot} pot)`);
}

async function cancelTournamentWithRefunds(io, tournament) {
  tournament.status = 'cancelled';
  await Tournament.findOneAndUpdate({ tournamentId: tournament.tournamentId }, { status: 'cancelled' });
  openTournaments.delete(tournament.tournamentId);

  // Refund escrowed players
  for (const p of tournament.players) {
    if (p.escrowed) {
      refundPlayer(p.wallet, tournament.stakeAmount).catch(err => {
        console.error(`Tournament refund failed for ${p.wallet}:`, err.message);
      });
    }
    io.to(p.socketId).emit('tournament-cancelled', {
      tournamentId: tournament.tournamentId,
      reason: 'Not all players escrowed in time. Refunds issued.',
    });
  }

  broadcastTournaments(io);
}

async function saveTournamentState(tournament) {
  await Tournament.findOneAndUpdate({ tournamentId: tournament.tournamentId }, {
    status: tournament.status,
    players: tournament.players,
    bracket: tournament.bracket,
    currentRound: tournament.currentRound,
    winner: tournament.winner,
    winnerUsername: tournament.winnerUsername,
    payoutTx: tournament.payoutTx,
    totalPot: tournament.totalPot,
    startedAt: tournament.startedAt,
    completedAt: tournament.completedAt,
  });
}

function sanitizeBracket(bracket) {
  return bracket.map(round => round.map(match => ({
    player1Wallet: match.player1Wallet,
    player2Wallet: match.player2Wallet,
    player1Username: match.player1Username,
    player2Username: match.player2Username,
    winner: match.winner,
    status: match.status,
    gameId: match.gameId,
  })));
}

function broadcastBracketUpdate(tournament, io) {
  tournament.players.forEach(p => {
    io.to(p.socketId).emit('tournament-bracket-update', {
      tournamentId: tournament.tournamentId,
      bracket: sanitizeBracket(tournament.bracket),
      currentRound: tournament.currentRound,
    });
  });
}

module.exports = { setupMatchmaking, openTournaments, queues, openLobbies };
