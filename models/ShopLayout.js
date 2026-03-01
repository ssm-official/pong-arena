const mongoose = require('mongoose');

const shopLayoutSchema = new mongoose.Schema({
  sections: [{
    id: String,
    title: String,
    type: { type: String, enum: ['featured', 'grid', 'banner'], default: 'grid' },
    bannerImage: { type: String, default: null },
    items: [{
      id: String,
      itemType: { type: String, enum: ['skin', 'crate'] },
      itemId: String,
      size: { type: String, enum: ['small', 'medium', 'large'], default: 'medium' },
      order: { type: Number, default: 0 },
    }],
    order: { type: Number, default: 0 },
  }],
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ShopLayout', shopLayoutSchema);
