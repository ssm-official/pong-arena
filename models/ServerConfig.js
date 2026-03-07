const mongoose = require('mongoose');

const serverConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: '' },
});

const ServerConfig = mongoose.model('ServerConfig', serverConfigSchema);

async function getConfig(key) {
  const doc = await ServerConfig.findOne({ key });
  return doc ? doc.value : null;
}

async function setConfig(key, value) {
  await ServerConfig.findOneAndUpdate(
    { key },
    { value: String(value) },
    { upsert: true }
  );
}

module.exports = { ServerConfig, getConfig, setConfig };
