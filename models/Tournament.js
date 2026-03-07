const mongoose = require('mongoose');

const tournamentSchema = new mongoose.Schema({
  tournamentId: { type: String, required: true, unique: true },
  creator: { type: String, required: true },           // wallet
  creatorUsername: { type: String, required: true },
  maxPlayers: { type: Number, required: true, min: 2 }, // flexible, no max
  stakeAmount: { type: Number, required: true },         // per player, base units
  totalPot: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['waiting', 'escrow', 'in-progress', 'completed', 'cancelled'],
    default: 'waiting',
  },
  players: [{
    wallet: String,
    username: String,
    socketId: String,
    escrowTx: String,
    escrowed: { type: Boolean, default: false },
    seed: Number,
    eliminatedRound: { type: Number, default: null },
  }],
  // bracket[roundIndex] = array of match objects
  bracket: [[{
    player1Wallet: String,
    player2Wallet: String,
    player1Username: String,
    player2Username: String,
    gameId: String,
    winner: String,
    status: { type: String, enum: ['pending', 'bye', 'in-progress', 'completed'], default: 'pending' },
  }]],
  currentRound: { type: Number, default: 0 },
  winner: { type: String, default: null },
  winnerUsername: { type: String, default: null },
  payoutTx: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
});

module.exports = mongoose.model('Tournament', tournamentSchema);
