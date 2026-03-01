// ===========================================
// Auth Middleware — Session token based
// ===========================================
// User signs ONE message on login → gets a session token.
// All subsequent requests use: Authorization: Bearer <token>
// Sessions stored in MongoDB so they survive server restarts.

const crypto = require('crypto');
const mongoose = require('mongoose');

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// MongoDB session model
const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  wallet: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // TTL index: auto-delete after 24h
});
const Session = mongoose.model('Session', sessionSchema);

/**
 * Create a session for a verified wallet. Returns the token.
 */
async function createSession(wallet) {
  // Remove any existing sessions for this wallet
  await Session.deleteMany({ wallet });
  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({ token, wallet });
  return token;
}

/**
 * Middleware: verify session token from Authorization header.
 * Expects: Authorization: Bearer <token>
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Invalid session token' });
  }

  try {
    const session = await Session.findOne({ token });
    if (!session) {
      return res.status(401).json({ error: 'Invalid session. Please reconnect wallet.' });
    }

    // Check expiry
    if (Date.now() - session.createdAt.getTime() > SESSION_TTL) {
      await Session.deleteOne({ token });
      return res.status(401).json({ error: 'Session expired. Please reconnect wallet.' });
    }

    req.wallet = session.wallet;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

/**
 * Optional auth — sets req.wallet if valid token, but never rejects the request.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.slice(7);
  if (!token || token === 'null' || token === 'undefined') return next();

  try {
    const session = await Session.findOne({ token });
    if (session && (Date.now() - session.createdAt.getTime() <= SESSION_TTL)) {
      req.wallet = session.wallet;
    }
  } catch (err) {
    // Silently continue without auth
  }
  next();
}

module.exports = { authMiddleware, optionalAuth, createSession };
