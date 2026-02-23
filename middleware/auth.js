// ===========================================
// Auth Middleware — Session token based
// ===========================================
// User signs ONE message on login → gets a session token.
// All subsequent requests use: Authorization: Bearer <token>
// No more Phantom popups on every click.

const crypto = require('crypto');

// In-memory session store: token -> { wallet, createdAt }
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create a session for a verified wallet. Returns the token.
 */
function createSession(wallet) {
  // Remove any existing session for this wallet
  for (const [token, session] of sessions) {
    if (session.wallet === wallet) sessions.delete(token);
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { wallet, createdAt: Date.now() });
  return token;
}

/**
 * Middleware: verify session token from Authorization header.
 * Expects: Authorization: Bearer <token>
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  const session = sessions.get(token);

  if (!session) {
    return res.status(401).json({ error: 'Invalid session. Please reconnect wallet.' });
  }

  // Check expiry
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired. Please reconnect wallet.' });
  }

  req.wallet = session.wallet;
  next();
}

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(token);
  }
}, 10 * 60 * 1000);

module.exports = { authMiddleware, createSession };
