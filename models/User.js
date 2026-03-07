const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  wallet: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, minlength: 3, maxlength: 20 }, // legacy — same as handle
  handle: { type: String, unique: true, sparse: true, minlength: 3, maxlength: 20 },   // permanent @handle ($10 to change)
  nickname: { type: String, default: '' },      // free changeable display name
  pfp: { type: String, default: '' },           // profile pic URL
  banner: { type: String, default: '' },        // profile banner URL
  bio: { type: String, default: '', maxlength: 160 },
  discordId: { type: String, sparse: true, unique: true, index: true },
  friends: [{ type: String }],                  // array of wallet addresses
  friendRequests: [{                             // pending incoming requests
    from: String,                                // wallet address
    fromUsername: String,
    createdAt: { type: Date, default: Date.now }
  }],
  skins: [{                                      // owned cosmetic skins
    skinId: String,
    purchasedAt: { type: Date, default: Date.now }
  }],
  ownedCrates: [{                                 // purchased but unopened crates
    crateId: String,
    purchasedAt: { type: Date, default: Date.now }
  }],
  equippedSkin: { type: String, default: 'default' },
  stats: {
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 }  // in $PONG (lamports)
  },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Clean up stale indexes on startup (especially discordId null duplicates)
(async () => {
  try {
    // Drop the problematic discordId index if it exists, then let syncIndexes rebuild it
    const collection = User.collection;
    const indexes = await collection.indexes().catch(() => []);
    for (const idx of indexes) {
      if (idx.key && idx.key.discordId !== undefined && idx.name !== '_id_') {
        await collection.dropIndex(idx.name).catch(() => {});
      }
    }
    // Also clear any null discordId values so they don't conflict
    await User.updateMany({ discordId: null }, { $unset: { discordId: 1 } }).catch(() => {});
    await User.syncIndexes();
  } catch (err) {
    console.warn('User index cleanup:', err.message);
  }
})();

module.exports = User;
