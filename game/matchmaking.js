// ===========================================
// Matchmaking — Tier-Based Queue System
// ===========================================

const { PongEngine } = require('./PongEngine');
const { STAKE_TIERS, buildEscrowTransaction, verifyEscrowTx, refundPlayer } = require('../solana/utils');
const Match = require('../models/Match');
const crypto = require('crypto');

// Skip on-chain escrow for testing (set SKIP_ESCROW=true in env)
const SKIP_ESCROW = process.env.SKIP_ESCROW === 'true';
if (SKIP_ESCROW) console.log('⚠ SKIP_ESCROW mode: games start without token escrow');

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

    // Tell both players this player is verifying
    const who = isP1 ? 'p1' : 'p2';
    io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'verifying' });
    io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'verifying' });

    // Verify tx on-chain
    console.log(`Verifying escrow tx for ${socket.wallet}: ${txSignature}`);
    const verified = await verifyEscrowTx(txSignature, STAKE_TIERS[pending.tier], socket.wallet);
    if (!verified) {
      io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'failed' });
      io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'failed' });
      return socket.emit('escrow-error', { error: 'Transaction failed on-chain. Make sure you have enough $PONG and SOL.' });
    }

    if (isP1) pending.p1Escrowed = true;
    if (isP2) pending.p2Escrowed = true;

    // Update match record
    const update = isP1
      ? { player1EscrowTx: txSignature }
      : { player2EscrowTx: txSignature };
    await Match.findOneAndUpdate({ gameId }, update);

    // Tell both players this player confirmed
    io.to(pending.player1.socketId).emit('escrow-status', { gameId, player: who, status: 'confirmed' });
    io.to(pending.player2.socketId).emit('escrow-status', { gameId, player: who, status: 'confirmed' });

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

      const countdownData = {
        gameId, seconds: 10, tier: pending.tier,
        player1: { wallet: pending.player1.wallet, username: pending.player1.username },
        player2: { wallet: pending.player2.wallet, username: pending.player2.username },
      };
      io.to(pending.player1.socketId).emit('game-countdown', countdownData);
      io.to(pending.player2.socketId).emit('game-countdown', countdownData);

      setTimeout(() => game.start(), 10000);
    }
  });

  // Player cancels pending escrow
  socket.on('escrow-cancel', async ({ gameId }) => {
    const pending = pendingEscrow.get(gameId);
    if (!pending) return;
    pendingEscrow.delete(gameId);
    await Match.findOneAndUpdate({ gameId }, { status: 'cancelled' });

    // If the other player already escrowed, refund them
    if (pending.p1Escrowed && socket.wallet !== pending.player1.wallet) {
      refundPlayer(pending.player1.wallet, STAKE_TIERS[pending.tier]).catch(err => {
        console.error('Refund P1 failed:', err.message);
      });
      io.to(pending.player1.socketId).emit('match-cancelled', { gameId, reason: 'Opponent cancelled. Your $PONG is being refunded.' });
    } else {
      io.to(pending.player1.socketId).emit('match-cancelled', { gameId, reason: 'Match cancelled' });
    }

    if (pending.p2Escrowed && socket.wallet !== pending.player2.wallet) {
      refundPlayer(pending.player2.wallet, STAKE_TIERS[pending.tier]).catch(err => {
        console.error('Refund P2 failed:', err.message);
      });
      io.to(pending.player2.socketId).emit('match-cancelled', { gameId, reason: 'Opponent cancelled. Your $PONG is being refunded.' });
    } else {
      io.to(pending.player2.socketId).emit('match-cancelled', { gameId, reason: 'Match cancelled' });
    }
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
    status: SKIP_ESCROW ? 'in-progress' : 'pending-escrow'
  });

  // --- DEV MODE: skip escrow, start game immediately ---
  if (SKIP_ESCROW) {
    const game = new PongEngine(gameId, player1, player2, tier, io, activeGames);
    activeGames.set(gameId, game);

    const countdownData = {
      gameId, seconds: 10, tier,
      player1: { wallet: player1.wallet, username: player1.username },
      player2: { wallet: player2.wallet, username: player2.username },
    };
    io.to(player1.socketId).emit('game-countdown', countdownData);
    io.to(player2.socketId).emit('game-countdown', countdownData);

    setTimeout(() => game.start(), 10000);
    return;
  }

  // --- PRODUCTION: build escrow transactions ---
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
