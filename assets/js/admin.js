const API_BASE = '/api';

const adminPasswordInput = document.getElementById('adminPassword');
const loginBtn = document.getElementById('loginBtn');
const loginMsg = document.getElementById('loginMsg');
const adminPanel = document.getElementById('adminPanel');
const generateBtn = document.getElementById('generateBtn');
const refreshBtn = document.getElementById('refreshBtn');
const keysTable = document.getElementById('keysTable');
const generatedKey = document.getElementById('generatedKey');

let adminPassword = localStorage.getItem('pipzo_admin_password') || '';

async function api(path, data = {}) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, admin_password: adminPassword })
  });

  return await res.json();
}

function unlock() {
  adminPanel.classList.remove('hidden');
  loginMsg.textContent = 'Admin unlocked.';
  loadKeys();
}

loginBtn.addEventListener('click', async () => {
  adminPassword = adminPasswordInput.value.trim();

  if (!adminPassword) {
    loginMsg.textContent = 'Enter admin password.';
    return;
  }

  localStorage.setItem('pipzo_admin_password', adminPassword);

  const res = await api('admin_list_keys');

  if (res.ok) {
    unlock();
  } else {
    loginMsg.textContent = res.message || 'Invalid admin password.';
  }
});

generateBtn.addEventListener('click', async () => {
  const label = document.getElementById('label').value.trim();
  const validUntil = document.getElementById('validUntil').value;
  const accountType = document.getElementById('accountType').value;

  if (!validUntil) {
    generatedKey.classList.remove('hidden');
    generatedKey.textContent = 'Please select validity date.';
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';

  const res = await api('admin_generate_key', {
    label,
    valid_until: validUntil,
    allowed_account_type: accountType
  });

  generateBtn.disabled = false;
  generateBtn.textContent = 'Generate Key';

  generatedKey.classList.remove('hidden');

  if (res.ok) {
    generatedKey.textContent = `Generated Key: ${res.license.license_key}`;
    await loadKeys();
  } else {
    generatedKey.textContent = res.message || 'Could not generate key.';
  }
});

refreshBtn.addEventListener('click', loadKeys);

async function loadKeys() {
  const res = await api('admin_list_keys');

  keysTable.innerHTML = '';

  if (!res.ok) {
    keysTable.innerHTML = `<tr><td colspan="7">${res.message || 'Could not load keys.'}</td></tr>`;
    return;
  }

  (res.keys || []).forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${row.license_key}</code></td>
      <td>${row.label || ''}</td>
      <td>${row.telegram_username || row.telegram_id || ''}</td>
      <td>${row.mt5_account || ''}</td>
      <td>${row.allowed_account_type || ''}</td>
      <td>${row.valid_until ? new Date(row.valid_until).toLocaleDateString() : ''}</td>
      <td>${row.is_active ? 'Yes' : 'No'}</td>
    `;
    keysTable.appendChild(tr);
  });
}

if (adminPassword) {
  adminPasswordInput.value = adminPassword;
}
