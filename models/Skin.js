const mongoose = require('mongoose');

const skinSchema = new mongoose.Schema({
  skinId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  rarity: { type: String, enum: ['common', 'rare', 'legendary'], default: 'common' },
  type: { type: String, enum: ['color', 'image'], default: 'color' },
  cssValue: String,       // hex color for type:'color'
  imageUrl: String,       // path like /skins/golden-warrior.png for type:'image'
  crateId: { type: String, required: true },  // links to parent Crate
});

module.exports = mongoose.model('Skin', skinSchema);

// --- Seed starter crates + skins (called once on first run) ---
module.exports.seedSkins = async () => {
  const Crate = require('./Crate');
  const Skin = mongoose.model('Skin');

  const crateCount = await Crate.countDocuments();
  if (crateCount > 0) return; // already seeded

  try {

  // --- Create 3 starter crates ---
  const starterCrate = await Crate.create({
    crateId: 'starter-crate',
    name: 'Starter Crate',
    description: 'A solid set of classic paddle colors.',
    price: 10000,
    imageColor: '#7c3aed',
    limited: false,
    active: true,
  });

  const neonCrate = await Crate.create({
    crateId: 'neon-crate',
    name: 'Neon Crate',
    description: 'Blindingly bright neon paddle colors.',
    price: 10000,
    imageColor: '#39ff14',
    limited: false,
    active: true,
  });

  const founderCrate = await Crate.create({
    crateId: 'founders-crate',
    name: "Limited: Founder's Crate",
    description: 'Exclusive colors for early supporters.',
    price: 10000,
    imageColor: '#f59e0b',
    limited: true,
    active: true,
  });

  // --- Seed skins into crates ---
  const skins = [
    // Starter Crate
    { skinId: 'starter-crimson', name: 'Crimson', description: 'Deep red paddle', rarity: 'common', type: 'color', cssValue: '#dc2626', crateId: 'starter-crate' },
    { skinId: 'starter-ocean', name: 'Ocean', description: 'Cool ocean blue', rarity: 'common', type: 'color', cssValue: '#0ea5e9', crateId: 'starter-crate' },
    { skinId: 'starter-forest', name: 'Forest', description: 'Natural green', rarity: 'common', type: 'color', cssValue: '#16a34a', crateId: 'starter-crate' },
    { skinId: 'starter-royal', name: 'Royal', description: 'Regal purple', rarity: 'common', type: 'color', cssValue: '#7c3aed', crateId: 'starter-crate' },
    { skinId: 'starter-hotpink', name: 'Hot Pink', description: 'Eye-catching pink', rarity: 'rare', type: 'color', cssValue: '#ec4899', crateId: 'starter-crate' },
    { skinId: 'starter-arctic', name: 'Arctic', description: 'Icy white-blue', rarity: 'rare', type: 'color', cssValue: '#e2e8f0', crateId: 'starter-crate' },

    // Neon Crate
    { skinId: 'neon-green', name: 'Neon Green', description: 'Radioactive glow', rarity: 'common', type: 'color', cssValue: '#39ff14', crateId: 'neon-crate' },
    { skinId: 'neon-pink', name: 'Neon Pink', description: 'Electric pink', rarity: 'common', type: 'color', cssValue: '#ff6ec7', crateId: 'neon-crate' },
    { skinId: 'neon-orange', name: 'Neon Orange', description: 'Blazing orange', rarity: 'common', type: 'color', cssValue: '#ff9100', crateId: 'neon-crate' },
    { skinId: 'neon-blue', name: 'Neon Blue', description: 'Cyan flash', rarity: 'common', type: 'color', cssValue: '#04d9ff', crateId: 'neon-crate' },
    { skinId: 'neon-yellow', name: 'Neon Yellow', description: 'Blinding yellow', rarity: 'rare', type: 'color', cssValue: '#fff700', crateId: 'neon-crate' },
    { skinId: 'neon-violet', name: 'Electric Violet', description: 'Vivid violet pulse', rarity: 'rare', type: 'color', cssValue: '#8b5cf6', crateId: 'neon-crate' },

    // Founder's Crate
    { skinId: 'founder-ember', name: 'Ember', description: 'Warm ember glow', rarity: 'common', type: 'color', cssValue: '#f97316', crateId: 'founders-crate' },
    { skinId: 'founder-frostbite', name: 'Frostbite', description: 'Freezing cyan', rarity: 'common', type: 'color', cssValue: '#22d3ee', crateId: 'founders-crate' },
    { skinId: 'founder-toxic', name: 'Toxic', description: 'Toxic lime', rarity: 'common', type: 'color', cssValue: '#84cc16', crateId: 'founders-crate' },
    { skinId: 'founder-shadow', name: 'Shadow', description: 'Dark as the void', rarity: 'rare', type: 'color', cssValue: '#1e1b4b', crateId: 'founders-crate' },
    { skinId: 'founder-platinum', name: 'Platinum', description: 'Ultra-rare platinum sheen', rarity: 'legendary', type: 'color', cssValue: '#94a3b8', crateId: 'founders-crate' },
  ];

  await Skin.insertMany(skins, { ordered: false }).catch(() => {});
  console.log('Seeded 3 starter crates with skins');

  } catch (err) {
    console.warn('Seed skipped (data may already exist):', err.message);
  }
};
