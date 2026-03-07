// ===========================================
// Public API v1 — Discord Bot & Third-Party
// ===========================================

const express = require('express');
const User = require('../models/User');
const Match = require('../models/Match');
const DiscordLinkCode = require('../models/DiscordLinkCode');

/**
 * Resolve a player by wallet address, Discord ID, or username/handle.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolvePlayer(identifier) {
  // Solana wallet: base58, 32-44 chars
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identifier)) {
    return User.findOne({ wallet: identifier });
  }
  // Discord ID: 17-20 digit snowflake
  if (/^\d{17,20}$/.test(identifier)) {
    return User.findOne({ discordId: identifier });
  }
  // Username / handle (case-insensitive)
  const escaped = escapeRegex(identifier);
  return User.findOne({
    $or: [
      { username: { $regex: new RegExp(`^${escaped}$`, 'i') } },
      { handle: { $regex: new RegExp(`^${escaped}$`, 'i') } }
    ]
  });
}

/**
 * Build a safe public player object (no friends, skins, crates, etc.)
 */
async function buildPlayerResponse(user) {
  const totalGames = (user.stats?.wins || 0) + (user.stats?.losses || 0);
  const winRate = totalGames > 0 ? parseFloat(((user.stats.wins / totalGames) * 100).toFixed(1)) : 0;

  // Rank by total earnings
  const rank = await User.countDocuments({ 'stats.totalEarnings': { $gt: user.stats?.totalEarnings || 0 } }) + 1;

  return {
    wallet: user.wallet,
    username: user.username,
    handle: user.handle,
    nickname: user.nickname,
    pfp: user.pfp,
    bio: user.bio,
    discordId: user.discordId || null,
    stats: {
      wins: user.stats?.wins || 0,
      losses: user.stats?.losses || 0,
      totalEarnings: user.stats?.totalEarnings || 0
    },
    winRate,
    rank,
    createdAt: user.createdAt
  };
}

function tierToDisplay(tier) {
  const map = { t5:'$5', t10:'$10', t25:'$25', t50:'$50', t100:'$100', t250:'$250', t500:'$500', t1000:'$1000', low:'$1', medium:'$5', high:'$10', duel:'Duel' };
  return map[tier] || tier;
}

module.exports = function (io, onlineUsers, activeGames, queues, openLobbies, openTournaments) {
  const router = express.Router();

  // --------------------------------------------------
  // GET /api/v1/player/:identifier
  // --------------------------------------------------
  router.get('/player/:identifier', async (req, res) => {
    try {
      const user = await resolvePlayer(req.params.identifier);
      if (!user) return res.status(404).json({ error: 'Player not found' });
      const player = await buildPlayerResponse(user);
      res.json({ player });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch player' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/player/:identifier/stats
  // --------------------------------------------------
  router.get('/player/:identifier/stats', async (req, res) => {
    try {
      const user = await resolvePlayer(req.params.identifier);
      if (!user) return res.status(404).json({ error: 'Player not found' });

      const totalGames = (user.stats?.wins || 0) + (user.stats?.losses || 0);
      const winRate = totalGames > 0 ? parseFloat(((user.stats.wins / totalGames) * 100).toFixed(1)) : 0;
      const rank = await User.countDocuments({ 'stats.totalEarnings': { $gt: user.stats?.totalEarnings || 0 } }) + 1;

      res.json({
        wallet: user.wallet,
        username: user.username,
        wins: user.stats?.wins || 0,
        losses: user.stats?.losses || 0,
        totalEarnings: user.stats?.totalEarnings || 0,
        winRate,
        rank
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/player/:identifier/matches?limit=20&offset=0
  // --------------------------------------------------
  router.get('/player/:identifier/matches', async (req, res) => {
    try {
      const user = await resolvePlayer(req.params.identifier);
      if (!user) return res.status(404).json({ error: 'Player not found' });

      const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);

      const query = {
        $or: [{ player1: user.wallet }, { player2: user.wallet }],
        status: 'completed'
      };

      const [matches, total] = await Promise.all([
        Match.find(query).sort({ completedAt: -1 }).skip(offset).limit(limit),
        Match.countDocuments(query)
      ]);

      const history = matches.map(m => {
        const isP1 = m.player1 === user.wallet;
        return {
          gameId: m.gameId,
          result: m.winner === user.wallet ? 'win' : 'loss',
          opponent: {
            wallet: isP1 ? m.player2 : m.player1,
            username: isP1 ? m.player2Username : m.player1Username
          },
          score: {
            player: isP1 ? m.score.player1 : m.score.player2,
            opponent: isP1 ? m.score.player2 : m.score.player1
          },
          tier: m.tier,
          stakeAmount: m.stakeAmount,
          completedAt: m.completedAt
        };
      });

      res.json({ matches: history, total, limit, offset });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch matches' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/leaderboard?sort=earnings|wins|games&limit=50
  // --------------------------------------------------
  router.get('/leaderboard', async (req, res) => {
    try {
      const sortParam = req.query.sort || 'earnings';
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);

      let sortField;
      switch (sortParam) {
        case 'wins': sortField = { 'stats.wins': -1 }; break;
        case 'games': sortField = { 'stats.wins': -1 }; break; // sort by wins as proxy
        default: sortField = { 'stats.totalEarnings': -1 }; break;
      }

      const users = await User.find({})
        .sort(sortField)
        .limit(limit)
        .select('wallet username handle nickname pfp stats createdAt');

      const leaderboard = users.map((u, i) => ({
        rank: i + 1,
        wallet: u.wallet,
        username: u.username,
        handle: u.handle,
        nickname: u.nickname,
        pfp: u.pfp,
        wins: u.stats?.wins || 0,
        losses: u.stats?.losses || 0,
        totalEarnings: u.stats?.totalEarnings || 0
      }));

      res.json({ leaderboard, sort: sortParam, limit });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/stats — Global stats
  // --------------------------------------------------
  router.get('/stats', async (req, res) => {
    try {
      const [totalMatches, totalPlayers, burnResult] = await Promise.all([
        Match.countDocuments({ status: 'completed' }),
        User.countDocuments({}),
        Match.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, totalStaked: { $sum: '$stakeAmount' } } }
        ])
      ]);

      const totalStaked = burnResult.length > 0 ? burnResult[0].totalStaked : 0;
      const totalBurned = Math.floor(totalStaked * 2 * 0.05);

      res.json({
        totalMatches,
        totalPlayers,
        totalBurned,
        activeGames: activeGames.size,
        onlinePlayers: onlineUsers.size
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/live — Active games (no wallets exposed)
  // --------------------------------------------------
  router.get('/live', (req, res) => {
    try {
      const games = [];
      for (const [gameId, game] of activeGames) {
        games.push({
          gameId,
          player1: game.player1?.username || 'Unknown',
          player2: game.player2?.username || 'Unknown',
          tier: game.tier,
          score: game.state?.score || { player1: 0, player2: 0 }
        });
      }
      res.json({ games, onlinePlayers: onlineUsers.size });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch live data' });
    }
  });

  // --------------------------------------------------
  // POST /api/v1/discord/link — Bot verifies link code
  // --------------------------------------------------
  router.post('/discord/link', async (req, res) => {
    try {
      const { code, discordId, botSecret } = req.body;

      if (!code || !discordId || !botSecret) {
        return res.status(400).json({ error: 'Missing code, discordId, or botSecret' });
      }

      // Validate bot secret
      if (botSecret !== process.env.DISCORD_BOT_SECRET) {
        return res.status(403).json({ error: 'Invalid bot secret' });
      }

      // Check if discordId is already linked
      const existingLink = await User.findOne({ discordId });
      if (existingLink) {
        return res.status(409).json({ error: 'This Discord account is already linked to another player' });
      }

      // Find and validate the link code
      const linkCode = await DiscordLinkCode.findOne({ code: code.toUpperCase() });
      if (!linkCode) {
        return res.status(404).json({ error: 'Invalid or expired link code' });
      }

      // Link the discord account
      const user = await User.findOneAndUpdate(
        { wallet: linkCode.wallet },
        { $set: { discordId } },
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ error: 'Player not found' });
      }

      // Delete the used code
      await DiscordLinkCode.deleteOne({ _id: linkCode._id });

      res.json({ linked: true, wallet: user.wallet, username: user.username });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'This Discord account is already linked to another player' });
      }
      res.status(500).json({ error: 'Failed to link Discord account' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/discord/:discordId — Check Discord link
  // --------------------------------------------------
  router.get('/discord/:discordId', async (req, res) => {
    try {
      const user = await User.findOne({ discordId: req.params.discordId });
      if (!user) {
        return res.json({ linked: false });
      }
      const player = await buildPlayerResponse(user);
      res.json({ linked: true, player });
    } catch (err) {
      res.status(500).json({ error: 'Failed to check Discord link' });
    }
  });

  // --------------------------------------------------
  // GET /api/v1/matchmaking — Current matchmaking activity
  // --------------------------------------------------
  router.get('/matchmaking', (req, res) => {
    // Build queues (only non-empty tiers)
    const queueList = [];
    for (const [tier, players] of Object.entries(queues)) {
      if (players.length > 0) {
        queueList.push({ tier, players: players.length, stakeDisplay: tierToDisplay(tier) });
      }
    }

    // Build lobbies
    const lobbyList = [];
    for (const [lobbyId, lobby] of openLobbies) {
      lobbyList.push({
        lobbyId,
        creator: lobby.username,
        stakeAmount: lobby.stakeAmount,
        stakeDisplay: '$' + (lobby.stakeAmount / 1e6),
        createdAt: lobby.createdAt,
      });
    }

    // Build tournaments (waiting/escrow only)
    const tournamentList = [];
    for (const [tid, t] of openTournaments) {
      if (t.status === 'waiting' || t.status === 'escrow') {
        tournamentList.push({
          tournamentId: tid,
          creator: t.creatorUsername,
          maxPlayers: t.maxPlayers,
          currentPlayers: t.players.length,
          stakeAmount: t.stakeAmount,
          stakeDisplay: '$' + (t.stakeAmount / 1e6),
          status: t.status,
          createdAt: t.createdAt,
        });
      }
    }

    res.json({
      queues: queueList,
      lobbies: lobbyList,
      tournaments: tournamentList,
      activeGames: activeGames.size,
      onlinePlayers: onlineUsers.size,
    });
  });

  return router;
};
