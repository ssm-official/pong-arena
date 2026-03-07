const mongoose = require('mongoose');

const statsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
});

const Stats = mongoose.model('Stats', statsSchema);

/**
 * Increment a stat counter atomically.
 */
async function incrementStat(key, amount) {
  await Stats.findOneAndUpdate(
    { key },
    { $inc: { value: amount } },
    { upsert: true }
  );
}

/**
 * Get a stat value.
 */
async function getStat(key) {
  const doc = await Stats.findOne({ key });
  return doc ? doc.value : 0;
}

module.exports = { Stats, incrementStat, getStat };
