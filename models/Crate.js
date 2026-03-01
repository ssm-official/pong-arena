const mongoose = require('mongoose');

const crateSchema = new mongoose.Schema({
  crateId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },      // in $PONG display units (e.g. 10000)
  imageColor: { type: String, default: '#7c3aed' }, // hex for UI card glow
  limited: { type: Boolean, default: false },
  crateType: { type: String, enum: ['skin', 'aura', 'mixed'], default: 'skin' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Crate', crateSchema);
