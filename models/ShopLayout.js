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
      customIcon: { type: String, default: null },
      animation: { type: String, enum: ['none', 'glow', 'float', 'pulse', 'shimmer', 'fire'], default: 'none' },
    }],
    order: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
  }],
  canvasHeight: { type: Number, default: 800 },
  elements: [{
    id: String,
    type: { type: String, enum: ['text', 'image', 'skin', 'crate'] },
    x: Number, y: Number, w: Number, h: Number,
    zIndex: { type: Number, default: 0 },
    text: String,
    fontSize: Number,
    fontColor: String,
    fontWeight: String,
    textAlign: String,
    imageUrl: String,
    itemId: String,
    backgroundColor: String,
    borderRadius: Number,
    borderColor: String,
    opacity: Number,
    crateBackgroundImage: String,
    crateIconImage: String,
    crateShowIcon: { type: Boolean, default: true },
    crateTextColor: String,
    crateTextBg: String,
    crateFontSize: Number,
  }],
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ShopLayout', shopLayoutSchema);
