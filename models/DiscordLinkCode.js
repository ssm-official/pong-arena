const mongoose = require('mongoose');

const discordLinkCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  wallet: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Auto-delete after 5 minutes
discordLinkCodeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

module.exports = mongoose.model('DiscordLinkCode', discordLinkCodeSchema);
