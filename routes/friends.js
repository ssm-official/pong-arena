// ===========================================
// Friends Routes — Search, add, accept, list
// ===========================================

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Message = require('../models/Message');

/**
 * GET /api/friends
 * List the authenticated user's friends with profile info.
 */
router.get('/', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.wallet });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Fetch friend profiles
    const friends = await User.find({ wallet: { $in: user.friends } })
      .select('wallet username pfp bio stats');

    res.json({ friends });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch friends' });
  }
});

/**
 * GET /api/friends/requests
 * List pending friend requests for the authenticated user.
 */
router.get('/requests', async (req, res) => {
  try {
    const user = await User.findOne({ wallet: req.wallet });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ requests: user.friendRequests });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

/**
 * GET /api/friends/search?q=username
 * Search users by username (partial match).
 */
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const users = await User.find({
      username: { $regex: q, $options: 'i' },
      wallet: { $ne: req.wallet } // exclude self
    })
    .select('wallet username pfp bio')
    .limit(10);

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /api/friends/add
 * Send a friend request. Body: { targetWallet }
 */
router.post('/add', async (req, res) => {
  try {
    const { targetWallet } = req.body;
    if (!targetWallet) return res.status(400).json({ error: 'Missing targetWallet' });
    if (targetWallet === req.wallet) return res.status(400).json({ error: 'Cannot add yourself' });

    const [user, target] = await Promise.all([
      User.findOne({ wallet: req.wallet }),
      User.findOne({ wallet: targetWallet })
    ]);

    if (!target) return res.status(404).json({ error: 'User not found' });
    if (user.friends.includes(targetWallet)) {
      return res.status(400).json({ error: 'Already friends' });
    }

    // Check if request already sent
    const existing = target.friendRequests.find(r => r.from === req.wallet);
    if (existing) return res.status(400).json({ error: 'Request already sent' });

    // Check if target already sent us a request (auto-accept)
    const incomingFromTarget = user.friendRequests.find(r => r.from === targetWallet);
    if (incomingFromTarget) {
      // Auto-accept: add each other as friends
      user.friends.push(targetWallet);
      target.friends.push(req.wallet);
      user.friendRequests = user.friendRequests.filter(r => r.from !== targetWallet);
      await Promise.all([user.save(), target.save()]);
      return res.json({ status: 'accepted', message: 'Friend request auto-accepted (mutual)' });
    }

    // Send request
    target.friendRequests.push({ from: req.wallet, fromUsername: user.username });
    await target.save();

    res.json({ status: 'sent', message: `Friend request sent to ${target.username}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send request' });
  }
});

/**
 * POST /api/friends/accept
 * Accept a friend request. Body: { fromWallet }
 */
router.post('/accept', async (req, res) => {
  try {
    const { fromWallet } = req.body;
    if (!fromWallet) return res.status(400).json({ error: 'Missing fromWallet' });

    const [user, requester] = await Promise.all([
      User.findOne({ wallet: req.wallet }),
      User.findOne({ wallet: fromWallet })
    ]);

    if (!requester) return res.status(404).json({ error: 'Requester not found' });

    const reqIndex = user.friendRequests.findIndex(r => r.from === fromWallet);
    if (reqIndex === -1) return res.status(400).json({ error: 'No pending request from this user' });

    // Add as friends (both ways)
    user.friendRequests.splice(reqIndex, 1);
    if (!user.friends.includes(fromWallet)) user.friends.push(fromWallet);
    if (!requester.friends.includes(req.wallet)) requester.friends.push(req.wallet);

    await Promise.all([user.save(), requester.save()]);

    res.json({ status: 'accepted', message: `Now friends with ${requester.username}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

/**
 * POST /api/friends/decline
 * Decline a friend request. Body: { fromWallet }
 */
router.post('/decline', async (req, res) => {
  try {
    const { fromWallet } = req.body;
    await User.findOneAndUpdate(
      { wallet: req.wallet },
      { $pull: { friendRequests: { from: fromWallet } } }
    );
    res.json({ status: 'declined' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

/**
 * POST /api/friends/remove
 * Remove a friend. Body: { friendWallet }
 */
router.post('/remove', async (req, res) => {
  try {
    const { friendWallet } = req.body;
    await Promise.all([
      User.findOneAndUpdate({ wallet: req.wallet }, { $pull: { friends: friendWallet } }),
      User.findOneAndUpdate({ wallet: friendWallet }, { $pull: { friends: req.wallet } }),
    ]);
    res.json({ status: 'removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// ===========================================
// MESSAGING (DMs)
// ===========================================

/**
 * GET /api/friends/messages/:friendWallet?before=timestamp&limit=50
 * Get paginated message history with a friend.
 */
router.get('/messages/:friendWallet', async (req, res) => {
  try {
    const { friendWallet } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? new Date(parseInt(req.query.before)) : new Date();

    const messages = await Message.find({
      $or: [
        { from: req.wallet, to: friendWallet },
        { from: friendWallet, to: req.wallet }
      ],
      createdAt: { $lt: before }
    })
    .sort({ createdAt: -1 })
    .limit(limit);

    // Mark messages from friend as read
    await Message.updateMany(
      { from: friendWallet, to: req.wallet, read: false },
      { $set: { read: true } }
    );

    res.json({ messages: messages.reverse() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/friends/messages
 * Send a message. Body: { to, text }
 */
router.post('/messages', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Missing to or text' });
    if (text.length > 500) return res.status(400).json({ error: 'Message too long (max 500)' });

    const msg = await Message.create({
      from: req.wallet,
      to,
      text: text.trim()
    });

    res.json({ message: msg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * GET /api/friends/unread
 * Get unread message count per friend.
 */
router.get('/unread', async (req, res) => {
  try {
    const unread = await Message.aggregate([
      { $match: { to: req.wallet, read: false } },
      { $group: { _id: '$from', count: { $sum: 1 } } }
    ]);

    const counts = {};
    unread.forEach(u => { counts[u._id] = u.count; });
    res.json({ unread: counts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unread counts' });
  }
});

module.exports = router;
