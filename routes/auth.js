// ===========================================
// Auth Routes — Wallet login + profile setup
// ===========================================

const express = require('express');
const router = express.Router();
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const User = require('../models/User');
const { seedSkins } = require('../models/Skin');
const { createSession } = require('../middleware/auth');

// Seed skins on first auth route load
seedSkins().catch(console.error);

/**
 * Verify a wallet signature. Reused by login and register.
 */
function verifyWalletSignature(wallet, signature, timestamp) {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000) {
    return false; // 10 min window
  }
  const message = `PongArena:${wallet}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = bs58.decode(signature);
  const publicKeyBytes = bs58.decode(wallet);
  return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
}

/**
 * POST /api/auth/login
 * Body: { wallet, signature, timestamp }
 * Returns session token + user profile (or indicates first-time user).
 */
router.post('/login', async (req, res) => {
  try {
    const { wallet, signature, timestamp } = req.body;

    if (!wallet || !signature || !timestamp) {
      return res.status(400).json({ error: 'Missing wallet, signature, or timestamp' });
    }

    if (!verifyWalletSignature(wallet, signature, timestamp)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Check if user exists
    const user = await User.findOne({ wallet });
    if (user) {
      const token = await createSession(wallet);
      return res.json({ status: 'existing', user, token });
    }

    // First-time user — return a temp token so register doesn't need re-signing
    const token = await createSession(wallet);
    return res.json({ status: 'new', wallet, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/register
 * Body: { username, pfp, bio }
 * Requires: Authorization: Bearer <token> (from login)
 */
router.post('/register', async (req, res) => {
  try {
    const { signature, timestamp, handle, nickname, pfp, bio } = req.body;
    const handleVal = handle || req.body.username;
    const wallet = req.body.wallet;

    if (!wallet || !handleVal) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify via signature if provided, otherwise verify via session token
    if (signature && timestamp) {
      if (!verifyWalletSignature(wallet, signature, timestamp)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Validate handle
    if (handleVal.length < 3 || handleVal.length > 20) {
      return res.status(400).json({ error: 'Handle must be 3-20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(handleVal)) {
      return res.status(400).json({ error: 'Handle can only contain letters, numbers, underscores' });
    }

    // Check duplicates (handle and username are synced)
    const existing = await User.findOne({
      $or: [
        { wallet },
        { handle: { $regex: new RegExp(`^${handleVal}$`, 'i') } },
        { username: { $regex: new RegExp(`^${handleVal}$`, 'i') } },
      ]
    });
    if (existing) {
      if (existing.wallet === wallet) return res.status(400).json({ error: 'Wallet already registered' });
      return res.status(400).json({ error: 'Handle taken' });
    }

    const user = await User.create({
      wallet,
      username: handleVal,
      handle: handleVal,
      nickname: nickname || handleVal,
      pfp: pfp || '',
      bio: bio || '',
    });

    const token = await createSession(wallet);
    res.json({ status: 'created', user, token });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'unknown';
      console.error('Duplicate key on field:', field, 'value:', err.keyValue);
      return res.status(400).json({ error: `${field} already exists` });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

module.exports = router;
