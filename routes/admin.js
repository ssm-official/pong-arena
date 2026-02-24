// ===========================================
// Admin Routes — Password-protected CRUD for crates & skins
// ===========================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const Crate = require('../models/Crate');
const Skin = require('../models/Skin');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'P0ngAr3naAdm1n!2024';

// Multer config — use memory storage so it works on serverless (Vercel).
// Uploaded images are converted to base64 data URLs and stored in MongoDB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only SVG, PNG, JPEG, and WebP files are allowed'));
    }
  }
});

/** Convert multer file buffer to a base64 data URL */
function toDataUrl(file) {
  const mime = file.mimetype || 'image/png';
  const base64 = file.buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

// --- Middleware: check admin password ---
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

// POST /api/admin/login — validate password
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ status: 'ok' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// GET /api/admin/crates — list all crates with their skins
router.get('/crates', adminAuth, async (req, res) => {
  try {
    const crates = await Crate.find({}).sort({ createdAt: -1 });
    const skins = await Skin.find({});

    const cratesWithSkins = crates.map(c => ({
      ...c.toObject(),
      skins: skins.filter(s => s.crateId === c.crateId),
    }));

    res.json({ crates: cratesWithSkins });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch crates' });
  }
});

// POST /api/admin/crate — create new crate
router.post('/crate', adminAuth, async (req, res) => {
  try {
    const { name, description, price, imageColor, limited } = req.body;
    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const crateId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      + '-' + crypto.randomBytes(3).toString('hex');

    const crate = await Crate.create({
      crateId,
      name,
      description: description || '',
      price: Number(price),
      imageColor: imageColor || '#7c3aed',
      limited: !!limited,
      active: true,
    });

    res.json({ crate });
  } catch (err) {
    console.error('Create crate error:', err);
    res.status(500).json({ error: 'Failed to create crate' });
  }
});

// PUT /api/admin/crate/:crateId — update crate
router.put('/crate/:crateId', adminAuth, async (req, res) => {
  try {
    const { name, description, price, imageColor, limited, active } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (price !== undefined) update.price = Number(price);
    if (imageColor !== undefined) update.imageColor = imageColor;
    if (limited !== undefined) update.limited = !!limited;
    if (active !== undefined) update.active = !!active;

    const crate = await Crate.findOneAndUpdate(
      { crateId: req.params.crateId },
      update,
      { new: true }
    );

    if (!crate) return res.status(404).json({ error: 'Crate not found' });
    res.json({ crate });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update crate' });
  }
});

// DELETE /api/admin/crate/:crateId — delete crate + its skins
router.delete('/crate/:crateId', adminAuth, async (req, res) => {
  try {
    const { crateId } = req.params;
    await Skin.deleteMany({ crateId });
    await Crate.findOneAndDelete({ crateId });
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete crate' });
  }
});

// POST /api/admin/skin — create skin with PNG upload
router.post('/skin', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, description, rarity, crateId, type } = req.body;
    if (!name || !crateId) {
      return res.status(400).json({ error: 'Name and crateId are required' });
    }

    // Verify crate exists
    const crate = await Crate.findOne({ crateId });
    if (!crate) return res.status(404).json({ error: 'Crate not found' });

    const skinId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      + '-' + crypto.randomBytes(3).toString('hex');

    const skinData = {
      skinId,
      name,
      description: description || '',
      rarity: rarity || 'common',
      crateId,
      type: type || (req.file ? 'image' : 'color'),
    };

    if (req.file) {
      skinData.imageUrl = toDataUrl(req.file);
      skinData.type = 'image';
    }

    if (req.body.cssValue) {
      skinData.cssValue = req.body.cssValue;
    }

    const skin = await Skin.create(skinData);
    res.json({ skin });
  } catch (err) {
    console.error('Create skin error:', err);
    res.status(500).json({ error: 'Failed to create skin' });
  }
});

// PUT /api/admin/skin/:skinId — update skin (name, description, rarity, image, cssValue)
router.put('/skin/:skinId', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const skin = await Skin.findOne({ skinId: req.params.skinId });
    if (!skin) return res.status(404).json({ error: 'Skin not found' });

    const update = {};
    if (req.body.name !== undefined) update.name = req.body.name;
    if (req.body.description !== undefined) update.description = req.body.description;
    if (req.body.rarity !== undefined) update.rarity = req.body.rarity;
    if (req.body.type !== undefined) update.type = req.body.type;
    if (req.body.cssValue !== undefined) update.cssValue = req.body.cssValue;
    if (req.body.crateId !== undefined) update.crateId = req.body.crateId;

    // If a new image was uploaded, store as base64 data URL
    if (req.file) {
      update.imageUrl = toDataUrl(req.file);
      update.type = 'image';
    }

    const updated = await Skin.findOneAndUpdate(
      { skinId: req.params.skinId },
      { $set: update },
      { new: true }
    );

    res.json({ skin: updated });
  } catch (err) {
    console.error('Update skin error:', err);
    res.status(500).json({ error: 'Failed to update skin' });
  }
});

// DELETE /api/admin/skin/:skinId — delete skin
router.delete('/skin/:skinId', adminAuth, async (req, res) => {
  try {
    const skin = await Skin.findOneAndDelete({ skinId: req.params.skinId });
    if (!skin) return res.status(404).json({ error: 'Skin not found' });
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete skin' });
  }
});

module.exports = router;
