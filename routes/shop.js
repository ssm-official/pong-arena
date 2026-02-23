// ===========================================
// Shop Routes — Buy and manage cosmetic skins
// ===========================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Skin = require('../models/Skin');
const { buildSkinPurchaseTransaction, verifyEscrowTx, burnSkinRevenue, PONG_DECIMALS } = require('../solana/utils');

/**
 * GET /api/shop
 * List all available skins.
 */
router.get('/', async (req, res) => {
  try {
    const skins = await Skin.find({});
    const user = await User.findOne({ wallet: req.wallet }).select('skins equippedSkin');
    const ownedIds = user ? user.skins.map(s => s.skinId) : [];

    const skinsWithOwnership = skins.map(s => ({
      ...s.toObject(),
      owned: ownedIds.includes(s.skinId),
      equipped: user?.equippedSkin === s.skinId
    }));

    res.json({ skins: skinsWithOwnership });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shop' });
  }
});

/**
 * POST /api/shop/buy
 * Step 1: Get a transaction to sign. Body: { skinId }
 * Returns serialized transaction for client to sign.
 */
router.post('/buy', async (req, res) => {
  try {
    const { skinId } = req.body;
    if (!skinId) return res.status(400).json({ error: 'Missing skinId' });

    const skin = await Skin.findOne({ skinId });
    if (!skin) return res.status(404).json({ error: 'Skin not found' });

    const user = await User.findOne({ wallet: req.wallet });
    if (user.skins.some(s => s.skinId === skinId)) {
      return res.status(400).json({ error: 'Already owned' });
    }

    // Build purchase transaction (player -> treasury)
    const priceBaseUnits = skin.price * (10 ** PONG_DECIMALS);
    const { transaction } = await buildSkinPurchaseTransaction(req.wallet, priceBaseUnits);

    res.json({ transaction, skinId, price: priceBaseUnits });
  } catch (err) {
    console.error('Shop buy error:', err);
    res.status(500).json({ error: 'Failed to create purchase transaction' });
  }
});

/**
 * POST /api/shop/confirm
 * Step 2: Confirm purchase after client signs & submits tx.
 * Body: { skinId, txSignature }
 */
router.post('/confirm', async (req, res) => {
  try {
    const { skinId, txSignature } = req.body;
    if (!skinId || !txSignature) {
      return res.status(400).json({ error: 'Missing skinId or txSignature' });
    }

    const skin = await Skin.findOne({ skinId });
    if (!skin) return res.status(404).json({ error: 'Skin not found' });

    // Verify on-chain
    const priceBaseUnits = skin.price * (10 ** PONG_DECIMALS);
    const verified = await verifyEscrowTx(txSignature, priceBaseUnits, req.wallet);
    if (!verified) {
      return res.status(400).json({ error: 'Transaction not confirmed on-chain' });
    }

    // Grant skin to user
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $push: { skins: { skinId } } }
    );

    // Burn 90% of revenue in background (don't block response)
    burnSkinRevenue(priceBaseUnits).catch(err => {
      console.error('Skin burn failed:', err.message);
    });

    res.json({ status: 'purchased', skinId });
  } catch (err) {
    console.error('Shop confirm error:', err);
    res.status(500).json({ error: 'Purchase confirmation failed' });
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
