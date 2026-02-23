const mongoose = require('mongoose');

const skinSchema = new mongoose.Schema({
  skinId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  category: { type: String, enum: ['paddle', 'ball', 'background'], required: true },
  price: { type: Number, required: true },  // in $PONG base units
  cssValue: String,                          // color/gradient for rendering
  rarity: { type: String, enum: ['common', 'rare', 'legendary'], default: 'common' }
});

module.exports = mongoose.model('Skin', skinSchema);

// --- Seed default skins (called once) ---
module.exports.seedSkins = async () => {
  const count = await mongoose.model('Skin').countDocuments();
  if (count > 0) return;

  const defaults = [
    { skinId: 'paddle-red', name: 'Crimson Paddle', category: 'paddle', price: 10, cssValue: '#ef4444', rarity: 'common', description: 'Classic red paddle' },
    { skinId: 'paddle-blue', name: 'Ocean Paddle', category: 'paddle', price: 10, cssValue: '#3b82f6', rarity: 'common', description: 'Cool blue paddle' },
    { skinId: 'paddle-gold', name: 'Golden Paddle', category: 'paddle', price: 50, cssValue: '#f59e0b', rarity: 'rare', description: 'Shiny gold paddle' },
    { skinId: 'paddle-neon', name: 'Neon Glow', category: 'paddle', price: 200, cssValue: '#a855f7', rarity: 'legendary', description: 'Glowing purple neon paddle' },
    { skinId: 'ball-fire', name: 'Fireball', category: 'ball', price: 25, cssValue: '#f97316', rarity: 'common', description: 'Blazing orange ball' },
    { skinId: 'ball-ice', name: 'Iceball', category: 'ball', price: 25, cssValue: '#06b6d4', rarity: 'common', description: 'Frozen cyan ball' },
    { skinId: 'ball-plasma', name: 'Plasma Orb', category: 'ball', price: 100, cssValue: '#ec4899', rarity: 'rare', description: 'Pulsing pink plasma' },
    { skinId: 'bg-midnight', name: 'Midnight', category: 'background', price: 30, cssValue: '#1e1b4b', rarity: 'common', description: 'Deep midnight blue arena' },
    { skinId: 'bg-sunset', name: 'Sunset Arena', category: 'background', price: 50, cssValue: '#7c2d12', rarity: 'rare', description: 'Warm sunset tones' },
    { skinId: 'bg-matrix', name: 'The Matrix', category: 'background', price: 150, cssValue: '#052e16', rarity: 'legendary', description: 'Digital green rain vibes' },
  ];

  await mongoose.model('Skin').insertMany(defaults, { ordered: false }).catch(() => {});
  console.log('Seeded default skins');
};
