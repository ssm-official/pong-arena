// ===========================================
// Profile Routes — View + edit user profile
// ===========================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const User = require('../models/User');
const Match = require('../models/Match');

// Multer config — use memory storage so it works on serverless (Vercel).
// Uploaded images are converted to base64 data URLs and stored in MongoDB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

/** Convert multer file buffer to a base64 data URL */
function toDataUrl(file) {
  const mime = file.mimetype || 'image/png';
  const base64 = file.buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

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
 * POST /api/profile/upload-pfp
 * Upload a profile picture. Stored as base64 data URL in MongoDB.
 */
router.post('/upload-pfp', upload.single('pfp'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const pfpUrl = toDataUrl(req.file);
    await User.findOneAndUpdate({ wallet: req.wallet }, { $set: { pfp: pfpUrl } });
    res.json({ pfp: pfpUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

/**
 * POST /api/profile/upload-banner
 * Upload a profile banner. Stored as base64 data URL in MongoDB.
 */
router.post('/upload-banner', upload.single('banner'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bannerUrl = toDataUrl(req.file);
    await User.findOneAndUpdate({ wallet: req.wallet }, { $set: { banner: bannerUrl } });
    res.json({ banner: bannerUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

/**
 * GET /api/profile/:wallet
 * View another user's public profile.
 */
router.get('/:wallet', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.params.wallet })
      .select('wallet username pfp banner bio stats equippedSkin createdAt');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
