// ===========================================
// Admin Routes — Password-protected CRUD for crates & skins
// ===========================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const Crate = require('../models/Crate');
const Skin = require('../models/Skin');
const ShopLayout = require('../models/ShopLayout');

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
    const { name, description, price, imageColor, limited, crateType } = req.body;
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
      crateType: crateType || 'skin',
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
    const { name, description, price, imageColor, limited, active, crateType } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (price !== undefined) update.price = Number(price);
    if (imageColor !== undefined) update.imageColor = imageColor;
    if (limited !== undefined) update.limited = !!limited;
    if (active !== undefined) update.active = !!active;
    if (crateType !== undefined) update.crateType = crateType;

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
    const { name, description, rarity, crateId, type, price } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Verify crate exists if provided
    if (crateId) {
      const crate = await Crate.findOne({ crateId });
      if (!crate) return res.status(404).json({ error: 'Crate not found' });
    }

    const skinId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      + '-' + crypto.randomBytes(3).toString('hex');

    const skinData = {
      skinId,
      name,
      description: description || '',
      rarity: rarity || 'common',
      crateId: crateId || null,
      type: type || (req.file ? 'image' : 'color'),
    };

    if (price !== undefined && price !== '' && price !== null) {
      skinData.price = Number(price);
    }

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
    if (req.body.crateId !== undefined) update.crateId = req.body.crateId || null;
    if (req.body.price !== undefined) update.price = req.body.price !== '' && req.body.price !== null ? Number(req.body.price) : null;

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

// ===========================================
// Shop Layout CRUD
// ===========================================

// GET /api/admin/shop-layout — get current layout
router.get('/shop-layout', adminAuth, async (req, res) => {
  try {
    const layout = await ShopLayout.findOne({}) || { sections: [] };
    res.json({ layout });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shop layout' });
  }
});

// PUT /api/admin/shop-layout — save entire layout (canvas elements or legacy sections)
router.put('/shop-layout', adminAuth, async (req, res) => {
  try {
    const { sections, elements, canvasHeight } = req.body;

    // Canvas mode: elements array provided
    if (Array.isArray(elements)) {
      const layout = await ShopLayout.findOneAndUpdate(
        {},
        { elements, canvasHeight: canvasHeight || 800, sections: [], updatedAt: new Date() },
        { upsert: true, new: true }
      );
      return res.json({ layout });
    }

    // Legacy mode: sections array
    if (!Array.isArray(sections)) {
      return res.status(400).json({ error: 'elements or sections must be an array' });
    }

    const layout = await ShopLayout.findOneAndUpdate(
      {},
      { sections, elements: [], updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ layout });
  } catch (err) {
    console.error('Save layout error:', err);
    res.status(500).json({ error: 'Failed to save shop layout' });
  }
});

// POST /api/admin/upload-banner — upload banner image, return base64 data URL
router.post('/upload-banner', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const dataUrl = toDataUrl(req.file);
    res.json({ imageUrl: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload banner' });
  }
});

// GET /api/admin/all-skins — list all skins (for item picker)
router.get('/all-skins', adminAuth, async (req, res) => {
  try {
    const skins = await Skin.find({}).sort({ name: 1 });
    res.json({ skins });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch skins' });
  }
});

// ===========================================
// Database Backup & Restore
// ===========================================

const { getConfig, setConfig } = require('../models/ServerConfig');

// ===========================================
// Server Config (Maintenance Mode)
// ===========================================

// GET /api/admin/server-config — get maintenance mode + allowed wallets
router.get('/server-config', adminAuth, async (req, res) => {
  try {
    const maintenanceMode = (await getConfig('maintenanceMode')) === 'true';
    const allowedWallets = (await getConfig('allowedWallets')) || '';
    res.json({ maintenanceMode, allowedWallets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch server config' });
  }
});

// PUT /api/admin/server-config — toggle maintenance mode, update allowed wallets
router.put('/server-config', adminAuth, async (req, res) => {
  try {
    const { maintenanceMode, allowedWallets } = req.body;
    if (maintenanceMode !== undefined) {
      await setConfig('maintenanceMode', String(!!maintenanceMode));
    }
    if (allowedWallets !== undefined) {
      await setConfig('allowedWallets', String(allowedWallets));
    }
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update server config' });
  }
});

const User = require('../models/User');
const Match = require('../models/Match');
const Message = require('../models/Message');
const { Stats } = require('../models/Stats');

// GET /api/admin/backup — download full database as JSON
router.get('/backup', adminAuth, async (req, res) => {
  try {
    const backup = {
      _meta: { version: 1, date: new Date().toISOString(), collections: 7 },
      users: await User.find({}).lean(),
      crates: await Crate.find({}).lean(),
      skins: await Skin.find({}).lean(),
      matches: await Match.find({}).lean(),
      messages: await Message.find({}).lean(),
      shopLayouts: await ShopLayout.find({}).lean(),
      stats: await Stats.find({}).lean(),
    };
    const filename = `pong-arena-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// POST /api/admin/restore — restore database from backup JSON
router.post('/restore', adminAuth, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const data = req.body;
    if (!data._meta || !data.users) {
      return res.status(400).json({ error: 'Invalid backup format' });
    }
    const results = {};
    if (data.users?.length) {
      await User.deleteMany({});
      results.users = (await User.insertMany(data.users, { ordered: false }).catch(e => [])).length;
    }
    if (data.crates?.length) {
      await Crate.deleteMany({});
      results.crates = (await Crate.insertMany(data.crates, { ordered: false }).catch(e => [])).length;
    }
    if (data.skins?.length) {
      await Skin.deleteMany({});
      results.skins = (await Skin.insertMany(data.skins, { ordered: false }).catch(e => [])).length;
    }
    if (data.matches?.length) {
      await Match.deleteMany({});
      results.matches = (await Match.insertMany(data.matches, { ordered: false }).catch(e => [])).length;
    }
    if (data.messages?.length) {
      await Message.deleteMany({});
      results.messages = (await Message.insertMany(data.messages, { ordered: false }).catch(e => [])).length;
    }
    if (data.shopLayouts?.length) {
      await ShopLayout.deleteMany({});
      results.shopLayouts = (await ShopLayout.insertMany(data.shopLayouts, { ordered: false }).catch(e => [])).length;
    }
    if (data.stats?.length) {
      await Stats.deleteMany({});
      results.stats = (await Stats.insertMany(data.stats, { ordered: false }).catch(e => [])).length;
    }
    res.json({ status: 'restored', results });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

module.exports = router;
