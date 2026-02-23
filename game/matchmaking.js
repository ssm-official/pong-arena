// ===========================================
// Matchmaking — Tier-Based Queue System
// ===========================================

const { PongEngine } = require('./PongEngine');
const { STAKE_TIERS, buildEscrowTransaction, verifyEscrowTx } = require('../solana/utils');
const Match = require('../models/Match');
const crypto = require('crypto');

// Queues per tier: { low: [player, ...], medium: [...], high: [...] }
const queues = { low: [], medium: [], high: [] };

// Pending matches waiting for escrow confirmation: gameId -> { player1, player2, escrow status }
const pendingEscrow = new Map();

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

    const player = {
      wallet: socket.wallet,
      username: socket.username || 'Anon',
      socketId: socket.id,
      tier
    };

    queues[tier].push(player);
    socket.emit('queue-joined', { tier, position: queues[tier].length });
    console.log(`${player.username} joined ${tier} queue (${queues[tier].length} in queue)`);

    // Check for match
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

    // Verify tx on-chain
    const verified = await verifyEscrowTx(txSignature, STAKE_TIERS[pending.tier], socket.wallet);
    if (!verified) {
      return socket.emit('escrow-error', { error: 'Transaction not confirmed' });
    }

    if (isP1) pending.p1Escrowed = true;
    if (isP2) pending.p2Escrowed = true;

    // Update match record
    const update = isP1
      ? { player1EscrowTx: txSignature }
      : { player2EscrowTx: txSignature };
    await Match.findOneAndUpdate({ gameId }, update);

    socket.emit('escrow-confirmed', { gameId });

    // If both players escrowed, start the game
    if (pending.p1Escrowed && pending.p2Escrowed) {
      pendingEscrow.delete(gameId);
      const game = new PongEngine(
        gameId,
        pending.player1,
        pending.player2,
        pending.tier,
        io,
        activeGames
      );
      activeGames.set(gameId, game);
      await Match.findOneAndUpdate({ gameId }, { status: 'in-progress' });

      // Short countdown before start
      io.to(pending.player1.socketId).emit('game-countdown', { gameId, seconds: 3 });
      io.to(pending.player2.socketId).emit('game-countdown', { gameId, seconds: 3 });

      setTimeout(() => game.start(), 3000);
    }
  });

  // Player cancels pending escrow
  socket.on('escrow-cancel', async ({ gameId }) => {
    const pending = pendingEscrow.get(gameId);
    if (!pending) return;
    pendingEscrow.delete(gameId);
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });

    io.to(pending.player1.socketId).emit('match-cancelled', { gameId, reason: 'Escrow cancelled' });
    io.to(pending.player2.socketId).emit('match-cancelled', { gameId, reason: 'Escrow cancelled' });
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    for (const tier of Object.keys(queues)) {
      queues[tier] = queues[tier].filter(p => p.wallet !== socket.wallet);
    }
  });
}

async function createMatch(io, player1, player2, tier, activeGames) {
  const gameId = crypto.randomUUID();

  // Create match record in DB
  await Match.create({
    gameId,
    player1: player1.wallet,
    player2: player2.wallet,
    player1Username: player1.username,
    player2Username: player2.username,
    tier,
    stakeAmount: STAKE_TIERS[tier],
    status: 'pending-escrow'
  });

  // Build escrow transactions for both players
  let p1Tx, p2Tx;
  try {
    p1Tx = await buildEscrowTransaction(player1.wallet, tier);
    p2Tx = await buildEscrowTransaction(player2.wallet, tier);
  } catch (err) {
    console.error('Failed to build escrow tx:', err.message, err.stack);
    io.to(player1.socketId).emit('match-error', { error: 'Failed to create escrow transaction' });
    io.to(player2.socketId).emit('match-error', { error: 'Failed to create escrow transaction' });
    return;
  }

  // Store pending match
  pendingEscrow.set(gameId, {
    player1, player2, tier,
    p1Escrowed: false, p2Escrowed: false,
  });

  // Notify both players they've been matched — send escrow tx to sign
  io.to(player1.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player2.wallet, username: player2.username },
    tier,
    stake: STAKE_TIERS[tier],
    escrowTransaction: p1Tx.transaction,
  });

  io.to(player2.socketId).emit('match-found', {
    gameId,
    opponent: { wallet: player1.wallet, username: player1.username },
    tier,
    stake: STAKE_TIERS[tier],
    escrowTransaction: p2Tx.transaction,
  });

  // Timeout: cancel if escrow not completed in 60 seconds
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
