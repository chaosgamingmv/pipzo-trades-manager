const API_BASE = '/api';

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const initData = tg?.initData || '';

const activateSection = document.getElementById('activateSection');
const dashboardSection = document.getElementById('dashboardSection');
const activateBtn = document.getElementById('activateBtn');
const activateMsg = document.getElementById('activateMsg');
const onlineBadge = document.getElementById('onlineBadge');

let pendingCommand = null;

function money(v) {
  const n = Number(v || 0);
  return '$' + n.toFixed(2);
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
  const res = await api('me');

  if (res.ok && res.user && res.user.license_key) {
    activateSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    await loadMt5Account();
    await loadStatus();
    await loadCommands();
  }
}

activateBtn.addEventListener('click', async () => {
  const licenseKey = document.getElementById('licenseKey').value.trim();

  if (!licenseKey) {
    activateMsg.textContent = 'Please enter your license key.';
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = 'Activating...';
  activateMsg.textContent = 'Activating...';

  const res = await api('activate', { license_key: licenseKey });

  activateBtn.disabled = false;
  activateBtn.textContent = 'Activate';

  if (res.ok) {
    activateMsg.textContent = 'Activated.';
    activateSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    await loadMt5Account();
    await loadStatus();
    await loadCommands();
  } else {
    activateMsg.textContent = res.message || 'Activation failed.';
  }
});

async function sendCommand(command, params = {}) {
  const res = await api('create_command', { command, params });

  if (tg) {
    tg.HapticFeedback?.notificationOccurred(res.ok ? 'success' : 'error');
  }

  await loadCommands();

  if (!res.ok) {
    alert(res.message || 'Command failed');
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

document.getElementById('closeLessProfit')?.addEventListener('click', () => {
  const maxProfit = Number(document.getElementById('lessProfitAmount').value || 0);
  sendCommand('close_less_profit', { max_profit: maxProfit });
});

document.getElementById('setSltp')?.addEventListener('click', () => {
  const slPoints = Number(document.getElementById('slPoints').value || 0);
  const tpPoints = Number(document.getElementById('tpPoints').value || 0);
  sendCommand('set_sltp', { sl_points: slPoints, tp_points: tpPoints });
});

document.getElementById('saveMt5Btn')?.addEventListener('click', async () => {
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
  btn.textContent = 'Save MT5 Account';

  if (res.ok) {
    msg.textContent = 'MT5 account saved. Worker will connect shortly.';
    document.getElementById('mt5Password').value = '';
    await loadMt5Account();
  } else {
    msg.textContent = res.message || 'Could not save MT5 account.';
  }
});

async function loadMt5Account() {
  const card = document.getElementById('mt5AccountStatus');
  if (!card) return;

  const res = await api('get_mt5_account');

  if (!res.ok || !res.account) {
    card.innerHTML = '<span>No MT5 account connected yet.</span>';
    return;
  }

  const a = res.account;
  card.innerHTML = `
    <b>Connected MT5 Account</b>
    <span>Login: ${a.mt5_login}</span>
    <span>Server: ${a.mt5_server}</span>
    <span>Status: ${a.connection_status || 'pending'}</span>
    ${a.last_error ? `<span class="error-text">Error: ${a.last_error}</span>` : ''}
  `;
}

function openConfirm(command) {
  pendingCommand = command;
  document.getElementById('confirmText').textContent = `Are you sure you want to run: ${command}?`;
  document.getElementById('confirmModal').classList.remove('hidden');
}

document.getElementById('cancelConfirm')?.addEventListener('click', () => {
  pendingCommand = null;
  document.getElementById('confirmModal').classList.add('hidden');
});

document.getElementById('yesConfirm')?.addEventListener('click', async () => {
  if (pendingCommand) {
    await sendCommand(pendingCommand);
  }

  pendingCommand = null;
  document.getElementById('confirmModal').classList.add('hidden');
});

async function loadStatus() {
  const res = await api('status');
  const s = res.status;

  if (!s) {
    onlineBadge.className = 'badge offline';
    onlineBadge.textContent = 'Worker Offline';
    return;
  }

  const lastSeen = new Date(s.last_seen).getTime();
  const online = Date.now() - lastSeen < 30000;

  onlineBadge.className = 'badge ' + (online ? 'online' : 'offline');
  onlineBadge.textContent = online ? 'Worker Online' : 'Worker Offline';

  document.getElementById('balance').textContent = money(s.balance);
  document.getElementById('equity').textContent = money(s.equity);
  document.getElementById('floating').textContent = money(s.floating_profit);
  document.getElementById('openTrades').textContent = s.open_trades || 0;
}

async function loadCommands() {
  const res = await api('list_commands');
  const box = document.getElementById('commandsList');
  box.innerHTML = '';

  (res.commands || []).forEach(c => {
    const div = document.createElement('div');
    div.className = 'command';
    div.innerHTML = `
      <b>${c.command} — ${c.status}</b>
      <small>${new Date(c.created_at).toLocaleString()}</small>
      <p>${c.result || ''}</p>
    `;
    box.appendChild(div);
  });
}

checkMe();
setInterval(loadMt5Account, 7000);
setInterval(loadStatus, 5000);
setInterval(loadCommands, 7000);
