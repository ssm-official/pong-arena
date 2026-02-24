const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  player1: { type: String, required: true },     // wallet
  player2: { type: String, required: true },
  player1Username: String,
  player2Username: String,
  tier: { type: String, enum: ['low', 'medium', 'high', 'duel'], required: true },
  stakeAmount: { type: Number, required: true },  // lamports of $PONG
  score: {
    player1: { type: Number, default: 0 },
    player2: { type: Number, default: 0 }
  },
  winner: { type: String, default: null },        // wallet of winner
  player1EscrowTx: String,                        // on-chain tx signature
  player2EscrowTx: String,
  payoutTx: String,                               // winner payout tx
  burnTx: String,                                 // burn tx
  status: {
    type: String,
    enum: ['pending-escrow', 'in-progress', 'completed', 'cancelled'],
    default: 'pending-escrow'
  },
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

module.exports = mongoose.model('Match', matchSchema);
