import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-EA-SECRET');
}

function json(res, status, data) {
  cors(res);
  res.status(status).json(data);
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false
    }
  });
}

function requireEaSecret(req, res) {
  const sent = req.headers['x-ea-secret'] || '';
  const expected = process.env.EA_API_SECRET || '';

  if (!expected || sent !== expected) {
    json(res, 401, {
      ok: false,
      message: 'Invalid EA secret'
    });
    return false;
  }

  return true;
}

function generateLicenseKey() {
  const a = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b = crypto.randomBytes(3).toString('hex').toUpperCase();
  const c = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `PZ-${a}-${b}-${c}`;
}

function validateTelegramInitData(initData) {
  if (!initData) {
    return {
      ok: false,
      message: 'Missing Telegram initData. Open inside Telegram.'
    };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');

  if (!hash) {
    return {
      ok: false,
      message: 'Missing Telegram hash.'
    };
  }

  params.delete('hash');

  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

  if (!botToken) {
    return {
      ok: false,
      message: 'Missing TELEGRAM_BOT_TOKEN on server.'
    };
  }

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash !== hash) {
    return {
      ok: false,
      message: 'Invalid Telegram initData.'
    };
  }

  let user = {};
  const userRaw = params.get('user');

  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      user = {};
    }
  }

  return {
    ok: true,
    user
  };
}

function getRoute(req) {
  const route = req.query.route;

  if (Array.isArray(route)) {
    return route[0] || '';
  }

  return route || '';
}

async function sendTelegramMessage(chatId, text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN.');
  }

  const telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  const telegramData = await telegramRes.json();

  if (!telegramData.ok) {
    throw new Error(telegramData.description || 'Could not send Telegram message.');
  }

  return telegramData;
}

async function handleActivate(req, res, supabase) {
  const {
    initData = '',
    license_key = ''
  } = req.body || {};

  const licenseKey = String(license_key).trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'License key is required'
    });
  }

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');
  const username = String(tg.user?.username || '');
  const firstName = String(tg.user?.first_name || '');
  const lastName = String(tg.user?.last_name || '');

  if (!telegramId) {
    return json(res, 400, {
      ok: false,
      message: 'Telegram user not found'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license) {
    return json(res, 404, {
      ok: false,
      message: 'License key not found'
    });
  }

  if (!license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License key is expired or inactive'
    });
  }

  if (license.telegram_id && license.telegram_id !== telegramId) {
    return json(res, 403, {
      ok: false,
      message: 'This key is already assigned to another Telegram account'
    });
  }

  if (!license.telegram_id) {
    const { error: assignError } = await supabase
      .from('license_keys')
      .update({
        telegram_id: telegramId,
        telegram_username: username
      })
      .eq('license_key', licenseKey);

    if (assignError) throw assignError;
  }

  const { error: userError } = await supabase
    .from('app_users')
    .upsert({
      telegram_id: telegramId,
      telegram_username: username,
      first_name: firstName,
      last_name: lastName,
      license_key: licenseKey,
      is_active: true,
      last_login: new Date().toISOString()
    }, {
      onConflict: 'telegram_id'
    });

  if (userError) throw userError;

  return json(res, 200, {
    ok: true,
    message: 'License activated',
    user: {
      telegram_id: telegramId,
      username,
      license_key: licenseKey
    },
    license: {
      valid_until: license.valid_until,
      allowed_account_type: license.allowed_account_type
    }
  });
}

async function handleMe(req, res, supabase) {
  const {
    initData = ''
  } = req.body || {};

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');

  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    user: data || null
  });
}

async function handleRequestLicense(req, res, supabase) {
  const {
    initData = '',
    request_type = 'both',
    note = ''
  } = req.body || {};

  if (!['demo', 'real', 'both'].includes(request_type)) {
    return json(res, 400, {
      ok: false,
      message: 'Invalid request type'
    });
  }

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');
  const username = String(tg.user?.username || '');
  const firstName = String(tg.user?.first_name || '');
  const lastName = String(tg.user?.last_name || '');

  if (!telegramId) {
    return json(res, 400, {
      ok: false,
      message: 'Telegram user not found.'
    });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return json(res, 500, {
      ok: false,
      message: 'Telegram bot token is not configured.'
    });
  }

  const typeLabel =
    request_type === 'demo'
      ? 'Demo Only'
      : request_type === 'real'
        ? 'Real Only'
        : 'Demo + Real';

  const displayName = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown';

  const autoDays = Number(process.env.AUTO_LICENSE_DAYS || 30);
  const validUntil = new Date(Date.now() + autoDays * 24 * 60 * 60 * 1000).toISOString();

  const key = generateLicenseKey();

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .insert({
      license_key: key,
      label: `${displayName} - Auto Request`,
      telegram_id: telegramId,
      telegram_username: username,
      allowed_account_type: request_type,
      valid_until: validUntil,
      is_active: true
    })
    .select()
    .single();

  if (licenseError) throw licenseError;

  const userMessage =
`✅ Pipzo License Approved

Your license key is:

${key}

Access Type: ${typeLabel}
Valid Until: ${new Date(validUntil).toLocaleDateString('en-GB')}

Open the Pipzo Mini App and paste this key to continue.`;

  try {
    await sendTelegramMessage(telegramId, userMessage);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      message: `License created, but could not send message to user: ${error.message}`,
      license: {
        license_key: key,
        allowed_account_type: request_type,
        valid_until: validUntil
      }
    });
  }

  const adminChatId = process.env.ADMIN_TELEGRAM_ID;

  if (adminChatId) {
    const adminMessage =
`🔐 Auto License Generated

👤 Name: ${displayName}
📱 Username: ${username ? '@' + username : 'No username'}
🆔 Telegram ID: ${telegramId}

📌 Access: ${typeLabel}
🗓 Valid Until: ${new Date(validUntil).toLocaleDateString('en-GB')}

🔑 Key:
${key}

📝 Note:
${note || 'No note'}`;

    try {
      await sendTelegramMessage(adminChatId, adminMessage);
    } catch {
      // Do not fail the user if only the admin notification fails.
    }
  }

  return json(res, 200, {
    ok: true,
    message: 'License key generated and sent to your Telegram.',
    license: {
      license_key: license.license_key,
      allowed_account_type: license.allowed_account_type,
      valid_until: license.valid_until
    }
  });
}

async function handleCreateCommand(req, res, supabase) {
  const allowedCommands = [
    'close_all',
    'close_profit',
    'close_loss',
    'close_half',
    'close_less_profit',
    'breakeven',
    'set_sl',
    'set_tp',
    'set_sltp',
    'refresh_status'
  ];

  const {
    initData = '',
    command = '',
    params = {}
  } = req.body || {};

  if (!allowedCommands.includes(command)) {
    return json(res, 400, {
      ok: false,
      message: 'Invalid command'
    });
  }

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) throw userError;

  if (!appUser?.license_key) {
    return json(res, 403, {
      ok: false,
      message: 'Activate your license first'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', appUser.license_key)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License expired or inactive'
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from('ea_commands')
    .insert({
      license_key: appUser.license_key,
      telegram_id: telegramId,
      mt5_account: license.mt5_account,
      command,
      params,
      status: 'pending'
    })
    .select()
    .single();

  if (insertError) throw insertError;

  return json(res, 200, {
    ok: true,
    message: 'Command queued',
    command: inserted
  });
}

async function handleListCommands(req, res, supabase) {
  const {
    initData = ''
  } = req.body || {};

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('license_key')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) throw userError;

  if (!appUser?.license_key) {
    return json(res, 200, {
      ok: true,
      commands: []
    });
  }

  const { data, error } = await supabase
    .from('ea_commands')
    .select('*')
    .eq('license_key', appUser.license_key)
    .order('created_at', {
      ascending: false
    })
    .limit(20);

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    commands: data || []
  });
}

async function handleStatus(req, res, supabase) {
  const {
    initData = ''
  } = req.body || {};

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('license_key')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) throw userError;

  if (!appUser?.license_key) {
    return json(res, 200, {
      ok: true,
      status: null
    });
  }

  const { data, error } = await supabase
    .from('ea_status')
    .select('*')
    .eq('license_key', appUser.license_key)
    .maybeSingle();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    status: data || null
  });
}

async function handleAdminGenerateKey(req, res, supabase) {
  const {
    admin_password = '',
    label = '',
    valid_until = '',
    allowed_account_type = 'both'
  } = req.body || {};

  if (!process.env.ADMIN_PASSWORD || admin_password !== process.env.ADMIN_PASSWORD) {
    return json(res, 401, {
      ok: false,
      message: 'Invalid admin password'
    });
  }

  if (!valid_until) {
    return json(res, 400, {
      ok: false,
      message: 'Validity date is required'
    });
  }

  if (!['demo', 'real', 'both'].includes(allowed_account_type)) {
    return json(res, 400, {
      ok: false,
      message: 'Invalid account type'
    });
  }

  const key = generateLicenseKey();
  const validUntilDate = new Date(`${valid_until}T23:59:59.000Z`).toISOString();

  const { data, error } = await supabase
    .from('license_keys')
    .insert({
      license_key: key,
      label,
      allowed_account_type,
      valid_until: validUntilDate,
      is_active: true
    })
    .select()
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    license: data
  });
}

async function handleAdminListKeys(req, res, supabase) {
  const {
    admin_password = ''
  } = req.body || {};

  if (!process.env.ADMIN_PASSWORD || admin_password !== process.env.ADMIN_PASSWORD) {
    return json(res, 401, {
      ok: false,
      message: 'Invalid admin password'
    });
  }

  const { data, error } = await supabase
    .from('license_keys')
    .select('*')
    .order('created_at', {
      ascending: false
    })
    .limit(100);

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    keys: data || []
  });
}

async function handleEaPoll(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    license_key = '',
    mt5_account = ''
  } = req.body || {};

  const licenseKey = String(license_key).trim();
  const mt5Account = String(mt5_account).trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'license_key required'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License inactive or expired'
    });
  }

  if (mt5Account && !license.mt5_account) {
    const { error: lockError } = await supabase
      .from('license_keys')
      .update({
        mt5_account: mt5Account
      })
      .eq('license_key', licenseKey);

    if (lockError) throw lockError;
  } else if (mt5Account && license.mt5_account && license.mt5_account !== mt5Account) {
    return json(res, 403, {
      ok: false,
      message: 'This license is locked to another MT5 account'
    });
  }

  const { data: command, error: cmdError } = await supabase
    .from('ea_commands')
    .select('*')
    .eq('license_key', licenseKey)
    .eq('status', 'pending')
    .order('created_at', {
      ascending: true
    })
    .limit(1)
    .maybeSingle();

  if (cmdError) throw cmdError;

  if (!command) {
    return json(res, 200, {
      ok: true,
      command: null
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from('ea_commands')
    .update({
      status: 'processing',
      picked_at: new Date().toISOString()
    })
    .eq('id', command.id)
    .select()
    .single();

  if (updateError) throw updateError;

  return json(res, 200, {
    ok: true,
    command: updated
  });
}

async function handleEaUpdateCommand(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    id = '',
    status = '',
    result = ''
  } = req.body || {};

  if (!id || !['executed', 'failed'].includes(status)) {
    return json(res, 400, {
      ok: false,
      message: 'Invalid request'
    });
  }

  const { data, error } = await supabase
    .from('ea_commands')
    .update({
      status,
      result,
      executed_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    data
  });
}

async function handleEaUpdateStatus(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const body = req.body || {};
  const licenseKey = String(body.license_key || '').trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'license_key required'
    });
  }

  const payload = {
    license_key: licenseKey,
    mt5_account: String(body.mt5_account || ''),
    broker: String(body.broker || ''),
    server_name: String(body.server_name || ''),
    account_name: String(body.account_name || ''),
    account_type: String(body.account_type || ''),
    balance: Number(body.balance || 0),
    equity: Number(body.equity || 0),
    margin: Number(body.margin || 0),
    free_margin: Number(body.free_margin || 0),
    floating_profit: Number(body.floating_profit || 0),
    open_trades: Number(body.open_trades || 0),
    is_online: true,
    last_seen: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('ea_status')
    .upsert(payload, {
      onConflict: 'license_key'
    })
    .select()
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    data
  });
}

async function handleSaveMt5Account(req, res, supabase) {
  const {
    initData = '',
    mt5_login = '',
    mt5_password = '',
    mt5_server = ''
  } = req.body || {};

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');
  const username = String(tg.user?.username || '');

  if (!telegramId) {
    return json(res, 400, {
      ok: false,
      message: 'Telegram user not found'
    });
  }

  if (!mt5_login || !mt5_password || !mt5_server) {
    return json(res, 400, {
      ok: false,
      message: 'MT5 login, password, and server are required'
    });
  }

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('license_key')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) throw userError;

  if (!appUser?.license_key) {
    return json(res, 403, {
      ok: false,
      message: 'Activate your license first'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', appUser.license_key)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License expired or inactive'
    });
  }

  const payload = {
    license_key: appUser.license_key,
    telegram_id: telegramId,
    telegram_username: username,
    mt5_login: String(mt5_login).trim(),
    mt5_password: String(mt5_password),
    mt5_server: String(mt5_server).trim(),
    is_active: true,
    connection_status: 'pending',
    last_error: null,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('mt5_accounts')
    .upsert(payload, {
      onConflict: 'license_key'
    })
    .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, created_at, updated_at')
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    message: 'MT5 account saved. Worker will connect shortly.',
    account: data
  });
}

async function handleGetMt5Account(req, res, supabase) {
  const {
    initData = ''
  } = req.body || {};

  const tg = validateTelegramInitData(initData);

  if (!tg.ok) {
    return json(res, 401, tg);
  }

  const telegramId = String(tg.user?.id || '');

  const { data: appUser, error: userError } = await supabase
    .from('app_users')
    .select('license_key')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) throw userError;

  if (!appUser?.license_key) {
    return json(res, 200, {
      ok: true,
      account: null
    });
  }

  const { data, error } = await supabase
    .from('mt5_accounts')
    .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, last_error, is_active, created_at, updated_at')
    .eq('license_key', appUser.license_key)
    .maybeSingle();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    account: data || null
  });
}

async function handleWorkerGetAccount(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    license_key = ''
  } = req.body || {};

  const licenseKey = String(license_key).trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'license_key required'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License inactive or expired'
    });
  }

  const { data: account, error: accountError } = await supabase
    .from('mt5_accounts')
    .select('*')
    .eq('license_key', licenseKey)
    .eq('is_active', true)
    .maybeSingle();

  if (accountError) throw accountError;

  if (!account) {
    return json(res, 404, {
      ok: false,
      message: 'No active MT5 account found for this license'
    });
  }

  return json(res, 200, {
    ok: true,
    account: {
      license_key: account.license_key,
      mt5_login: account.mt5_login,
      mt5_password: account.mt5_password,
      mt5_server: account.mt5_server,
      telegram_username: account.telegram_username
    }
  });
}

async function handleWorkerGetNextAccount(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const { data: account, error: accountError } = await supabase
    .from('mt5_accounts')
    .select('*')
    .eq('is_active', true)
    .in('connection_status', ['pending', 'failed', 'connected'])
    .order('updated_at', {
      ascending: true
    })
    .limit(1)
    .maybeSingle();

  if (accountError) throw accountError;

  if (!account) {
    return json(res, 404, {
      ok: false,
      message: 'No active MT5 account found'
    });
  }

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .select('*')
    .eq('license_key', account.license_key)
    .maybeSingle();

  if (licenseError) throw licenseError;

  if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
    return json(res, 403, {
      ok: false,
      message: 'License inactive or expired for selected account'
    });
  }

  return json(res, 200, {
    ok: true,
    account: {
      license_key: account.license_key,
      mt5_login: account.mt5_login,
      mt5_password: account.mt5_password,
      mt5_server: account.mt5_server,
      telegram_username: account.telegram_username
    }
  });
}

async function handleWorkerUpdateAccountStatus(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    license_key = '',
    connection_status = '',
    last_error = '',
    account_name = '',
    broker = ''
  } = req.body || {};

  const licenseKey = String(license_key).trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'license_key required'
    });
  }

  const { data, error } = await supabase
    .from('mt5_accounts')
    .update({
      connection_status,
      last_error,
      account_name,
      broker,
      updated_at: new Date().toISOString()
    })
    .eq('license_key', licenseKey)
    .select('id, license_key, connection_status, last_error')
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    account: data
  });
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      message: 'Method not allowed'
    });
  }

  const route = getRoute(req);

  try {
    const supabase = getSupabase();

    if (route === 'activate') return await handleActivate(req, res, supabase);
    if (route === 'me') return await handleMe(req, res, supabase);
    if (route === 'request_license') return await handleRequestLicense(req, res, supabase);

    if (route === 'create_command') return await handleCreateCommand(req, res, supabase);
    if (route === 'list_commands') return await handleListCommands(req, res, supabase);
    if (route === 'status') return await handleStatus(req, res, supabase);

    if (route === 'admin_generate_key') return await handleAdminGenerateKey(req, res, supabase);
    if (route === 'admin_list_keys') return await handleAdminListKeys(req, res, supabase);

    if (route === 'ea_poll') return await handleEaPoll(req, res, supabase);
    if (route === 'ea_update_command') return await handleEaUpdateCommand(req, res, supabase);
    if (route === 'ea_update_status') return await handleEaUpdateStatus(req, res, supabase);

    if (route === 'save_mt5_account') return await handleSaveMt5Account(req, res, supabase);
    if (route === 'get_mt5_account') return await handleGetMt5Account(req, res, supabase);
    if (route === 'worker_get_account') return await handleWorkerGetAccount(req, res, supabase);
    if (route === 'worker_get_next_account') return await handleWorkerGetNextAccount(req, res, supabase);
    if (route === 'worker_update_account_status') return await handleWorkerUpdateAccountStatus(req, res, supabase);

    return json(res, 404, {
      ok: false,
      message: `API route not found: ${route}`
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      message: error.message || 'Server error'
    });
  }
}
