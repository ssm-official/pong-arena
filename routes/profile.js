// ===========================================
// Profile Routes — View + edit user profile
// ===========================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const User = require('../models/User');
const Match = require('../models/Match');
const DiscordLinkCode = require('../models/DiscordLinkCode');
const Season = require('../models/Season');
const { calcLevel } = require('../game/PongEngine');

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
 * Update nickname, pfp, bio, equippedSkin.
 */
router.put('/', async (req, res) => {
  try {
    const { nickname, pfp, bio, equippedSkin } = req.body;
    const updates = {};

    // Nickname is free to change
    if (nickname !== undefined) {
      if (nickname.length < 1 || nickname.length > 20) {
        return res.status(400).json({ error: 'Nickname must be 1-20 characters' });
      }
      updates.nickname = nickname;
    }

    // Legacy: still accept username updates (syncs with handle)
    if (req.body.username !== undefined) {
      const username = req.body.username;
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
      }
      const conflict = await User.findOne({
        username: { $regex: new RegExp(`^${username}$`, 'i') },
        wallet: { $ne: req.wallet }
      });
      if (conflict) return res.status(400).json({ error: 'Username taken' });
      updates.username = username;
      updates.handle = username;
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
 * PUT /api/profile/handle
 * Change handle — costs $10 worth of $PONG (validated client-side via tx).
 * For now just validates and updates; payment enforced on client.
 */
router.put('/handle', async (req, res) => {
  try {
    const { handle } = req.body;
    if (!handle || handle.length < 3 || handle.length > 20) {
      return res.status(400).json({ error: 'Handle must be 3-20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
      return res.status(400).json({ error: 'Handle can only contain letters, numbers, underscores' });
    }
    const conflict = await User.findOne({
      handle: { $regex: new RegExp(`^${handle}$`, 'i') },
      wallet: { $ne: req.wallet }
    });
    if (conflict) return res.status(400).json({ error: 'Handle taken' });

    const user = await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $set: { handle, username: handle } },
      { new: true }
    );
    res.json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Handle taken' });
    res.status(500).json({ error: 'Handle update failed' });
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
    .limit(50)
    .lean();

    // Collect unique opponent wallets and batch-fetch their pfps
    const opponentWallets = new Set();
    for (const m of matches) {
      opponentWallets.add(m.player1 === req.wallet ? m.player2 : m.player1);
    }
    const users = await User.find(
      { wallet: { $in: [...opponentWallets] } },
      { wallet: 1, pfp: 1 }
    ).lean();
    const pfpMap = {};
    for (const u of users) pfpMap[u.wallet] = u.pfp || '';

    // Attach pfps to matches
    for (const m of matches) {
      m.player1Pfp = pfpMap[m.player1] || '';
      m.player2Pfp = pfpMap[m.player2] || '';
    }

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

// ===========================================
// Discord Linking
// ===========================================

/**
 * GET /api/profile/discord
 * Check if the authenticated user has a linked Discord account.
 */
router.get('/discord', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.wallet }).select('discordId');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ linked: !!user.discordId, discordId: user.discordId || undefined });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check Discord status' });
  }
});

/**
 * POST /api/profile/discord/generate-code
 * Generate a 6-character link code for Discord account linking.
 */
router.post('/discord/generate-code', async (req, res) => {
  try {
    // Delete any existing code for this wallet
    await DiscordLinkCode.deleteMany({ wallet: req.wallet });

    // Generate 6-char code from safe alphabet (no ambiguous chars)
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[bytes[i] % alphabet.length];
    }

    const doc = await DiscordLinkCode.create({ code, wallet: req.wallet });
    const expiresAt = new Date(doc.createdAt.getTime() + 300000); // 5 minutes

    res.json({ code, expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate link code' });
  }
});

/**
 * DELETE /api/profile/discord
 * Unlink Discord account from the authenticated user.
 */
router.delete('/discord', async (req, res) => {
  try {
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $set: { discordId: null } }
    );
    res.json({ unlinked: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlink Discord' });
  }
});

/**
 * GET /api/profile/:wallet
 * View another user's public profile.
 */
/**
 * GET /api/profile/season
 * Returns the currently active season info (public).
 */
router.get('/season', async (req, res) => {
  try {
    const season = await Season.findOne({ active: true });
    res.json({ season: season || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch season' });
  }
});

router.get('/:wallet', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.params.wallet })
      .select('wallet username handle nickname pfp banner bio stats equippedSkin createdAt');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Attach rank from active season
    const userObj = user.toObject();
    const season = await Season.findOne({ active: true });
    if (season && season.ranks && season.ranks.length > 0) {
      const sorted = [...season.ranks].sort((a, b) => b.minLevel - a.minLevel);
      const rank = sorted.find(r => (userObj.stats?.seasonLevel || 1) >= r.minLevel) || sorted[sorted.length - 1];
      userObj.rank = rank;
      userObj.seasonName = season.name;
    }

    res.json({ user: userObj });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
