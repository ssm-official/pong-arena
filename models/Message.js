const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from: { type: String, required: true, index: true },      // sender wallet
  to: { type: String, required: true, index: true },        // recipient wallet
  text: { type: String, required: true, maxlength: 500 },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true }
});

// Compound index for conversation queries
messageSchema.index({ from: 1, to: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
