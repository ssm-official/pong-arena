// ===========================================
// Auth Middleware — Session token based
// ===========================================
// User signs ONE message on login → gets a session token.
// All subsequent requests use: Authorization: Bearer <token>
// Sessions stored in MongoDB so they survive server restarts.

const crypto = require('crypto');
const mongoose = require('mongoose');

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Lazy model — only created once, avoids duplicate model errors
let Session;
function getSessionModel() {
  if (Session) return Session;
  const schema = new mongoose.Schema({
    token: { type: String, required: true, unique: true },
    wallet: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  });
  schema.index({ token: 1 });
  schema.index({ wallet: 1 });
  schema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
  try {
    Session = mongoose.model('Session');
  } catch {
    Session = mongoose.model('Session', schema);
  }
  return Session;
}

/**
 * Create a session for a verified wallet. Returns the token.
 */
async function createSession(wallet) {
  const S = getSessionModel();
  await S.deleteMany({ wallet });
  const token = crypto.randomBytes(32).toString('hex');
  await S.create({ token, wallet });
  return token;
}

/**
 * Find session by token. Returns { wallet, createdAt } or null.
 */
async function findSession(token) {
  const S = getSessionModel();
  const session = await S.findOne({ token });
  if (!session) return null;
  if (Date.now() - session.createdAt.getTime() > SESSION_TTL) {
    await S.deleteOne({ token });
    return null;
  }
  return session;
}

/**
 * Express 4-safe async middleware wrapper.
 * Catches promise rejections and forwards them to next(err).
 */
function asyncMw(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Middleware: verify session token from Authorization header.
 */
const authMiddleware = asyncMw(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Invalid session token' });
  }

  const session = await findSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid session. Please reconnect wallet.' });
  }

  req.wallet = session.wallet;
  next();
});

/**
 * Optional auth — sets req.wallet if valid token, but never rejects.
 */
const optionalAuth = asyncMw(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.slice(7);
  if (!token || token === 'null' || token === 'undefined') return next();

  try {
    const session = await findSession(token);
    if (session) req.wallet = session.wallet;
  } catch {
    // Silently continue
  }
  next();
});

module.exports = { authMiddleware, optionalAuth, createSession };
