// ===========================================
// Pong Arena — Main Server
// ===========================================
// Run: npm install && node server.js
// Open: http://localhost:3000

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const friendRoutes = require('./routes/friends');
const shopRoutes = require('./routes/shop');
const { authMiddleware } = require('./middleware/auth');
const { setupMatchmaking } = require('./game/matchmaking');
const { PongEngine } = require('./game/PongEngine');
const { seedSkins } = require('./models/Skin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --------------- Middleware ---------------
app.set('trust proxy', 1); // trust Railway's reverse proxy
app.use(helmet({ contentSecurityPolicy: false })); // relaxed CSP for dev
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Rate limit API routes
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', apiLimiter);

// --------------- API Routes ---------------
app.use('/api/auth', authRoutes);
app.use('/api/profile', authMiddleware, profileRoutes);
app.use('/api/friends', authMiddleware, friendRoutes);
app.use('/api/shop', authMiddleware, shopRoutes);

// Practice mode
app.get('/practice', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'practice.html'));
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------- In-Memory State ---------------
// Tracks online users: wallet -> { socketId, username }
const onlineUsers = new Map();
// Active games: gameId -> PongEngine instance
const activeGames = new Map();

// --------------- Socket.io ---------------
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Client announces who they are after auth
  socket.on('register', ({ wallet, username }) => {
    if (!wallet) return;
    onlineUsers.set(wallet, { socketId: socket.id, username });
    socket.wallet = wallet;
    socket.username = username;
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  // --- Matchmaking ---
  setupMatchmaking(io, socket, onlineUsers, activeGames);

  // --- In-Game Paddle Input ---
  socket.on('paddle-move', ({ gameId, direction }) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    game.handleInput(socket.wallet, direction); // 'up' | 'down' | 'stop'
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    if (socket.wallet) {
      onlineUsers.delete(socket.wallet);
      io.emit('online-users', Array.from(onlineUsers.keys()));

      // Forfeit any active game
      for (const [gameId, game] of activeGames) {
        if (game.hasPlayer(socket.wallet)) {
          game.forfeit(socket.wallet);
          activeGames.delete(gameId);
        }
      }
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// --------------- MongoDB & Start ---------------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pong-arena';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await seedSkins(); // populate default skins
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Pong Arena running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
