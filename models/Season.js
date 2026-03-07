const mongoose = require('mongoose');

const seasonSchema = new mongoose.Schema({
  seasonNumber: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date },
  active: { type: Boolean, default: true },
  xpMultiplier: { type: Number, default: 1 },
  ranks: [{
    name: { type: String, required: true },
    minLevel: { type: Number, required: true },
    icon: { type: String, default: '' },
    color: { type: String, default: '#9ca3af' },
  }],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Season', seasonSchema);
