const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  wallet: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, minlength: 3, maxlength: 20 }, // legacy — same as handle
  handle: { type: String, unique: true, sparse: true, minlength: 3, maxlength: 20 },   // permanent @handle ($10 to change)
  nickname: { type: String, default: '' },      // free changeable display name
  pfp: { type: String, default: '' },           // profile pic URL
  banner: { type: String, default: '' },        // profile banner URL
  bio: { type: String, default: '', maxlength: 160 },
  discordId: { type: String, default: null, sparse: true, unique: true, index: true },
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

module.exports = mongoose.model('User', userSchema);
