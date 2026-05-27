const API_BASE = '/api';

const $ = (id) => document.getElementById(id);

const state = {
  adminPassword: localStorage.getItem('pipzo_admin_password') || '',
  licenses: [],
  requests: [],
  users: [],
  accounts: [],
  commands: []
};

const els = {
  loginCard: $('loginCard'),
  adminPanel: $('adminPanel'),
  adminPassword: $('adminPassword'),
  loginBtn: $('loginBtn'),
  loginMsg: $('loginMsg'),
  logoutBtn: $('logoutBtn'),
  refreshAllBtn: $('refreshAllBtn'),
  refreshCommandsBtn: $('refreshCommandsBtn'),
  generateBtn: $('generateBtn'),
  generatedKey: $('generatedKey'),
  licensesTable: $('licensesTable'),
  requestsTable: $('requestsTable'),
  usersTable: $('usersTable'),
  accountsTable: $('accountsTable'),
  commandsTable: $('commandsTable'),
  licenseSearch: $('licenseSearch'),
  requestSearch: $('requestSearch'),
  userSearch: $('userSearch'),
  accountSearch: $('accountSearch'),
  toast: $('toast')
};

async function api(path, data = {}) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, admin_password: state.adminPassword })
  });

  const json = await res.json().catch(() => ({ ok: false, message: 'Invalid server response' }));

  if (!res.ok && !json.message) {
    json.message = `Request failed with status ${res.status}`;
  }

  return json;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function fmtDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function isExpired(value) {
  return value ? new Date(value).getTime() < Date.now() : false;
}

function textIncludes(row, term) {
  if (!term) return true;
  return JSON.stringify(row || {}).toLowerCase().includes(term.toLowerCase());
}

function statusPill(text, type = 'blue') {
  return `<span class="pill ${type}">${text}</span>`;
}

function accountOnline(account) {
  const status = String(account.connection_status || '').toLowerCase();
  const ping = account.last_worker_heartbeat || account.updated_at;
  const pingMs = ping ? new Date(ping).getTime() : 0;
  const fresh = pingMs && Date.now() - pingMs < 90 * 1000;
  return ['running', 'connected', 'online'].includes(status) || fresh;
}

function showApp() {
  els.loginCard.classList.add('hidden');
  els.adminPanel.classList.remove('hidden');
  els.logoutBtn.classList.remove('hidden');
}

function showLogin(message = '') {
  els.loginCard.classList.remove('hidden');
  els.adminPanel.classList.add('hidden');
  els.logoutBtn.classList.add('hidden');
  els.loginMsg.textContent = message;
}

async function unlock() {
  els.loginMsg.textContent = 'Checking...';
  const res = await api('admin_dashboard');

  if (!res.ok) {
    showLogin(res.message || 'Invalid admin password.');
    return;
  }

  showApp();
  applyAdminData(res);
  toast('Admin unlocked');
}

function applyAdminData(res) {
  state.licenses = res.licenses || [];
  state.requests = res.requests || [];
  state.users = res.users || [];
  state.accounts = res.accounts || [];
  state.commands = res.commands || [];

  const activeLicenses = state.licenses.filter(x => x.is_active && !isExpired(x.valid_until)).length;
  const expiredLicenses = state.licenses.filter(x => isExpired(x.valid_until)).length;
  const onlineAccounts = state.accounts.filter(accountOnline).length;
  const pendingRequests = state.requests.filter(x => String(x.status || '').toLowerCase() === 'pending').length;
  const pendingCommands = state.commands.filter(x => ['pending', 'processing'].includes(String(x.status || '').toLowerCase())).length;

  $('statUsers').textContent = state.users.length;
  $('statActiveLicenses').textContent = activeLicenses;
  $('statExpiredLicenses').textContent = expiredLicenses;
  $('statOnlineAccounts').textContent = onlineAccounts;
  $('statOfflineAccounts').textContent = Math.max(state.accounts.length - onlineAccounts, 0);
  $('statPendingRequests').textContent = pendingRequests;
  $('statPendingCommands').textContent = pendingCommands;

  renderLicenses();
  renderRequests();
  renderUsers();
  renderAccounts();
  renderCommands();
}

async function refreshAll() {
  els.refreshAllBtn.disabled = true;
  els.refreshAllBtn.textContent = 'Refreshing...';
  const res = await api('admin_dashboard');
  els.refreshAllBtn.disabled = false;
  els.refreshAllBtn.textContent = '⟳ Refresh';

  if (!res.ok) {
    toast(res.message || 'Could not refresh admin data');
    return;
  }

  applyAdminData(res);
  toast('Updated');
}


function typeLabel(value) {
  if (value === 'demo') return 'Demo Only';
  if (value === 'real') return 'Real Only';
  return 'Demo + Real';
}

function renderRequests() {
  if (!els.requestsTable) return;
  const term = els.requestSearch ? els.requestSearch.value.trim() : '';
  const rows = state.requests.filter(row => textIncludes(row, term));

  els.requestsTable.innerHTML = rows.length ? '' : `<tr><td colspan="6">No license requests found.</td></tr>`;

  rows.forEach(row => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.telegram_username || row.telegram_id || 'Unknown';
    const username = row.telegram_username ? '@' + row.telegram_username : '';
    const status = String(row.status || 'pending').toLowerCase();
    const statusType = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : 'yellow';
    const actionButtons = status === 'pending'
      ? `<button class="success-btn" data-action="approve-request" data-id="${row.id}">Approve</button>
         <button class="danger-btn" data-action="reject-request" data-id="${row.id}">Reject</button>`
      : `<span class="muted">${row.license_key ? `<code>${row.license_key}</code>` : '-'}</span>
         ${status === 'approved' && row.license_key ? `<button class="ghost-btn" data-action="resend-license-message" data-id="${row.id}">Send Key</button>` : ''}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong><br><span class="muted">${username || row.telegram_id || '-'}</span></td>
      <td>${typeLabel(row.request_type)}</td>
      <td>${row.note || '-'}</td>
      <td>${statusPill(row.status || 'pending', statusType)}${row.admin_note ? `<br><span class="muted">${row.admin_note}</span>` : ''}</td>
      <td>${fmtDate(row.created_at)}</td>
      <td><div class="row-actions">${actionButtons}</div></td>
    `;
    els.requestsTable.appendChild(tr);
  });
}

function renderLicenses() {
  const term = els.licenseSearch.value.trim();
  const rows = state.licenses.filter(row => textIncludes(row, term));

  els.licensesTable.innerHTML = rows.length ? '' : `<tr><td colspan="6">No licenses found.</td></tr>`;

  rows.forEach(row => {
    const expired = isExpired(row.valid_until);
    const active = row.is_active && !expired;
    const user = row.telegram_username ? `@${row.telegram_username}` : (row.telegram_id || row.label || '-');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${row.license_key || '-'}</code><br><span class="muted">${row.label || ''}</span></td>
      <td>${user}</td>
      <td>${row.allowed_account_type || 'both'}</td>
      <td>${fmtDate(row.valid_until)}</td>
      <td>${active ? statusPill('Active', 'green') : expired ? statusPill('Expired', 'yellow') : statusPill('Inactive', 'red')}</td>
      <td>
        <div class="row-actions">
          <button class="ghost-btn" data-action="extend-license" data-id="${row.id}" data-days="30">+30d</button>
          <button class="ghost-btn" data-action="extend-license" data-id="${row.id}" data-days="7">+7d</button>
          <button class="${row.is_active ? 'danger-btn' : 'success-btn'}" data-action="toggle-license" data-id="${row.id}" data-active="${row.is_active ? 'false' : 'true'}">${row.is_active ? 'Disable' : 'Enable'}</button>
          <button class="danger-btn" data-action="delete-license" data-id="${row.id}" data-key="${row.license_key || ''}">Delete</button>
        </div>
      </td>
    `;
    els.licensesTable.appendChild(tr);
  });
}

function renderUsers() {
  const term = els.userSearch.value.trim();
  const rows = state.users.filter(row => textIncludes(row, term));

  els.usersTable.innerHTML = rows.length ? '' : `<tr><td colspan="5">No users found.</td></tr>`;

  rows.forEach(row => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.telegram_username || 'Unknown';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong><br><span class="muted">${row.telegram_username ? '@' + row.telegram_username : ''}</span></td>
      <td>${row.telegram_id || '-'}</td>
      <td><code>${row.license_key || '-'}</code></td>
      <td>${row.is_active ? statusPill('Active', 'green') : statusPill('Inactive', 'red')}</td>
      <td>${fmtDate(row.last_login)}</td>
    `;
    els.usersTable.appendChild(tr);
  });
}

function renderAccounts() {
  const term = els.accountSearch.value.trim();
  const rows = state.accounts.filter(row => textIncludes(row, term));

  els.accountsTable.innerHTML = rows.length ? '' : `<tr><td colspan="7">No MT5 accounts found.</td></tr>`;

  rows.forEach(row => {
    const online = accountOnline(row);
    const manageTrades = row.algo_trading_allowed === true ? statusPill('On', 'green') : row.algo_trading_allowed === false ? statusPill('Off', 'red') : statusPill('Unknown', 'yellow');
    const user = row.telegram_username ? `@${row.telegram_username}` : (row.telegram_id || '-');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${row.mt5_login || '-'}</strong><br><span class="muted">${row.account_name || row.broker || ''}</span></td>
      <td>${user}<br><span class="muted"><code>${row.license_key || '-'}</code></span></td>
      <td>${row.mt5_server || '-'}</td>
      <td>${online ? statusPill('Online', 'green') : statusPill(row.connection_status || 'Offline', 'red')}<br><span class="muted">${row.last_error || ''}</span></td>
      <td>${manageTrades}</td>
      <td>${fmtDate(row.last_worker_heartbeat || row.updated_at)}</td>
      <td>
        <div class="row-actions">
          <button class="ghost-btn" data-action="reset-start" data-id="${row.id}">Reset Start</button>
          <button class="warning-btn" data-action="force-stop" data-id="${row.id}">Force Stop</button>
          <button class="${row.is_active ? 'danger-btn' : 'success-btn'}" data-action="toggle-account" data-id="${row.id}" data-active="${row.is_active ? 'false' : 'true'}">${row.is_active ? 'Disable' : 'Enable'}</button>
        </div>
      </td>
    `;
    els.accountsTable.appendChild(tr);
  });
}

function renderCommands() {
  els.commandsTable.innerHTML = state.commands.length ? '' : `<tr><td colspan="6">No commands found.</td></tr>`;

  state.commands.forEach(row => {
    const status = String(row.status || 'pending').toLowerCase();
    const type = status === 'executed' || status === 'done' ? 'green' : status === 'failed' || status === 'error' ? 'red' : status === 'processing' ? 'yellow' : 'blue';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${row.command || '-'}</strong></td>
      <td>${row.mt5_account || row.params?.mt5_login || '-'}</td>
      <td>${row.telegram_id || '-'}</td>
      <td>${statusPill(row.status || 'pending', type)}</td>
      <td>${row.result || row.error || '-'}</td>
      <td>${fmtDate(row.created_at)}</td>
    `;
    els.commandsTable.appendChild(tr);
  });
}

async function generateLicense() {
  const label = $('label').value.trim();
  const validUntil = $('validUntil').value;
  const accountType = $('accountType').value;

  if (!validUntil) {
    els.generatedKey.classList.remove('hidden');
    els.generatedKey.textContent = 'Please select validity date.';
    return;
  }

  els.generateBtn.disabled = true;
  els.generateBtn.textContent = 'Generating...';

  const res = await api('admin_generate_key', {
    label,
    valid_until: validUntil,
    allowed_account_type: accountType
  });

  els.generateBtn.disabled = false;
  els.generateBtn.textContent = 'Generate Key';
  els.generatedKey.classList.remove('hidden');

  if (!res.ok) {
    els.generatedKey.textContent = res.message || 'Could not generate key.';
    return;
  }

  els.generatedKey.innerHTML = `Generated Key: <code>${res.license.license_key}</code>`;
  await refreshAll();
}


async function updateLicenseRequest(id, action) {
  let adminNote = '';
  if (action === 'reject') {
    adminNote = prompt('Optional rejection note:') || '';
  }

  const res = await api('admin_update_license_request', {
    id,
    action,
    admin_note: adminNote
  });

  if (!res.ok) return toast(res.message || 'Could not update request');
  toast(res.message || (action === 'approve' ? 'Request approved' : 'Request rejected'));
  await refreshAll();
}

async function resendLicenseMessage(id) {
  const res = await api('admin_resend_license_message', {
    request_id: id
  });

  if (!res.ok) return toast(res.message || 'Could not send license message');
  toast(res.message || 'License message sent');
}

async function updateLicense(id, payload) {
  const res = await api('admin_update_license', { id, ...payload });
  if (!res.ok) return toast(res.message || 'Could not update license');
  toast(payload.action === 'delete' ? 'License deleted' : 'License updated');
  await refreshAll();
}

async function updateAccount(id, payload) {
  const res = await api('admin_update_account', { id, ...payload });
  if (!res.ok) return toast(res.message || 'Could not update account');
  toast('Account updated');
  await refreshAll();
}

function bindTables() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'approve-request') {
      return updateLicenseRequest(id, 'approve');
    }

    if (action === 'reject-request') {
      return updateLicenseRequest(id, 'reject');
    }

    if (action === 'resend-license-message') {
      return resendLicenseMessage(id);
    }

    if (action === 'extend-license') {
      return updateLicense(id, { action: 'extend', days: Number(btn.dataset.days || 30) });
    }

    if (action === 'toggle-license') {
      return updateLicense(id, { action: 'set_active', is_active: btn.dataset.active === 'true' });
    }

    if (action === 'delete-license') {
      const key = btn.dataset.key || '';
      const confirmed = confirm(`Delete this license permanently?${key ? `\n\n${key}` : ''}\n\nThis will also unlink the license from the user and remove linked MT5 account/command/status data.`);
      if (!confirmed) return;
      return updateLicense(id, { action: 'delete' });
    }

    if (action === 'reset-start') {
      return updateAccount(id, { action: 'reset_start' });
    }

    if (action === 'force-stop') {
      return updateAccount(id, { action: 'force_stop' });
    }

    if (action === 'toggle-account') {
      return updateAccount(id, { action: 'set_active', is_active: btn.dataset.active === 'true' });
    }
  });
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

els.loginBtn.addEventListener('click', async () => {
  state.adminPassword = els.adminPassword.value.trim();
  if (!state.adminPassword) {
    els.loginMsg.textContent = 'Enter admin password.';
    return;
  }
  localStorage.setItem('pipzo_admin_password', state.adminPassword);
  await unlock();
});

els.adminPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.loginBtn.click();
});

els.logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('pipzo_admin_password');
  state.adminPassword = '';
  els.adminPassword.value = '';
  showLogin('Logged out.');
});

els.refreshAllBtn.addEventListener('click', refreshAll);
els.refreshCommandsBtn.addEventListener('click', refreshAll);
els.generateBtn.addEventListener('click', generateLicense);
els.licenseSearch.addEventListener('input', renderLicenses);
if (els.requestSearch) els.requestSearch.addEventListener('input', renderRequests);
els.userSearch.addEventListener('input', renderUsers);
els.accountSearch.addEventListener('input', renderAccounts);

bindTabs();
bindTables();

if (state.adminPassword) {
  els.adminPassword.value = state.adminPassword;
  unlock();
}
