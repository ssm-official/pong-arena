// ===========================================
// Auth Middleware — Verify wallet signature
// ===========================================
// Clients sign a message containing their wallet + timestamp.
// We verify the signature matches the claimed wallet.

const nacl = require('tweetnacl');
const bs58 = require('bs58');
const User = require('../models/User');

/**
 * Expects header: Authorization: <wallet>:<signature>:<timestamp>
 * The signed message is: "PongArena:<wallet>:<timestamp>"
 * Signature is valid for 5 minutes.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const parts = authHeader.split(':');
  if (parts.length !== 3) {
    return res.status(401).json({ error: 'Invalid auth format. Expected wallet:signature:timestamp' });
  }

  const [wallet, signature, timestamp] = parts;

  // Check timestamp freshness (5 min window)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Auth token expired. Please re-sign.' });
  }

  // Verify signature
  const message = `PongArena:${wallet}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);

  try {
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(wallet);
    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  // Attach wallet to request
  req.wallet = wallet;
  next();
}

module.exports = { authMiddleware };
