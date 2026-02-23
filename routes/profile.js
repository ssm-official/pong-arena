// ===========================================
// Profile Routes — View + edit user profile
// ===========================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Match = require('../models/Match');

/**
 * GET /api/profile
 * Returns the authenticated user's profile.
 */
router.get('/', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.wallet });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * PUT /api/profile
 * Update username, pfp, bio, equippedSkin.
 */
router.put('/', async (req, res) => {
  try {
    const { username, pfp, bio, equippedSkin } = req.body;
    const updates = {};

    if (username !== undefined) {
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
      }
      // Check uniqueness
      const conflict = await User.findOne({
        username: { $regex: new RegExp(`^${username}$`, 'i') },
        wallet: { $ne: req.wallet }
      });
      if (conflict) return res.status(400).json({ error: 'Username taken' });
      updates.username = username;
    }

    if (pfp !== undefined) updates.pfp = pfp;
    if (bio !== undefined) {
      if (bio.length > 160) return res.status(400).json({ error: 'Bio max 160 characters' });
      updates.bio = bio;
    }
    if (equippedSkin !== undefined) updates.equippedSkin = equippedSkin;

    const user = await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $set: updates },
      { new: true }
    );

    res.json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Username taken' });
    res.status(500).json({ error: 'Update failed' });
  }
});

/**
 * GET /api/profile/history
 * Returns match history for the authenticated user.
 */
router.get('/history', async (req, res) => {
  try {
    const matches = await Match.find({
      $or: [{ player1: req.wallet }, { player2: req.wallet }],
      status: 'completed'
    })
    .sort({ completedAt: -1 })
    .limit(50);

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /api/profile/:wallet
 * View another user's public profile.
 */
router.get('/:wallet', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.params.wallet })
      .select('wallet username pfp bio stats equippedSkin createdAt');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
