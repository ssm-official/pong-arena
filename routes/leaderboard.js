const express = require('express');
const router = express.Router();
const User = require('../models/User');

/**
 * GET /api/leaderboard?sort=earnings|wins|games&limit=50
 * Public endpoint — no auth required.
 */
router.get('/', async (req, res) => {
  try {
    const sort = req.query.sort || 'earnings';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    let sortObj;
    let projection = 'wallet username pfp stats';

    if (sort === 'wins') {
      sortObj = { 'stats.wins': -1 };
    } else if (sort === 'games') {
      // Sort by total games (wins + losses)
      // Use aggregation for computed field
      const pipeline = [
        {
          $addFields: {
            totalGames: { $add: ['$stats.wins', '$stats.losses'] }
          }
        },
        { $sort: { totalGames: -1 } },
        { $limit: limit },
        {
          $project: {
            wallet: 1, username: 1, pfp: 1, stats: 1, totalGames: 1
          }
        }
      ];
      const users = await User.aggregate(pipeline);
      return res.json({ users });
    } else {
      // Default: earnings
      sortObj = { 'stats.totalEarnings': -1 };
    }

    const users = await User.find({})
      .select(projection)
      .sort(sortObj)
      .limit(limit);

    res.json({ users });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;
