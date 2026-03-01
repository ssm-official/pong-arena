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

// --- Music state ---
let musicStarted = false;
let musicEnabled = localStorage.getItem('pong-music-enabled') !== 'false'; // default true
let musicVolume = parseInt(localStorage.getItem('pong-music-volume') || '30', 10);

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

(async function tryAutoLogin() {
  const saved = localStorage.getItem('pong_session');
  if (!saved) {
    // No session — show dashboard without wallet
    initDashboard();
    return;
  }
  try {
    const { token } = JSON.parse(saved);
    const res = await fetch('/api/profile', {
      headers: { Authorization: 'Bearer ' + token }
    }).then(r => r.json());
    if (res.user) {
      sessionToken = token;
      currentUser = res.user;
      await WalletManager.reconnectIfTrusted();
      showApp();
    } else {
      localStorage.removeItem('pong_session');
      initDashboard();
    }
  } catch {
    localStorage.removeItem('pong_session');
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
};
const ROUTE_PATHS = {};
Object.entries(TAB_ROUTES).forEach(([path, tab]) => { ROUTE_PATHS[tab] = path; });

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
      document.getElementById('shop-standard-grid').innerHTML = '<p class="text-red-400 text-sm col-span-full">Failed to load shop.</p>';
      return;
    }
    const ownedCrates = res.ownedCrates || {};

    // Limited section
    const limitedSection = document.getElementById('shop-limited-section');
    const limitedGrid = document.getElementById('shop-limited-grid');
    if (res.limited && res.limited.length > 0) {
      limitedSection.classList.remove('hidden');
      limitedGrid.innerHTML = res.limited.map(c => renderCrateCard(c, 'limited', ownedCrates[c.crateId] || 0)).join('');
    } else {
      limitedSection.classList.add('hidden');
    }

    // Aura section
    const auraSection = document.getElementById('shop-aura-section');
    const auraGrid = document.getElementById('shop-aura-grid');
    if (res.aura && res.aura.length > 0) {
      auraSection.classList.remove('hidden');
      auraGrid.innerHTML = res.aura.map(c => renderCrateCard(c, 'aura', ownedCrates[c.crateId] || 0)).join('');
    } else {
      auraSection.classList.add('hidden');
    }

    // Standard section
    const standardGrid = document.getElementById('shop-standard-grid');
    standardGrid.innerHTML = (res.standard || []).map(c => renderCrateCard(c, 'standard', ownedCrates[c.crateId] || 0)).join('');
  } catch (err) {
    console.error('Failed to load shop:', err);
  }
}

function getCrateIllustration(color, crateType) {
  const c = esc(color || '#7c3aed');
  if (crateType === 'aura') {
    return `<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs>
        <radialGradient id="ag${c.replace('#','')}" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="${c}" stop-opacity="0.4"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>
      </defs>
      <rect x="14" y="30" width="52" height="36" rx="4" fill="#1a1a3a" stroke="${c}" stroke-width="2"/>
      <rect x="14" y="30" width="52" height="12" rx="4" fill="${c}" opacity="0.3"/>
      <line x1="40" y1="30" x2="40" y2="66" stroke="${c}" stroke-width="2" opacity="0.5"/>
      <rect x="32" y="42" width="16" height="8" rx="2" fill="${c}" opacity="0.6"/>
      <circle cx="40" cy="22" r="12" fill="url(#ag${c.replace('#','')})"/>
      <text x="40" y="26" text-anchor="middle" font-size="14" fill="${c}">&#10024;</text>
    </svg>`;
  }
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
  const borderColor = section === 'limited' ? 'border-yellow-600/60' : section === 'aura' ? 'border-purple-600/60' : 'border-gray-700/60';
  const glowBg = section === 'limited' ? 'rgba(234,179,8,0.06)' : section === 'aura' ? 'rgba(168,85,247,0.06)' : 'rgba(30,30,60,0.5)';
  const usdPrice = pongPriceUsd > 0 ? formatUsd(c.price * pongPriceUsd) + ' / ' : '';
  const owned = ownedCount || 0;
  const crateType = c.crateType || 'skin';
  const typeBadge = crateType === 'aura' ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-400">AURA</span>'
    : crateType === 'mixed' ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">MIXED</span>' : '';
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
          <div class="flex items-center gap-2 text-[10px] text-gray-500">
            <span>${c.rarityBreakdown.common}C</span>
            <span class="text-purple-400">${c.rarityBreakdown.rare}R</span>
            <span class="text-yellow-400">${c.rarityBreakdown.legendary}L</span>
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
      const rarityClass = s.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
        : s.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
        : 'bg-gray-800 text-gray-400';
      const chancePct = s.chance >= 1 ? s.chance.toFixed(0) + '%' : s.chance.toFixed(1) + '%';
      const chanceColor = s.rarity === 'legendary' ? 'text-yellow-400' : s.rarity === 'rare' ? 'text-purple-400' : 'text-gray-400';
      let preview, bgColor;
      if (s.type === 'aura') {
        let aC = '#a855f7';
        try { aC = JSON.parse(s.cssValue).color || '#a855f7'; } catch {}
        preview = s.imageUrl
          ? `<img src="${esc(s.imageUrl)}" class="h-10 w-10 object-contain" />`
          : `<span style="font-size:28px;color:${esc(aC)}">&#10024;</span>`;
        bgColor = esc(aC) + '15';
      } else if (s.type === 'color') {
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
          <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${s.rarity}</span>
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
    const freqs = rarity === 'legendary' ? [523, 659, 784, 1047]
                : rarity === 'rare' ? [523, 659, 784] : [523, 659];
    const duration = rarity === 'legendary' ? 1.2 : rarity === 'rare' ? 0.8 : 0.5;
    const volume = rarity === 'legendary' ? 0.15 : rarity === 'rare' ? 0.12 : 0.08;
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
    if (skin.type === 'aura') {
      let aColor = '#a855f7';
      try { aColor = JSON.parse(skin.cssValue).color || '#a855f7'; } catch {}
      const auraVisual = skin.imageUrl
        ? `<img src="${esc(skin.imageUrl)}" style="height:36px;width:36px;object-fit:contain;" />`
        : `<div style="font-size:32px;color:${esc(aColor)}">&#10024;</div>`;
      card.innerHTML = `${auraVisual}<div style="font-size:10px;color:#ccc;margin-top:4px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:90px">${esc(skin.name)}</div>`;
    } else if (skin.type === 'color') {
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
  if (skin.type === 'aura') {
    let aColor = '#a855f7';
    try { aColor = JSON.parse(skin.cssValue).color || '#a855f7'; } catch {}
    preview.innerHTML = skin.imageUrl
      ? `<img src="${esc(skin.imageUrl)}" style="height:56px;width:56px;object-fit:contain;" />`
      : `<div style="font-size:48px;color:${esc(aColor)}">&#10024;</div>`;
    preview.style.background = aColor + '15';
  } else if (skin.type === 'color') {
    preview.innerHTML = `<div class="w-16 h-16 rounded-full" style="background:${esc(skin.cssValue)};box-shadow:0 0 20px ${esc(skin.cssValue)}"></div>`;
    preview.style.background = skin.cssValue + '22';
  } else {
    preview.innerHTML = `<img src="${esc(skin.imageUrl)}" class="h-20 object-contain" />`;
    preview.style.background = '#1a1a3a';
  }
  nameEl.textContent = skin.name;
  const rarityColors = { common: 'text-gray-400', rare: 'text-purple-400', legendary: 'text-yellow-400' };
  rarityEl.textContent = isDuplicate ? skin.rarity.toUpperCase() + ' (DUPLICATE)' : skin.rarity.toUpperCase();
  rarityEl.className = `text-sm mb-4 font-bold ${isDuplicate ? 'text-gray-500' : (rarityColors[skin.rarity] || 'text-gray-400')}`;
  if (skin.rarity === 'legendary') {
    const flash = document.getElementById('roller-flash');
    flash.style.opacity = '0.6';
    setTimeout(() => { flash.style.opacity = '0'; }, 300);
    preview.classList.add('reveal-glow');
  } else if (skin.rarity === 'rare') {
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
  showFinalReveal(wonSkin, isDuplicate);
}

function closeRoller() {
  document.getElementById('crate-roller-modal').classList.add('hidden');
  document.getElementById('roller-reveal').classList.add('hidden');
  document.getElementById('roller-reveal-preview').classList.remove('reveal-glow');
  loadShop();
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
let pendingP1Aura = null;
let pendingP2Aura = null;
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
  pendingP1Aura = data.player1?.aura || null;
  pendingP2Aura = data.player2?.aura || null;

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
  const p1Aura = data.player1.aura || pendingP1Aura || null;
  const p2Aura = data.player2.aura || pendingP2Aura || null;
  GameClient.setPlayerAuras(p1Aura, p2Aura);

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
  GameClient.setPlayerAuras(data.player1.aura || null, data.player2.aura || null);
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

let currentDashLbSort = 'earnings';

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
    // Find equipped aura using the top-level equippedAura skinId from the API
    const equippedAuraId = res.equippedAura || 'none';
    const equippedAuraSkin = equippedAuraId !== 'none'
      ? dashInventory.find(s => s.type === 'aura' && s.skinId === equippedAuraId)
      : null;
    updatePaddlePreview(equippedAuraSkin || null);
  } catch (err) {
    console.error('Failed to load dashboard skins:', err);
  }
}

function updatePaddlePreview(auraSkin) {
  const paddle = document.getElementById('dash-paddle-preview');
  const nameEl = document.getElementById('dash-skin-name');
  const rarityEl = document.getElementById('dash-skin-rarity');
  if (!paddle) return;
  const equipped = dashInventory.find(s => s.equipped);
  if (equipped) {
    if (equipped.type === 'color') {
      paddle.style.background = esc(equipped.cssValue);
      paddle.style.boxShadow = '0 0 15px ' + esc(equipped.cssValue);
      paddle.style.backgroundImage = '';
    } else {
      paddle.style.background = 'url(' + esc(equipped.imageUrl) + ') center/cover no-repeat';
      paddle.style.boxShadow = 'none';
    }
    nameEl.textContent = equipped.name;
    const rarityClass = equipped.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
      : equipped.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
      : 'bg-gray-800 text-gray-400';
    rarityEl.className = 'text-xs px-1.5 py-0.5 rounded ' + rarityClass;
    rarityEl.textContent = equipped.rarity;
    rarityEl.classList.remove('hidden');
  } else {
    paddle.style.background = '#a855f7';
    paddle.style.boxShadow = '0 0 15px #a855f7';
    paddle.style.backgroundImage = '';
    nameEl.textContent = 'Default';
    rarityEl.classList.add('hidden');
  }

  // Dashboard Customize card — sync skin + aura to the right paddle preview
  const dashPaddleRight = document.getElementById('dash-paddle-preview-right');
  const dashAuraName = document.getElementById('dash-aura-name');
  if (dashPaddleRight) {
    // Apply the same skin styling to the Customize card paddle
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

    // Apply aura glow
    if (auraSkin) {
      let auraColor = '#a855f7';
      try { auraColor = JSON.parse(auraSkin.cssValue).color || '#a855f7'; } catch {}
      dashPaddleRight.style.boxShadow = `0 0 18px ${auraColor}, 0 0 6px ${auraColor}`;
      if (dashAuraName) dashAuraName.textContent = 'Aura: ' + auraSkin.name;
    } else {
      const glowColor = equipped && equipped.type === 'color' ? equipped.cssValue : '#a855f7';
      dashPaddleRight.style.boxShadow = '0 0 12px ' + glowColor;
      if (dashAuraName) dashAuraName.textContent = 'Aura: None';
    }
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
    const rarityClass = s.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
      : s.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
      : 'bg-gray-800 text-gray-400';
    let preview, bgStyle;
    if (s.type === 'aura') {
      let aC = '#a855f7';
      try { aC = JSON.parse(s.cssValue).color || '#a855f7'; } catch {}
      preview = s.imageUrl
        ? `<img src="${esc(s.imageUrl)}" class="h-10 w-10 object-contain" />`
        : `<span style="font-size:24px;color:${esc(aC)}">&#10024;</span>`;
      bgStyle = `background:${esc(aC)}15`;
    } else if (s.type === 'color') {
      preview = `<div class="w-8 h-8 rounded-full" style="background:${esc(s.cssValue)};box-shadow:0 0 12px ${esc(s.cssValue)}"></div>`;
      bgStyle = `background:${esc(s.cssValue)}33`;
    } else {
      preview = `<img src="${esc(s.imageUrl)}" class="h-14 object-contain" />`;
      bgStyle = 'background:#1a1a3a';
    }
    const btnClass = s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300';
    const equipFn = s.type === 'aura' ? `equipAuraFromCosmetics('${s.skinId}')` : `equipSkinFromModal('${s.skinId}')`;
    const classBadge = s.type === 'aura'
      ? '<span class="text-[10px] px-1 py-0.5 rounded bg-purple-900/50 text-purple-400">AURA</span>'
      : '<span class="text-[10px] px-1 py-0.5 rounded bg-gray-700 text-gray-400">SKIN</span>';
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
  const auraGrid = document.getElementById('cosmetics-aura-inventory');
  const paddlePreview = document.getElementById('cosmetics-paddle-preview');
  const equippedName = document.getElementById('cosmetics-equipped-name');
  const equippedRarity = document.getElementById('cosmetics-equipped-rarity');
  const auraPreview = document.getElementById('cosmetics-aura-preview');
  const equippedAuraName = document.getElementById('cosmetics-equipped-aura-name');
  const equippedAuraRarity = document.getElementById('cosmetics-equipped-aura-rarity');
  if (!grid) return;

  try {
    const res = await fetch('/api/shop', { headers: { Authorization: getAuthHeader() } }).then(r => r.json());
    const inventory = res.inventory || [];
    dashInventory = inventory;
    const equippedAuraId = res.equippedAura || 'none';

    // Split into skins and auras
    const skins = inventory.filter(s => s.type !== 'aura');
    const auras = inventory.filter(s => s.type === 'aura');

    // Mark equipped aura
    auras.forEach(a => { a.equippedAura = a.skinId === equippedAuraId; });

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
        const rc = equipped.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
          : equipped.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
          : 'bg-gray-800 text-gray-400';
        equippedRarity.className = 'text-xs px-2 py-0.5 rounded ' + rc;
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

    // Update equipped aura preview
    const equippedAura = auras.find(a => a.equippedAura);
    if (equippedAura && auraPreview) {
      let auraColor = '#a855f7';
      try { auraColor = JSON.parse(equippedAura.cssValue).color || '#a855f7'; } catch {}
      if (equippedAura.imageUrl) {
        auraPreview.innerHTML = `<img src="${esc(equippedAura.imageUrl)}" class="h-8 w-8 object-contain" />`;
        auraPreview.style.color = '';
      } else {
        auraPreview.innerHTML = '&#10024;';
        auraPreview.style.color = auraColor;
      }
      if (equippedAuraName) equippedAuraName.textContent = equippedAura.name;
      if (equippedAuraRarity) {
        const rc = equippedAura.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
          : equippedAura.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
          : 'bg-gray-800 text-gray-400';
        equippedAuraRarity.className = 'text-xs px-2 py-0.5 rounded ' + rc;
        equippedAuraRarity.textContent = equippedAura.rarity;
        equippedAuraRarity.classList.remove('hidden');
      }
    } else {
      if (auraPreview) { auraPreview.innerHTML = '&#10024;'; auraPreview.style.color = '#4b5563'; }
      if (equippedAuraName) equippedAuraName.textContent = 'None';
      if (equippedAuraRarity) equippedAuraRarity.classList.add('hidden');
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
        const rarityClass = s.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
          : s.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
          : 'bg-gray-800 text-gray-400';
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
              <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${s.rarity}</span>
              <button onclick="equipFromCosmetics('${s.skinId}')" class="text-xs font-medium ${s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300'}">
                ${s.equipped ? '✓ Equipped' : 'Equip'}
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render auras grid
    if (auraGrid) {
      if (auras.length === 0) {
        auraGrid.innerHTML = '<p class="text-gray-500 text-sm col-span-full text-center py-4">No auras yet. Open crates to find auras!</p>';
      } else {
        auraGrid.innerHTML = auras.map(a => {
          let auraColor = '#a855f7';
          let effectName = 'unknown';
          try { const cfg = JSON.parse(a.cssValue); auraColor = cfg.color || '#a855f7'; effectName = cfg.effect || 'unknown'; } catch {}
          const rarityClass = a.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300'
            : a.rarity === 'rare' ? 'bg-purple-900 text-purple-300'
            : 'bg-gray-800 text-gray-400';
          const borderClass = a.equippedAura ? 'border-purple-500 shadow-[0_0_12px_rgba(168,85,247,0.3)]' : 'border-gray-800 hover:border-gray-600';
          return `
            <div class="skin-card bg-arena-card rounded-xl p-3 border ${borderClass} transition-all">
              <div class="w-full h-20 rounded-lg mb-2 flex items-center justify-center" style="background:${esc(auraColor)}15">
                ${a.imageUrl
                  ? `<img src="${esc(a.imageUrl)}" class="h-12 w-12 object-contain" />`
                  : `<span style="color:${esc(auraColor)};font-size:28px">&#10024;</span>`}
              </div>
              <div class="flex items-center gap-1.5 mb-0.5">
                <h4 class="font-bold text-sm truncate">${esc(a.name)}</h4>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-400 flex-shrink-0">AURA</span>
              </div>
              <p class="text-xs text-gray-500 truncate">${esc(effectName)}</p>
              <div class="flex items-center justify-between mt-1.5">
                <span class="text-xs px-1.5 py-0.5 rounded ${rarityClass}">${a.rarity}</span>
                <button onclick="equipAuraFromCosmetics('${a.skinId}')" class="text-xs font-medium ${a.equippedAura ? 'text-green-400' : 'text-purple-400 hover:text-purple-300'}">
                  ${a.equippedAura ? '✓ Equipped' : 'Equip'}
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
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

async function equipAuraFromCosmetics(skinId) {
  if (!requireWallet('equip')) return;
  try {
    const result = await apiPostAuth('/api/shop/equip-aura', { skinId }, getAuthHeader());
    if (result.status === 'equipped') {
      loadCosmetics();
      showToast('Aura equipped!');
    }
  } catch (err) {
    console.error('Equip aura failed:', err);
    showToast(err.message || 'Failed to equip aura');
  }
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
  // Sync UI with current state
  const toggle = document.getElementById('settings-music-toggle');
  if (toggle) toggle.checked = musicEnabled;
  const slider = document.getElementById('settings-volume-slider');
  if (slider) slider.value = musicVolume;
  const label = document.getElementById('settings-volume-label');
  if (label) label.textContent = musicVolume + '%';
  modal.classList.remove('hidden');
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

function toggleMusicSetting(enabled) {
  musicEnabled = enabled;
  localStorage.setItem('pong-music-enabled', enabled ? 'true' : 'false');
  const audio = document.getElementById('bg-music');
  if (!audio) return;
  if (enabled && musicStarted) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
  updateMusicIcon();
}

function toggleMusic() {
  musicEnabled = !musicEnabled;
  localStorage.setItem('pong-music-enabled', musicEnabled ? 'true' : 'false');
  const audio = document.getElementById('bg-music');
  if (!audio) return;
  if (musicEnabled) {
    if (!musicStarted) {
      initMusic();
    } else {
      audio.play().catch(() => {});
    }
  } else {
    audio.pause();
  }
  updateMusicIcon();
}

function setMusicVolume(val) {
  musicVolume = parseInt(val, 10);
  localStorage.setItem('pong-music-volume', String(musicVolume));
  const audio = document.getElementById('bg-music');
  if (audio) audio.volume = musicVolume / 100;
  const label = document.getElementById('settings-volume-label');
  if (label) label.textContent = musicVolume + '%';
}

function updateMusicIcon() {
  const onIcon = document.getElementById('music-icon-on');
  const offIcon = document.getElementById('music-icon-off');
  const btn = document.getElementById('btn-music-toggle');
  if (!onIcon || !offIcon) return;
  if (musicEnabled) {
    onIcon.classList.remove('hidden');
    offIcon.classList.add('hidden');
    if (btn) { btn.style.color = '#c084fc'; }
  } else {
    onIcon.classList.add('hidden');
    offIcon.classList.remove('hidden');
    if (btn) { btn.style.color = ''; }
  }
}

function initMusic() {
  const audio = document.getElementById('bg-music');
  if (!audio) return;
  audio.volume = musicVolume / 100;
  if (musicEnabled) {
    audio.play().then(() => {
      musicStarted = true;
      updateMusicIcon();
    }).catch(() => {
      // Autoplay blocked — will retry on user interaction
    });
  } else {
    musicStarted = true;
  }
  updateMusicIcon();
}

// ===========================================
// LOADING SCREEN & MUSIC AUTO-START
// ===========================================

function dismissLoadingScreen() {
  const screen = document.getElementById('loading-screen');
  if (!screen || screen.classList.contains('fade-out')) return;
  screen.classList.add('fade-out');
  setTimeout(() => {
    screen.style.display = 'none';
  }, 600);
}

function tryStartMusic() {
  if (!musicStarted) initMusic();
}

// Immediately attempt to play music (works if user has interacted with domain before)
tryStartMusic();

(function initLoadingScreen() {
  // Auto-dismiss after 1.5s and try to start music
  const autoDismiss = setTimeout(() => {
    tryStartMusic();
    dismissLoadingScreen();
  }, 1500);

  function earlyDismiss() {
    clearTimeout(autoDismiss);
    tryStartMusic();
    dismissLoadingScreen();
    document.removeEventListener('click', earlyDismiss);
    document.removeEventListener('keydown', earlyDismiss);
    document.removeEventListener('touchstart', earlyDismiss);
  }
  document.addEventListener('click', earlyDismiss);
  document.addEventListener('keydown', earlyDismiss);
  document.addEventListener('touchstart', earlyDismiss);
})();

// Persistent fallback: keep trying on ANY user interaction until music starts
function persistentMusicStart() {
  if (musicStarted) return;
  const audio = document.getElementById('bg-music');
  if (!audio || !musicEnabled) return;
  audio.volume = musicVolume / 100;
  audio.play().then(() => {
    musicStarted = true;
    updateMusicIcon();
    // Remove all listeners once music starts
    ['click', 'keydown', 'touchstart', 'mousedown', 'scroll'].forEach(evt => {
      document.removeEventListener(evt, persistentMusicStart);
    });
  }).catch(() => {});
}
['click', 'keydown', 'touchstart', 'mousedown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, persistentMusicStart);
});

// Initialize music icon state on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateMusicIcon);
} else {
  updateMusicIcon();
}
