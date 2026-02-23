// ===========================================
// App.js — Main application logic
// ===========================================
// Handles UI state, API calls, socket events, tab navigation.

let currentUser = null;  // { wallet, username, pfp, bio, stats, ... }
let sessionToken = null; // Bearer token from server — sign once, use everywhere
let onlineUsers = [];    // array of online wallet addresses
let currentGameId = null;
let pendingEscrowTx = null;
let isMirrored = false;
let chosenSide = 'left'; // which side the player wants their paddle on

/** Return Authorization header using cached session token. No wallet popup. */
function getAuthHeader() {
  return 'Bearer ' + sessionToken;
}

// ---- Socket.io ----
const socket = io();
window.socket = socket; // expose for game-client input

// Re-register on reconnect (Railway can drop connections)
socket.on('connect', () => {
  if (currentUser) {
    socket.emit('register', {
      wallet: currentUser.wallet,
      username: currentUser.username
    });
  }
});

// ===========================================
// WALLET CONNECTION & AUTH
// ===========================================

async function connectWallet() {
  try {
    const wallet = await WalletManager.connect();
    const authData = await WalletManager.signAuthMessage();

    // Try login — server returns session token (sign once!)
    const res = await apiPost('/api/auth/login', authData);
    sessionToken = res.token;

    if (res.status === 'existing') {
      currentUser = res.user;
      showApp();
    } else if (res.status === 'new') {
      showView('register');
    }
  } catch (err) {
    alert('Wallet connection failed: ' + err.message);
  }
}

async function registerUser() {
  const username = document.getElementById('reg-username').value.trim();
  const pfp = document.getElementById('reg-pfp').value.trim();
  const bio = document.getElementById('reg-bio').value.trim();

  if (!username) return showRegError('Username is required');

  try {
    // Use existing session token from login step — no re-signing needed
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({ wallet: WalletManager.getWallet(), username, pfp, bio })
    }).then(r => r.json());

    if (res.error) return showRegError(res.error);
    sessionToken = res.token;
    currentUser = res.user;
    showApp();
  } catch (err) {
    showRegError(err.message);
  }
}

function showRegError(msg) {
  const el = document.getElementById('reg-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ===========================================
// UI NAVIGATION
// ===========================================

function showView(view) {
  document.getElementById('view-connect').classList.add('hidden');
  document.getElementById('view-register').classList.add('hidden');
  document.getElementById('view-app').classList.add('hidden');

  document.getElementById(`view-${view}`).classList.remove('hidden');
}

function showApp() {
  showView('app');
  updateNav();
  switchTab('play');

  // Register with socket
  socket.emit('register', {
    wallet: currentUser.wallet,
    username: currentUser.username
  });

  // Init game canvas
  const canvas = document.getElementById('game-canvas');
  GameClient.init(canvas, currentUser.wallet);
}

function updateNav() {
  document.getElementById('btn-connect').textContent = shortenAddress(currentUser.wallet);
  document.getElementById('btn-connect').onclick = null; // disable reconnect
  document.getElementById('nav-username').textContent = currentUser.username;
  if (currentUser.pfp) {
    document.getElementById('nav-pfp').src = currentUser.pfp;
  }
  document.getElementById('nav-user').classList.remove('hidden');
}

function switchTab(tab) {
  // Hide all tab contents
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('tab-active'));

  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('tab-active');

  // Load tab-specific data
  if (tab === 'profile') loadProfile();
  if (tab === 'friends') loadFriends();
  if (tab === 'shop') loadShop();
  if (tab === 'history') loadHistory();
}

// ===========================================
// PROFILE
// ===========================================

function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profile-pfp').src = currentUser.pfp || '';
  document.getElementById('profile-username').textContent = currentUser.username;
  document.getElementById('profile-wallet').textContent = shortenAddress(currentUser.wallet);
  document.getElementById('edit-username').value = currentUser.username;
  document.getElementById('edit-pfp').value = currentUser.pfp || '';
  document.getElementById('edit-bio').value = currentUser.bio || '';
  document.getElementById('stat-wins').textContent = currentUser.stats?.wins || 0;
  document.getElementById('stat-losses').textContent = currentUser.stats?.losses || 0;
  document.getElementById('stat-earnings').textContent = formatPong(currentUser.stats?.totalEarnings || 0);
}

async function saveProfile() {
  try {
    const body = {
      username: document.getElementById('edit-username').value.trim(),
      pfp: document.getElementById('edit-pfp').value.trim(),
      bio: document.getElementById('edit-bio').value.trim(),
    };

    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify(body)
    }).then(r => r.json());

    if (res.error) {
      showProfileMsg(res.error, 'red');
    } else {
      currentUser = res.user;
      updateNav();
      showProfileMsg('Profile saved!', 'green');
    }
  } catch (err) {
    showProfileMsg('Save failed: ' + err.message, 'red');
  }
}

function showProfileMsg(msg, color) {
  const el = document.getElementById('profile-msg');
  el.textContent = msg;
  el.className = `text-sm text-${color}-400`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ===========================================
// FRIENDS
// ===========================================

async function loadFriends() {
  try {
    const auth = getAuthHeader();
    const [friendRes, requestRes] = await Promise.all([
      fetch('/api/friends', { headers: { Authorization: auth } }).then(r => r.json()),
      fetch('/api/friends/requests', { headers: { Authorization: auth } }).then(r => r.json()),
    ]);

    renderFriendList(friendRes.friends || []);
    renderFriendRequests(requestRes.requests || []);
  } catch (err) {
    console.error('Failed to load friends:', err);
  }
}

function renderFriendList(friends) {
  const container = document.getElementById('friend-list');
  if (friends.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No friends yet.</p>';
    return;
  }
  container.innerHTML = friends.map(f => `
    <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-2 h-2 rounded-full ${onlineUsers.includes(f.wallet) ? 'bg-green-400' : 'bg-gray-600'}"></div>
        <span class="font-medium">${esc(f.username)}</span>
        <span class="text-gray-500 text-xs">${shortenAddress(f.wallet)}</span>
      </div>
      <button onclick="removeFriend('${f.wallet}')" class="text-red-400 hover:text-red-300 text-xs">Remove</button>
    </div>
  `).join('');
}

function renderFriendRequests(requests) {
  const container = document.getElementById('friend-requests');
  if (requests.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No pending requests</p>';
    return;
  }
  container.innerHTML = requests.map(r => `
    <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
      <span class="font-medium">${esc(r.fromUsername)}</span>
      <div class="flex gap-2">
        <button onclick="acceptFriend('${r.from}')" class="text-green-400 hover:text-green-300 text-sm">Accept</button>
        <button onclick="declineFriend('${r.from}')" class="text-red-400 hover:text-red-300 text-sm">Decline</button>
      </div>
    </div>
  `).join('');
}

async function searchFriends() {
  const q = document.getElementById('friend-search').value.trim();
  if (q.length < 2) return;

  try {
    const auth = getAuthHeader();
    const res = await fetch(`/api/friends/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: auth }
    }).then(r => r.json());

    const container = document.getElementById('search-results');
    if (!res.users || res.users.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No users found</p>';
      return;
    }
    container.innerHTML = res.users.map(u => `
      <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
        <span class="font-medium">${esc(u.username)}</span>
        <button onclick="addFriend('${u.wallet}')" class="bg-purple-600 hover:bg-purple-700 px-3 py-1 rounded text-xs transition">
          Add Friend
        </button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Search failed:', err);
  }
}

async function addFriend(targetWallet) {
  const res = await apiPostAuth('/api/friends/add', { targetWallet }, getAuthHeader());
  alert(res.message || res.error || 'Done');
  loadFriends();
}

async function acceptFriend(fromWallet) {
  await apiPostAuth('/api/friends/accept', { fromWallet }, getAuthHeader());
  loadFriends();
}

async function declineFriend(fromWallet) {
  await apiPostAuth('/api/friends/decline', { fromWallet }, getAuthHeader());
  loadFriends();
}

async function removeFriend(friendWallet) {
  if (!confirm('Remove this friend?')) return;
  await apiPostAuth('/api/friends/remove', { friendWallet }, getAuthHeader());
  loadFriends();
}

// ===========================================
// SHOP
// ===========================================

async function loadShop() {
  try {
    const auth = getAuthHeader();
    const res = await fetch('/api/shop', { headers: { Authorization: auth } }).then(r => r.json());

    const grid = document.getElementById('shop-grid');
    grid.innerHTML = (res.skins || []).map(s => `
      <div class="skin-card bg-arena-card rounded-xl p-4 border ${s.owned ? 'border-purple-600' : 'border-gray-800'}">
        <div class="w-full h-20 rounded-lg mb-3 flex items-center justify-center"
          style="background: ${esc(s.cssValue)}33">
          <div class="w-10 h-10 rounded-full" style="background: ${esc(s.cssValue)}; box-shadow: 0 0 15px ${esc(s.cssValue)}"></div>
        </div>
        <h4 class="font-bold text-sm">${esc(s.name)}</h4>
        <p class="text-gray-500 text-xs mb-2">${esc(s.description || '')}</p>
        <div class="flex items-center justify-between">
          <span class="text-xs px-2 py-0.5 rounded ${
            s.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300' :
            s.rarity === 'rare' ? 'bg-purple-900 text-purple-300' :
            'bg-gray-800 text-gray-400'
          }">${s.rarity}</span>
          ${s.owned
            ? `<button onclick="equipSkin('${s.skinId}')" class="text-xs ${s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300'}">${s.equipped ? 'Equipped' : 'Equip'}</button>`
            : `<button onclick="buySkin('${s.skinId}')" class="bg-purple-600 hover:bg-purple-700 px-3 py-1 rounded text-xs transition">${s.price} $PONG</button>`
          }
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load shop:', err);
  }
}

async function buySkin(skinId) {
  try {
    const auth = getAuthHeader();

    // Step 1: Get transaction to sign
    const buyRes = await apiPostAuth('/api/shop/buy', { skinId }, auth);
    if (buyRes.error) return alert(buyRes.error);

    // Step 2: Sign and send transaction via Phantom
    alert('Please approve the $PONG transfer in your wallet.');
    const txSignature = await WalletManager.signAndSendTransaction(buyRes.transaction);

    // Step 3: Confirm purchase with server
    const confirmRes = await apiPostAuth('/api/shop/confirm', { skinId, txSignature }, auth);
    if (confirmRes.error) return alert(confirmRes.error);

    alert('Skin purchased! 90% of the cost was burned.');
    loadShop();
  } catch (err) {
    alert('Purchase failed: ' + err.message);
  }
}

async function equipSkin(skinId) {
  try {
    await apiPostAuth('/api/shop/equip', { skinId }, getAuthHeader());
    loadShop();
  } catch (err) {
    alert('Failed to equip: ' + err.message);
  }
}

// ===========================================
// MATCH HISTORY
// ===========================================

async function loadHistory() {
  try {
    const auth = getAuthHeader();
    const res = await fetch('/api/profile/history', { headers: { Authorization: auth } }).then(r => r.json());

    const container = document.getElementById('history-list');
    if (!res.matches || res.matches.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No matches played yet.</p>';
      return;
    }

    container.innerHTML = res.matches.map(m => {
      const won = m.winner === currentUser.wallet;
      const opponent = m.player1 === currentUser.wallet ? m.player2Username : m.player1Username;
      return `
        <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
          <div>
            <span class="font-medium ${won ? 'text-green-400' : 'text-red-400'}">${won ? 'WIN' : 'LOSS'}</span>
            <span class="text-gray-400 ml-2">vs ${esc(opponent || 'Unknown')}</span>
          </div>
          <div class="text-right">
            <span class="text-gray-400 text-sm">${m.score.player1} - ${m.score.player2}</span>
            <span class="text-gray-600 text-xs ml-2">${m.tier} tier</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

// ===========================================
// MATCHMAKING (via Socket.io)
// ===========================================

function joinQueue(tier) {
  socket.emit('queue-join', { tier });
  showMatchmakingState('queue');
  document.getElementById('queue-tier-display').textContent =
    `${tier.toUpperCase()} tier — ${tier === 'low' ? '10K' : tier === 'medium' ? '50K' : '200K'} $PONG`;
}

function leaveQueue() {
  socket.emit('queue-leave');
  showMatchmakingState('select');
}

function showMatchmakingState(state) {
  document.getElementById('matchmaking-ui').classList.toggle('hidden', state !== 'select');
  document.getElementById('queue-ui').classList.toggle('hidden', state !== 'queue');
  document.getElementById('escrow-ui').classList.toggle('hidden', state !== 'escrow');
  document.getElementById('game-ui').classList.toggle('hidden', state !== 'game');
  document.getElementById('gameover-ui').classList.toggle('hidden', state !== 'gameover');
}

// Track which player we are in the current match
let myPlayerSlot = null; // 'p1' or 'p2'

// Socket: Match found → show escrow prompt
socket.on('match-found', (data) => {
  currentGameId = data.gameId;
  pendingEscrowTx = data.escrowTransaction;
  myPlayerSlot = data.yourSlot; // server tells us if we're p1 or p2

  document.getElementById('escrow-opponent').textContent = data.opponent.username;
  document.getElementById('escrow-stake').textContent = formatPong(data.stake) + ' $PONG';

  // Reset escrow UI
  const btn = document.getElementById('btn-escrow-submit');
  if (btn) { btn.disabled = false; btn.textContent = 'Approve & Stake'; }
  setEscrowIcon('escrow-you-icon', 'escrow-you-status', '?', 'Waiting...', 'bg-gray-700');
  setEscrowIcon('escrow-opp-icon', 'escrow-opp-status', '?', 'Waiting...', 'bg-gray-700');
  document.getElementById('escrow-msg').textContent = 'Approve the transaction in Phantom to stake your $PONG.';

  showMatchmakingState('escrow');
});

function setEscrowIcon(iconId, statusId, icon, text, bgClass) {
  const iconEl = document.getElementById(iconId);
  const statusEl = document.getElementById(statusId);
  iconEl.textContent = icon;
  iconEl.className = `w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-1 text-lg ${bgClass}`;
  statusEl.textContent = text;
}

// Socket: Per-player escrow status updates
socket.on('escrow-status', (data) => {
  if (data.gameId !== currentGameId) return;

  const isMe = data.player === myPlayerSlot;
  const iconId = isMe ? 'escrow-you-icon' : 'escrow-opp-icon';
  const statusId = isMe ? 'escrow-you-status' : 'escrow-opp-status';

  if (data.status === 'verifying') {
    setEscrowIcon(iconId, statusId, '...', 'Verifying...', 'bg-yellow-900');
  } else if (data.status === 'confirmed') {
    setEscrowIcon(iconId, statusId, '\u2713', 'Confirmed!', 'bg-green-900');
    if (isMe) {
      document.getElementById('escrow-msg').textContent = 'You confirmed! Waiting for opponent...';
      document.getElementById('btn-escrow-submit').classList.add('hidden');
    }
  } else if (data.status === 'failed') {
    setEscrowIcon(iconId, statusId, '\u2717', 'Failed', 'bg-red-900');
    if (isMe) {
      const btn = document.getElementById('btn-escrow-submit');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }
});

async function submitEscrow() {
  try {
    const btn = document.getElementById('btn-escrow-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Sign in Phantom...'; }

    // Sign the escrow transaction via Phantom
    const txSignature = await WalletManager.signAndSendTransaction(pendingEscrowTx);

    if (btn) { btn.textContent = 'Verifying on-chain...'; }

    socket.emit('escrow-submit', { gameId: currentGameId, txSignature });
  } catch (err) {
    const btn = document.getElementById('btn-escrow-submit');
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    alert('Escrow failed: ' + err.message);
  }
}

function cancelEscrow() {
  socket.emit('escrow-cancel', { gameId: currentGameId });
  showMatchmakingState('select');
}

socket.on('match-cancelled', (data) => {
  alert(data.reason || 'Match cancelled');
  showMatchmakingState('select');
});

// ===========================================
// SIDE PICKER
// ===========================================

function pickSide(side) {
  chosenSide = side;

  // Update button styles
  const btnLeft = document.getElementById('btn-side-left');
  const btnRight = document.getElementById('btn-side-right');
  if (side === 'left') {
    btnLeft.className = 'bg-purple-600 hover:bg-purple-700 px-5 py-2 rounded-lg text-sm font-medium transition border-2 border-purple-500';
    btnRight.className = 'bg-gray-700 hover:bg-gray-600 px-5 py-2 rounded-lg text-sm font-medium transition border-2 border-transparent';
  } else {
    btnRight.className = 'bg-purple-600 hover:bg-purple-700 px-5 py-2 rounded-lg text-sm font-medium transition border-2 border-purple-500';
    btnLeft.className = 'bg-gray-700 hover:bg-gray-600 px-5 py-2 rounded-lg text-sm font-medium transition border-2 border-transparent';
  }
}

// Socket: Game countdown (10s intermission)
socket.on('game-countdown', (data) => {
  showMatchmakingState('game');
  GameClient.setGameInfo(data.gameId, null); // will be set on game-start

  // Reset side picker to left (default)
  chosenSide = 'left';
  pickSide('left');

  // Show intermission overlay with opponent info + side picker
  const intermission = document.getElementById('intermission-info');
  const sidePicker = document.getElementById('side-picker');
  if (intermission && data.player1 && data.player2) {
    const me = currentUser.wallet === data.player1.wallet ? data.player1 : data.player2;
    const opp = currentUser.wallet === data.player1.wallet ? data.player2 : data.player1;
    document.getElementById('intermission-you').textContent = me.username;
    document.getElementById('intermission-opp').textContent = opp.username;
    document.getElementById('intermission-tier').textContent =
      (data.tier || '').toUpperCase() + ' TIER';
    intermission.classList.remove('hidden');
    if (sidePicker) sidePicker.classList.remove('hidden');
  }

  let sec = data.seconds;
  const countdownEl = document.getElementById('intermission-countdown');
  function updateCountdown() {
    GameClient.renderCountdown(sec);
    if (countdownEl) countdownEl.textContent = sec;
    sec--;
    if (sec <= 0) {
      clearInterval(countdownInterval);
      // Don't hide intermission here — game-start handler does it
    }
  }
  updateCountdown();
  const countdownInterval = setInterval(updateCountdown, 1000);
});

// Socket: Game starts
socket.on('game-start', (data) => {
  currentGameId = data.gameId;
  showMatchmakingState('game');
  const intermission = document.getElementById('intermission-info');
  if (intermission) intermission.classList.add('hidden');
  GameClient.setGameInfo(data.gameId, data.player1.wallet);

  // Compute mirroring: p1 is naturally on the LEFT, p2 on the RIGHT.
  // Mirror when your chosen side doesn't match your natural side.
  const amP1 = (currentUser.wallet === data.player1.wallet);
  const myNaturalSide = amP1 ? 'left' : 'right';
  isMirrored = (chosenSide !== myNaturalSide);
  console.log('Side picker:', { chosenSide, amP1, myNaturalSide, isMirrored });
  GameClient.setMirrored(isMirrored);

  // Set player name labels to match the visual layout
  const leftLabel = document.getElementById('game-p1-name');
  const rightLabel = document.getElementById('game-p2-name');
  if (isMirrored) {
    leftLabel.textContent = data.player2.username;
    rightLabel.textContent = data.player1.username;
  } else {
    leftLabel.textContent = data.player1.username;
    rightLabel.textContent = data.player2.username;
  }

  GameClient.startRendering();
});

// Socket: Game state tick
socket.on('game-state', (data) => {
  if (data.gameId !== currentGameId) return;
  GameClient.updateState(data.state);
  // Swap score display to match mirrored view
  if (isMirrored) {
    document.getElementById('game-score-p1').textContent = data.state.score.p2;
    document.getElementById('game-score-p2').textContent = data.state.score.p1;
  } else {
    document.getElementById('game-score-p1').textContent = data.state.score.p1;
    document.getElementById('game-score-p2').textContent = data.state.score.p2;
  }
});

// Socket: Opponent disconnected (15s grace period)
socket.on('opponent-disconnected', (data) => {
  if (data.gameId !== currentGameId) return;
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.remove('hidden');
});

// Socket: Opponent reconnected
socket.on('opponent-reconnected', (data) => {
  if (data.gameId !== currentGameId) return;
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
});

// Socket: Game over
socket.on('game-over', (data) => {
  GameClient.cleanup();
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
  const won = data.winner === currentUser.wallet;

  document.getElementById('gameover-title').textContent = won ? 'VICTORY!' : 'DEFEAT';
  document.getElementById('gameover-title').className =
    `text-2xl font-bold mb-2 ${won ? 'text-green-400' : 'text-red-400'}`;
  document.getElementById('gameover-score').textContent =
    `Final Score: ${data.score.p1} - ${data.score.p2}`;
  document.getElementById('gameover-payout').textContent = won ? 'Payout processing...' : '';

  showMatchmakingState('gameover');
});

// Socket: Payout complete
socket.on('payout-complete', (data) => {
  const won = data.winner === currentUser.wallet;
  if (won) {
    document.getElementById('gameover-payout').textContent =
      `You won ${formatPong(data.winnerShare)} $PONG! (${formatPong(data.burned)} burned)`;
  } else {
    document.getElementById('gameover-payout').textContent =
      `Your stake was lost. ${formatPong(data.burned)} $PONG was burned.`;
  }
  refreshUserData();
});

// Socket: Forfeit
socket.on('game-forfeit', (data) => {
  GameClient.cleanup();
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
  const won = data.winner === currentUser.wallet;
  document.getElementById('gameover-title').textContent = won ? 'OPPONENT LEFT — YOU WIN!' : 'DISCONNECTED — FORFEIT';
  document.getElementById('gameover-title').className =
    `text-2xl font-bold mb-2 ${won ? 'text-green-400' : 'text-red-400'}`;
  document.getElementById('gameover-score').textContent = data.reason || '';
  showMatchmakingState('gameover');
});

function backToMatchmaking() {
  currentGameId = null;
  isMirrored = false;
  chosenSide = 'left';
  const intermission = document.getElementById('intermission-info');
  if (intermission) intermission.classList.add('hidden');
  showMatchmakingState('select');
}

// Socket: Online users update
socket.on('online-users', (users) => {
  onlineUsers = users;
});

// Socket: Errors
socket.on('queue-error', (data) => alert(data.error));
socket.on('escrow-error', (data) => alert(data.error));
socket.on('match-error', (data) => {
  alert(data.error);
  showMatchmakingState('select');
});
socket.on('payout-error', (data) => console.error('Payout error:', data.error));

// ===========================================
// HELPERS
// ===========================================

function shortenAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function formatPong(baseUnits) {
  return (baseUnits / 1e6).toFixed(2);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function apiPostAuth(url, body, authHeader) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function refreshUserData() {
  try {
    const auth = getAuthHeader();
    const res = await fetch('/api/profile', { headers: { Authorization: auth } }).then(r => r.json());
    if (res.user) currentUser = res.user;
  } catch (err) {
    console.error('Failed to refresh user:', err);
  }
}
