// ===========================================
// Auth Routes — Wallet login + profile setup
// ===========================================

const express = require('express');
const router = express.Router();
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const User = require('../models/User');
const { seedSkins } = require('../models/Skin');

// Seed skins on first auth route load
seedSkins().catch(console.error);

/**
 * POST /api/auth/login
 * Body: { wallet, signature, timestamp }
 * Verifies wallet ownership. Returns user profile or indicates first-time user.
 */
router.post('/login', async (req, res) => {
  try {
    const { wallet, signature, timestamp } = req.body;

    if (!wallet || !signature || !timestamp) {
      return res.status(400).json({ error: 'Missing wallet, signature, or timestamp' });
    }

    // Verify signature
    const message = `PongArena:${wallet}:${timestamp}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(wallet);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Check if user exists
    const user = await User.findOne({ wallet });
    if (user) {
      return res.json({ status: 'existing', user });
    }

    // First-time user — needs to set up profile
    return res.json({ status: 'new', wallet });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/register
 * Body: { wallet, signature, timestamp, username, pfp, bio }
 * Creates a new user profile after wallet verification.
 */
router.post('/register', async (req, res) => {
  try {
    const { wallet, signature, timestamp, username, pfp, bio } = req.body;

    if (!wallet || !signature || !timestamp || !username) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify signature
    const message = `PongArena:${wallet}:${timestamp}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(wallet);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Validate username
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores' });
    }

    // Check duplicates
    const existing = await User.findOne({
      $or: [{ wallet }, { username: { $regex: new RegExp(`^${username}$`, 'i') } }]
    });
    if (existing) {
      if (existing.wallet === wallet) return res.status(400).json({ error: 'Wallet already registered' });
      return res.status(400).json({ error: 'Username taken' });
    }

    const user = await User.create({
      wallet,
      username,
      pfp: pfp || '',
      bio: bio || '',
    });

    res.json({ status: 'created', user });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Wallet or username already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

module.exports = router;
