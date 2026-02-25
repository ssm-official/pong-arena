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
const adminRoutes = require('./routes/admin');
const leaderboardRoutes = require('./routes/leaderboard');
const { authMiddleware } = require('./middleware/auth');
const { setupMatchmaking } = require('./game/matchmaking');
const { PongEngine } = require('./game/PongEngine');
const { seedSkins } = require('./models/Skin');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --------------- Middleware ---------------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
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
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', apiLimiter);

// --------------- API Routes ---------------
app.use('/api/auth', authRoutes);
app.use('/api/profile', authMiddleware, profileRoutes);
app.use('/api/friends', authMiddleware, friendRoutes);
app.use('/api/shop', authMiddleware, shopRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Stats: total burned $PONG (from match payouts)
const Match = require('./models/Match');
app.get('/api/stats/burned', async (req, res) => {
  try {
    const result = await Match.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, totalStaked: { $sum: '$stakeAmount' } } }
    ]);
    // Each match: both players stake stakeAmount, total pot = 2x, 5% burned
    const totalStaked = result.length > 0 ? result[0].totalStaked : 0;
    const totalBurned = Math.floor(totalStaked * 2 * 0.05);
    res.json({ totalBurned });
  } catch (err) {
    res.json({ totalBurned: 0 });
  }
});

// Player $PONG balance
const { getPlayerBalance } = require('./solana/utils');
app.get('/api/balance/:wallet', async (req, res) => {
  try {
    const balance = await getPlayerBalance(req.params.wallet);
    res.json({ balance });
  } catch (err) {
    res.json({ balance: 0 });
  }
});

// Admin console
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Practice mode
app.get('/practice', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'practice.html'));
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------- In-Memory State ---------------
const onlineUsers = new Map();    // wallet -> { socketId, username }
const activeGames = new Map();    // gameId -> PongEngine instance

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

    // Update socketId in any active game (handles reconnection)
    for (const [gameId, game] of activeGames) {
      const isP1 = game.player1.wallet === wallet;
      const isP2 = game.player2.wallet === wallet;
      if (!isP1 && !isP2) continue;

      if (isP1) game.player1.socketId = socket.id;
      if (isP2) game.player2.socketId = socket.id;

      const wasDisconnected = game.isDisconnected(wallet);
      if (wasDisconnected) {
        game.clearDisconnect(wallet);
        const oppSocketId = isP1 ? game.player2.socketId : game.player1.socketId;
        io.to(oppSocketId).emit('opponent-reconnected', { gameId });
        console.log(`${isP1 ? 'Player1' : 'Player2'} reconnected to game ${gameId}`);
      }

      socket.emit('rejoin-game', {
        gameId,
        player1: { wallet: game.player1.wallet, username: game.player1.username, skin: game.player1.skin || null },
        player2: { wallet: game.player2.wallet, username: game.player2.username, skin: game.player2.skin || null },
        tier: game.tier,
        state: game.state,
      });
    }
  });

  // --- Matchmaking (includes duel, ready, game-chat handlers) ---
  setupMatchmaking(io, socket, onlineUsers, activeGames);

  // --- In-Game Paddle Input ---
  socket.on('paddle-move', ({ gameId, direction, y }) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    game.handleInput(socket.wallet, direction, y);
  });

  // --- Paddle position sync (prevents tick-rate drift) ---
  socket.on('paddle-sync', ({ gameId, y }) => {
    if (typeof y !== 'number') return;
    const game = activeGames.get(gameId);
    if (!game) return;
    game._syncPaddle(socket.wallet, y);
  });

  // --- Direct Messages ---
  socket.on('dm-send', async ({ to, text }) => {
    if (!socket.wallet || !to || !text) return;
    if (typeof text !== 'string' || text.length > 500) return;

    try {
      const msg = await Message.create({
        from: socket.wallet,
        to,
        text: text.trim(),
      });

      // Emit to recipient if online
      const recipientInfo = onlineUsers.get(to);
      if (recipientInfo) {
        io.to(recipientInfo.socketId).emit('dm-receive', {
          from: socket.wallet,
          fromUsername: socket.username,
          text: msg.text,
          createdAt: msg.createdAt,
        });
      }

      // Confirm to sender
      socket.emit('dm-sent', {
        to,
        text: msg.text,
        createdAt: msg.createdAt,
      });
    } catch (err) {
      console.error('DM send error:', err.message);
    }
  });

  socket.on('dm-read', async ({ friendWallet }) => {
    if (!socket.wallet || !friendWallet) return;
    try {
      await Message.updateMany(
        { from: friendWallet, to: socket.wallet, read: false },
        { $set: { read: true } }
      );
    } catch (err) {
      console.error('DM read error:', err.message);
    }
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    if (socket.wallet) {
      onlineUsers.delete(socket.wallet);
      io.emit('online-users', Array.from(onlineUsers.keys()));

      const wallet = socket.wallet;
      for (const [gameId, game] of activeGames) {
        if (game.hasPlayer(wallet)) {
          game.setDisconnect(wallet);

          const oppSocketId = wallet === game.player1.wallet
            ? game.player2.socketId : game.player1.socketId;
          io.to(oppSocketId).emit('opponent-disconnected', { gameId });

          setTimeout(() => {
            if (activeGames.has(gameId) && game.isDisconnected(wallet)) {
              game.forfeit(wallet);
              activeGames.delete(gameId);
            }
          }, 15000);
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
    await seedSkins();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Pong Arena running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
