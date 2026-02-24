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
let priceLastFetched = 0;
let priceFetchFailed = false;
const PRICE_REFRESH_MS = 60000;
const TIER_PONG_AMOUNTS = { low: 10000, medium: 50000, high: 200000 };

// --- DM state ---
let dmOpenWallet = null;
let dmOpenUsername = null;
let unreadCounts = {};

// --- Duel state ---
let duelTargetWallet = null;
let pendingDuelId = null;

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
        const price = parseFloat(data.pairs[0].priceUsd);
        if (price && price > 0) {
          pongPriceUsd = price;
          priceLastFetched = Date.now();
          priceFetchFailed = false;
          updateAllUsdDisplays();
          return;
        }
      }
    }
  } catch (e) { console.warn('DexScreener price fetch failed:', e.message); }

  // Source 2: GeckoTerminal
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${PONG_TOKEN_MINT}`);
    if (res.ok) {
      const data = await res.json();
      const priceStr = data?.data?.attributes?.token_prices?.[PONG_TOKEN_MINT];
      if (priceStr) {
        const price = parseFloat(priceStr);
        if (price && price > 0) {
          pongPriceUsd = price;
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
  return TIER_PONG_AMOUNTS[tier] * pongPriceUsd;
}

function updateAllUsdDisplays() {
  const lowUsd = document.getElementById('tier-usd-low');
  const medUsd = document.getElementById('tier-usd-medium');
  const highUsd = document.getElementById('tier-usd-high');

  if (priceFetchFailed || pongPriceUsd <= 0) {
    if (lowUsd) lowUsd.textContent = 'Price N/A';
    if (medUsd) medUsd.textContent = 'Price N/A';
    if (highUsd) highUsd.textContent = 'Price N/A';
  } else {
    if (lowUsd) lowUsd.textContent = formatUsd(getTierUsd('low'));
    if (medUsd) medUsd.textContent = formatUsd(getTierUsd('medium'));
    if (highUsd) highUsd.textContent = formatUsd(getTierUsd('high'));
  }
  updateGameStakeDisplay();
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
  return 'Bearer ' + sessionToken;
}

// ---- Socket.io ----
const socket = io();
window.socket = socket;

socket.on('connect', () => {
  if (currentUser) {
    socket.emit('register', { wallet: currentUser.wallet, username: currentUser.username });
  }
});

// ===========================================
// WALLET CONNECTION & AUTH
// ===========================================

(async function tryAutoLogin() {
  const saved = localStorage.getItem('pong_session');
  if (!saved) return;
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
    }
  } catch {
    localStorage.removeItem('pong_session');
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
  const username = document.getElementById('reg-username').value.trim();
  const bio = document.getElementById('reg-bio').value.trim();
  if (!username) return showRegError('Username is required');
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader() },
      body: JSON.stringify({ wallet: WalletManager.getWallet(), username, pfp: '', bio })
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
  // Route to the tab matching the current URL, or default to play
  const initialTab = getTabFromPath();
  switchTab(initialTab, false);
  // Replace current history entry so back works correctly
  history.replaceState({ tab: initialTab }, '', ROUTE_PATHS[initialTab] || '/play');
  socket.emit('register', { wallet: currentUser.wallet, username: currentUser.username });
  const canvas = document.getElementById('game-canvas');
  GameClient.init(canvas, currentUser.wallet);
  startPriceRefresh();
  // Show online count
  document.getElementById('online-count').classList.remove('hidden');
  // Fetch unread DM counts
  fetchUnreadCounts();
}

function updateNav() {
  document.getElementById('btn-connect').textContent = shortenAddress(currentUser.wallet);
  document.getElementById('btn-connect').onclick = null;
  document.getElementById('nav-username').textContent = currentUser.username;
  if (currentUser.pfp) document.getElementById('nav-pfp').src = currentUser.pfp;
  document.getElementById('nav-user').classList.remove('hidden');
}

// ===========================================
// CLIENT-SIDE ROUTING
// ===========================================

const TAB_ROUTES = {
  '/play': 'play',
  '/leaderboard': 'leaderboard',
  '/profile': 'profile',
  '/friends': 'friends',
  '/opponents': 'opponents',
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

  // Update URL (don't push on popstate or initial load)
  if (pushState !== false) {
    const targetPath = ROUTE_PATHS[tab] || '/play';
    if (window.location.pathname !== targetPath) {
      history.pushState({ tab }, '', targetPath);
    }
  }

  if (tab === 'profile') loadProfile();
  if (tab === 'friends') loadFriends();
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
  document.getElementById('profile-username').textContent = currentUser.username;
  document.getElementById('profile-wallet').textContent = shortenAddress(currentUser.wallet);
  document.getElementById('edit-username').value = currentUser.username;
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
      username: document.getElementById('edit-username').value.trim(),
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
  const badge = document.getElementById('friends-badge');
  if (total > 0) {
    badge.textContent = total;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
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
    const limitedSection = document.getElementById('shop-limited-section');
    const limitedGrid = document.getElementById('shop-limited-grid');
    if (res.limited && res.limited.length > 0) {
      limitedSection.classList.remove('hidden');
      limitedGrid.innerHTML = res.limited.map(c => renderCrateCard(c, true)).join('');
    } else {
      limitedSection.classList.add('hidden');
    }
    const standardGrid = document.getElementById('shop-standard-grid');
    standardGrid.innerHTML = (res.standard || []).map(c => renderCrateCard(c, false)).join('');
    const inventory = document.getElementById('shop-inventory');
    if (res.inventory && res.inventory.length > 0) {
      inventory.innerHTML = res.inventory.map(s => `
        <div class="skin-card bg-arena-card rounded-xl p-3 border ${s.equipped ? 'border-purple-500' : 'border-gray-800'}">
          <div class="w-full h-16 rounded-lg mb-2 flex items-center justify-center"
            style="background: ${s.type === 'color' ? esc(s.cssValue) + '33' : '#1a1a3a'}">
            ${s.type === 'color'
              ? `<div class="w-8 h-8 rounded-full" style="background:${esc(s.cssValue)};box-shadow:0 0 12px ${esc(s.cssValue)}"></div>`
              : `<img src="${esc(s.imageUrl)}" class="h-14 object-contain" />`
            }
          </div>
          <h4 class="font-bold text-xs">${esc(s.name)}</h4>
          <div class="flex items-center justify-between mt-1">
            <span class="text-xs px-1.5 py-0.5 rounded ${
              s.rarity === 'legendary' ? 'bg-yellow-900 text-yellow-300' :
              s.rarity === 'rare' ? 'bg-purple-900 text-purple-300' :
              'bg-gray-800 text-gray-400'
            }">${s.rarity}</span>
            <button onclick="equipSkin('${s.skinId}')" class="text-xs ${s.equipped ? 'text-green-400' : 'text-purple-400 hover:text-purple-300'}">
              ${s.equipped ? 'Equipped' : 'Equip'}
            </button>
          </div>
        </div>
      `).join('');
    } else {
      inventory.innerHTML = '<p class="text-gray-500 text-sm col-span-full">No skins yet. Open a crate!</p>';
    }
  } catch (err) {
    console.error('Failed to load shop:', err);
  }
}

function renderCrateCard(c, isLimited) {
  const borderColor = isLimited ? 'border-yellow-600' : 'border-gray-700';
  const usdPrice = pongPriceUsd > 0 ? formatUsd(c.price * pongPriceUsd) + ' / ' : '';
  return `
    <div class="skin-card bg-arena-card rounded-xl p-4 border ${borderColor}">
      <div class="flex items-start justify-between mb-2">
        <div>
          <h4 class="font-bold">${esc(c.name)}</h4>
          <p class="text-gray-500 text-xs">${esc(c.description || '')}</p>
        </div>
        <div class="w-10 h-10 rounded-lg flex-shrink-0" style="background:${esc(c.imageColor)};box-shadow:0 0 15px ${esc(c.imageColor)}55"></div>
      </div>
      <div class="flex items-center gap-3 text-xs text-gray-400 mb-3">
        <span>${c.rarityBreakdown.common} common</span>
        <span class="text-purple-400">${c.rarityBreakdown.rare} rare</span>
        <span class="text-yellow-400">${c.rarityBreakdown.legendary} legendary</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-sm font-bold text-white">${usdPrice}${c.price.toLocaleString()} $PONG</span>
        <button onclick="buyCrate('${c.crateId}')" class="bg-purple-600 hover:bg-purple-700 px-4 py-1.5 rounded-lg text-xs font-medium transition">
          Open${c.unownedCount > 0 ? ` (${c.unownedCount} new)` : ''}
        </button>
      </div>
    </div>
  `;
}

async function buyCrate(crateId) {
  try {
    const auth = getAuthHeader();
    const buyRes = await apiPostAuth('/api/shop/buy-crate', { crateId }, auth);
    if (buyRes.error) return alert(buyRes.error);
    const txSignature = await WalletManager.signAndSendTransaction(buyRes.transaction);
    const confirmRes = await apiPostAuth('/api/shop/confirm-crate', { crateId, txSignature }, auth);
    if (confirmRes.error) return alert(confirmRes.error);
    showCrateRoller(confirmRes.skin, confirmRes.crateSkins || [], confirmRes.duplicate);
  } catch (err) {
    alert('Purchase failed: ' + err.message);
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
  socket.emit('queue-join', { tier });
  currentGameTier = tier;
  showMatchmakingState('queue');
  const pongAmt = tier === 'low' ? '10K' : tier === 'medium' ? '50K' : '200K';
  const usdAmt = pongPriceUsd > 0 ? ` (${formatUsd(getTierUsd(tier))})` : '';
  document.getElementById('queue-tier-display').textContent = `${tier.toUpperCase()} tier — ${pongAmt} $PONG${usdAmt}`;
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
    const pongAmt = TIER_PONG_AMOUNTS[currentGameTier] || 0;
    const usdAmt = getTierUsd(currentGameTier);
    if (pongPriceUsd > 0 && pongAmt) {
      el.textContent = `${formatUsd(usdAmt)} (${(pongAmt / 1000).toFixed(0)}K $PONG each)`;
    } else if (pongAmt) {
      el.textContent = `${(pongAmt / 1000).toFixed(0)}K $PONG each`;
    } else {
      el.textContent = '';
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
  const countdownEl = document.getElementById('intermission-countdown');
  let sec = data.seconds;
  function tick() {
    if (countdownEl) countdownEl.textContent = sec;
    GameClient.renderCountdown(sec);
    sec--;
    if (sec >= 0) setTimeout(tick, 1000);
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

  let sec = data.seconds || 30;
  const countdownEl = document.getElementById('intermission-countdown');
  if (intermissionCountdownInterval) clearInterval(intermissionCountdownInterval);
  function updateCountdown() {
    GameClient.renderCountdown(sec);
    if (countdownEl) countdownEl.textContent = sec;
    sec--;
    if (sec < 0) clearInterval(intermissionCountdownInterval);
  }
  updateCountdown();
  intermissionCountdownInterval = setInterval(updateCountdown, 1000);
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
  let remaining = 15;
  if (countEl) countEl.textContent = remaining;
  if (disconnectCountdownInterval) clearInterval(disconnectCountdownInterval);
  disconnectCountdownInterval = setInterval(() => {
    remaining--;
    if (countEl) countEl.textContent = Math.max(remaining, 0);
    if (remaining <= 0) clearInterval(disconnectCountdownInterval);
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
