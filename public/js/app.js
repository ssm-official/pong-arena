// ===========================================
// App.js — Main application logic
// ===========================================

let currentUser = null;
let sessionToken = null;
let onlineUsers = [];
let currentGameId = null;
let pendingEscrowTx = null;
let isMirrored = false;
let chosenSide = 'left';

// --- Rarity config ---
const RARITY_COLORS = {
  secret:     { hex: '#06b6d4', tw: 'text-cyan-300',   border: 'border-cyan-400/60',   bg: 'bg-cyan-900/50',   bgRgba: 'rgba(6,182,212,0.2)' },
  mythic:     { hex: '#ef4444', tw: 'text-red-400',    border: 'border-red-600/50',    bg: 'bg-red-900/50',    bgRgba: 'rgba(239,68,68,0.15)' },
  legendary:  { hex: '#eab308', tw: 'text-yellow-400', border: 'border-yellow-600/50', bg: 'bg-yellow-900/50', bgRgba: 'rgba(234,179,8,0.15)' },
  super_rare: { hex: '#ec4899', tw: 'text-pink-400',   border: 'border-pink-600/50',   bg: 'bg-pink-900/50',   bgRgba: 'rgba(236,72,153,0.15)' },
  rare:       { hex: '#a855f7', tw: 'text-purple-400', border: 'border-purple-600/50', bg: 'bg-purple-900/50', bgRgba: 'rgba(168,85,247,0.15)' },
  uncommon:   { hex: '#22c55e', tw: 'text-green-400',  border: 'border-green-600/50',  bg: 'bg-green-900/50',  bgRgba: 'rgba(34,197,94,0.15)' },
  common:     { hex: '#6b7280', tw: 'text-gray-400',   border: 'border-gray-700/50',   bg: 'bg-gray-800',      bgRgba: 'rgba(107,114,128,0.1)' },
};
function rc(rarity) { return RARITY_COLORS[rarity] || RARITY_COLORS.common; }
function rarityBadge(rarity) {
  const map = {
    secret: 'bg-cyan-900 text-cyan-200', mythic: 'bg-red-900 text-red-300', legendary: 'bg-yellow-900 text-yellow-300',
    super_rare: 'bg-pink-900 text-pink-300', rare: 'bg-purple-900 text-purple-300',
    uncommon: 'bg-green-900 text-green-300', common: 'bg-gray-800 text-gray-400',
  };
  return map[rarity] || map.common;
}

// --- $PONG Price in USD ---
const PONG_TOKEN_MINT = 'GVLfSudckNc8L1MGWUJP5vXUgFNtYJqjytLR7xm3pump';
let pongPriceUsd = 0;
let pongPriceChange24h = null;
let pongMarketCap = null;
let priceLastFetched = 0;
let priceFetchFailed = false;
const PRICE_REFRESH_MS = 60000;
// USD-based tiers — PONG amounts auto-calculated from live price
const TIER_USD_AMOUNTS = { t5: 5, t10: 10, t25: 25, t50: 50, t100: 100, t250: 250, t500: 500, t1000: 1000 };
// Legacy compat
const TIER_PONG_AMOUNTS = { low: 10000, medium: 50000, high: 200000 };

function getTierPongAmount(tier) {
  const usd = TIER_USD_AMOUNTS[tier];
  if (!usd || pongPriceUsd <= 0) return 0;
  return Math.round(usd / pongPriceUsd);
}

// --- DM state ---
let dmOpenWallet = null;
let dmOpenUsername = null;
let unreadCounts = {};

// --- Duel state ---
let duelTargetWallet = null;
let pendingDuelId = null;

// --- Inventory state ---
let dashInventory = [];

// --- Lobby state ---
let myLobbyId = null;
let lobbyList = [];
let lobbyFilterMin = 0;
let lobbyFilterMax = Infinity;

// --- Game opponent for post-game add ---
let lastGameOpponent = null;

// --- Leaderboard ---
let currentLbSort = 'earnings';

// ===========================================
// USD PRICE FETCH (with fallback)
// ===========================================

async function fetchPongPrice() {
  // Source 1: DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${PONG_TOKEN_MINT}`);
    if (res.ok) {
      const data = await res.json();
      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        const price = parseFloat(pair.priceUsd);
        if (price && price > 0) {
          pongPriceUsd = price;
          if (pair.priceChange && pair.priceChange.h24 != null) {
            pongPriceChange24h = parseFloat(pair.priceChange.h24);
          }
          if (pair.marketCap) pongMarketCap = parseFloat(pair.marketCap);
          else if (pair.fdv) pongMarketCap = parseFloat(pair.fdv);
          priceLastFetched = Date.now();
          priceFetchFailed = false;
          updateAllUsdDisplays();
          return;
        }
      }
    }
  } catch (e) { console.warn('DexScreener price fetch failed:', e.message); }

  // Source 2: GeckoTerminal (pool endpoint — has price, fdv, 24h change)
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${PONG_TOKEN_MINT}/pools?page=1`);
    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data.length > 0) {
        const pool = data.data[0].attributes;
        const price = parseFloat(pool.base_token_price_usd);
        if (price && price > 0) {
          pongPriceUsd = price;
          if (pool.fdv_usd) pongMarketCap = parseFloat(pool.fdv_usd);
          if (pool.price_change_percentage && pool.price_change_percentage.h24 != null) {
            pongPriceChange24h = parseFloat(pool.price_change_percentage.h24);
          }
          priceLastFetched = Date.now();
          priceFetchFailed = false;
          updateAllUsdDisplays();
          return;
        }
      }
    }
  } catch (e) { console.warn('GeckoTerminal price fetch failed:', e.message); }

  // Source 3: Birdeye public API
  try {
    const res = await fetch(`https://public-api.birdeye.so/defi/price?address=${PONG_TOKEN_MINT}`, {
      headers: { 'X-Chain': 'solana' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.data?.value) {
        const price = parseFloat(data.data.value);
        if (price && price > 0) {
          pongPriceUsd = price;
          priceLastFetched = Date.now();
          priceFetchFailed = false;
          updateAllUsdDisplays();
          return;
        }
      }
    }
  } catch (e) { console.warn('Birdeye price fetch failed:', e.message); }

  // All sources failed
  console.error('All price sources failed for $PONG');
  priceFetchFailed = true;
  updateAllUsdDisplays();
}

function formatUsd(amount) {
  if (!amount || amount <= 0) return '--';
  if (amount < 0.01) return '<$0.01';
  if (amount < 1) return '$' + amount.toFixed(2);
  if (amount < 1000) return '$' + amount.toFixed(2);
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getTierUsd(tier) {
  // New USD-based tiers
  if (TIER_USD_AMOUNTS[tier]) return TIER_USD_AMOUNTS[tier];
  // Legacy fallback
  return (TIER_PONG_AMOUNTS[tier] || 0) * pongPriceUsd;
}

function formatPongShort(pong) {
  if (pong >= 1e6) return (pong / 1e6).toFixed(1) + 'M';
  if (pong >= 1e3) return (pong / 1e3).toFixed(0) + 'K';
  return pong.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function updateAllUsdDisplays() {
  // Update all USD-based tier buttons (modal + dashboard quick tiers)
  Object.keys(TIER_USD_AMOUNTS).forEach(tier => {
    const el = document.getElementById(`tier-pong-${tier}`);
    if (el) {
      if (priceFetchFailed || pongPriceUsd <= 0) el.textContent = 'Price N/A';
      else el.textContent = formatPongShort(getTierPongAmount(tier)) + ' $PONG';
    }
    // Dashboard quick-tier buttons
    const dashEl = document.getElementById(`dash-tier-pong-${tier}`);
    if (dashEl) {
      if (priceFetchFailed || pongPriceUsd <= 0) dashEl.textContent = '-- PONG';
      else dashEl.textContent = formatPongShort(getTierPongAmount(tier)) + ' PONG';
    }
  });
  updateGameStakeDisplay();
  updateTokenPriceCard();
}

function startPriceRefresh() {
  fetchPongPrice();
  setInterval(() => {
    if (Date.now() - priceLastFetched > PRICE_REFRESH_MS) {
      fetchPongPrice();
    }
  }, PRICE_REFRESH_MS);
}

function getAuthHeader() {
  if (!sessionToken) return '';
  return 'Bearer ' + sessionToken;
}

// ---- Socket.io ----
// --- Tab routing (must be before tryAutoLogin IIFE) ---
const TAB_ROUTES = {
  '/play': 'play',
  '/dashboard': 'play',
  '/leaderboard': 'leaderboard',
  '/profile': 'profile',
  '/friends': 'friends',
  '/opponents': 'opponents',
  '/cosmetics': 'cosmetics',
  '/shop': 'shop',
  '/history': 'history',
  '/settings': 'settings',
  '/tokenomics': 'tokenomics',
};
const ROUTE_PATHS = {};
Object.entries(TAB_ROUTES).forEach(([path, tab]) => { ROUTE_PATHS[tab] = path; });
let currentDashLbSort = 'earnings';

const socket = io();
window.socket = socket;

socket.on('connect', () => {
  if (currentUser) {
    socket.emit('register', { wallet: currentUser.wallet, username: currentUser.username });
    socket.emit('lobby-list-request');
  }
});

// ===========================================
// WALLET CONNECTION & AUTH
// ===========================================

// --- Maintenance mode state ---
let maintenanceModeActive = false;
let maintenanceAllowedWallets = [];

async function checkMaintenanceMode() {
  try {
    const res = await fetch('/api/server-status');
    const data = await res.json();
    maintenanceModeActive = !!data.maintenance;
    maintenanceAllowedWallets = data.allowedWallets || [];
    return maintenanceModeActive;
  } catch {
    return false;
  }
}

function showMaintenanceScreen() {
  document.getElementById('maintenance-overlay').classList.remove('hidden');
}

function hideMaintenanceScreen() {
  document.getElementById('maintenance-overlay').classList.add('hidden');
}

async function maintenanceConnectWallet() {
  const statusEl = document.getElementById('maintenance-status');
  const btn = document.getElementById('maintenance-connect-btn');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Connecting wallet...';
  statusEl.className = 'text-gray-400 text-sm mt-4';
  try {
    const wallet = await WalletManager.connect();
    const walletAddr = WalletManager.getWallet();
    if (maintenanceAllowedWallets.includes(walletAddr)) {
      statusEl.textContent = 'Access granted! Loading...';
      statusEl.className = 'text-green-400 text-sm mt-4';
      hideMaintenanceScreen();
      // Continue normal auto-login flow
      const saved = localStorage.getItem('pong_session');
      if (saved) {
        try {
          const { token } = JSON.parse(saved);
          const res = await fetch('/api/profile', {
            headers: { Authorization: 'Bearer ' + token }
          }).then(r => r.json());
          if (res.user) {
            sessionToken = token;
            currentUser = res.user;
            showApp();
            return;
          }
        } catch {}
      }
      // No valid session — try login
      const authData = await WalletManager.signAuthMessage();
      const loginRes = await apiPost('/api/auth/login', authData);
      sessionToken = loginRes.token;
      if (loginRes.status === 'existing') {
        currentUser = loginRes.user;
        saveSession();
        showApp();
      } else {
        initDashboard();
      }
    } else {
      statusEl.textContent = 'Access denied. Your wallet is not authorized for maintenance bypass.';
      statusEl.className = 'text-red-400 text-sm mt-4';
    }
  } catch (err) {
    statusEl.textContent = 'Connection failed: ' + err.message;
    statusEl.className = 'text-red-400 text-sm mt-4';
  }
}

(async function tryAutoLogin() {
  // Check maintenance mode first
  const isMaintenance = await checkMaintenanceMode();

  const saved = localStorage.getItem('pong_session');
  if (!saved) {
    if (isMaintenance) {
      showMaintenanceScreen();
      return;
    }
    initDashboard();
    return;
  }
  try {
    const { token } = JSON.parse(saved);
    const res = await fetch('/api/profile', {
      headers: { Authorization: 'Bearer ' + token }
    }).then(r => r.json());
    if (res.user) {
      // If maintenance, check if this user's wallet is allowed
      if (isMaintenance && !maintenanceAllowedWallets.includes(res.user.wallet)) {
        localStorage.removeItem('pong_session');
        showMaintenanceScreen();
        return;
      }
      sessionToken = token;
      currentUser = res.user;
      await WalletManager.reconnectIfTrusted();
      showApp();
    } else {
      localStorage.removeItem('pong_session');
      if (isMaintenance) { showMaintenanceScreen(); return; }
      initDashboard();
    }
  } catch {
    localStorage.removeItem('pong_session');
    if (isMaintenance) { showMaintenanceScreen(); return; }
    initDashboard();
  }
})();

function saveSession() {
  if (sessionToken && currentUser) {
    localStorage.setItem('pong_session', JSON.stringify({ token: sessionToken, wallet: currentUser.wallet }));
  }
}

async function connectWallet() {
  try {
    const wallet = await WalletManager.connect();
    const authData = await WalletManager.signAuthMessage();
    const res = await apiPost('/api/auth/login', authData);
    sessionToken = res.token;
    if (res.status === 'existing') {
      currentUser = res.user;
      saveSession();
      showApp();
    } else if (res.status === 'new') {
      showView('register');
    }
  } catch (err) {
    alert('Wallet connection failed: ' + err.message);
  }
}

async function registerUser() {
  const handle = document.getElementById('reg-handle').value.trim();
  const nickname = document.getElementById('reg-nickname').value.trim();
  const bio = document.getElementById('reg-bio').value.trim();
  if (!handle) return showRegError('Handle is required');
  if (handle.length < 3) return showRegError('Handle must be at least 3 characters');
  if (!/^[a-zA-Z0-9_]+$/.test(handle)) return showRegError('Handle can only contain letters, numbers, underscores');
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({ wallet: WalletManager.getWallet(), handle, nickname: nickname || handle, pfp: '', bio })
    }).then(r => r.json());
    if (res.error) return showRegError(res.error);
    sessionToken = res.token;
    currentUser = res.user;
    saveSession();
    if (cropPendingFile) {
      await uploadPfpFile(cropPendingFile);
      cropPendingFile = null;
    }
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
  removeWalletLocks();
  updateDashboardNickname();
  // Hide the connect wallet button in wallet card since we're logged in
  const connectCardBtn = document.getElementById('btn-connect-wallet-card');
  if (connectCardBtn) connectCardBtn.classList.add('hidden');
  // Route to the tab matching the current URL, or default to play
  const initialTab = getTabFromPath();
  switchTab(initialTab, false);
  // Replace current history entry so back works correctly
  history.replaceState({ tab: initialTab }, '', ROUTE_PATHS[initialTab] || '/play');
  socket.emit('register', { wallet: currentUser.wallet, username: currentUser.username });
  socket.emit('lobby-list-request');
  const canvas = document.getElementById('game-canvas');
  GameClient.init(canvas, currentUser.wallet);
  startPriceRefresh();
  // Show online count
  document.getElementById('online-count').classList.remove('hidden');
  // Fetch unread DM counts
  fetchUnreadCounts();
}

// Show dashboard immediately on load (no wallet gate)
function initDashboard() {
  const initialTab = getTabFromPath();
  switchTab(initialTab, false);
  history.replaceState({ tab: initialTab }, '', ROUTE_PATHS[initialTab] || '/play');
  startPriceRefresh();
  document.getElementById('online-count').classList.remove('hidden');
  socket.emit('lobby-list-request');
  applyWalletLocks();
}

// Check wallet before actions that require it
function requireWallet(action) {
  if (currentUser && sessionToken) return true;
  showToast('Please connect your wallet first');
  connectWallet();
  return false;
}

// Stake Picker Modal
function openStakePicker() {
  if (!requireWallet('play')) return;
  document.getElementById('stake-modal').classList.remove('hidden');
}
function closeStakePicker() {
  document.getElementById('stake-modal').classList.add('hidden');
}

// Wallet lock blur — blur cards that need wallet, show overlay
function applyWalletLocks() {
  if (currentUser) {
    removeWalletLocks();
    return;
  }
  const lockConfigs = [
    { id: 'card-balance', label: 'Connect wallet to view balance' },
    { id: 'card-record', label: 'Connect wallet to view record' },
    { id: 'card-nickname', label: 'Connect wallet to set nickname' },
    { id: 'card-friends', label: 'Connect wallet to see friends' },
  ];
  lockConfigs.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('wallet-locked')) return;
    el.classList.add('wallet-locked');
    const overlay = document.createElement('div');
    overlay.className = 'wallet-lock-overlay';
    overlay.onclick = (e) => { e.stopPropagation(); connectWallet(); };
    overlay.innerHTML = `<div class="lock-btn">${label}</div>`;
    el.appendChild(overlay);
  });
}
function removeWalletLocks() {
  document.querySelectorAll('.wallet-locked').forEach(el => {
    el.classList.remove('wallet-locked');
    const overlay = el.querySelector('.wallet-lock-overlay');
    if (overlay) overlay.remove();
  });
}

function updateNav() {
  const connectBtn = document.getElementById('btn-connect');
  connectBtn.onclick = null;
  // Change wallet button to connected state
  connectBtn.style.background = 'rgba(22, 163, 74, 0.3)';
  connectBtn.style.borderColor = '#22c55e';
  // Update icon bg
  const iconDiv = connectBtn.querySelector('.nav-icon');
  if (iconDiv) iconDiv.style.background = 'rgba(22, 163, 74, 0.4)';
  // Update label
  const label = connectBtn.querySelector('.nav-label');
  if (label) label.textContent = shortenAddress(currentUser.wallet).slice(0,6);
  document.getElementById('nav-username').textContent = currentUser.nickname || currentUser.username;
  const navPfp = document.getElementById('nav-pfp');
  if (currentUser.pfp && navPfp) {
    navPfp.src = currentUser.pfp;
    navPfp.style.display = 'block';
    const fallbackSvg = navPfp.nextElementSibling;
    if (fallbackSvg) fallbackSvg.style.display = 'none';
  }
}

// ===========================================
// CLIENT-SIDE ROUTING
// ===========================================

// (TAB_ROUTES & ROUTE_PATHS declared at top of file)

function getTabFromPath() {
  const path = window.location.pathname;
  if (path === '/' || path === '/home') return 'play';
  return TAB_ROUTES[path] || 'play';
}

function switchTab(tab, pushState) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('tab-active'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  const tabBtn = document.querySelector(`[data-tab="${tab}"]`);
  if (tabBtn) tabBtn.classList.add('tab-active');

  // Update side nav active state
  document.querySelectorAll('#side-nav [data-nav]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === tab);
  });

  // Update URL (don't push on popstate or initial load)
  if (pushState !== false) {
    const targetPath = ROUTE_PATHS[tab] || '/play';
    if (window.location.pathname !== targetPath) {
      history.pushState({ tab }, '', targetPath);
    }
  }

  if (tab === 'play') loadDashboard();
  if (tab === 'profile') loadProfile();
  if (tab === 'friends') loadFriends();
  if (tab === 'cosmetics') loadCosmetics();
  if (tab === 'shop') loadShop();
  if (tab === 'history') loadHistory();
  if (tab === 'leaderboard') loadLeaderboard(currentLbSort);
  if (tab === 'opponents') loadRecentOpponents();
  if (tab === 'settings') loadSettings();
  if (tab === 'tokenomics') loadTokenomics();
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  if (!currentUser) return; // not logged in, ignore
  const tab = (e.state && e.state.tab) ? e.state.tab : getTabFromPath();
  switchTab(tab, false);
});

// ===========================================
// LEADERBOARD
// ===========================================

async function loadLeaderboard(sort) {
  currentLbSort = sort || 'earnings';
  // Update button styles
  ['earnings', 'wins', 'games'].forEach(s => {
    const btn = document.getElementById(`lb-btn-${s}`);
    if (s === currentLbSort) {
      btn.className = 'bg-purple-600 px-4 py-1.5 rounded-lg text-sm font-medium transition';
    } else {
      btn.className = 'bg-gray-700 hover:bg-gray-600 px-4 py-1.5 rounded-lg text-sm font-medium transition';
    }
  });

  try {
    const res = await fetch(`/api/leaderboard?sort=${currentLbSort}&limit=50`).then(r => r.json());
    const container = document.getElementById('leaderboard-list');
    if (!res.users || res.users.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No players yet.</p>';
      return;
    }
    container.innerHTML = res.users.map((u, i) => {
      let statVal;
      if (currentLbSort === 'earnings') {
        statVal = formatPong(u.stats?.totalEarnings || 0) + ' $PONG';
      } else if (currentLbSort === 'wins') {
        statVal = (u.stats?.wins || 0) + ' wins';
      } else {
        statVal = (u.totalGames || ((u.stats?.wins || 0) + (u.stats?.losses || 0))) + ' games';
      }
      const isMe = currentUser && u.wallet === currentUser.wallet;
      return `
        <div class="bg-arena-card rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-800/50 transition ${isMe ? 'border border-purple-500/50' : ''}"
          onclick="showProfilePopup('${u.wallet}')">
          <span class="text-gray-500 font-bold w-8 text-right">#${i + 1}</span>
          <img src="${esc(u.pfp || '')}" class="w-8 h-8 rounded-full bg-gray-700" onerror="this.style.display='none'" />
          <span class="font-medium flex-1">${esc(u.username)}</span>
          <span class="text-gray-400 text-sm">${statVal}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Leaderboard error:', err);
  }
}

// ===========================================
// PROFILE
// ===========================================

function loadProfile() {
  if (!currentUser) return;
  // Banner
  const bannerImg = document.getElementById('profile-banner-img');
  if (currentUser.banner) {
    bannerImg.src = currentUser.banner;
    bannerImg.classList.remove('hidden');
  } else {
    bannerImg.classList.add('hidden');
  }

  document.getElementById('profile-pfp').src = currentUser.pfp || '';
  document.getElementById('profile-nickname').textContent = currentUser.nickname || currentUser.username;
  document.getElementById('profile-handle').textContent = '@' + (currentUser.handle || currentUser.username);
  document.getElementById('profile-wallet').textContent = shortenAddress(currentUser.wallet);
  document.getElementById('edit-nickname').value = currentUser.nickname || currentUser.username;
  document.getElementById('edit-handle-display').textContent = currentUser.handle || currentUser.username;
  document.getElementById('edit-bio').value = currentUser.bio || '';
  document.getElementById('stat-wins').textContent = currentUser.stats?.wins || 0;
  document.getElementById('stat-losses').textContent = currentUser.stats?.losses || 0;
  document.getElementById('stat-earnings').textContent = formatPong(currentUser.stats?.totalEarnings || 0);

  const editPreview = document.getElementById('edit-pfp-preview');
  const editLabel = document.getElementById('edit-pfp-label');
  if (currentUser.pfp) {
    editPreview.src = currentUser.pfp;
    editPreview.classList.remove('hidden');
    editLabel.textContent = 'Drag & drop or click to change';
  } else {
    editPreview.classList.add('hidden');
    editLabel.textContent = 'Drag & drop or click to upload';
  }

  loadDiscordStatus();
}

// ===========================================
// DISCORD LINKING
// ===========================================

let discordCodeTimerInterval = null;

async function loadDiscordStatus() {
  try {
    const res = await fetch('/api/profile/discord', {
      headers: { Authorization: getAuthHeader() }
    });
    const data = await res.json();

    const unlinkedEl = document.getElementById('discord-unlinked');
    const codeEl = document.getElementById('discord-code-state');
    const linkedEl = document.getElementById('discord-linked');

    unlinkedEl.classList.add('hidden');
    codeEl.classList.add('hidden');
    linkedEl.classList.add('hidden');

    if (data.linked) {
      linkedEl.classList.remove('hidden');
      document.getElementById('discord-linked-id').textContent = data.discordId;
    } else {
      unlinkedEl.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Discord status error:', err);
  }
}

async function generateDiscordCode() {
  try {
    const res = await fetch('/api/profile/discord/generate-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() }
    });
    const data = await res.json();
    if (data.code) {
      document.getElementById('discord-unlinked').classList.add('hidden');
      document.getElementById('discord-code-state').classList.remove('hidden');
      document.getElementById('discord-code-display').textContent = data.code;
      startDiscordCodeTimer(new Date(data.expiresAt));
    }
  } catch (err) {
    console.error('Discord code error:', err);
  }
}

function startDiscordCodeTimer(expiresAt) {
  if (discordCodeTimerInterval) clearInterval(discordCodeTimerInterval);
  const timerEl = document.getElementById('discord-code-timer');

  discordCodeTimerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    if (remaining <= 0) {
      clearInterval(discordCodeTimerInterval);
      discordCodeTimerInterval = null;
      timerEl.textContent = 'Code expired';
      // Reset to unlinked state after a moment
      setTimeout(() => loadDiscordStatus(), 1500);
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerEl.textContent = `Expires in ${mins}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

function copyDiscordCode() {
  const code = document.getElementById('discord-code-display').textContent;
  navigator.clipboard.writeText(code);
}

async function unlinkDiscord() {
  if (!confirm('Unlink your Discord account?')) return;
  try {
    await fetch('/api/profile/discord', {
      method: 'DELETE',
      headers: { Authorization: getAuthHeader() }
    });
    loadDiscordStatus();
  } catch (err) {
    console.error('Discord unlink error:', err);
  }
}

async function saveProfile() {
  try {
    const body = {
      nickname: document.getElementById('edit-nickname').value.trim(),
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
      updateDashboardNickname();
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
// NICKNAME / HANDLE
// ===========================================

function updateDashboardNickname() {
  if (!currentUser) return;
  const nicknameEl = document.getElementById('dash-nickname');
  const handleEl = document.getElementById('dash-handle');
  if (nicknameEl) nicknameEl.textContent = currentUser.nickname || currentUser.username;
  if (handleEl) handleEl.textContent = '@' + (currentUser.handle || currentUser.username);
}

function openNicknameEdit() {
  if (!requireWallet('change nickname')) return;
  const input = document.getElementById('nickname-input');
  input.value = currentUser.nickname || currentUser.username;
  document.getElementById('nickname-error').classList.add('hidden');
  document.getElementById('nickname-modal').classList.remove('hidden');
  input.focus();
}

function closeNicknameEdit() {
  document.getElementById('nickname-modal').classList.add('hidden');
}

async function saveNickname() {
  const nickname = document.getElementById('nickname-input').value.trim();
  if (!nickname || nickname.length < 1) {
    const err = document.getElementById('nickname-error');
    err.textContent = 'Nickname cannot be empty';
    err.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({ nickname })
    }).then(r => r.json());
    if (res.error) {
      const err = document.getElementById('nickname-error');
      err.textContent = res.error;
      err.classList.remove('hidden');
      return;
    }
    currentUser = res.user;
    updateNav();
    updateDashboardNickname();
    loadProfile();
    closeNicknameEdit();
    showToast('Nickname updated!');
  } catch (e) {
    const err = document.getElementById('nickname-error');
    err.textContent = 'Failed to save: ' + e.message;
    err.classList.remove('hidden');
  }
}

function openHandleChange() {
  if (!requireWallet('change handle')) return;
  const input = document.getElementById('handle-change-input');
  input.value = '';
  document.getElementById('handle-change-error').classList.add('hidden');
  document.getElementById('handle-change-modal').classList.remove('hidden');
  input.focus();
}

function closeHandleChange() {
  document.getElementById('handle-change-modal').classList.add('hidden');
}

async function submitHandleChange() {
  const newHandle = document.getElementById('handle-change-input').value.trim();
  const errEl = document.getElementById('handle-change-error');
  if (!newHandle || newHandle.length < 3 || newHandle.length > 20) {
    errEl.textContent = 'Handle must be 3-20 characters';
    errEl.classList.remove('hidden');
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(newHandle)) {
    errEl.textContent = 'Only letters, numbers, underscores allowed';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/profile/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({ handle: newHandle })
    }).then(r => r.json());
    if (res.error) {
      errEl.textContent = res.error;
      errEl.classList.remove('hidden');
      return;
    }
    currentUser = res.user;
    updateNav();
    updateDashboardNickname();
    loadProfile();
    closeHandleChange();
    showToast('Handle changed to @' + newHandle);
  } catch (e) {
    errEl.textContent = 'Failed: ' + e.message;
    errEl.classList.remove('hidden');
  }
}

// --- Toast Notification ---
function showToast(message) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Crop Modal State ---
let activeCropper = null;
let cropPendingFile = null;      // stored for registration flow
let cropPendingPrefix = null;    // 'reg' or 'edit'

function openCropModal(file, aspectRatio, uploadType) {
  const modal = document.getElementById('crop-modal');
  const image = document.getElementById('crop-image');
  const title = document.getElementById('crop-modal-title');
  const confirmBtn = document.getElementById('crop-confirm-btn');
  const cancelBtn = document.getElementById('crop-cancel-btn');

  title.textContent = uploadType === 'banner' ? 'Crop Banner' : 'Crop Profile Picture';

  const reader = new FileReader();
  reader.onload = (e) => {
    image.src = e.target.result;
    modal.classList.remove('hidden');

    // Destroy any previous cropper
    if (activeCropper) { activeCropper.destroy(); activeCropper = null; }

    // Wait for image to load before initializing Cropper
    image.onload = () => {
      activeCropper = new Cropper(image, {
        aspectRatio: aspectRatio,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 1,
        responsive: true,
        background: false,
      });
    };
  };
  reader.readAsDataURL(file);

  // Remove old listeners by cloning buttons
  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  newCancel.addEventListener('click', closeCropModal);

  newConfirm.addEventListener('click', () => {
    if (!activeCropper) return;
    const canvas = activeCropper.getCroppedCanvas({
      maxWidth: uploadType === 'banner' ? 1200 : 400,
      maxHeight: uploadType === 'banner' ? 300 : 400,
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const ext = file.name.match(/\.\w+$/)?.[0] || '.png';
      const croppedFile = new File([blob], 'cropped' + ext, { type: blob.type });

      if (uploadType === 'banner') {
        doUploadBanner(croppedFile);
      } else if (uploadType === 'pfp-edit') {
        doUploadPfp(croppedFile);
      } else if (uploadType === 'pfp-reg') {
        // Store cropped file for registration submit
        cropPendingFile = croppedFile;
        showPfpPreviewFromFile(croppedFile, 'reg');
      }
      closeCropModal();
    }, file.type || 'image/png', 0.9);
  });
}

function closeCropModal() {
  const modal = document.getElementById('crop-modal');
  modal.classList.add('hidden');
  if (activeCropper) { activeCropper.destroy(); activeCropper = null; }
}

// --- Banner Upload (after crop) ---
async function doUploadBanner(file) {
  const formData = new FormData();
  formData.append('banner', file);
  try {
    const res = await fetch('/api/profile/upload-banner', {
      method: 'POST',
      headers: { Authorization: getAuthHeader() },
      body: formData,
    }).then(r => r.json());
    if (res.banner) {
      currentUser.banner = res.banner;
      showToast('Banner added!');
      setTimeout(() => location.reload(), 1500);
    } else {
      showProfileMsg(res.error || 'Upload failed', 'red');
    }
  } catch (err) {
    showProfileMsg('Banner upload failed', 'red');
  }
}

function uploadBanner(input) {
  if (!input.files.length) return;
  openCropModal(input.files[0], 16 / 4, 'banner');
  input.value = '';
}

// --- Profile Picture Upload (after crop) ---
async function doUploadPfp(file) {
  const formData = new FormData();
  formData.append('pfp', file);
  try {
    const res = await fetch('/api/profile/upload-pfp', {
      method: 'POST',
      headers: { Authorization: getAuthHeader() },
      body: formData,
    }).then(r => r.json());
    if (res.pfp) {
      currentUser.pfp = res.pfp;
      updateNav();
      showToast('Profile picture added!');
      setTimeout(() => location.reload(), 1500);
    } else {
      showProfileMsg(res.error || 'Upload failed', 'red');
    }
  } catch (err) {
    showProfileMsg('PFP upload failed', 'red');
  }
}

// uploadPfpFile: called from registration flow with the pre-cropped file
async function uploadPfpFile(file) {
  const formData = new FormData();
  formData.append('pfp', file);
  const res = await fetch('/api/profile/upload-pfp', {
    method: 'POST',
    headers: { Authorization: getAuthHeader() },
    body: formData,
  }).then(r => r.json());
  if (res.pfp) {
    currentUser.pfp = res.pfp;
    updateNav();
  }
  return res;
}

function handlePfpSelect(input, prefix) {
  if (!input.files.length) return;
  const file = input.files[0];
  if (prefix === 'edit') {
    openCropModal(file, 1, 'pfp-edit');
  } else {
    // Registration: crop, then store for submit
    openCropModal(file, 1, 'pfp-reg');
  }
  input.value = '';
}

function showPfpPreviewFromFile(file, prefix) {
  const preview = document.getElementById(`${prefix}-pfp-preview`);
  const label = document.getElementById(`${prefix}-pfp-label`);
  const reader = new FileReader();
  reader.onload = (e) => {
    preview.src = e.target.result;
    preview.classList.remove('hidden');
    label.textContent = 'Cropped image ready';
  };
  reader.readAsDataURL(file);
}

function showPfpPreview(file, prefix) {
  const preview = document.getElementById(`${prefix}-pfp-preview`);
  const label = document.getElementById(`${prefix}-pfp-label`);
  const reader = new FileReader();
  reader.onload = (e) => {
    preview.src = e.target.result;
    preview.classList.remove('hidden');
    label.textContent = file.name;
  };
  reader.readAsDataURL(file);
}

function initPfpDropzones() {
  ['reg-pfp-drop', 'edit-pfp-drop'].forEach(id => {
    const zone = document.getElementById(id);
    if (!zone) return;
    const prefix = id.startsWith('reg') ? 'reg' : 'edit';
    const fileInput = document.getElementById(`${prefix}-pfp-file`);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => { zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        handlePfpSelect(fileInput, prefix);
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPfpDropzones);
} else {
  initPfpDropzones();
}

// ===========================================
// PROFILE POPUP MODAL
// ===========================================

let popupWallet = null;

async function showProfilePopup(wallet) {
  popupWallet = wallet;
  try {
    const res = await fetch(`/api/profile/${wallet}`, {
      headers: { Authorization: getAuthHeader() }
    }).then(r => r.json());
    if (!res.user) return;
    const u = res.user;

    // Banner
    const bannerImg = document.getElementById('popup-banner-img');
    if (u.banner) {
      bannerImg.src = u.banner;
      bannerImg.classList.remove('hidden');
    } else {
      bannerImg.classList.add('hidden');
    }

    document.getElementById('popup-pfp').src = u.pfp || '';
    document.getElementById('popup-username').textContent = u.username;
    document.getElementById('popup-bio').textContent = u.bio || '';
    document.getElementById('popup-wins').textContent = u.stats?.wins || 0;
    document.getElementById('popup-losses').textContent = u.stats?.losses || 0;
    document.getElementById('popup-earnings').textContent = formatPong(u.stats?.totalEarnings || 0);

    // Hide add button if already friends or self
    const addBtn = document.getElementById('popup-add-btn');
    const challengeBtn = document.getElementById('popup-challenge-btn');
    const msgBtn = document.getElementById('popup-msg-btn');
    const isSelf = currentUser && wallet === currentUser.wallet;
    const isFriend = currentUser && currentUser.friends && currentUser.friends.includes(wallet);
    addBtn.classList.toggle('hidden', isSelf || isFriend);
    challengeBtn.classList.toggle('hidden', isSelf || !isFriend);
    msgBtn.classList.toggle('hidden', isSelf || !isFriend);

    document.getElementById('profile-popup').classList.remove('hidden');
  } catch (err) {
    console.error('Profile popup error:', err);
  }
}

function closeProfilePopup() {
  document.getElementById('profile-popup').classList.add('hidden');
  popupWallet = null;
}

function popupAddFriend() {
  if (!popupWallet) return;
  addFriend(popupWallet);
  closeProfilePopup();
}

function popupChallenge() {
  if (!popupWallet) return;
  const username = document.getElementById('popup-username').textContent;
  closeProfilePopup();
  openDuelModal(popupWallet, username);
}

function popupMessage() {
  if (!popupWallet) return;
  const username = document.getElementById('popup-username').textContent;
  closeProfilePopup();
  openDmPanel(popupWallet, username);
}

// ===========================================
// FRIENDS (with autocomplete search)
// ===========================================

let searchDebounceTimer = null;

// Init autocomplete on friend search input
function initFriendSearch() {
  const input = document.getElementById('friend-search');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      document.getElementById('search-dropdown').classList.add('hidden');
      return;
    }
    searchDebounceTimer = setTimeout(() => autocompleteSearch(q), 300);
  });
  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#friend-search') && !e.target.closest('#search-dropdown')) {
      document.getElementById('search-dropdown').classList.add('hidden');
    }
  });
}

async function autocompleteSearch(q) {
  try {
    const res = await fetch(`/api/friends/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: getAuthHeader() }
    }).then(r => r.json());

    const dropdown = document.getElementById('search-dropdown');
    if (!res.users || res.users.length === 0) {
      dropdown.innerHTML = '<p class="text-gray-500 text-sm p-3">No users found</p>';
      dropdown.classList.remove('hidden');
      return;
    }
    dropdown.innerHTML = res.users.map(u => `
      <div class="autocomplete-item flex items-center gap-2 px-3 py-2 cursor-pointer"
        onclick="showProfilePopup('${u.wallet}')">
        <img src="${esc(u.pfp || '')}" class="w-7 h-7 rounded-full bg-gray-700" onerror="this.style.display='none'" />
        <span class="font-medium text-sm">${esc(u.username)}</span>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  } catch (err) {
    console.error('Autocomplete search failed:', err);
  }
}

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
  container.innerHTML = friends.map(f => {
    const isOnline = onlineUsers.includes(f.wallet);
    const unread = unreadCounts[f.wallet] || 0;
    return `
      <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
        <div class="flex items-center gap-2 cursor-pointer" onclick="showProfilePopup('${f.wallet}')">
          <div class="w-2 h-2 rounded-full ${isOnline ? 'bg-green-400' : 'bg-gray-600'}"></div>
          <img src="${esc(f.pfp || '')}" class="w-7 h-7 rounded-full bg-gray-700" onerror="this.style.display='none'" />
          <span class="font-medium">${esc(f.username)}</span>
          ${unread > 0 ? `<span class="bg-red-500 text-white text-xs rounded-full px-1.5">${unread}</span>` : ''}
        </div>
        <div class="flex gap-2 items-center">
          <button onclick="openDmPanel('${f.wallet}', '${esc(f.username)}')" class="text-blue-400 hover:text-blue-300 text-xs">Chat</button>
          ${isOnline ? `<button onclick="openDuelModal('${f.wallet}', '${esc(f.username)}')" class="text-yellow-400 hover:text-yellow-300 text-xs">Challenge</button>` : ''}
          <button onclick="removeFriend('${f.wallet}')" class="text-red-400 hover:text-red-300 text-xs">Remove</button>
        </div>
      </div>
    `;
  }).join('');
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
  autocompleteSearch(q);
}

async function addFriend(targetWallet) {
  const res = await apiPostAuth('/api/friends/add', { targetWallet }, getAuthHeader());
  alert(res.message || res.error || 'Done');
  await refreshUserData();
  loadFriends();
}

async function acceptFriend(fromWallet) {
  await apiPostAuth('/api/friends/accept', { fromWallet }, getAuthHeader());
  await refreshUserData();
  loadFriends();
}

async function declineFriend(fromWallet) {
  await apiPostAuth('/api/friends/decline', { fromWallet }, getAuthHeader());
  loadFriends();
}

async function removeFriend(friendWallet) {
  if (!confirm('Remove this friend?')) return;
  await apiPostAuth('/api/friends/remove', { friendWallet }, getAuthHeader());
  await refreshUserData();
  loadFriends();
}

// ===========================================
// RECENT OPPONENTS
// ===========================================

async function loadRecentOpponents() {
  try {
    const res = await fetch('/api/profile/history', {
      headers: { Authorization: getAuthHeader() }
    }).then(r => r.json());

    const container = document.getElementById('opponents-list');
    if (!res.matches || res.matches.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No recent opponents yet.</p>';
      return;
    }

    // Get unique opponents
    const seen = new Set();
    const opponents = [];
    for (const m of res.matches) {
      const oppWallet = m.player1 === currentUser.wallet ? m.player2 : m.player1;
      const oppName = m.player1 === currentUser.wallet ? m.player2Username : m.player1Username;
      if (!seen.has(oppWallet)) {
        seen.add(oppWallet);
        const won = m.winner === currentUser.wallet;
        opponents.push({ wallet: oppWallet, username: oppName, won, score: m.score, tier: m.tier });
      }
    }

    const isFriend = (wallet) => currentUser.friends && currentUser.friends.includes(wallet);

    container.innerHTML = opponents.slice(0, 30).map(o => `
      <div class="bg-arena-card rounded-lg p-3 flex items-center justify-between">
        <div class="flex items-center gap-3 cursor-pointer" onclick="showProfilePopup('${o.wallet}')">
          <div class="w-2 h-2 rounded-full ${onlineUsers.includes(o.wallet) ? 'bg-green-400' : 'bg-gray-600'}"></div>
          <span class="font-medium">${esc(o.username || 'Unknown')}</span>
          <span class="text-xs ${o.won ? 'text-green-400' : 'text-red-400'}">${o.won ? 'W' : 'L'}</span>
          <span class="text-gray-500 text-xs">${o.tier}</span>
        </div>
        <div class="flex gap-2">
          ${isFriend(o.wallet)
            ? '<span class="text-green-400 text-xs">Friends</span>'
            : `<button onclick="addFriend('${o.wallet}')" class="bg-purple-600 hover:bg-purple-700 px-3 py-1 rounded text-xs transition">Add Friend</button>`
          }
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load opponents:', err);
  }
}

// ===========================================
// DIRECT MESSAGES (DM Panel)
// ===========================================

async function fetchUnreadCounts() {
  try {
    const res = await fetch('/api/friends/unread', {
      headers: { Authorization: getAuthHeader() }
    }).then(r => r.json());
    unreadCounts = res.unread || {};
    updateFriendsBadge();
  } catch (err) {
    console.error('Failed to fetch unread:', err);
  }
}

function updateFriendsBadge() {
  const total = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);
  // Update nav badge on side nav
  const navBadge = document.getElementById('nav-friends-badge');
  if (navBadge) {
    if (total > 0) {
      navBadge.textContent = total;
      navBadge.classList.remove('hidden');
    } else {
      navBadge.classList.add('hidden');
    }
  }
}

function openDmPanel(wallet, username) {
  dmOpenWallet = wallet;
  dmOpenUsername = username;
  document.getElementById('dm-panel-username').textContent = username;
  document.getElementById('dm-panel-pfp').src = '';
  document.getElementById('dm-messages').innerHTML = '<p class="text-gray-500 text-xs text-center">Loading...</p>';
  document.getElementById('dm-panel').classList.add('open');
  document.getElementById('dm-input').value = '';

  // Mark as read
  socket.emit('dm-read', { friendWallet: wallet });
  delete unreadCounts[wallet];
  updateFriendsBadge();

  loadDmHistory(wallet);
}

function closeDmPanel() {
  document.getElementById('dm-panel').classList.remove('open');
  dmOpenWallet = null;
  dmOpenUsername = null;
}

async function loadDmHistory(wallet) {
  try {
    const res = await fetch(`/api/friends/messages/${wallet}?limit=50`, {
      headers: { Authorization: getAuthHeader() }
    }).then(r => r.json());

    const container = document.getElementById('dm-messages');
    if (!res.messages || res.messages.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-xs text-center">No messages yet. Say hi!</p>';
      return;
    }
    container.innerHTML = res.messages.map(m => {
      const isMe = m.from === currentUser.wallet;
      return `
        <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
          <div class="max-w-[80%] px-3 py-1.5 rounded-lg text-sm ${isMe ? 'bg-purple-600/40' : 'bg-gray-700'}">
            ${esc(m.text)}
            <div class="text-[10px] text-gray-500 mt-0.5">${formatTime(m.createdAt)}</div>
          </div>
        </div>
      `;
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error('Failed to load DM history:', err);
  }
}

function sendDm() {
  const input = document.getElementById('dm-input');
  const text = input.value.trim();
  if (!text || !dmOpenWallet) return;
  input.value = '';
  socket.emit('dm-send', { to: dmOpenWallet, text });

  // Optimistic add
  const container = document.getElementById('dm-messages');
  const emptyMsg = container.querySelector('p.text-gray-500');
  if (emptyMsg) emptyMsg.remove();
  container.innerHTML += `
    <div class="flex justify-end">
      <div class="max-w-[80%] px-3 py-1.5 rounded-lg text-sm bg-purple-600/40">
        ${esc(text)}
        <div class="text-[10px] text-gray-500 mt-0.5">now</div>
      </div>
    </div>
  `;
  container.scrollTop = container.scrollHeight;
}

// Socket: Receive DM
socket.on('dm-receive', (data) => {
  // If DM panel is open for this sender, add message
  if (dmOpenWallet === data.from) {
    const container = document.getElementById('dm-messages');
    const emptyMsg = container.querySelector('p.text-gray-500');
    if (emptyMsg) emptyMsg.remove();
    container.innerHTML += `
      <div class="flex justify-start">
        <div class="max-w-[80%] px-3 py-1.5 rounded-lg text-sm bg-gray-700">
          ${esc(data.text)}
          <div class="text-[10px] text-gray-500 mt-0.5">now</div>
        </div>
      </div>
    `;
    container.scrollTop = container.scrollHeight;
    socket.emit('dm-read', { friendWallet: data.from });
  } else {
    // Increment unread
    unreadCounts[data.from] = (unreadCounts[data.from] || 0) + 1;
    updateFriendsBadge();
  }
});

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ===========================================
// DUEL INVITE
// ===========================================

function openDuelModal(targetWallet, username) {
  duelTargetWallet = targetWallet;
  document.getElementById('duel-target-name').textContent = username;
  document.getElementById('duel-usd-input').value = '';
  document.getElementById('duel-pong-display').textContent = '';
  document.getElementById('duel-modal').classList.remove('hidden');
}

function closeDuelModal() {
  document.getElementById('duel-modal').classList.add('hidden');
  duelTargetWallet = null;
}

function updateDuelPongAmount() {
  const usdInput = document.getElementById('duel-usd-input').value;
  const display = document.getElementById('duel-pong-display');
  if (!usdInput || pongPriceUsd <= 0) {
    display.textContent = pongPriceUsd <= 0 ? 'Price unavailable — enter $PONG amount directly' : '';
    return;
  }
  const pongAmount = Math.round(parseFloat(usdInput) / pongPriceUsd);
  display.textContent = `≈ ${pongAmount.toLocaleString()} $PONG`;
}

function sendDuelInvite() {
  const usdInput = parseFloat(document.getElementById('duel-usd-input').value);
  if (!usdInput || usdInput <= 0) return alert('Enter a valid USD amount');
  if (pongPriceUsd <= 0) return alert('Price unavailable. Try again later.');
  if (!duelTargetWallet) return;

  const pongAmount = Math.round(usdInput / pongPriceUsd);
  const baseUnits = pongAmount * 1e6; // convert to base units (6 decimals)

  socket.emit('duel-invite', { targetWallet: duelTargetWallet, stakeAmount: baseUnits });
  closeDuelModal();
}

// Socket: Duel sent confirmation
socket.on('duel-sent', (data) => {
  // Could show a toast, but keeping it simple
});

// Socket: Duel error
socket.on('duel-error', (data) => {
  alert(data.error);
});

// Socket: Incoming duel invite
socket.on('duel-incoming', (data) => {
  pendingDuelId = data.duelId;
  const pongAmount = (data.stakeAmount / 1e6);
  const usdAmount = pongPriceUsd > 0 ? ` (${formatUsd(pongAmount * pongPriceUsd)})` : '';
  const stakeText = pongAmount.toLocaleString() + ' $PONG' + usdAmount;

  // Show modal
  document.getElementById('duel-from-name').textContent = data.fromUsername;
  document.getElementById('duel-incoming-stake').textContent = stakeText;
  document.getElementById('duel-incoming-modal').classList.remove('hidden');

  // Also show the persistent challenge bar
  const bar = document.getElementById('challenge-bar');
  const barText = document.getElementById('challenge-bar-text');
  if (bar && barText) {
    barText.textContent = `${data.fromUsername} challenged you for ${stakeText}`;
    bar.classList.remove('hidden');
  }
});

function hideChallengeBar() {
  const bar = document.getElementById('challenge-bar');
  if (bar) bar.classList.add('hidden');
}

function acceptDuel() {
  if (!pendingDuelId) return;
  socket.emit('duel-accept', { duelId: pendingDuelId });
  document.getElementById('duel-incoming-modal').classList.add('hidden');
  hideChallengeBar();
  // Switch to Play tab so user sees the escrow/game flow
  switchTab('play');
  pendingDuelId = null;
}

function declineDuel() {
  if (!pendingDuelId) return;
  socket.emit('duel-decline', { duelId: pendingDuelId });
  document.getElementById('duel-incoming-modal').classList.add('hidden');
  hideChallengeBar();
  pendingDuelId = null;
}

function acceptChallengeFromBar() {
  acceptDuel();
}

function declineChallengeFromBar() {
  declineDuel();
}

socket.on('duel-declined', (data) => {
  alert(`${data.byUsername} declined the duel.`);
});

socket.on('duel-expired', (data) => {
  document.getElementById('duel-incoming-modal').classList.add('hidden');
  hideChallengeBar();
  pendingDuelId = null;
});

// ===========================================
// CUSTOM LOBBIES
// ===========================================

function formatPongAmount(amount) {
  const pong = amount / 1e6;
  if (pong >= 1e6) return (pong / 1e6).toFixed(2) + 'M';
  if (pong >= 1e3) return (pong / 1e3).toFixed(1) + 'K';
  return pong.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function updateLobbyPongDisplay() {
  const usdInput = document.getElementById('lobby-usd-input').value;
  const display = document.getElementById('lobby-pong-display');
  if (!usdInput || pongPriceUsd <= 0) {
    display.textContent = pongPriceUsd <= 0 ? 'Price unavailable' : '';
    return;
  }
  const pongAmount = Math.round(parseFloat(usdInput) / pongPriceUsd);
  display.textContent = `≈ ${pongAmount.toLocaleString()} $PONG`;
}

function createLobby() {
  if (!requireWallet('create a lobby')) return;
  const usdInput = parseFloat(document.getElementById('lobby-usd-input').value);
  if (!usdInput || usdInput <= 0) return alert('Enter a valid USD amount');
  if (pongPriceUsd <= 0) return alert('Price unavailable. Try again later.');

  const pongAmount = Math.round(usdInput / pongPriceUsd);
  const baseUnits = pongAmount * 1e6;

  socket.emit('lobby-create', { stakeAmount: baseUnits });
}

function cancelLobby() {
  if (!myLobbyId) return;
  socket.emit('lobby-cancel', { lobbyId: myLobbyId });
}

function joinLobby(lobbyId) {
  socket.emit('lobby-join', { lobbyId });
}

function applyLobbyFilters() {
  const minInput = document.getElementById('lobby-filter-min');
  const maxInput = document.getElementById('lobby-filter-max');
  lobbyFilterMin = parseFloat(minInput.value) || 0;
  lobbyFilterMax = parseFloat(maxInput.value) || Infinity;
  renderLobbies();
}

function renderLobbies() {
  const container = document.getElementById('lobby-list');
  if (!container) return;

  const filtered = lobbyList.filter(l => {
    if (pongPriceUsd <= 0) return true;
    const usd = (l.stakeAmount / 1e6) * pongPriceUsd;
    return usd >= lobbyFilterMin && usd <= lobbyFilterMax;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">No open lobbies. Create one!</p>';
    return;
  }

  container.innerHTML = filtered.map(l => {
    const pongAmt = l.stakeAmount / 1e6;
    const usdAmt = pongPriceUsd > 0 ? formatUsd(pongAmt * pongPriceUsd) : '--';
    const shortWallet = l.wallet.slice(0, 4) + '...' + l.wallet.slice(-4);
    const isOwn = currentUser && l.wallet === currentUser.wallet;
    return `
      <div class="flex items-center justify-between bg-gray-800/60 rounded-lg px-3 py-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-sm font-bold text-white truncate">${esc(l.username)}</span>
          <span class="text-xs text-gray-500">${shortWallet}</span>
        </div>
        <div class="text-right flex-shrink-0 ml-2">
          <div class="text-sm font-bold text-yellow-400">${usdAmt}</div>
          <div class="text-xs text-gray-500">${formatPongAmount(l.stakeAmount)} $PONG</div>
        </div>
        ${isOwn
          ? '<span class="text-xs text-gray-500 ml-3">Your lobby</span>'
          : `<button onclick="joinLobby('${l.lobbyId}')" class="bg-purple-600 hover:bg-purple-700 px-3 py-1 rounded text-xs font-medium ml-3 transition">Join</button>`
        }
      </div>
    `;
  }).join('');
}

function updateLobbyUI() {
  const createSection = document.getElementById('lobby-create-section');
  const cancelSection = document.getElementById('lobby-cancel-section');
  if (!createSection || !cancelSection) return;

  if (myLobbyId) {
    createSection.classList.add('hidden');
    cancelSection.classList.remove('hidden');
    // Find my lobby in list to show stake
    const myLobby = lobbyList.find(l => l.lobbyId === myLobbyId);
    const stakeEl = document.getElementById('lobby-my-stake');
    if (myLobby && stakeEl) {
      const pong = myLobby.stakeAmount / 1e6;
      const usd = pongPriceUsd > 0 ? formatUsd(pong * pongPriceUsd) + ' — ' : '';
      stakeEl.textContent = `${usd}${formatPongAmount(myLobby.stakeAmount)} $PONG`;
    }
  } else {
    createSection.classList.remove('hidden');
    cancelSection.classList.add('hidden');
  }
}

// Socket: Lobby created
socket.on('lobby-created', (data) => {
  myLobbyId = data.lobbyId;
  document.getElementById('lobby-usd-input').value = '';
  document.getElementById('lobby-pong-display').textContent = '';
  updateLobbyUI();
});

// Socket: Lobby cancelled
socket.on('lobby-cancelled', () => {
  myLobbyId = null;
  updateLobbyUI();
});

// Socket: Lobby list update (broadcast)
socket.on('lobby-update', (data) => {
  lobbyList = data.lobbies || [];
  renderLobbies();
  updateLobbyUI();
});

// Socket: Initial lobby list
socket.on('lobby-list', (data) => {
  lobbyList = data.lobbies || [];
  renderLobbies();
  updateLobbyUI();
});

// Socket: Lobby error
socket.on('lobby-error', (data) => {
  showToast(data.error || 'Lobby error', 'error');
});

// ===========================================
// IN-GAME CHAT
// ===========================================

function sendGameChat() {
  const gameInput = document.getElementById('game-chat-input');
  const postInput = document.getElementById('postgame-chat-input');
  const input = gameInput && !gameInput.closest('.hidden') ? gameInput : postInput;
  if (!input) return;
  const text = input.value.trim();
  if (!text || !currentGameId) return;
  input.value = '';
  socket.emit('game-chat', { gameId: currentGameId, text });
}

socket.on('game-chat-msg', (data) => {
  if (data.gameId !== currentGameId) return;
  const isMe = data.from === currentUser.wallet;
  const msgHtml = `<div class="${isMe ? 'text-purple-300' : 'text-gray-300'}"><span class="font-bold">${esc(data.username)}:</span> ${esc(data.text)}</div>`;

  // Add to in-game chat
  const gameChat = document.getElementById('game-chat-messages');
  if (gameChat) {
    gameChat.innerHTML += msgHtml;
    if (gameChat.children.length > 10) gameChat.removeChild(gameChat.firstChild);
    gameChat.scrollTop = gameChat.scrollHeight;
  }

  // Also add to post-game chat
  const postChat = document.getElementById('postgame-chat-messages');
  if (postChat) {
    postChat.innerHTML += msgHtml;
    if (postChat.children.length > 10) postChat.removeChild(postChat.firstChild);
    postChat.scrollTop = postChat.scrollHeight;
  }
});

// ===========================================
// SHOP (Crate-based)
// ===========================================

async function loadShop() {
  try {
    const auth = getAuthHeader();
    const resp = await fetch('/api/shop', { headers: { Authorization: auth } });
    const res = await resp.json();
    if (res.error) {
      const fallback = document.getElementById('shop-fallback');
      if (fallback) fallback.innerHTML = '<p class="text-red-400 text-sm text-center py-8">Failed to load shop.</p>';
      return;
    }
    const ownedCrates = res.ownedCrates || {};
    const layout = res.layout;
    const allSkins = res.skins || [];
    const allCrates = [...(res.limited || []), ...(res.standard || [])];

    const layoutContainer = document.getElementById('shop-layout-container');
    const fallback = document.getElementById('shop-fallback');
    const ownedSkinIds = (res.inventory || []).map(s => s.skinId);

    // Canvas layout (new)
    if (layout && layout.elements && layout.elements.length > 0) {
      layoutContainer.innerHTML = '';
      fallback.classList.add('hidden');
      layoutContainer.innerHTML = renderCanvasShop(layout, allSkins, allCrates, ownedSkinIds, ownedCrates);
    }
    // Section-based layout (legacy)
    else if (layout && layout.sections && layout.sections.length > 0) {
      layoutContainer.innerHTML = '';
      fallback.classList.add('hidden');

      const sortedSections = [...layout.sections].sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const section of sortedSections) {
        layoutContainer.innerHTML += renderShopSection(section, allSkins, allCrates, ownedCrates);
      }
    } else {
      // Fallback: legacy crate layout
      layoutContainer.innerHTML = '';
      fallback.classList.remove('hidden');

      const limitedSection = document.getElementById('shop-limited-section');
      const limitedGrid = document.getElementById('shop-limited-grid');
      if (res.limited && res.limited.length > 0) {
        limitedSection.classList.remove('hidden');
        limitedGrid.innerHTML = res.limited.map(c => renderCrateCard(c, 'limited', ownedCrates[c.crateId] || 0)).join('');
      } else {
        limitedSection.classList.add('hidden');
      }

      const standardGrid = document.getElementById('shop-standard-grid');
      standardGrid.innerHTML = (res.standard || []).map(c => renderCrateCard(c, 'standard', ownedCrates[c.crateId] || 0)).join('');
    }
    startShopCountdowns();
  } catch (err) {
    console.error('Failed to load shop:', err);
  }
}

// --- Live countdown timers for shop sections ---
let shopCountdownInterval = null;
function startShopCountdowns() {
  if (shopCountdownInterval) clearInterval(shopCountdownInterval);
  shopCountdownInterval = setInterval(updateShopCountdowns, 1000);
  updateShopCountdowns();
}
function updateShopCountdowns() {
  const els = document.querySelectorAll('.shop-countdown[data-expires]');
  const now = Date.now();
  for (const el of els) {
    const exp = new Date(el.dataset.expires).getTime();
    const diff = exp - now;
    if (diff <= 0) {
      el.textContent = 'Expired';
      el.classList.remove('text-yellow-400');
      el.classList.add('text-red-400');
      continue;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    let text = '';
    if (d > 0) text += d + 'd ';
    if (d > 0 || h > 0) text += h + 'h ';
    text += m + 'm ' + s + 's';
    el.textContent = text;
  }
  // Auto-hide expired sections
  const sections = document.querySelectorAll('[data-section-expires]');
  for (const sec of sections) {
    const exp = new Date(sec.dataset.sectionExpires).getTime();
    if (exp <= now) sec.style.display = 'none';
  }
}

function renderShopSection(section, allSkins, allCrates, ownedCrates) {
  // Skip expired sections
  if (section.expiresAt && new Date(section.expiresAt) <= new Date()) return '';

  if (section.type === 'banner') {
    if (!section.bannerImage) return '';
    return `<div class="mb-6 rounded-2xl overflow-hidden"><img src="${esc(section.bannerImage)}" class="w-full" /></div>`;
  }

  const items = (section.items || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (items.length === 0) return '';

  const isFeatured = section.type === 'featured';
  const gridCols = isFeatured ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4';

  let tilesHtml = '';
  for (const item of items) {
    if (item.itemType === 'crate') {
      const crate = allCrates.find(c => c.crateId === item.itemId);
      if (crate) tilesHtml += renderShopTile({ ...crate, _tileType: 'crate', _customIcon: item.customIcon, _iconSize: item.iconSize, _animation: item.animation }, item.size, isFeatured, ownedCrates[crate.crateId] || 0);
    } else {
      const skin = allSkins.find(s => s.skinId === item.itemId);
      if (skin) tilesHtml += renderShopTile({ ...skin, _tileType: 'skin', _customIcon: item.customIcon, _iconSize: item.iconSize, _animation: item.animation }, item.size, isFeatured, 0);
    }
  }

  // Countdown HTML
  let countdownHtml = '';
  if (section.expiresAt) {
    countdownHtml = `<span class="shop-countdown text-xs text-yellow-400 ml-2" data-expires="${esc(section.expiresAt)}"></span>`;
  }

  return `
    <div class="mb-6" ${section.expiresAt ? `data-section-expires="${esc(section.expiresAt)}"` : ''}>
      <div class="flex items-center mb-3">
        ${section.title ? `<h3 class="text-lg font-bold text-white ${isFeatured ? 'text-xl bg-gradient-to-r from-yellow-400 to-purple-400 bg-clip-text text-transparent' : ''}">${esc(section.title)}</h3>` : ''}
        ${countdownHtml}
      </div>
      <div class="grid ${gridCols} gap-3">${tilesHtml}</div>
    </div>`;
}

function renderCanvasShop(layout, allSkins, allCrates, ownedSkinIds, ownedCrates) {
  const ch = layout.canvasHeight || 800;
  const sorted = [...layout.elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  let elHtml = '';
  for (const el of sorted) {
    const bgAlpha = el.opacity != null ? el.opacity : 1;
    const bgColor = el.backgroundColor ? `background-color:${hexToRgba(esc(el.backgroundColor), bgAlpha)};` : '';
    const bgImg = (el.type === 'crate' && el.crateBackgroundImage) ? `background-image:url('${esc(el.crateBackgroundImage)}');background-size:cover;background-position:center;` : '';
    const radius = el.borderRadius ? `border-radius:${el.borderRadius}px;` : '';
    const border = el.borderColor ? `border:1px solid ${esc(el.borderColor)};` : '';
    const base = `position:absolute;left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%;z-index:${el.zIndex||0};${bgColor}${bgImg}${radius}${border}overflow:hidden;box-sizing:border-box;`;

    if (el.type === 'text') {
      const fs = el.fontSize || 24;
      const fc = el.fontColor || '#fff';
      const fw = el.fontWeight || 'normal';
      const ta = el.textAlign || 'left';
      const jc = ta === 'center' ? 'center' : ta === 'right' ? 'flex-end' : 'flex-start';
      elHtml += `<div style="${base}"><div style="width:100%;height:100%;display:flex;align-items:center;padding:6px 8px;font-size:${fs}px;color:${fc};font-weight:${fw};text-align:${ta};overflow:hidden;line-height:1.2;justify-content:${jc}">${esc(el.text || '')}</div></div>`;
    } else if (el.type === 'image') {
      elHtml += `<div style="${base}">${el.imageUrl ? `<img src="${esc(el.imageUrl)}" style="width:100%;height:100%;object-fit:contain" />` : ''}</div>`;
    } else if (el.type === 'skin') {
      const skin = allSkins.find(s => s.skinId === el.itemId);
      if (!skin) { elHtml += `<div style="${base}"></div>`; continue; }
      const owned = ownedSkinIds.includes(skin.skinId);
      const rarityColor = rc(skin.rarity).hex;
      const rarityBg = rc(skin.rarity).bgRgba;
      let preview;
      if (skin.type === 'color') {
        preview = `<div style="width:40px;height:40px;border-radius:50%;background:${esc(skin.cssValue)};box-shadow:0 0 12px ${esc(skin.cssValue)}"></div>`;
      } else {
        preview = `<img src="${esc(skin.imageUrl)}" style="max-height:60%;object-fit:contain" />`;
      }
      const priceDisplay = skin.price != null ? (pongPriceUsd > 0 ? formatUsd(skin.price * pongPriceUsd) + ' / ' : '') + Number(skin.price).toLocaleString() + ' $PONG' : '';
      let actionHtml;
      if (owned) {
        actionHtml = '<span style="color:#4ade80;font-size:11px;font-weight:600">Owned</span>';
      } else if (priceDisplay) {
        actionHtml = `<button onclick="buySkin('${skin.skinId}')" style="background:#7c3aed;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer">${priceDisplay}</button>`;
      } else {
        actionHtml = '<span style="color:#6b7280;font-size:10px">Crate only</span>';
      }
      elHtml += `<div style="${base}border:1px solid ${rarityColor}40;cursor:pointer" class="hover:border-purple-500 transition-all">
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:4px;padding:8px;background:${rarityBg}">
          ${preview}
          <div style="text-align:center">
            <div style="font-size:13px;font-weight:bold;color:#fff">${esc(skin.name)}</div>
            <div style="font-size:9px;color:${rarityColor};text-transform:uppercase">${skin.rarity}</div>
          </div>
          ${actionHtml}
        </div>
      </div>`;
    } else if (el.type === 'crate') {
      const crate = allCrates.find(c => c.crateId === el.itemId);
      if (!crate) { elHtml += `<div style="${base}"></div>`; continue; }
      const owned = ownedCrates[crate.crateId] || 0;
      const usdPrice = pongPriceUsd > 0 ? formatUsd(crate.price * pongPriceUsd) + ' / ' : '';
      const cc = esc(crate.imageColor || '#7c3aed');
      const showIcon = el.crateShowIcon !== false;
      let iconHtml = '';
      if (showIcon) {
        if (el.crateIconImage) {
          iconHtml = `<div style="width:48px;height:48px"><img src="${esc(el.crateIconImage)}" style="width:100%;height:100%;object-fit:contain" /></div>`;
        } else {
          iconHtml = `<div style="width:48px;height:48px">${getCrateIllustration(cc)}</div>`;
        }
      }
      const ctc = el.crateTextColor || '#fff';
      const cfs = el.crateFontSize || 13;
      const ctbg = el.crateTextBg ? 'background:'+esc(el.crateTextBg)+';padding:2px 6px;border-radius:4px;' : '';
      elHtml += `<div style="${base}cursor:pointer" onclick="openCratePreview('${crate.crateId}')" class="hover:border-purple-500 transition-all">
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;padding:8px;color:${ctc}">
          ${iconHtml}
          <div style="text-align:center">
            <div style="font-size:${cfs}px;font-weight:bold;${ctbg}">${esc(crate.name)}</div>
            <div style="font-size:${Math.max(8,cfs-3)}px">${crate.totalSkins || '?'} skins</div>
            <div style="font-size:${Math.max(8,cfs-2)}px;font-weight:500;margin-top:2px">${usdPrice}${Number(crate.price).toLocaleString()} $PONG</div>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">
            ${owned > 0 ? `<button onclick="event.stopPropagation();openOwnedCrate('${crate.crateId}')" style="background:#16a34a;color:#fff;border:none;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer">Open (${owned})</button>` : ''}
            <button onclick="event.stopPropagation();buyCrate('${crate.crateId}')" style="background:#7c3aed;color:#fff;border:none;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer">Buy</button>
          </div>
        </div>
      </div>`;
    }
  }
  return `<div style="position:relative;width:100%;aspect-ratio:1200/${ch};overflow:hidden">${elHtml}</div>`;
}

function shopAnimClass(anim) {
  const map = { glow: 'shop-anim-glow', float: 'shop-anim-float', pulse: 'shop-anim-pulse', shimmer: 'shop-anim-shimmer', fire: 'shop-anim-fire' };
  return map[anim] || '';
}

function shopAnimUnderline(anim) {
  if (!anim || anim === 'none') return '';
  return `<div class="shop-anim-underline shop-ul-${esc(anim)}"></div>`;
}

function renderShopTile(item, size, isFeatured, ownedCount) {
  const sizeClass = size === 'large' ? 'col-span-2 row-span-2' : size === 'small' ? '' : '';
  const height = isFeatured ? 'h-48' : (size === 'large' ? 'h-48' : 'h-32');
  const r = rc(item.rarity);
  const anim = item._animation || 'none';
  const ac = shopAnimClass(anim);
  const isz = item._iconSize || 64;

  if (item._tileType === 'crate') {
    const usdPrice = pongPriceUsd > 0 ? formatUsd(item.price * pongPriceUsd) + ' / ' : '';
    const iconHtml = item._customIcon
      ? `<img src="${esc(item._customIcon)}" style="width:${isz}px;height:${isz}px" class="object-contain ${ac}" />`
      : `<div style="width:${isz}px;height:${isz}px" class="${ac}">${getCrateIllustration(item.imageColor)}</div>`;
    return `
      <div class="${sizeClass} group bg-arena-card rounded-xl border ${r.border} cursor-pointer hover:border-purple-500 transition-all hover:shadow-[0_0_20px_rgba(168,85,247,0.15)] overflow-hidden" onclick="openCratePreview('${item.crateId}')">
        <div class="${height} flex flex-col items-center justify-center bg-gray-900/50 p-4">
          ${iconHtml}
          ${shopAnimUnderline(anim)}
        </div>
        <div class="p-3">
          <h4 class="font-bold text-sm text-white truncate">${esc(item.name)}</h4>
          <p class="text-xs text-gray-500">${item.totalSkins || '?'} skins</p>
          <div class="flex items-center justify-between mt-2">
            <span class="text-xs text-purple-400 font-medium">${usdPrice}${Number(item.price).toLocaleString()} $PONG</span>
            ${ownedCount > 0 ? `<span class="text-xs text-green-400">${ownedCount} owned</span>` : ''}
          </div>
          <div class="flex gap-2 mt-2">
            ${ownedCount > 0 ? `<button onclick="event.stopPropagation();openOwnedCrate('${item.crateId}')" class="flex-1 bg-green-600 hover:bg-green-700 py-1.5 rounded-lg text-xs font-medium transition text-center">Open (${ownedCount})</button>` : ''}
            <button onclick="event.stopPropagation();buyCrate('${item.crateId}')" class="flex-1 bg-purple-600 hover:bg-purple-700 py-1.5 rounded-lg text-xs font-medium transition text-center">Buy</button>
          </div>
        </div>
      </div>`;
  }

  // Skin tile
  const owned = item.owned;
  let preview;
  if (item._customIcon) {
    preview = `<img src="${esc(item._customIcon)}" style="width:${isz}px;height:${isz}px" class="object-contain ${ac}" />`;
  } else if (item.type === 'color') {
    preview = `<div class="rounded-full ${ac}" style="width:${isz}px;height:${isz}px;background:${esc(item.cssValue)};box-shadow:0 0 15px ${esc(item.cssValue)}"></div>`;
  } else {
    preview = `<img src="${esc(item.imageUrl)}" style="height:${isz}px" class="object-contain ${ac}" />`;
  }
  const priceDisplay = item.price != null ? (pongPriceUsd > 0 ? formatUsd(item.price * pongPriceUsd) + ' / ' : '') + Number(item.price).toLocaleString() + ' $PONG' : '';
  const rarityLabel = (item.rarity || 'common').replace('_', ' ');

  return `
    <div class="${sizeClass} group bg-arena-card rounded-xl border ${r.border} transition-all hover:border-purple-500 hover:shadow-[0_0_20px_rgba(168,85,247,0.15)] overflow-hidden">
      <div class="${height} flex flex-col items-center justify-center bg-gray-900/50">
        ${preview}
        ${shopAnimUnderline(anim)}
      </div>
      <div class="p-3">
        <div class="flex items-center gap-1.5 mb-1">
          <h4 class="font-bold text-sm text-white truncate">${esc(item.name)}</h4>
          <span class="text-[10px] px-1 py-0.5 rounded ${r.bg} ${r.tw} uppercase">${rarityLabel}</span>
        </div>
        ${owned
          ? '<span class="text-xs text-green-400 font-medium">Owned</span>'
          : priceDisplay
            ? `<button onclick="buySkin('${item.skinId}')" class="bg-purple-600 hover:bg-purple-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium transition mt-1">${priceDisplay}</button>`
            : '<span class="text-xs text-gray-500">Crate only</span>'}
      </div>
    </div>`;
}

function hexToRgba(hex, alpha) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.substring(0,2),16), g = parseInt(hex.substring(2,4),16), b = parseInt(hex.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getCrateIllustration(color, crateType) {
  const c = esc(color || '#7c3aed');
  return `<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
    <rect x="14" y="28" width="52" height="38" rx="4" fill="#1a1a3a" stroke="${c}" stroke-width="2"/>
    <rect x="14" y="28" width="52" height="13" rx="4" fill="${c}" opacity="0.25"/>
    <line x1="40" y1="28" x2="40" y2="66" stroke="${c}" stroke-width="2" opacity="0.5"/>
    <rect x="32" y="41" width="16" height="8" rx="2" fill="${c}" opacity="0.6"/>
    <path d="M30 28 L40 16 L50 28" stroke="${c}" stroke-width="2" fill="${c}" fill-opacity="0.15" stroke-linejoin="round"/>
    <rect x="36" y="18" width="8" height="4" rx="1" fill="${c}" opacity="0.5"/>
  </svg>`;
}

function renderCrateCard(c, section, ownedCount) {
  const borderColor = section === 'limited' ? 'border-yellow-600/60' : 'border-gray-700/60';
  const glowBg = section === 'limited' ? 'rgba(234,179,8,0.06)' : 'rgba(30,30,60,0.5)';
  const usdPrice = pongPriceUsd > 0 ? formatUsd(c.price * pongPriceUsd) + ' / ' : '';
  const owned = ownedCount || 0;
  const crateType = c.crateType || 'skin';
  const typeBadge = '';
  return `
    <div class="group bg-gray-900/40 rounded-xl border ${borderColor} cursor-pointer hover:border-purple-500 transition-all hover:shadow-[0_0_20px_rgba(168,85,247,0.15)]" onclick="openCratePreview('${c.crateId}')" style="background:${glowBg}">
      <div class="flex gap-3 p-3">
        <!-- Crate Illustration -->
        <div class="w-16 h-16 flex-shrink-0 rounded-lg flex items-center justify-center" style="background:${esc(c.imageColor)}10">
          ${getCrateIllustration(c.imageColor, crateType)}
        </div>
        <!-- Info -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 mb-0.5">
            <h4 class="font-bold text-sm truncate">${esc(c.name)}</h4>
            ${typeBadge}
          </div>
          <p class="text-gray-500 text-xs truncate mb-1.5">${esc(c.description || '')}</p>
          <div class="flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
            ${c.rarityBreakdown.common ? `<span>${c.rarityBreakdown.common}C</span>` : ''}
            ${c.rarityBreakdown.uncommon ? `<span class="text-green-400">${c.rarityBreakdown.uncommon}U</span>` : ''}
            ${c.rarityBreakdown.rare ? `<span class="text-purple-400">${c.rarityBreakdown.rare}R</span>` : ''}
            ${c.rarityBreakdown.super_rare ? `<span class="text-pink-400">${c.rarityBreakdown.super_rare}SR</span>` : ''}
            ${c.rarityBreakdown.legendary ? `<span class="text-yellow-400">${c.rarityBreakdown.legendary}L</span>` : ''}
            ${c.rarityBreakdown.mythic ? `<span class="text-red-400">${c.rarityBreakdown.mythic}M</span>` : ''}
            ${c.rarityBreakdown.secret ? `<span class="text-cyan-300">${c.rarityBreakdown.secret}S</span>` : ''}
            <span class="text-gray-600">|</span>
            <span class="text-white font-semibold">${usdPrice}${c.price.toLocaleString()} $PONG</span>
          </div>
        </div>
      </div>
      <div class="flex gap-2 px-3 pb-3">
        ${owned > 0 ? `<button onclick="event.stopPropagation();openOwnedCrate('${c.crateId}')" class="flex-1 bg-green-600 hover:bg-green-700 py-1.5 rounded-lg text-xs font-medium transition text-center">Open (${owned})</button>` : ''}
        <button onclick="event.stopPropagation();buyCrate('${c.crateId}')" class="flex-1 bg-purple-600 hover:bg-purple-700 py-1.5 rounded-lg text-xs font-medium transition text-center">Buy</button>
      </div>
    </div>
  `;
}

async function openCratePreview(crateId) {
  const modal = document.getElementById('crate-preview-modal');
  const title = document.getElementById('crate-preview-title');
  const grid = document.getElementById('crate-preview-grid');
  const openBtn = document.getElementById('crate-preview-open-btn');
  const buyBtn = document.getElementById('crate-preview-buy-btn');
  grid.innerHTML = '<p class="text-gray-500 text-sm col-span-3 text-center py-6">Loading...</p>';
  modal.classList.remove('hidden');
  openBtn.onclick = function() { closeCratePreview(); buyAndOpenCrate(crateId); };
  buyBtn.onclick = function() { closeCratePreview(); buyCrate(crateId); };
  try {
    const res = await fetch('/api/shop/crate/' + crateId + '/skins', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    if (res.error) { grid.innerHTML = '<p class="text-red-400 text-sm col-span-3 text-center">Failed to load</p>'; return; }
    title.textContent = res.crate.name + ' — Contents';
    if (res.skins.length === 0) {
      grid.innerHTML = '<p class="text-gray-500 text-sm col-span-3 text-center py-6">No skins in this crate.</p>';
      return;
    }
    grid.innerHTML = res.skins.map(s => {
      const rarityClass = rarityBadge(s.rarity);
      const chancePct = s.chance >= 1 ? s.chance.toFixed(0) + '%' : s.chance >= 0.1 ? s.chance.toFixed(1) + '%' : s.chance.toFixed(2) + '%';
      const chanceColor = rc(s.rarity).tw;
      let preview, bgColor;
      if (s.type === 'color') {
        preview = `<div class="w-8 h-8 rounded-full" style="background:${esc(s.cssValue)};box-shadow:0 0 12px ${esc(s.cssValue)}"></div>`;
        bgColor = esc(s.cssValue) + '33';
      } else {
        preview = `<img src="${esc(s.imageUrl)}" class="h-14 object-contain" />`;
        bgColor = '#1a1a3a';
      }
      return `
        <div class="bg-gray-800/50 rounded-lg p-3 flex flex-col items-center gap-1.5 border border-gray-700">
          <div class="w-full h-16 rounded-lg flex items-center justify-center"
            style="background:${bgColor}">
            ${preview}
          </div>
          <h4 class="font-bold text-xs text-center truncate w-full">${esc(s.name)}</h4>
          <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${(s.rarity || 'common').replace('_', ' ')}</span>
          <span class="text-xs font-mono ${chanceColor}">${chancePct}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = '<p class="text-red-400 text-sm col-span-3 text-center">Failed to load skins</p>';
  }
}

function closeCratePreview() {
  document.getElementById('crate-preview-modal').classList.add('hidden');
}

async function buyCrate(crateId) {
  if (!requireWallet('buy crate')) return;
  try {
    const auth = getAuthHeader();
    const buyRes = await apiPostAuth('/api/shop/buy-crate', { crateId }, auth);
    const txSignature = await WalletManager.signAndSendTransaction(buyRes.transaction);
    await apiPostAuth('/api/shop/confirm-crate', { crateId, txSignature }, auth);
    showToast('Crate purchased!');
    loadShop();
  } catch (err) {
    showToast('Purchase failed: ' + err.message);
  }
}

async function buyAndOpenCrate(crateId) {
  if (!requireWallet('buy crate')) return;
  try {
    const auth = getAuthHeader();
    const buyRes = await apiPostAuth('/api/shop/buy-crate', { crateId }, auth);
    const txSignature = await WalletManager.signAndSendTransaction(buyRes.transaction);
    await apiPostAuth('/api/shop/confirm-crate', { crateId, txSignature }, auth);
    // Now immediately open it from inventory
    const openRes = await apiPostAuth('/api/shop/open-crate', { crateId }, auth);
    showCrateRoller(openRes.skin, openRes.crateSkins || [], openRes.duplicate);
  } catch (err) {
    showToast('Purchase failed: ' + err.message);
  }
}

async function openOwnedCrate(crateId) {
  if (!requireWallet('open crate')) return;
  try {
    const auth = getAuthHeader();
    const openRes = await apiPostAuth('/api/shop/open-crate', { crateId }, auth);
    showCrateRoller(openRes.skin, openRes.crateSkins || [], openRes.duplicate);
  } catch (err) {
    showToast('Failed to open crate: ' + err.message);
  }
}

async function buySkin(skinId) {
  if (!requireWallet('buy skin')) return;
  try {
    const auth = getAuthHeader();
    const buyRes = await apiPostAuth('/api/shop/buy-skin', { skinId }, auth);
    const txSignature = await WalletManager.signAndSendTransaction(buyRes.transaction);
    await apiPostAuth('/api/shop/confirm-skin', { skinId, txSignature }, auth);
    showToast('Skin purchased!');
    loadShop();
  } catch (err) {
    showToast('Purchase failed: ' + err.message);
  }
}

// ===========================================
// CRATE ROLLER ANIMATION + SOUND EFFECTS
// ===========================================

let rollerAudioCtx = null;
function getRollerAudioCtx() {
  if (!rollerAudioCtx) rollerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return rollerAudioCtx;
}

function playTickSound(progress) {
  try {
    const ctx = getRollerAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 400 + progress * 400;
    osc.type = 'square';
    gain.gain.value = 0.08;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  } catch (e) {}
}

function playRevealSound(rarity) {
  try {
    const ctx = getRollerAudioCtx();
    const isHigh = ['secret', 'mythic', 'legendary'].includes(rarity);
    const isMid = ['super_rare', 'rare'].includes(rarity);
    const freqs = isHigh ? [523, 659, 784, 1047] : isMid ? [523, 659, 784] : [523, 659];
    const duration = isHigh ? 1.2 : isMid ? 0.8 : 0.5;
    const volume = isHigh ? 0.15 : isMid ? 0.12 : 0.08;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const startTime = ctx.currentTime + i * 0.08;
      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    });
  } catch (e) {}
}

function buildRollerStrip(wonSkin, crateSkins) {
  const TOTAL_CARDS = 36;
  const WIN_INDEX = 30;
  const strip = document.getElementById('roller-strip');
  strip.innerHTML = '';
  strip.style.transform = 'translateX(0px)';
  const pool = crateSkins.length > 0 ? crateSkins : [wonSkin];
  const cards = [];
  for (let i = 0; i < TOTAL_CARDS; i++) {
    let skin = i === WIN_INDEX ? wonSkin : pool[Math.floor(Math.random() * pool.length)];
    const card = document.createElement('div');
    card.className = `roller-card rarity-${skin.rarity}`;
    card.style.background = '#111128';
    if (skin.type === 'color') {
      card.innerHTML = `<div style="width:36px;height:36px;border-radius:50%;background:${esc(skin.cssValue)};box-shadow:0 0 10px ${esc(skin.cssValue)}"></div><div style="font-size:10px;color:#ccc;margin-top:4px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:90px">${esc(skin.name)}</div>`;
    } else {
      card.innerHTML = `<img src="${esc(skin.imageUrl)}" style="height:44px;object-fit:contain;" /><div style="font-size:10px;color:#ccc;margin-top:4px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:90px">${esc(skin.name)}</div>`;
    }
    strip.appendChild(card);
    cards.push({ el: card, skin });
  }
  return { cards, winIndex: WIN_INDEX };
}

function animateRoller(cards, winIndex) {
  return new Promise((resolve) => {
    const strip = document.getElementById('roller-strip');
    const container = strip.parentElement;
    const containerWidth = container.offsetWidth;
    const cardWidth = 108;
    const centerOffset = containerWidth / 2 - cardWidth / 2;
    const targetX = winIndex * cardWidth - centerOffset;
    const finalX = targetX + (Math.random() * 20 - 10);
    const DURATION = 4500;
    const startTime = performance.now();
    let lastCardIndex = -1;
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / DURATION, 1);
      const easedProgress = easeOutCubic(progress);
      const currentX = easedProgress * finalX;
      strip.style.transform = `translateX(${-currentX}px)`;
      const centerWorldX = currentX + centerOffset;
      const currentCardIndex = Math.floor(centerWorldX / cardWidth);
      if (currentCardIndex !== lastCardIndex && currentCardIndex >= 0) {
        lastCardIndex = currentCardIndex;
        playTickSound(progress);
      }
      if (progress < 1) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
}

function showFinalReveal(skin, isDuplicate) {
  const preview = document.getElementById('roller-reveal-preview');
  const nameEl = document.getElementById('roller-reveal-name');
  const rarityEl = document.getElementById('roller-reveal-rarity');
  const revealDiv = document.getElementById('roller-reveal');
  if (skin.type === 'color') {
    preview.innerHTML = `<div class="w-16 h-16 rounded-full" style="background:${esc(skin.cssValue)};box-shadow:0 0 20px ${esc(skin.cssValue)}"></div>`;
    preview.style.background = skin.cssValue + '22';
  } else {
    preview.innerHTML = `<img src="${esc(skin.imageUrl)}" class="h-20 object-contain" />`;
    preview.style.background = '#1a1a3a';
  }
  nameEl.textContent = skin.name;
  // uses global rc() for rarity colors
  const rarityLabel = (skin.rarity || 'common').replace('_', ' ').toUpperCase();
  rarityEl.textContent = isDuplicate ? rarityLabel + ' (DUPLICATE)' : rarityLabel;
  rarityEl.className = `text-sm mb-4 font-bold ${isDuplicate ? 'text-gray-500' : rc(skin.rarity).tw}`;
  if (['secret', 'mythic', 'legendary'].includes(skin.rarity)) {
    const flash = document.getElementById('roller-flash');
    flash.style.opacity = '0.6';
    setTimeout(() => { flash.style.opacity = '0'; }, 300);
    preview.classList.add('reveal-glow');
  } else if (['super_rare', 'rare'].includes(skin.rarity)) {
    preview.classList.add('reveal-glow');
  }
  playRevealSound(skin.rarity);
  revealDiv.classList.remove('hidden');
}

async function showCrateRoller(wonSkin, crateSkins, isDuplicate) {
  const modal = document.getElementById('crate-roller-modal');
  const revealDiv = document.getElementById('roller-reveal');
  const flash = document.getElementById('roller-flash');
  const preview = document.getElementById('roller-reveal-preview');
  revealDiv.classList.add('hidden');
  flash.style.opacity = '0';
  preview.classList.remove('reveal-glow');
  modal.classList.remove('hidden');
  const { cards, winIndex } = buildRollerStrip(wonSkin, crateSkins);
  await new Promise(r => setTimeout(r, 300));
  await animateRoller(cards, winIndex);

  if (wonSkin.rarity === 'secret') {
    // Hide roller modal, launch epic cutscene
    modal.classList.add('hidden');
    await playSecretCutscene(wonSkin, isDuplicate);
  } else {
    showFinalReveal(wonSkin, isDuplicate);
  }
}

function closeRoller() {
  document.getElementById('crate-roller-modal').classList.add('hidden');
  document.getElementById('roller-reveal').classList.add('hidden');
  document.getElementById('roller-reveal-preview').classList.remove('reveal-glow');
  loadShop();
}

// ===========================================
// SECRET RARITY — EPIC CUTSCENE
// ===========================================

let secretParticleAnim = null;

function playSecretCutscene(skin, isDuplicate) {
  return new Promise((resolve) => {
    const cutscene = document.getElementById('secret-cutscene');
    const canvas = document.getElementById('secret-particles');
    const flashLayer = document.getElementById('secret-flash-layer');
    const content = document.getElementById('secret-content');
    const itemPreview = document.getElementById('secret-item-preview');
    const label = document.getElementById('secret-label');
    const nameEl = document.getElementById('secret-skin-name');
    const descEl = document.getElementById('secret-skin-desc');
    const ctx = canvas.getContext('2d');

    // Reset all
    content.style.opacity = '0';
    label.style.opacity = '0';
    nameEl.style.opacity = '0';
    descEl.style.opacity = '0';
    flashLayer.style.opacity = '0';
    flashLayer.style.transition = 'none';
    itemPreview.innerHTML = '';
    cutscene.classList.remove('hidden');

    // Size canvas
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    // ---- Particle system ----
    const particles = [];
    const phase = { current: 0 }; // 0=vortex, 1=converge, 2=explode, 3=ambient

    function spawnParticle(opts = {}) {
      const angle = Math.random() * Math.PI * 2;
      const dist = opts.dist || (150 + Math.random() * 300);
      particles.push({
        x: opts.x ?? (cx + Math.cos(angle) * dist),
        y: opts.y ?? (cy + Math.sin(angle) * dist),
        vx: opts.vx || 0, vy: opts.vy || 0,
        size: opts.size || (1 + Math.random() * 3),
        life: opts.life || (60 + Math.random() * 120),
        maxLife: opts.life || (60 + Math.random() * 120),
        hue: opts.hue ?? (180 + Math.random() * 60), // cyan range
        angle, dist, speed: opts.speed || (0.02 + Math.random() * 0.03),
      });
    }

    // Spawn initial vortex particles
    for (let i = 0; i < 200; i++) spawnParticle();

    function updateParticles() {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life--;
        if (p.life <= 0) { particles.splice(i, 1); continue; }

        if (phase.current === 0) {
          // Vortex — orbit and slowly pull in
          p.angle += p.speed;
          p.dist = Math.max(p.dist - 0.5, 10);
          p.x = cx + Math.cos(p.angle) * p.dist;
          p.y = cy + Math.sin(p.angle) * p.dist;
        } else if (phase.current === 1) {
          // Converge to center fast
          const dx = cx - p.x, dy = cy - p.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 5) { p.x += dx * 0.08; p.y += dy * 0.08; }
        } else if (phase.current === 2) {
          // Explode outward
          p.x += p.vx; p.y += p.vy;
          p.vx *= 0.97; p.vy *= 0.97;
        } else {
          // Ambient float
          p.angle += p.speed * 0.5;
          p.x += Math.cos(p.angle) * 0.5;
          p.y += Math.sin(p.angle) * 0.3 + p.vy;
          p.vy = (p.vy || 0) - 0.01;
        }
      }
    }

    function drawParticles() {
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        const alpha = Math.min(1, p.life / p.maxLife * 2);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${alpha})`;
        ctx.fill();
        // Glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${alpha * 0.15})`;
        ctx.fill();
      }
    }

    let frameId;
    function particleLoop() {
      updateParticles();
      drawParticles();
      frameId = requestAnimationFrame(particleLoop);
    }
    frameId = requestAnimationFrame(particleLoop);
    secretParticleAnim = frameId;

    // ---- Sound: building tension ----
    function playSecretBuildSound() {
      try {
        const actx = getRollerAudioCtx();
        // Low rumble
        const rumble = actx.createOscillator();
        const rumbleGain = actx.createGain();
        rumble.connect(rumbleGain); rumbleGain.connect(actx.destination);
        rumble.frequency.value = 60;
        rumble.type = 'sawtooth';
        rumbleGain.gain.setValueAtTime(0, actx.currentTime);
        rumbleGain.gain.linearRampToValueAtTime(0.08, actx.currentTime + 1.5);
        rumbleGain.gain.linearRampToValueAtTime(0.12, actx.currentTime + 2.5);
        rumbleGain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 3);
        rumble.start(actx.currentTime);
        rumble.stop(actx.currentTime + 3);

        // Rising tone
        const rise = actx.createOscillator();
        const riseGain = actx.createGain();
        rise.connect(riseGain); riseGain.connect(actx.destination);
        rise.frequency.setValueAtTime(200, actx.currentTime);
        rise.frequency.exponentialRampToValueAtTime(2000, actx.currentTime + 2.5);
        rise.type = 'sine';
        riseGain.gain.setValueAtTime(0, actx.currentTime);
        riseGain.gain.linearRampToValueAtTime(0.05, actx.currentTime + 1);
        riseGain.gain.linearRampToValueAtTime(0.1, actx.currentTime + 2.3);
        riseGain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 2.8);
        rise.start(actx.currentTime);
        rise.stop(actx.currentTime + 3);
      } catch (e) {}
    }

    function playSecretRevealSound() {
      try {
        const actx = getRollerAudioCtx();
        // Impact boom
        const boom = actx.createOscillator();
        const boomGain = actx.createGain();
        boom.connect(boomGain); boomGain.connect(actx.destination);
        boom.frequency.value = 80;
        boom.type = 'sine';
        boomGain.gain.setValueAtTime(0.3, actx.currentTime);
        boomGain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.8);
        boom.start(actx.currentTime);
        boom.stop(actx.currentTime + 0.8);

        // Bright chime arpeggio
        const notes = [523, 659, 784, 1047, 1319, 1568];
        notes.forEach((freq, i) => {
          const osc = actx.createOscillator();
          const gain = actx.createGain();
          osc.connect(gain); gain.connect(actx.destination);
          osc.frequency.value = freq;
          osc.type = 'sine';
          const t = actx.currentTime + 0.1 + i * 0.07;
          gain.gain.setValueAtTime(0.12, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
          osc.start(t);
          osc.stop(t + 1.5);
        });

        // Shimmer noise
        const bufferSize = actx.sampleRate * 2;
        const buffer = actx.createBuffer(1, bufferSize, actx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
        const noise = actx.createBufferSource();
        noise.buffer = buffer;
        const noiseFilter = actx.createBiquadFilter();
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 6000;
        const noiseGain = actx.createGain();
        noise.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(actx.destination);
        noiseGain.gain.setValueAtTime(0.06, actx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 1.5);
        noise.start(actx.currentTime);
        noise.stop(actx.currentTime + 1.5);
      } catch (e) {}
    }

    // ---- Timeline ----
    playSecretBuildSound();

    // Phase 0: Vortex (0-2s) — already running
    // Add more particles over time
    const spawnInterval = setInterval(() => {
      for (let i = 0; i < 8; i++) spawnParticle({ hue: 170 + Math.random() * 80 });
    }, 50);

    // Phase 1: Converge (2s)
    setTimeout(() => { phase.current = 1; }, 2000);

    // Phase 2: Flash + Explode (2.8s)
    setTimeout(() => {
      clearInterval(spawnInterval);
      phase.current = 2;

      // Flash
      flashLayer.style.transition = 'none';
      flashLayer.style.opacity = '1';
      setTimeout(() => {
        flashLayer.style.transition = 'opacity 0.6s ease-out';
        flashLayer.style.opacity = '0';
      }, 80);

      playSecretRevealSound();

      // Explode particles outward
      for (const p of particles) {
        const angle = Math.atan2(p.y - cy, p.x - cx);
        const speed = 4 + Math.random() * 12;
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed;
        p.life = 60 + Math.random() * 40;
        p.maxLife = p.life;
        p.hue = Math.random() * 360; // Rainbow explosion
      }

      // Spawn explosion particles
      for (let i = 0; i < 150; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 3 + Math.random() * 15;
        spawnParticle({
          x: cx, y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 1 + Math.random() * 4,
          life: 50 + Math.random() * 60,
          hue: Math.random() * 360,
        });
      }

      // Ring bursts
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          const ring = document.createElement('div');
          ring.className = 'secret-ring-burst';
          ring.style.left = (cx - 50) + 'px';
          ring.style.top = (cy - 50) + 'px';
          ring.style.borderColor = `hsl(${180 + i * 40}, 80%, 60%)`;
          cutscene.appendChild(ring);
          setTimeout(() => ring.remove(), 1000);
        }, i * 200);
      }
    }, 2800);

    // Phase 3: Show item (3.5s)
    setTimeout(() => {
      phase.current = 3;
      content.style.opacity = '1';
      content.style.transition = 'opacity 0.3s';

      // Skin preview
      if (skin.type === 'color') {
        itemPreview.innerHTML = `<div class="w-20 h-20 rounded-full" style="background:${esc(skin.cssValue)};box-shadow:0 0 40px ${esc(skin.cssValue)}, 0 0 80px ${esc(skin.cssValue)}44"></div>`;
      } else {
        itemPreview.innerHTML = `<img src="${esc(skin.imageUrl)}" class="h-24 object-contain" style="filter:drop-shadow(0 0 20px rgba(6,182,212,0.8))" />`;
      }

      // Ambient sparkle particles
      const ambientInterval = setInterval(() => {
        for (let i = 0; i < 3; i++) {
          spawnParticle({
            x: cx + (Math.random() - 0.5) * 400,
            y: cy + (Math.random() - 0.5) * 400,
            size: 0.5 + Math.random() * 2,
            life: 80 + Math.random() * 80,
            hue: 170 + Math.random() * 80,
            speed: 0.01 + Math.random() * 0.02,
            vy: -0.3 - Math.random() * 0.5,
          });
        }
      }, 80);

      // Cleanup ambient on close
      cutscene._ambientInterval = ambientInterval;
    }, 3500);

    // Show label (4s)
    setTimeout(() => {
      label.style.opacity = '1';
      label.textContent = isDuplicate ? 'SECRET (DUPLICATE)' : 'SECRET';
    }, 4000);

    // Show name (4.5s)
    setTimeout(() => {
      nameEl.style.opacity = '1';
      nameEl.textContent = skin.name;
      descEl.style.opacity = '1';
      descEl.textContent = skin.description || '';
    }, 4500);

    // Click to close
    function onClose() {
      cutscene.removeEventListener('click', onClose);
      cancelAnimationFrame(frameId);
      if (cutscene._ambientInterval) clearInterval(cutscene._ambientInterval);
      cutscene.classList.add('hidden');
      particles.length = 0;
      ctx.clearRect(0, 0, W, H);
      loadShop();
      resolve();
    }

    // Allow closing after 5s
    setTimeout(() => {
      cutscene.addEventListener('click', onClose);
    }, 5000);
  });
}

async function equipSkin(skinId) {
  if (!requireWallet('equip')) return;
  try {
    const result = await apiPostAuth('/api/shop/equip', { skinId }, getAuthHeader());
    if (result.status === 'equipped') {
      loadShop();
      showToast('Skin equipped!');
    }
  } catch (err) {
    console.error('Equip failed:', err);
    showToast(err.message || 'Failed to equip skin');
  }
}

// ===========================================
// MATCH HISTORY
// ===========================================

async function loadHistory() {
  try {
    const res = await fetch('/api/profile/history', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
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
  if (!requireWallet('join a match')) return;
  closeStakePicker();
  // Auto-cancel any open lobby when joining queue
  if (myLobbyId) {
    socket.emit('lobby-cancel', { lobbyId: myLobbyId });
    myLobbyId = null;
    updateLobbyUI();
  }
  // For USD-based tiers, compute the PONG amount from live price
  const usdAmount = TIER_USD_AMOUNTS[tier];
  if (usdAmount && pongPriceUsd <= 0) {
    return alert('$PONG price not available yet. Please wait a moment.');
  }
  const pongAmount = usdAmount ? getTierPongAmount(tier) : (TIER_PONG_AMOUNTS[tier] || 0);

  socket.emit('queue-join', { tier, pongAmount });
  currentGameTier = tier;
  showMatchmakingState('queue');
  const pongDisplay = formatPongShort(pongAmount);
  const usdDisplay = usdAmount ? formatUsd(usdAmount) : '';
  document.getElementById('queue-tier-display').textContent = usdDisplay
    ? `${usdDisplay} — ${pongDisplay} $PONG each`
    : `${pongDisplay} $PONG each`;
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

let myPlayerSlot = null;
let currentGameTier = null;

function updateGameStakeDisplay() {
  const el = document.getElementById('game-stake-display');
  if (!el || !currentGameTier) return;
  if (currentGameTier === 'duel' && currentCustomStake) {
    const pongAmt = currentCustomStake / 1e6;
    const usdAmt = pongPriceUsd > 0 ? formatUsd(pongAmt * pongPriceUsd) : '';
    el.textContent = usdAmt ? `${usdAmt} (${pongAmt.toLocaleString()} $PONG each)` : `${pongAmt.toLocaleString()} $PONG each`;
  } else {
    const usdTier = TIER_USD_AMOUNTS[currentGameTier];
    if (usdTier) {
      const pongAmt = getTierPongAmount(currentGameTier);
      el.textContent = pongAmt > 0
        ? `${formatUsd(usdTier)} (${formatPongShort(pongAmt)} $PONG each)`
        : formatUsd(usdTier) + ' each';
    } else {
      const pongAmt = TIER_PONG_AMOUNTS[currentGameTier] || 0;
      const usdAmt = getTierUsd(currentGameTier);
      if (pongPriceUsd > 0 && pongAmt) {
        el.textContent = `${formatUsd(usdAmt)} (${formatPongShort(pongAmt)} $PONG each)`;
      } else if (pongAmt) {
        el.textContent = `${formatPongShort(pongAmt)} $PONG each`;
      } else {
        el.textContent = '';
      }
    }
  }
}

let currentCustomStake = null;

// Socket: Match found
socket.on('match-found', (data) => {
  currentGameId = data.gameId;
  pendingEscrowTx = data.escrowTransaction;
  myPlayerSlot = data.yourSlot;
  currentGameTier = data.tier;
  currentCustomStake = data.tier === 'duel' ? data.stake : null;

  document.getElementById('escrow-opponent').textContent = data.opponent.username;
  const pongText = formatPong(data.stake) + ' $PONG';
  const pongDisplayAmt = data.stake / 1e6;
  const usdText = pongPriceUsd > 0 ? formatUsd(pongDisplayAmt * pongPriceUsd) : '';
  document.getElementById('escrow-stake').innerHTML = usdText
    ? `<span class="text-2xl">${usdText}</span> <span class="text-sm text-gray-400">(${pongText})</span>`
    : pongText;

  const btn = document.getElementById('btn-escrow-submit');
  if (btn) { btn.disabled = false; btn.textContent = 'Approve & Stake'; btn.classList.remove('hidden'); }
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
    const txSignature = await WalletManager.signAndSendTransaction(pendingEscrowTx);
    if (btn) btn.textContent = 'Verifying on-chain...';
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
// READY SYSTEM
// ===========================================

let isReady = false;

function sendReady() {
  if (!currentGameId || isReady) return;
  isReady = true;
  socket.emit('player-ready', { gameId: currentGameId });
  const btn = document.getElementById('btn-ready');
  if (btn) {
    btn.textContent = 'READY!';
    btn.className = 'bg-green-800 px-8 py-3 rounded-lg text-lg font-bold cursor-not-allowed';
    btn.disabled = true;
  }
}

socket.on('ready-status', (data) => {
  if (data.gameId !== currentGameId) return;
  const amP1 = myPlayerSlot === 'p1';
  const myReady = amP1 ? data.p1Ready : data.p2Ready;
  const oppReady = amP1 ? data.p2Ready : data.p1Ready;

  document.getElementById('ready-you-dot').className = `w-4 h-4 rounded-full mx-auto mb-1 ${myReady ? 'bg-green-400' : 'bg-gray-600'}`;
  document.getElementById('ready-opp-dot').className = `w-4 h-4 rounded-full mx-auto mb-1 ${oppReady ? 'bg-green-400' : 'bg-gray-600'}`;
});

socket.on('ready-countdown', (data) => {
  if (data.gameId !== currentGameId) return;
  // Stop the intermission countdown so it doesn't overlap
  if (intermissionCountdownInterval) {
    clearInterval(intermissionCountdownInterval);
    intermissionCountdownInterval = null;
  }
  // Hide side picker and ready button during countdown
  const sidePicker = document.getElementById('side-picker');
  if (sidePicker) sidePicker.classList.add('hidden');
  const readySection = document.getElementById('ready-section');
  if (readySection) readySection.classList.add('hidden');

  const countdownEl = document.getElementById('intermission-countdown');
  let sec = data.seconds;
  function tick() {
    if (countdownEl) countdownEl.textContent = sec;
    sec--;
    if (sec >= 0) {
      setTimeout(tick, 1000);
    }
  }
  tick();
});

socket.on('ready-expired', (data) => {
  if (data.gameId !== currentGameId) return;
  alert(data.reason || 'Ready timeout. Game cancelled.');
  backToMatchmaking();
});

socket.on('ready-phase', (data) => {
  // Reset ready UI
  isReady = false;
  const btn = document.getElementById('btn-ready');
  if (btn) {
    btn.textContent = 'READY';
    btn.className = 'bg-green-600 hover:bg-green-700 px-8 py-3 rounded-lg text-lg font-bold transition';
    btn.disabled = false;
  }
  document.getElementById('ready-you-dot').className = 'w-4 h-4 rounded-full bg-gray-600 mx-auto mb-1';
  document.getElementById('ready-opp-dot').className = 'w-4 h-4 rounded-full bg-gray-600 mx-auto mb-1';
});

// ===========================================
// SIDE PICKER
// ===========================================

function pickSide(side) {
  chosenSide = side;
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

// Socket: Game countdown (30s ready-up phase)
let pendingP1Skin = null;
let pendingP2Skin = null;
let intermissionCountdownInterval = null;

socket.on('game-countdown', (data) => {
  showMatchmakingState('game');
  GameClient.setGameInfo(data.gameId, null);
  currentGameId = data.gameId;
  currentGameTier = data.tier;
  currentCustomStake = data.stakeAmount || null;

  // Determine player slot
  if (data.player1 && data.player2) {
    myPlayerSlot = currentUser.wallet === data.player1.wallet ? 'p1' : 'p2';
  }

  pendingP1Skin = data.player1?.skin || null;
  pendingP2Skin = data.player2?.skin || null;

  chosenSide = 'left';
  pickSide('left');

  // Reset ready state
  isReady = false;
  const readyBtn = document.getElementById('btn-ready');
  if (readyBtn) {
    readyBtn.textContent = 'READY';
    readyBtn.className = 'bg-green-600 hover:bg-green-700 px-8 py-3 rounded-lg text-lg font-bold transition';
    readyBtn.disabled = false;
  }

  // Clear game chat
  document.getElementById('game-chat-messages').innerHTML = '';
  document.getElementById('postgame-chat-messages').innerHTML = '';

  const intermission = document.getElementById('intermission-info');
  const sidePicker = document.getElementById('side-picker');
  if (intermission && data.player1 && data.player2) {
    const me = currentUser.wallet === data.player1.wallet ? data.player1 : data.player2;
    const opp = currentUser.wallet === data.player1.wallet ? data.player2 : data.player1;
    document.getElementById('intermission-you').textContent = me.username;
    document.getElementById('intermission-opp').textContent = opp.username;

    const tierLabel = data.tier === 'duel' ? 'DUEL' : (data.tier || '').toUpperCase() + ' TIER';
    const stakeUsd = pongPriceUsd > 0 && data.stakeAmount
      ? ` — ${formatUsd((data.stakeAmount / 1e6) * pongPriceUsd)} each`
      : '';
    document.getElementById('intermission-tier').textContent = tierLabel + stakeUsd;

    intermission.classList.remove('hidden');
    if (sidePicker) sidePicker.classList.remove('hidden');
  }

  const countdownEl = document.getElementById('intermission-countdown');
  if (intermissionCountdownInterval) clearInterval(intermissionCountdownInterval);
  // Don't show a countdown during ready phase — just show "READY UP"
  if (countdownEl) countdownEl.textContent = '';
  GameClient.renderCountdown('?');
});

// Socket: Game starts
socket.on('game-start', (data) => {
  currentGameId = data.gameId;
  if (intermissionCountdownInterval) { clearInterval(intermissionCountdownInterval); intermissionCountdownInterval = null; }
  showMatchmakingState('game');
  const intermission = document.getElementById('intermission-info');
  if (intermission) intermission.classList.add('hidden');
  GameClient.setGameInfo(data.gameId, data.player1.wallet);

  const p1Skin = data.player1.skin || pendingP1Skin || null;
  const p2Skin = data.player2.skin || pendingP2Skin || null;
  GameClient.setPlayerSkins(p1Skin, p2Skin);

  const amP1 = (currentUser.wallet === data.player1.wallet);
  const myNaturalSide = amP1 ? 'left' : 'right';
  isMirrored = (chosenSide !== myNaturalSide);
  GameClient.setMirrored(isMirrored);

  const leftLabel = document.getElementById('game-p1-name');
  const rightLabel = document.getElementById('game-p2-name');
  if (isMirrored) {
    leftLabel.textContent = data.player2.username;
    rightLabel.textContent = data.player1.username;
  } else {
    leftLabel.textContent = data.player1.username;
    rightLabel.textContent = data.player2.username;
  }

  // Store opponent for post-game
  lastGameOpponent = amP1
    ? { wallet: data.player2.wallet, username: data.player2.username }
    : { wallet: data.player1.wallet, username: data.player1.username };

  currentCustomStake = data.stake || currentCustomStake;
  updateGameStakeDisplay();
  GameClient.startRendering();
});

// Socket: Game state tick
socket.on('game-state', (data) => {
  if (data.gameId !== currentGameId) return;
  GameClient.updateState(data.state, data.sounds);
  if (isMirrored) {
    document.getElementById('game-score-p1').textContent = data.state.score.p2;
    document.getElementById('game-score-p2').textContent = data.state.score.p1;
  } else {
    document.getElementById('game-score-p1').textContent = data.state.score.p1;
    document.getElementById('game-score-p2').textContent = data.state.score.p2;
  }
});

// Socket: Opponent disconnected
let disconnectCountdownInterval = null;
socket.on('opponent-disconnected', (data) => {
  if (data.gameId !== currentGameId) return;
  const banner = document.getElementById('disconnect-banner');
  const countEl = document.getElementById('disconnect-countdown');
  if (banner) banner.classList.remove('hidden');
  let remaining = data.timeout || 15;
  if (countEl) countEl.textContent = remaining;
  if (disconnectCountdownInterval) clearInterval(disconnectCountdownInterval);
  disconnectCountdownInterval = setInterval(() => {
    remaining--;
    if (countEl) countEl.textContent = Math.max(remaining, 1);
    if (remaining <= 0) {
      clearInterval(disconnectCountdownInterval);
      disconnectCountdownInterval = null;
    }
  }, 1000);
});

socket.on('opponent-reconnected', (data) => {
  if (data.gameId !== currentGameId) return;
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
  if (disconnectCountdownInterval) { clearInterval(disconnectCountdownInterval); disconnectCountdownInterval = null; }
});

// Socket: Rejoin active game
socket.on('rejoin-game', (data) => {
  // If the game is already finished, don't show the game UI — go to game-over screen
  if (data.state && data.state.status === 'finished') {
    currentGameId = data.gameId;
    const amP1 = (currentUser.wallet === data.player1.wallet);
    lastGameOpponent = amP1
      ? { wallet: data.player2.wallet, username: data.player2.username }
      : { wallet: data.player1.wallet, username: data.player1.username };
    const won = data.state.winner === currentUser.wallet;
    document.getElementById('gameover-title').textContent = won ? 'VICTORY!' : 'DEFEAT';
    document.getElementById('gameover-title').className = `text-2xl font-bold mb-2 ${won ? 'text-green-400' : 'text-red-400'}`;
    document.getElementById('gameover-score').textContent = `Final Score: ${data.state.score.p1} - ${data.state.score.p2}`;
    document.getElementById('gameover-payout').textContent = '';
    const addSection = document.getElementById('gameover-add-friend');
    if (lastGameOpponent && currentUser.friends && !currentUser.friends.includes(lastGameOpponent.wallet)) {
      document.getElementById('btn-add-opponent').textContent = `Add ${lastGameOpponent.username}`;
      addSection.classList.remove('hidden');
    } else {
      addSection.classList.add('hidden');
    }
    showMatchmakingState('gameover');
    return;
  }

  currentGameId = data.gameId;
  currentGameTier = data.tier;
  showMatchmakingState('game');
  const intermission = document.getElementById('intermission-info');
  if (intermission) intermission.classList.add('hidden');
  GameClient.setGameInfo(data.gameId, data.player1.wallet);
  GameClient.setPlayerSkins(data.player1.skin || null, data.player2.skin || null);
  const amP1 = (currentUser.wallet === data.player1.wallet);
  const myNaturalSide = amP1 ? 'left' : 'right';
  isMirrored = (chosenSide !== myNaturalSide);
  GameClient.setMirrored(isMirrored);
  const leftLabel = document.getElementById('game-p1-name');
  const rightLabel = document.getElementById('game-p2-name');
  if (isMirrored) {
    leftLabel.textContent = data.player2.username;
    rightLabel.textContent = data.player1.username;
  } else {
    leftLabel.textContent = data.player1.username;
    rightLabel.textContent = data.player2.username;
  }
  if (data.state) {
    GameClient.updateState(data.state);
    if (isMirrored) {
      document.getElementById('game-score-p1').textContent = data.state.score.p2;
      document.getElementById('game-score-p2').textContent = data.state.score.p1;
    } else {
      document.getElementById('game-score-p1').textContent = data.state.score.p1;
      document.getElementById('game-score-p2').textContent = data.state.score.p2;
    }
  }
  lastGameOpponent = amP1
    ? { wallet: data.player2.wallet, username: data.player2.username }
    : { wallet: data.player1.wallet, username: data.player1.username };
  updateGameStakeDisplay();
  GameClient.startRendering();
});

// Socket: Game over
socket.on('game-over', (data) => {
  GameClient.cleanup();
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
  if (disconnectCountdownInterval) { clearInterval(disconnectCountdownInterval); disconnectCountdownInterval = null; }
  const won = data.winner === currentUser.wallet;

  document.getElementById('gameover-title').textContent = won ? 'VICTORY!' : 'DEFEAT';
  document.getElementById('gameover-title').className = `text-2xl font-bold mb-2 ${won ? 'text-green-400' : 'text-red-400'}`;
  document.getElementById('gameover-score').textContent = `Final Score: ${data.score.p1} - ${data.score.p2}`;
  document.getElementById('gameover-payout').textContent = won ? 'Payout processing...' : '';

  // Show add friend button if not already friends
  const addSection = document.getElementById('gameover-add-friend');
  if (lastGameOpponent && currentUser.friends && !currentUser.friends.includes(lastGameOpponent.wallet)) {
    document.getElementById('btn-add-opponent').textContent = `Add ${lastGameOpponent.username}`;
    addSection.classList.remove('hidden');
  } else {
    addSection.classList.add('hidden');
  }

  // Keep currentGameId alive for post-game chat
  showMatchmakingState('gameover');
});

function addGameOpponent() {
  if (!lastGameOpponent) return;
  addFriend(lastGameOpponent.wallet);
  document.getElementById('gameover-add-friend').classList.add('hidden');
}

// Socket: Payout complete
socket.on('payout-complete', (data) => {
  const won = data.winner === currentUser.wallet;
  const winPong = formatPong(data.winnerShare);
  const burnPong = formatPong(data.burned);
  const winUsd = pongPriceUsd > 0 ? ` (${formatUsd((data.winnerShare / 1e6) * pongPriceUsd)})` : '';
  if (won) {
    document.getElementById('gameover-payout').textContent = `You won ${winPong} $PONG${winUsd}! (${burnPong} burned)`;
  } else {
    document.getElementById('gameover-payout').textContent = `Your stake was lost. ${burnPong} $PONG was burned.`;
  }
  refreshUserData();
});

// Socket: Forfeit
socket.on('game-forfeit', (data) => {
  GameClient.cleanup();
  const banner = document.getElementById('disconnect-banner');
  if (banner) banner.classList.add('hidden');
  if (disconnectCountdownInterval) { clearInterval(disconnectCountdownInterval); disconnectCountdownInterval = null; }
  const won = data.winner === currentUser.wallet;
  document.getElementById('gameover-title').textContent = won ? 'OPPONENT LEFT — YOU WIN!' : 'DISCONNECTED — FORFEIT';
  document.getElementById('gameover-title').className = `text-2xl font-bold mb-2 ${won ? 'text-green-400' : 'text-red-400'}`;
  document.getElementById('gameover-score').textContent = data.reason || '';
  showMatchmakingState('gameover');
});

function backToMatchmaking() {
  currentGameId = null;
  currentGameTier = null;
  currentCustomStake = null;
  isMirrored = false;
  chosenSide = 'left';
  isReady = false;
  lastGameOpponent = null;
  const intermission = document.getElementById('intermission-info');
  if (intermission) intermission.classList.add('hidden');
  if (intermissionCountdownInterval) { clearInterval(intermissionCountdownInterval); intermissionCountdownInterval = null; }
  showMatchmakingState('select');
}

// Socket: Online users update
socket.on('online-users', (users) => {
  onlineUsers = users;
  // Update online count display
  const countEl = document.getElementById('online-count-num');
  if (countEl) countEl.textContent = users.length;
  // Update dashboard online/player counts
  const dashCount = document.getElementById('dash-online-count');
  if (dashCount) dashCount.textContent = users.length;
  const dashPlayers = document.getElementById('dash-players-ingame');
  if (dashPlayers) dashPlayers.textContent = users.length;
});

// Socket: Errors
socket.on('queue-error', (data) => { showToast(data.error); showMatchmakingState('select'); });
socket.on('escrow-error', (data) => showToast(data.error));
socket.on('match-error', (data) => {
  alert(data.error);
  showMatchmakingState('select');
});
socket.on('payout-error', (data) => console.error('Payout error:', data.error));

// ===========================================
// DASHBOARD
// ===========================================

// (currentDashLbSort declared at top of file)

function loadDashboard() {
  loadDashboardLeaderboard(currentDashLbSort);
  loadDashboardFriends();
  loadDashboardSkins();
  updateDashboardStats();
  fetchBurnedTotal();
  fetchDashboardBalance();
}

async function loadDashboardLeaderboard(sort) {
  currentDashLbSort = sort || 'earnings';
  // Update category button styles
  ['earnings', 'wins', 'games'].forEach(s => {
    const btn = document.getElementById(`dash-lb-btn-${s}`);
    if (!btn) return;
    if (s === currentDashLbSort) {
      btn.className = 'bg-purple-600 px-3 py-1 rounded text-xs font-medium transition';
    } else {
      btn.className = 'bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs font-medium transition';
    }
  });

  try {
    const res = await fetch(`/api/leaderboard?sort=${currentDashLbSort}&limit=5`).then(r => r.json());
    const container = document.getElementById('dash-leaderboard-list');
    if (!container) return;
    if (!res.users || res.users.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-xs">No players yet.</p>';
      return;
    }
    const medalColors = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];
    container.innerHTML = res.users.map((u, i) => {
      let statVal;
      if (currentDashLbSort === 'earnings') {
        statVal = formatPong(u.stats?.totalEarnings || 0) + ' $PONG';
      } else if (currentDashLbSort === 'wins') {
        statVal = (u.stats?.wins || 0) + ' wins';
      } else {
        statVal = (u.totalGames || ((u.stats?.wins || 0) + (u.stats?.losses || 0))) + ' games';
      }
      const medal = i < 3 ? medalColors[i] : 'text-gray-500';
      return `
        <div class="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-800/50 rounded px-1 transition"
          onclick="showProfilePopup('${u.wallet}')">
          <span class="${medal} font-bold text-xs w-5 text-right">#${i + 1}</span>
          <img src="${esc(u.pfp || '')}" class="w-5 h-5 rounded-full bg-gray-700" onerror="this.style.display='none'" />
          <span class="text-sm flex-1 truncate">${esc(u.username)}</span>
          <span class="text-gray-400 text-xs">${statVal}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Dashboard leaderboard error:', err);
  }
}

function updateDashboardStats() {
  // Stats updated via other dashboard functions (balance, burned, etc.)
}

async function fetchDashboardBalance() {
  if (!currentUser) return;
  const pongEl = document.getElementById('dash-balance-pong');
  const usdEl = document.getElementById('dash-balance-usd');
  if (!pongEl) return;
  try {
    const res = await fetch(`/api/balance/${currentUser.wallet}`).then(r => r.json());
    const baseUnits = res.balance || 0;
    const pong = baseUnits / 1e6;
    // PONG display (secondary / small)
    if (pong >= 1e6) pongEl.textContent = (pong / 1e6).toFixed(2) + 'M';
    else if (pong >= 1e3) pongEl.textContent = (pong / 1e3).toFixed(1) + 'K';
    else pongEl.textContent = pong.toLocaleString('en-US', { maximumFractionDigits: 2 });
    // USD display (primary / large)
    if (usdEl) {
      if (pongPriceUsd > 0) {
        usdEl.textContent = formatUsd(pong * pongPriceUsd);
      } else {
        usdEl.textContent = '--';
      }
    }
  } catch (e) {
    pongEl.textContent = '--';
    if (usdEl) usdEl.textContent = '--';
  }
}

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
  if (!authHeader) {
    throw new Error('Not authenticated. Please connect wallet.');
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    throw new Error('Network error — check your connection.');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Server error (status ' + res.status + ')');
  }
  if (!res.ok) {
    if (res.status === 401) {
      sessionToken = null;
      currentUser = null;
      localStorage.removeItem('pong_session');
      throw new Error('Session expired. Please reconnect wallet.');
    }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function refreshUserData() {
  try {
    const res = await fetch('/api/profile', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    if (res.user) currentUser = res.user;
  } catch (err) {
    console.error('Failed to refresh user:', err);
  }
}

// Init autocomplete on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFriendSearch);
} else {
  initFriendSearch();
}

// ===========================================
// TOKEN PRICE CARD (Market Cap + Burned)
// ===========================================

function formatMarketCap(val) {
  if (!val || val <= 0) return '--';
  if (val >= 1e9) return '$' + (val / 1e9).toFixed(2) + 'B';
  if (val >= 1e6) return '$' + (val / 1e6).toFixed(2) + 'M';
  if (val >= 1e3) return '$' + (val / 1e3).toFixed(1) + 'K';
  return '$' + val.toFixed(0);
}

function updateTokenPriceCard() {
  const mcapEl = document.getElementById('dash-token-mcap');
  const changeEl = document.getElementById('dash-token-change');
  if (!mcapEl) return;

  if (priceFetchFailed || pongPriceUsd <= 0) {
    mcapEl.textContent = '--';
    if (changeEl) { changeEl.textContent = '24h: --'; changeEl.className = 'text-[10px] mt-0.5 text-gray-400'; }
    return;
  }

  mcapEl.textContent = pongMarketCap ? formatMarketCap(pongMarketCap) : '--';

  if (changeEl) {
    if (pongPriceChange24h != null) {
      const sign = pongPriceChange24h >= 0 ? '+' : '';
      changeEl.textContent = `24h: ${sign}${pongPriceChange24h.toFixed(2)}%`;
      changeEl.className = 'text-[10px] mt-0.5 font-medium ' +
        (pongPriceChange24h >= 0 ? 'text-green-400' : 'text-red-400');
    } else {
      changeEl.textContent = '24h: --';
      changeEl.className = 'text-[10px] mt-0.5 text-gray-400';
    }
  }
}

async function fetchBurnedTotal() {
  try {
    const res = await fetch('/api/stats/burned').then(r => r.json());
    const burned = res.totalBurned || 0;
    let text;
    if (burned <= 0) { text = '0'; }
    else {
      const pong = burned / 1e6;
      if (pong >= 1e6) text = (pong / 1e6).toFixed(2) + 'M';
      else if (pong >= 1e3) text = (pong / 1e3).toFixed(1) + 'K';
      else text = pong.toLocaleString();
    }
    // Update all burned display elements
    const els = [document.getElementById('dash-token-burned'), document.getElementById('dash-burned-amount')];
    els.forEach(el => { if (el) el.textContent = text + ' $PONG'; });
  } catch (e) {
    const els = [document.getElementById('dash-token-burned'), document.getElementById('dash-burned-amount')];
    els.forEach(el => { if (el) el.textContent = '--'; });
  }
}

// ===========================================
// DASHBOARD: FRIENDS
// ===========================================

async function loadDashboardFriends() {
  const container = document.getElementById('dash-friends-list');
  if (!container) return;
  try {
    const res = await fetch('/api/friends', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    const friends = res.friends || [];
    if (friends.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-xs">No friends yet. Add players from the Friends tab!</p>';
      return;
    }
    container.innerHTML = friends.slice(0, 5).map(f => {
      const isOnline = onlineUsers.includes(f.wallet);
      return `
        <div class="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-800/50 rounded px-1 transition"
          onclick="showProfilePopup('${f.wallet}')">
          <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-green-400' : 'bg-gray-600'} flex-shrink-0"></span>
          <img src="${esc(f.pfp || '')}" class="w-5 h-5 rounded-full bg-gray-700 flex-shrink-0" onerror="this.style.display='none'" />
          <span class="text-sm flex-1 truncate">${esc(f.username)}</span>
          ${isOnline ? '<span class="text-green-400 text-xs">Online</span>' : '<span class="text-gray-600 text-xs">Offline</span>'}
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = '<p class="text-gray-500 text-xs">Could not load friends.</p>';
  }
}

// ===========================================
// DASHBOARD: SKINS
// ===========================================

async function loadDashboardSkins() {
  const paddle = document.getElementById('dash-paddle-preview');
  if (!paddle) return;
  try {
    const res = await fetch('/api/shop', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    dashInventory = res.inventory || [];
    updatePaddlePreview();
  } catch (err) {
    console.error('Failed to load dashboard skins:', err);
  }
}

function updatePaddlePreview() {
  const paddle = document.getElementById('dash-paddle-preview');
  const nameEl = document.getElementById('dash-skin-name');
  const rarityEl = document.getElementById('dash-skin-rarity');
  if (!paddle) return;
  const equipped = dashInventory.find(s => s.equipped);

  if (equipped) {
    if (equipped.type === 'color') {
      paddle.style.background = esc(equipped.cssValue);
      paddle.style.backgroundImage = '';
    } else {
      paddle.style.background = 'url(' + esc(equipped.imageUrl) + ') center/cover no-repeat';
    }
    nameEl.textContent = equipped.name;
    const rarityClass = rarityBadge(equipped.rarity);
    rarityEl.className = 'text-xs px-1.5 py-0.5 rounded ' + rarityClass;
    rarityEl.textContent = equipped.rarity;
    rarityEl.classList.remove('hidden');
  } else {
    paddle.style.background = '#a855f7';
    paddle.style.backgroundImage = '';
    nameEl.textContent = 'Default';
    rarityEl.classList.add('hidden');
  }

  const glowColor = equipped && equipped.type === 'color' ? equipped.cssValue : '#a855f7';
  paddle.style.boxShadow = '0 0 10px ' + glowColor;

  // Dashboard Customize card — sync skin to the right paddle preview
  const dashPaddleRight = document.getElementById('dash-paddle-preview-right');
  if (dashPaddleRight) {
    if (equipped) {
      if (equipped.type === 'color') {
        dashPaddleRight.style.background = esc(equipped.cssValue);
        dashPaddleRight.style.backgroundImage = '';
      } else {
        dashPaddleRight.style.background = 'url(' + esc(equipped.imageUrl) + ') center/cover no-repeat';
      }
    } else {
      dashPaddleRight.style.background = '#a855f7';
      dashPaddleRight.style.backgroundImage = '';
    }

    const glowColorRight = equipped && equipped.type === 'color' ? equipped.cssValue : '#a855f7';
    dashPaddleRight.style.boxShadow = '0 0 12px ' + glowColorRight;
  }
}

function openInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('hidden');
  renderInventoryGrid();
}

function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.add('hidden');
}

function renderInventoryGrid() {
  const grid = document.getElementById('inventory-grid');
  if (dashInventory.length === 0) {
    grid.innerHTML = '<p class="text-gray-500 text-sm col-span-3">No skins yet. Open a crate!</p>';
    return;
  }
  grid.innerHTML = dashInventory.map(s => {
    const rarityClass = rarityBadge(s.rarity);
    let preview, bgStyle;
    if (s.type === 'color') {
      preview = `<div class="w-8 h-8 rounded-full" style="background:${esc(s.cssValue)};box-shadow:0 0 12px ${esc(s.cssValue)}"></div>`;
      bgStyle = `background:${esc(s.cssValue)}33`;
    } else {
      preview = `<img src="${esc(s.imageUrl)}" class="h-14 object-contain" />`;
      bgStyle = 'background:#1a1a3a';
    }
    const btnClass = s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300';
    const equipFn = `equipSkinFromModal('${s.skinId}')`;
    const classBadge = '<span class="text-[10px] px-1 py-0.5 rounded bg-gray-700 text-gray-400">SKIN</span>';
    return `
      <div class="bg-gray-800/50 rounded-lg p-3 flex flex-col items-center gap-1.5 border border-gray-700">
        <div class="w-full h-16 rounded-lg flex items-center justify-center" style="${bgStyle}">
          ${preview}
        </div>
        <div class="flex items-center gap-1 w-full justify-center">
          <h4 class="font-bold text-xs text-center truncate">${esc(s.name)}</h4>
          ${classBadge}
        </div>
        <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${s.rarity}</span>
        <button onclick="${equipFn}" class="text-xs font-medium ${btnClass}">
          ${s.equipped ? 'Equipped' : 'Equip'}
        </button>
      </div>
    `;
  }).join('');
}

async function equipSkinFromModal(skinId) {
  if (!requireWallet('equip')) return;
  try {
    const result = await apiPostAuth('/api/shop/equip', { skinId }, getAuthHeader());
    if (result.status === 'equipped') {
      dashInventory.forEach(s => { s.equipped = s.skinId === skinId; });
      renderInventoryGrid();
      updatePaddlePreview();
      showToast('Skin equipped!');
    }
  } catch (err) {
    console.error('Equip failed:', err);
    showToast(err.message || 'Failed to equip skin');
  }
}

// ===========================================
// COSMETICS TAB
// ===========================================

async function loadCosmetics() {
  const grid = document.getElementById('cosmetics-inventory');
  const paddlePreview = document.getElementById('cosmetics-paddle-preview');
  const equippedName = document.getElementById('cosmetics-equipped-name');
  const equippedRarity = document.getElementById('cosmetics-equipped-rarity');
  if (!grid) return;

  try {
    const res = await fetch('/api/shop', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    const inventory = res.inventory || [];
    dashInventory = inventory;

    const skins = inventory;

    // Update equipped paddle preview
    const equipped = skins.find(s => s.equipped);
    if (equipped && paddlePreview) {
      if (equipped.type === 'color') {
        paddlePreview.style.background = esc(equipped.cssValue);
        paddlePreview.style.boxShadow = '0 0 15px ' + esc(equipped.cssValue);
        paddlePreview.style.backgroundImage = '';
      } else {
        paddlePreview.style.background = 'url(' + esc(equipped.imageUrl) + ') center/cover no-repeat';
        paddlePreview.style.boxShadow = 'none';
      }
      if (equippedName) equippedName.textContent = equipped.name;
      if (equippedRarity) {
        const erc = rarityBadge(equipped.rarity);
        equippedRarity.className = 'text-xs px-2 py-0.5 rounded ' + erc;
        equippedRarity.textContent = equipped.rarity;
        equippedRarity.classList.remove('hidden');
      }
    } else {
      if (paddlePreview) {
        paddlePreview.style.background = '#a855f7';
        paddlePreview.style.boxShadow = '0 0 15px #a855f7';
        paddlePreview.style.backgroundImage = '';
      }
      if (equippedName) equippedName.textContent = 'Default';
      if (equippedRarity) equippedRarity.classList.add('hidden');
    }

    // Render skins grid
    if (skins.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-10">
          <p class="text-gray-500 text-sm mb-3">No skins yet!</p>
          <button onclick="switchTab('shop')" class="bg-purple-600 hover:bg-purple-700 px-5 py-2 rounded-lg text-sm font-medium transition">Open Crates in Shop</button>
        </div>`;
    } else {
      grid.innerHTML = skins.map(s => {
        const rarityClass = rarityBadge(s.rarity);
        const borderClass = s.equipped ? 'border-purple-500 shadow-[0_0_12px_rgba(168,85,247,0.3)]' : 'border-gray-800 hover:border-gray-600';
        const preview = s.type === 'color'
          ? `<div class="w-10 h-10 rounded-full" style="background:${esc(s.cssValue)};box-shadow:0 0 12px ${esc(s.cssValue)}"></div>`
          : `<img src="${esc(s.imageUrl)}" class="h-16 object-contain" />`;
        return `
          <div class="skin-card bg-arena-card rounded-xl p-3 border ${borderClass} transition-all">
            <div class="w-full h-20 rounded-lg mb-2 flex items-center justify-center"
              style="background: ${s.type === 'color' ? esc(s.cssValue) + '22' : '#1a1a3a'}">
              ${preview}
            </div>
            <div class="flex items-center gap-1.5 mb-0.5">
              <h4 class="font-bold text-sm truncate">${esc(s.name)}</h4>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 flex-shrink-0">SKIN</span>
            </div>
            <div class="flex items-center justify-between mt-1.5">
              <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${(s.rarity || 'common').replace('_', ' ')}</span>
              <button onclick="equipFromCosmetics('${s.skinId}')" class="text-xs font-medium ${s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300'}">
                ${s.equipped ? '✓ Equipped' : 'Equip'}
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

  } catch (err) {
    grid.innerHTML = '<p class="text-red-400 text-sm col-span-full text-center py-8">Failed to load cosmetics.</p>';
    console.error('Failed to load cosmetics:', err);
  }
}

async function equipFromCosmetics(skinId) {
  if (!requireWallet('equip')) return;
  try {
    const result = await apiPostAuth('/api/shop/equip', { skinId }, getAuthHeader());
    if (result.status === 'equipped') {
      dashInventory.forEach(s => { s.equipped = s.skinId === skinId; });
      loadCosmetics();
      updatePaddlePreview();
      showToast('Skin equipped!');
    }
  } catch (err) {
    console.error('Equip failed:', err);
    showToast(err.message || 'Failed to equip skin');
  }
}


// ===========================================
// SETTINGS PAGE
// ===========================================

// --- Music state ---
let musicEnabled = localStorage.getItem('pong-music-enabled') !== 'false';
let musicVolume = parseInt(localStorage.getItem('pong-music-volume') || '30', 10);
let musicStarted = false;

function toggleMusic(enabled) {
  musicEnabled = enabled;
  localStorage.setItem('pong-music-enabled', enabled ? 'true' : 'false');
  const audio = document.getElementById('bg-music');
  if (!audio) return;
  if (enabled) {
    if (!musicStarted) { startMusic(); } else { audio.play().catch(() => {}); }
  } else {
    audio.pause();
  }
}

function setMusicVolume(val) {
  musicVolume = parseInt(val, 10);
  localStorage.setItem('pong-music-volume', String(musicVolume));
  const audio = document.getElementById('bg-music');
  if (audio) audio.volume = musicVolume / 100;
  const label = document.getElementById('settings-volume-label');
  if (label) label.textContent = musicVolume + '%';
}

function startMusic() {
  const audio = document.getElementById('bg-music');
  if (!audio || !audio.src || audio.src === window.location.href) return;
  audio.volume = musicVolume / 100;
  audio.play().then(() => { musicStarted = true; }).catch(() => {});
}

function loadSettings() {
  const toggle = document.getElementById('settings-music-toggle');
  if (toggle) toggle.checked = musicEnabled;
  const slider = document.getElementById('settings-volume-slider');
  if (slider) slider.value = musicVolume;
  const label = document.getElementById('settings-volume-label');
  if (label) label.textContent = musicVolume + '%';
}

function showLegalModal(title) {
  const modal = document.getElementById('legal-modal');
  const titleEl = document.getElementById('legal-modal-title');
  if (modal && titleEl) {
    titleEl.textContent = title;
    modal.classList.remove('hidden');
  }
}

function closeLegalModal() {
  const modal = document.getElementById('legal-modal');
  if (modal) modal.classList.add('hidden');
}

// ===========================================
// TOKENOMICS PAGE
// ===========================================

async function loadTokenomics() {
  // Burned amount
  const burnedEl = document.getElementById('tokenomics-burned');
  if (burnedEl) {
    try {
      const res = await fetch('/api/stats/burned').then(r => r.json());
      const burned = res.totalBurned || 0;
      const pong = burned / 1e6;
      burnedEl.textContent = pong.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' $PONG';
    } catch {
      burnedEl.textContent = '0 $PONG';
    }
  }

  // Animate charts
  animateTokenomicsCharts();
}

function animateTokenomicsCharts() {
  // Animate donut segments
  document.querySelectorAll('.donut-segment').forEach((seg, i) => {
    const dash = seg.getAttribute('data-dash');
    if (dash) {
      seg.style.transition = 'none';
      seg.setAttribute('stroke-dasharray', '0 100');
      setTimeout(() => {
        seg.style.transition = 'stroke-dasharray 1.2s cubic-bezier(0.4,0,0.2,1)';
        seg.setAttribute('stroke-dasharray', dash);
      }, 150 + i * 200);
    }
  });

  // Animate bar fills
  document.querySelectorAll('.bar-fill').forEach((bar, i) => {
    const target = bar.getAttribute('data-width');
    if (target) {
      bar.style.width = '0%';
      setTimeout(() => {
        bar.style.transition = 'width 1s cubic-bezier(0.4,0,0.2,1)';
        bar.style.width = target;
      }, 300 + i * 150);
    }
  });

  // Animate counter numbers
  document.querySelectorAll('[data-count-to]').forEach(el => {
    const target = parseFloat(el.getAttribute('data-count-to'));
    const suffix = el.getAttribute('data-suffix') || '';
    const decimals = parseInt(el.getAttribute('data-decimals') || '0');
    let start = 0;
    const duration = 1500;
    const startTime = performance.now();
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + (target - start) * eased;
      el.textContent = current.toFixed(decimals) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

// ===========================================
// BUY $PONG MODAL
// ===========================================

let solPriceUsd = 0;

async function fetchSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (res.ok) {
      const data = await res.json();
      if (data.solana && data.solana.usd) {
        solPriceUsd = data.solana.usd;
      }
    }
  } catch (e) { console.warn('SOL price fetch failed:', e.message); }
}

function openBuyPong() {
  if (!requireWallet('buy')) return;
  fetchSolPrice().then(() => {
    const priceDisplay = document.getElementById('buy-pong-price-display');
    const solDisplay = document.getElementById('buy-sol-price-display');
    if (priceDisplay && pongPriceUsd > 0) priceDisplay.textContent = '$' + pongPriceUsd.toFixed(8);
    if (solDisplay && solPriceUsd > 0) solDisplay.textContent = '$' + solPriceUsd.toFixed(2);
  });
  document.getElementById('buy-sol-input').value = '';
  document.getElementById('buy-pong-estimate').textContent = '--';
  const errEl = document.getElementById('buy-pong-error');
  if (errEl) errEl.classList.add('hidden');
  document.getElementById('buy-pong-modal').classList.remove('hidden');
}

function closeBuyPong() {
  document.getElementById('buy-pong-modal').classList.add('hidden');
}

function updateBuyPongEstimate() {
  const solAmount = parseFloat(document.getElementById('buy-sol-input').value);
  const estimateEl = document.getElementById('buy-pong-estimate');
  if (!solAmount || solAmount <= 0 || solPriceUsd <= 0 || pongPriceUsd <= 0) {
    estimateEl.textContent = '--';
    return;
  }
  const usdValue = solAmount * solPriceUsd;
  const pongAmount = Math.floor(usdValue / pongPriceUsd);
  estimateEl.textContent = pongAmount.toLocaleString();
}

async function executeBuyPong() {
  const solAmount = parseFloat(document.getElementById('buy-sol-input').value);
  const errEl = document.getElementById('buy-pong-error');
  errEl.classList.add('hidden');

  if (!solAmount || solAmount <= 0) {
    errEl.textContent = 'Enter a valid SOL amount';
    errEl.classList.remove('hidden');
    return;
  }
  if (solAmount < 0.001) {
    errEl.textContent = 'Minimum 0.001 SOL';
    errEl.classList.remove('hidden');
    return;
  }

  // Open Jupiter swap in new tab with the $PONG token pre-selected
  const jupiterUrl = `https://jup.ag/swap/SOL-${PONG_TOKEN_MINT}?amount=${solAmount}`;
  window.open(jupiterUrl, '_blank');
  closeBuyPong();
}

// ===========================================
// SETTINGS MODAL
// ===========================================

function openSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

// ===========================================
// LOADING SCREEN
// ===========================================

function dismissLoadingScreen() {
  const screen = document.getElementById('loading-screen');
  if (!screen || screen.classList.contains('fade-out')) return;
  screen.classList.add('fade-out');
  setTimeout(() => {
    screen.style.display = 'none';
  }, 600);
}

(function initLoadingScreen() {
  const autoDismiss = setTimeout(() => {
    dismissLoadingScreen();
  }, 1500);

  function earlyDismiss() {
    clearTimeout(autoDismiss);
    dismissLoadingScreen();
    document.removeEventListener('click', earlyDismiss);
    document.removeEventListener('keydown', earlyDismiss);
    document.removeEventListener('touchstart', earlyDismiss);
  }
  document.addEventListener('click', earlyDismiss);
  document.addEventListener('keydown', earlyDismiss);
  document.addEventListener('touchstart', earlyDismiss);
})();
