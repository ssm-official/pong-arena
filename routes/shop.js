// ===========================================
// Shop Routes — Crate + Skin shop with layout
// ===========================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Skin = require('../models/Skin');
const Crate = require('../models/Crate');
const ShopLayout = require('../models/ShopLayout');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { buildSkinPurchaseTransaction, verifyEscrowTx, burnSkinRevenue, PONG_DECIMALS } = require('../solana/utils');

/**
 * GET /api/shop
 * Returns active crates grouped as { limited: [...], standard: [...] } + user inventory.
 * Works without auth (shows crates only), with auth also shows user inventory.
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const crates = await Crate.find({ active: true });
    const skins = await Skin.find({});
    console.log(`Shop: ${crates.length} active crates, ${skins.length} total skins`);

    // Try to get user data if wallet is available (auth succeeded)
    let user = null;
    if (req.wallet) {
      user = await User.findOne({ wallet: req.wallet }).select('skins equippedSkin ownedCrates');
    }
    const ownedIds = user ? user.skins.map(s => s.skinId) : [];

    const cratesWithSkins = crates.map(c => {
      const crateSkins = skins.filter(s => s.crateId === c.crateId);
      const unownedCount = crateSkins.filter(s => !ownedIds.includes(s.skinId)).length;
      const rarityBreakdown = { common: 0, uncommon: 0, rare: 0, super_rare: 0, legendary: 0, mythic: 0 };
      crateSkins.forEach(s => { if (rarityBreakdown[s.rarity] !== undefined) rarityBreakdown[s.rarity]++; });

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

    // Build owned crates count map
    const ownedCratesMap = {};
    if (user && user.ownedCrates) {
      user.ownedCrates.forEach(oc => {
        ownedCratesMap[oc.crateId] = (ownedCratesMap[oc.crateId] || 0) + 1;
      });
    }

    // Standalone skins (direct purchase, have a price set)
    const standaloneSkins = skins
      .filter(s => s.price != null)
      .map(s => ({
        ...s.toObject(),
        owned: ownedIds.includes(s.skinId),
      }));

    // Shop layout
    const layout = await ShopLayout.findOne({}) || { sections: [] };

    res.json({ limited, standard, skins: standaloneSkins, layout, inventory, equippedSkin: user?.equippedSkin || 'default', ownedCrates: ownedCratesMap });
  } catch (err) {
    console.error('Shop fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch shop' });
  }
});

/**
 * GET /api/shop/crate/:crateId/skins
 * Returns all possible skins in a crate with drop chances.
 */
router.get('/crate/:crateId/skins', async (req, res) => {
  try {
    const crate = await Crate.findOne({ crateId: req.params.crateId, active: true });
    if (!crate) return res.status(404).json({ error: 'Crate not found' });
    const skins = await Skin.find({ crateId: crate.crateId });
    const weights = { common: 70, uncommon: 50, rare: 25, super_rare: 12, legendary: 5, mythic: 2 };
    const rarityCounts = { common: 0, uncommon: 0, rare: 0, super_rare: 0, legendary: 0, mythic: 0 };
    skins.forEach(s => { if (rarityCounts[s.rarity] !== undefined) rarityCounts[s.rarity]++; });
    const skinsWithChance = skins.map(s => {
      const count = rarityCounts[s.rarity] || 1;
      const chance = (weights[s.rarity] || 70) / count;
      return { ...s.toObject(), chance: Math.round(chance * 100) / 100 };
    });
    res.json({ crate: { crateId: crate.crateId, name: crate.name }, skins: skinsWithChance });
  } catch (err) {
    console.error('Crate skins fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch crate skins' });
  }
});

/**
 * POST /api/shop/buy-crate
 * Step 1: Build Solana tx for crate price. Body: { crateId }
 */
router.post('/buy-crate', authMiddleware, async (req, res) => {
  try {
    const { crateId } = req.body;
    if (!crateId) return res.status(400).json({ error: 'Missing crateId' });

    const crate = await Crate.findOne({ crateId, active: true });
    if (!crate) return res.status(404).json({ error: 'Crate not found or inactive' });

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
 * Step 2: Verify tx, add crate to user's inventory.
 * Body: { crateId, txSignature }
 */
router.post('/confirm-crate', authMiddleware, async (req, res) => {
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

    // Add crate to user inventory
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $push: { ownedCrates: { crateId } } }
    );

    // Burn 90% of revenue in background
    burnSkinRevenue(priceBaseUnits).catch(err => {
      console.error('Crate burn failed:', err.message);
    });

    res.json({ status: 'purchased', crateId });
  } catch (err) {
    console.error('Confirm crate error:', err);
    res.status(500).json({ error: 'Crate purchase failed' });
  }
});

/**
 * POST /api/shop/open-crate
 * Open a crate from user's inventory. Rolls random skin, removes crate.
 * Body: { crateId }
 */
router.post('/open-crate', authMiddleware, async (req, res) => {
  try {
    const { crateId } = req.body;
    if (!crateId) return res.status(400).json({ error: 'Missing crateId' });

    const user = await User.findOne({ wallet: req.wallet });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check user owns this crate
    const crateIndex = user.ownedCrates.findIndex(oc => oc.crateId === crateId);
    if (crateIndex === -1) {
      return res.status(400).json({ error: 'You don\'t own this crate' });
    }

    // Roll from ALL skins in this crate
    const crateSkins = await Skin.find({ crateId });
    if (crateSkins.length === 0) {
      return res.status(400).json({ error: 'Crate has no skins' });
    }

    const ownedIds = user.skins.map(s => s.skinId);

    // Weighted random by rarity
    const weights = { common: 70, uncommon: 50, rare: 25, super_rare: 12, legendary: 5, mythic: 2 };
    const weighted = [];
    for (const skin of crateSkins) {
      const w = weights[skin.rarity] || 70;
      for (let i = 0; i < w; i++) weighted.push(skin);
    }
    const droppedSkin = weighted[Math.floor(Math.random() * weighted.length)];

    // Grant skin + remove crate atomically using findOneAndUpdate
    const alreadyOwned = ownedIds.includes(droppedSkin.skinId);
    const updateOps = {
      $pull: { ownedCrates: { _id: user.ownedCrates[crateIndex]._id } },
    };
    if (!alreadyOwned) {
      updateOps.$push = { skins: { skinId: droppedSkin.skinId } };
    }
    await User.findOneAndUpdate({ wallet: req.wallet }, updateOps);

    res.json({
      status: 'opened',
      duplicate: alreadyOwned,
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
    console.error('Open crate error:', err);
    res.status(500).json({ error: 'Crate opening failed: ' + err.message });
  }
});

/**
 * POST /api/shop/equip
 * Equip an owned skin. Body: { skinId }
 */
router.post('/equip', authMiddleware, async (req, res) => {
  try {
    const { skinId } = req.body;
    if (!skinId) return res.status(400).json({ error: 'Missing skinId' });

    const user = await User.findOne({ wallet: req.wallet }).select('skins equippedSkin');
    if (!user) return res.status(404).json({ error: 'User not found. Please reconnect wallet.' });

    if (skinId !== 'default' && !user.skins.some(s => s.skinId === skinId)) {
      return res.status(400).json({ error: 'You don\'t own this skin' });
    }

    await User.findOneAndUpdate({ wallet: req.wallet }, { equippedSkin: skinId });
    res.json({ status: 'equipped', skinId });
  } catch (err) {
    console.error('Equip error:', err.message);
    res.status(500).json({ error: 'Failed to equip skin: ' + err.message });
  }
});


/**
 * GET /api/shop/layout
 * Returns just the shop layout (for non-auth browsing).
 */
router.get('/layout', async (req, res) => {
  try {
    const layout = await ShopLayout.findOne({}) || { sections: [] };
    res.json({ layout });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch layout' });
  }
});

/**
 * POST /api/shop/buy-skin
 * Direct skin purchase. Body: { skinId }
 */
router.post('/buy-skin', authMiddleware, async (req, res) => {
  try {
    const { skinId } = req.body;
    if (!skinId) return res.status(400).json({ error: 'Missing skinId' });

    const skin = await Skin.findOne({ skinId });
    if (!skin) return res.status(404).json({ error: 'Skin not found' });
    if (skin.price == null) return res.status(400).json({ error: 'Skin is not available for direct purchase' });

    // Check not already owned
    const user = await User.findOne({ wallet: req.wallet }).select('skins');
    if (user && user.skins.some(s => s.skinId === skinId)) {
      return res.status(400).json({ error: 'You already own this skin' });
    }

    // Price is in USD cents — convert to PONG display units
    // For now, use price field directly as PONG display units (admin sets PONG price)
    const pongPrice = skin.price;
    const priceBaseUnits = pongPrice * (10 ** PONG_DECIMALS);
    const { transaction } = await buildSkinPurchaseTransaction(req.wallet, priceBaseUnits);

    res.json({ transaction, skinId, price: priceBaseUnits });
  } catch (err) {
    console.error('Buy skin error:', err);
    res.status(500).json({ error: 'Failed to create purchase transaction' });
  }
});

/**
 * POST /api/shop/confirm-skin
 * Verify on-chain, grant skin. Body: { skinId, txSignature }
 */
router.post('/confirm-skin', authMiddleware, async (req, res) => {
  try {
    const { skinId, txSignature } = req.body;
    if (!skinId || !txSignature) {
      return res.status(400).json({ error: 'Missing skinId or txSignature' });
    }

    const skin = await Skin.findOne({ skinId });
    if (!skin || skin.price == null) return res.status(404).json({ error: 'Skin not found' });

    const pongPrice = skin.price;
    const priceBaseUnits = pongPrice * (10 ** PONG_DECIMALS);
    const verified = await verifyEscrowTx(txSignature, priceBaseUnits, req.wallet);
    if (!verified) {
      return res.status(400).json({ error: 'Transaction not confirmed on-chain' });
    }

    // Grant skin
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $push: { skins: { skinId } } }
    );

    // Burn 90% of revenue
    burnSkinRevenue(priceBaseUnits).catch(err => {
      console.error('Skin burn failed:', err.message);
    });

    res.json({ status: 'purchased', skinId });
  } catch (err) {
    console.error('Confirm skin error:', err);
    res.status(500).json({ error: 'Skin purchase failed' });
  }
});

module.exports = router;
