// ===========================================
// Shop Routes — Crate-based skin shop
// ===========================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Skin = require('../models/Skin');
const Crate = require('../models/Crate');
const { buildSkinPurchaseTransaction, verifyEscrowTx, burnSkinRevenue, PONG_DECIMALS } = require('../solana/utils');

/**
 * GET /api/shop
 * Returns active crates grouped as { limited: [...], standard: [...] } + user inventory.
 */
router.get('/', async (req, res) => {
  try {
    const crates = await Crate.find({ active: true });
    const skins = await Skin.find({});
    const user = await User.findOne({ wallet: req.wallet }).select('skins equippedSkin');
    const ownedIds = user ? user.skins.map(s => s.skinId) : [];

    const cratesWithSkins = crates.map(c => {
      const crateSkins = skins.filter(s => s.crateId === c.crateId);
      const unownedCount = crateSkins.filter(s => !ownedIds.includes(s.skinId)).length;
      const rarityBreakdown = { common: 0, rare: 0, legendary: 0 };
      crateSkins.forEach(s => { rarityBreakdown[s.rarity]++; });

      return {
        ...c.toObject(),
        totalSkins: crateSkins.length,
        unownedCount,
        rarityBreakdown,
        allOwned: unownedCount === 0,
      };
    });

    const limited = cratesWithSkins.filter(c => c.limited);
    const standard = cratesWithSkins.filter(c => !c.limited);

    // Build inventory — owned skins with full data
    const inventory = skins
      .filter(s => ownedIds.includes(s.skinId))
      .map(s => ({
        ...s.toObject(),
        equipped: user?.equippedSkin === s.skinId,
      }));

    res.json({ limited, standard, inventory, equippedSkin: user?.equippedSkin || 'default' });
  } catch (err) {
    console.error('Shop fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch shop' });
  }
});

/**
 * POST /api/shop/buy-crate
 * Step 1: Build Solana tx for crate price. Body: { crateId }
 */
router.post('/buy-crate', async (req, res) => {
  try {
    const { crateId } = req.body;
    if (!crateId) return res.status(400).json({ error: 'Missing crateId' });

    const crate = await Crate.findOne({ crateId, active: true });
    if (!crate) return res.status(404).json({ error: 'Crate not found or inactive' });

    // Check if user already owns all skins in this crate
    const crateSkins = await Skin.find({ crateId });
    const user = await User.findOne({ wallet: req.wallet });
    const ownedIds = user ? user.skins.map(s => s.skinId) : [];
    const unowned = crateSkins.filter(s => !ownedIds.includes(s.skinId));

    if (unowned.length === 0) {
      return res.status(400).json({ error: 'You already own all skins in this crate' });
    }

    const priceBaseUnits = crate.price * (10 ** PONG_DECIMALS);
    const { transaction } = await buildSkinPurchaseTransaction(req.wallet, priceBaseUnits);

    res.json({ transaction, crateId, price: priceBaseUnits });
  } catch (err) {
    console.error('Buy crate error:', err);
    res.status(500).json({ error: 'Failed to create purchase transaction' });
  }
});

/**
 * POST /api/shop/confirm-crate
 * Step 2: Verify tx, roll random skin from crate, grant to user.
 * Body: { crateId, txSignature }
 */
router.post('/confirm-crate', async (req, res) => {
  try {
    const { crateId, txSignature } = req.body;
    if (!crateId || !txSignature) {
      return res.status(400).json({ error: 'Missing crateId or txSignature' });
    }

    const crate = await Crate.findOne({ crateId });
    if (!crate) return res.status(404).json({ error: 'Crate not found' });

    // Verify on-chain
    const priceBaseUnits = crate.price * (10 ** PONG_DECIMALS);
    const verified = await verifyEscrowTx(txSignature, priceBaseUnits, req.wallet);
    if (!verified) {
      return res.status(400).json({ error: 'Transaction not confirmed on-chain' });
    }

    // Get unowned skins from this crate
    const crateSkins = await Skin.find({ crateId });
    const user = await User.findOne({ wallet: req.wallet });
    const ownedIds = user ? user.skins.map(s => s.skinId) : [];
    const unowned = crateSkins.filter(s => !ownedIds.includes(s.skinId));

    if (unowned.length === 0) {
      return res.status(400).json({ error: 'You already own all skins in this crate' });
    }

    // Weighted random by rarity
    const weights = { common: 70, rare: 25, legendary: 5 };
    const weighted = [];
    for (const skin of unowned) {
      const w = weights[skin.rarity] || 70;
      for (let i = 0; i < w; i++) weighted.push(skin);
    }
    const droppedSkin = weighted[Math.floor(Math.random() * weighted.length)];

    // Grant skin to user
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $push: { skins: { skinId: droppedSkin.skinId } } }
    );

    // Burn 90% of revenue in background
    burnSkinRevenue(priceBaseUnits).catch(err => {
      console.error('Crate burn failed:', err.message);
    });

    res.json({
      status: 'opened',
      skin: {
        skinId: droppedSkin.skinId,
        name: droppedSkin.name,
        description: droppedSkin.description,
        rarity: droppedSkin.rarity,
        type: droppedSkin.type,
        cssValue: droppedSkin.cssValue,
        imageUrl: droppedSkin.imageUrl,
      },
      crateSkins: crateSkins.map(s => ({
        skinId: s.skinId,
        name: s.name,
        rarity: s.rarity,
        type: s.type,
        cssValue: s.cssValue,
        imageUrl: s.imageUrl,
      }))
    });
  } catch (err) {
    console.error('Confirm crate error:', err);
    res.status(500).json({ error: 'Crate opening failed' });
  }
});

/**
 * POST /api/shop/equip
 * Equip an owned skin. Body: { skinId }
 */
router.post('/equip', async (req, res) => {
  try {
    const { skinId } = req.body;
    const user = await User.findOne({ wallet: req.wallet });

    // Allow 'default' or any owned skin
    if (skinId !== 'default' && !user.skins.some(s => s.skinId === skinId)) {
      return res.status(400).json({ error: 'Skin not owned' });
    }

    user.equippedSkin = skinId;
    await user.save();

    res.json({ status: 'equipped', skinId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to equip skin' });
  }
});

module.exports = router;
