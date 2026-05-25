const API_BASE = '/api';

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const initData = tg?.initData || '';
const tgUser = tg?.initDataUnsafe?.user || {};

const licenseScreen = document.getElementById('licenseScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const activateBtn = document.getElementById('activateBtn');
const activateMsg = document.getElementById('activateMsg');

const welcomeName = document.getElementById('welcomeName');
const profileBtn = document.getElementById('profileBtn');
const profileMenu = document.getElementById('profileMenu');
const profilePhoto = document.getElementById('profilePhoto');
const profileInitial = document.getElementById('profileInitial');
const menuName = document.getElementById('menuName');
const menuUsername = document.getElementById('menuUsername');
const logoutBtn = document.getElementById('logoutBtn');

const accountStep = document.getElementById('accountStep');
const tradeManagerStep = document.getElementById('tradeManagerStep');
const accountStatusPill = document.getElementById('accountStatusPill');

let pendingCommand = null;
let selectedRequestType = 'both';

function showScreen(screen) {
  licenseScreen.classList.remove('active');
  dashboardScreen.classList.remove('active');
  screen.classList.add('active');
}

function money(v) {
  const n = Number(v || 0);
  return '$' + n.toFixed(2);
}

function setupProfile() {
  const name = tgUser.first_name || tgUser.username || 'Trader';
  const username = tgUser.username ? `@${tgUser.username}` : 'Telegram User';

  welcomeName.textContent = name;
  menuName.textContent = name;
  menuUsername.textContent = username;

  const initial = String(name || 'P').charAt(0).toUpperCase();
  profileInitial.textContent = initial;

  if (tgUser.photo_url) {
    profilePhoto.src = tgUser.photo_url;
    profilePhoto.classList.remove('hidden');
    profileInitial.classList.add('hidden');
  }
}

async function api(path, data = {}) {
  try {
    const res = await fetch(`${API_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, initData })
    });

    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch {
      return {
        ok: false,
        message: `API did not return JSON. Status: ${res.status}. Response: ${text.substring(0, 250)}`
      };
    }
  } catch (error) {
    return { ok: false, message: error.message || 'Network/API error' };
  }
}

async function checkMe() {
  setupProfile();

  const res = await api('me');

  if (res.ok && res.user && res.user.license_key && localStorage.getItem('pipzo_logged_out') !== 'yes') {
    showScreen(dashboardScreen);
    await loadMt5Account();
    await loadStatus();
  } else {
    showScreen(licenseScreen);
  }
}

activateBtn.addEventListener('click', async () => {
  const licenseKey = document.getElementById('licenseKey').value.trim();

  if (!licenseKey) {
    activateMsg.textContent = 'Please enter your license key.';
    return;
  }

  localStorage.removeItem('pipzo_logged_out');

  activateBtn.disabled = true;
  activateBtn.textContent = 'Checking...';
  activateMsg.textContent = 'Checking license...';

  const res = await api('activate', { license_key: licenseKey });

  activateBtn.disabled = false;
  activateBtn.textContent = 'Continue';

  if (res.ok) {
    activateMsg.textContent = 'License activated.';
    showScreen(dashboardScreen);
    await loadMt5Account();
    await loadStatus();
  } else {
    activateMsg.textContent = res.message || 'Activation failed.';
  }
});

document.getElementById('showRequestBtn').addEventListener('click', () => {
  document.getElementById('requestBox').classList.toggle('hidden');
});

document.querySelectorAll('.seg-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-option').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRequestType = btn.dataset.requestType;
  });
});

document.getElementById('requestLicenseBtn').addEventListener('click', async () => {
  const btn = document.getElementById('requestLicenseBtn');
  const msg = document.getElementById('requestMsg');
  const note = document.getElementById('requestNote').value.trim();

  btn.disabled = true;
  btn.textContent = 'Sending...';
  msg.textContent = 'Sending request...';

  const res = await api('request_license', {
    request_type: selectedRequestType,
    note
  });

  btn.disabled = false;
  btn.textContent = 'Send Request';

  if (res.ok) {
    msg.textContent = 'Request sent. Admin will review it.';
  } else if (res.message && res.message.includes('not found')) {
    msg.textContent = 'Request API is not enabled yet. Please contact admin for a license key.';
  } else {
    msg.textContent = res.message || 'Could not send request. Contact admin.';
  }
});

profileBtn.addEventListener('click', () => {
  profileMenu.classList.toggle('hidden');
});

logoutBtn.addEventListener('click', () => {
  localStorage.setItem('pipzo_logged_out', 'yes');
  profileMenu.classList.add('hidden');
  document.getElementById('licenseKey').value = '';
  showScreen(licenseScreen);
});

document.getElementById('saveMt5Btn').addEventListener('click', async () => {
  const login = document.getElementById('mt5Login').value.trim();
  const password = document.getElementById('mt5Password').value;
  const server = document.getElementById('mt5Server').value.trim();
  const msg = document.getElementById('mt5Msg');

  if (!login || !password || !server) {
    msg.textContent = 'MT5 login, password, and server are required.';
    return;
  }

  const btn = document.getElementById('saveMt5Btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  msg.textContent = 'Saving MT5 account...';

  const res = await api('save_mt5_account', {
    mt5_login: login,
    mt5_password: password,
    mt5_server: server
  });

  btn.disabled = false;
  btn.textContent = 'Continue to Trade Manager';

  if (res.ok) {
    msg.textContent = 'MT5 account saved. Worker will connect shortly.';
    document.getElementById('mt5Password').value = '';
    await loadMt5Account();
  } else {
    msg.textContent = res.message || 'Could not save MT5 account.';
  }
});

document.getElementById('editAccountBtn').addEventListener('click', () => {
  accountStep.classList.remove('hidden');
  tradeManagerStep.classList.add('hidden');
});

async function loadMt5Account() {
  const card = document.getElementById('mt5AccountStatus');

  const res = await api('get_mt5_account');

  if (!res.ok || !res.account) {
    card.innerHTML = '<span>No MT5 account connected yet.</span>';
    accountStatusPill.textContent = 'Pending';
    accountStatusPill.className = 'pill pending';
    accountStep.classList.remove('hidden');
    tradeManagerStep.classList.add('hidden');
    return;
  }

  const a = res.account;
  const status = a.connection_status || 'pending';

  accountStatusPill.textContent = status;
  accountStatusPill.className = `pill ${status === 'connected' ? 'connected' : status === 'failed' ? 'failed' : 'pending'}`;

  card.innerHTML = `
    <b>MT5 Account</b>
    <span>Login: ${a.mt5_login}</span>
    <span>Server: ${a.mt5_server}</span>
    <span>Status: ${status}</span>
    ${a.last_error ? `<span class="error-text">Error: ${a.last_error}</span>` : ''}
  `;

  if (status === 'connected') {
    accountStep.classList.add('hidden');
    tradeManagerStep.classList.remove('hidden');
  } else {
    accountStep.classList.remove('hidden');
    tradeManagerStep.classList.add('hidden');
  }
}

async function sendCommand(command, params = {}) {
  const msg = document.getElementById('actionMsg');
  msg.textContent = 'Sending command...';

  const res = await api('create_command', { command, params });

  if (tg) {
    tg.HapticFeedback?.notificationOccurred(res.ok ? 'success' : 'error');
  }

  if (res.ok) {
    msg.textContent = 'Command sent. Worker will execute it shortly.';
  } else {
    msg.textContent = res.message || 'Command failed.';
  }

  return res;
}

document.querySelectorAll('[data-command]').forEach(btn => {
  btn.addEventListener('click', () => {
    const command = btn.dataset.command;
    const needsConfirm = btn.dataset.confirm === 'true';

    if (needsConfirm) {
      openConfirm(command);
    } else {
      sendCommand(command);
    }
  });
});

document.getElementById('closeLessProfit').addEventListener('click', () => {
  const maxProfit = Number(document.getElementById('lessProfitAmount').value || 0);
  sendCommand('close_less_profit', { max_profit: maxProfit });
});

document.getElementById('setSltp').addEventListener('click', () => {
  const slPoints = Number(document.getElementById('slPoints').value || 0);
  const tpPoints = Number(document.getElementById('tpPoints').value || 0);
  sendCommand('set_sltp', { sl_points: slPoints, tp_points: tpPoints });
});

function openConfirm(command) {
  pendingCommand = command;
  document.getElementById('confirmText').textContent = `Are you sure you want to run: ${command}?`;
  document.getElementById('confirmModal').classList.remove('hidden');
}

document.getElementById('cancelConfirm').addEventListener('click', () => {
  pendingCommand = null;
  document.getElementById('confirmModal').classList.add('hidden');
});

document.getElementById('yesConfirm').addEventListener('click', async () => {
  if (pendingCommand) {
    await sendCommand(pendingCommand);
  }

  pendingCommand = null;
  document.getElementById('confirmModal').classList.add('hidden');
});

async function loadStatus() {
  const res = await api('status');
  const s = res.status;
  const badge = document.getElementById('onlineBadge');

  if (!s) {
    badge.className = 'status-text offline';
    badge.textContent = 'Offline';
    return;
  }

  const lastSeen = new Date(s.last_seen).getTime();
  const online = Date.now() - lastSeen < 30000;

  badge.className = 'status-text ' + (online ? 'online' : 'offline');
  badge.textContent = online ? 'Online' : 'Offline';

  document.getElementById('balance').textContent = money(s.balance);
  document.getElementById('equity').textContent = money(s.equity);
  document.getElementById('floating').textContent = money(s.floating_profit);
  document.getElementById('openTrades').textContent = s.open_trades || 0;
}

checkMe();
setInterval(loadMt5Account, 8000);
setInterval(loadStatus, 5000);
