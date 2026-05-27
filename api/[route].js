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
    throw new Error('Missing TELEGRAM_BOT_TOKEN in Vercel environment variables.');
  }

  const cleanChatId = String(chatId || '').trim();

  if (!cleanChatId) {
    throw new Error('Missing Telegram chat id.');
  }

  const telegramRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: cleanChatId,
      text,
      disable_web_page_preview: true
    })
  });

  const telegramData = await telegramRes.json().catch(() => null);

  if (!telegramRes.ok || !telegramData || !telegramData.ok) {
    const description = telegramData?.description || `Telegram API HTTP ${telegramRes.status}`;
    throw new Error(description);
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

  const { data: existingUserLicense, error: existingUserLicenseError } = await supabase
    .from('license_keys')
    .select('license_key, valid_until')
    .eq('telegram_id', telegramId)
    .eq('is_active', true)
    .maybeSingle();

  if (existingUserLicenseError) throw existingUserLicenseError;

  if (existingUserLicense && existingUserLicense.license_key !== licenseKey) {
    return json(res, 403, {
      ok: false,
      message: 'You already have an active license linked to this Telegram account.'
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


function normalizeLicenseType(value) {
  const v = String(value || 'both').toLowerCase().trim();
  if (v === 'demo' || v === 'real' || v === 'both') return v;
  return 'both';
}

function getMt5ServerAccountType(serverName) {
  const server = String(serverName || '').toLowerCase();
  if (server.includes('trial')) return 'demo';
  if (server.includes('real')) return 'real';
  return 'unknown';
}

function validateMt5ServerAgainstLicense(allowedType, serverName) {
  const allowed = normalizeLicenseType(allowedType);
  const detected = getMt5ServerAccountType(serverName);

  if (detected === 'unknown') {
    return {
      ok: false,
      detected,
      message: 'Could not detect account type from server name. Demo servers must include "trial" and real servers must include "real".'
    };
  }

  if (allowed === 'both' || allowed === detected) {
    return { ok: true, detected };
  }

  return {
    ok: false,
    detected,
    message: allowed === 'demo'
      ? 'This license is Demo Only. Use an MT5 server that includes "trial".'
      : 'This license is Real Only. Use an MT5 server that includes "real".'
  };
}

async function handleRequestLicense(req, res, supabase) {
  const {
    initData = '',
    request_type = 'both',
    note = ''
  } = req.body || {};

  const requestType = normalizeLicenseType(request_type);

  if (!['demo', 'real', 'both'].includes(requestType)) {
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

  const { data: existingLicense, error: existingLicenseError } = await supabase
    .from('license_keys')
    .select('license_key, valid_until, allowed_account_type')
    .eq('telegram_id', telegramId)
    .eq('is_active', true)
    .maybeSingle();

  if (existingLicenseError) throw existingLicenseError;

  if (existingLicense && new Date(existingLicense.valid_until).getTime() > Date.now()) {
    return json(res, 200, {
      ok: true,
      message: 'You already have an active license. No new request was created.',
      license: {
        allowed_account_type: existingLicense.allowed_account_type,
        valid_until: existingLicense.valid_until
      }
    });
  }

  const { data: pendingRequest, error: pendingRequestError } = await supabase
    .from('license_requests')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingRequestError) throw pendingRequestError;

  if (pendingRequest) {
    return json(res, 200, {
      ok: true,
      message: 'You already have a pending license request. Please wait for admin approval.',
      request: pendingRequest
    });
  }

  const displayName = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown';

  const { data: request, error: requestError } = await supabase
    .from('license_requests')
    .insert({
      telegram_id: telegramId,
      telegram_username: username,
      first_name: firstName,
      last_name: lastName,
      request_type: requestType,
      note,
      status: 'pending',
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (requestError) throw requestError;

  const typeLabel =
    requestType === 'demo'
      ? 'Demo Only'
      : requestType === 'real'
        ? 'Real Only'
        : 'Demo + Real';

  try {
    await sendTelegramMessage(telegramId,
`✅ Pipzo License Request Received

Your request is now pending admin approval.

Requested Access: ${typeLabel}

You will receive your license key here after admin approves your request.`);
  } catch {
    // Do not fail the request if only Telegram notification fails.
  }

  const adminChatId = process.env.ADMIN_TELEGRAM_ID;

  if (adminChatId) {
    try {
      await sendTelegramMessage(adminChatId,
`🕒 New Pipzo License Request

👤 Name: ${displayName}
📱 Username: ${username ? '@' + username : 'No username'}
🆔 Telegram ID: ${telegramId}
📌 Access: ${typeLabel}

📝 Note:
${note || 'No note'}

Open the Pipzo Admin Panel to approve or reject.`);
    } catch {
      // Do not fail the user if only the admin notification fails.
    }
  }

  return json(res, 200, {
    ok: true,
    message: 'License request sent. Admin will review and approve it.',
    request
  });
}

async function handleCreateCommand(req, res, supabase) {
  const allowedCommands = [
    'close_all',
    'close_profit',
    'close_half',
    'close_less_profit',
    'breakeven',
    'set_sl',
    'set_tp',
    'set_sltp',
    'close_side_profit',
    'breakeven_side',
    'modify_side',
    'set_algo_trading',
    'refresh_status'
  ];

  const {
    initData = '',
    mt5_account_id = '',
    command = '',
    params = {}
  } = req.body || {};

  if (!allowedCommands.includes(command)) {
    return json(res, 400, {
      ok: false,
      message: 'Invalid command'
    });
  }

  if (!mt5_account_id) {
    return json(res, 400, {
      ok: false,
      message: 'Please select an MT5 account first.'
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

  const { data: account, error: accountError } = await supabase
    .from('mt5_accounts')
    .select('id, license_key, telegram_id, mt5_login, mt5_server, is_active')
    .eq('id', mt5_account_id)
    .eq('telegram_id', telegramId)
    .eq('license_key', appUser.license_key)
    .eq('is_active', true)
    .maybeSingle();

  if (accountError) throw accountError;

  if (!account) {
    return json(res, 403, {
      ok: false,
      message: 'Selected MT5 account was not found or does not belong to you.'
    });
  }

  const commandParams = {
    ...(params && typeof params === 'object' ? params : {}),
    mt5_account_id: account.id,
    mt5_login: account.mt5_login,
    mt5_server: account.mt5_server
  };

  const { data: inserted, error: insertError } = await supabase
    .from('ea_commands')
    .insert({
      license_key: appUser.license_key,
      telegram_id: telegramId,
      mt5_account: account.mt5_login,
      command,
      params: commandParams,
      status: 'pending'
    })
    .select()
    .single();

  if (insertError) throw insertError;

  return json(res, 200, {
    ok: true,
    message: 'Command queued',
    command: inserted,
    account: {
      id: account.id,
      mt5_login: account.mt5_login,
      mt5_server: account.mt5_server
    }
  });
}


async function handleStartMt5Account(req, res, supabase) {
  const {
    initData = '',
    mt5_account_id = ''
  } = req.body || {};

  if (!mt5_account_id) {
    return json(res, 400, {
      ok: false,
      message: 'Please select an MT5 account first.'
    });
  }

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
    return json(res, 403, {
      ok: false,
      message: 'Activate your license first'
    });
  }

  const { data: account, error: accountError } = await supabase
    .from('mt5_accounts')
    .select('id, license_key, telegram_id, mt5_login, mt5_server, is_active, connection_status')
    .eq('id', mt5_account_id)
    .eq('telegram_id', telegramId)
    .eq('license_key', appUser.license_key)
    .eq('is_active', true)
    .maybeSingle();

  if (accountError) throw accountError;

  if (!account) {
    return json(res, 403, {
      ok: false,
      message: 'Selected MT5 account was not found or does not belong to you.'
    });
  }

  const startRequestId = crypto.randomUUID();

  const { data: updated, error: updateError } = await supabase
    .from('mt5_accounts')
    .update({
      start_requested: true,
      start_request_id: startRequestId,
      start_requested_at: new Date().toISOString(),
      // Start is a manual action. Always move ONLY this selected account back to pending.
      // The VM claims accounts only when start_request_id is present, so old accounts
      // cannot auto-open when the master worker restarts.
      connection_status: 'pending',
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', account.id)
    .select('id, mt5_login, mt5_server, connection_status, start_requested, start_request_id, start_requested_at')
    .single();

  if (updateError) throw updateError;

  return json(res, 200, {
    ok: true,
    message: `Start request sent for MT5 ${account.mt5_login}.`,
    account: updated
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
    initData = '',
    mt5_account_id = ''
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

  let mt5Login = '';

  if (mt5_account_id) {
    const { data: account, error: accountError } = await supabase
      .from('mt5_accounts')
      .select('mt5_login')
      .eq('id', mt5_account_id)
      .eq('telegram_id', telegramId)
      .eq('license_key', appUser.license_key)
      .maybeSingle();

    if (accountError) throw accountError;
    mt5Login = account?.mt5_login || '';
  }

  let query = supabase
    .from('ea_status')
    .select('*')
    .eq('license_key', appUser.license_key);

  if (mt5Login) {
    query = query.eq('mt5_account', mt5Login);
  }

  const { data, error } = await query
    .order('updated_at', {
      ascending: false
    })
    .limit(1)
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


function requireAdminPassword(req, res) {
  const { admin_password = '' } = req.body || {};

  if (!process.env.ADMIN_PASSWORD || admin_password !== process.env.ADMIN_PASSWORD) {
    json(res, 401, {
      ok: false,
      message: 'Invalid admin password'
    });
    return false;
  }

  return true;
}

async function safeSelect(supabase, table, queryBuilder) {
  try {
    const query = queryBuilder ? queryBuilder(supabase.from(table)) : supabase.from(table).select('*');
    const { data, error } = await query;

    if (error) {
      return [];
    }

    return data || [];
  } catch {
    return [];
  }
}


async function handleAdminUpdateLicenseRequest(req, res, supabase) {
  if (!requireAdminPassword(req, res)) return;

  const {
    id = '',
    action = '',
    admin_note = ''
  } = req.body || {};

  if (!id) {
    return json(res, 400, {
      ok: false,
      message: 'Request id is required'
    });
  }

  const { data: request, error: requestError } = await supabase
    .from('license_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (requestError) throw requestError;

  if (!request) {
    return json(res, 404, {
      ok: false,
      message: 'License request not found'
    });
  }

  if (request.status !== 'pending') {
    return json(res, 400, {
      ok: false,
      message: 'This request has already been reviewed'
    });
  }

  if (action === 'reject') {
    const { data: updated, error: updateError } = await supabase
      .from('license_requests')
      .update({
        status: 'rejected',
        admin_note,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    try {
      await sendTelegramMessage(request.telegram_id,
`❌ Pipzo License Request Rejected

Your license request was not approved.${admin_note ? `\n\nAdmin note: ${admin_note}` : ''}`);
    } catch {
      // Telegram notification failure should not revert admin action.
    }

    return json(res, 200, {
      ok: true,
      message: 'License request rejected',
      request: updated
    });
  }

  if (action !== 'approve') {
    return json(res, 400, {
      ok: false,
      message: 'Invalid request action'
    });
  }

  const { data: existingLicense, error: existingLicenseError } = await supabase
    .from('license_keys')
    .select('license_key, valid_until')
    .eq('telegram_id', request.telegram_id)
    .eq('is_active', true)
    .maybeSingle();

  if (existingLicenseError) throw existingLicenseError;

  if (existingLicense && new Date(existingLicense.valid_until).getTime() > Date.now()) {
    return json(res, 400, {
      ok: false,
      message: 'This Telegram user already has an active license.'
    });
  }

  const autoDays = Number(process.env.AUTO_LICENSE_DAYS || 30);
  const validUntil = new Date(Date.now() + autoDays * 24 * 60 * 60 * 1000).toISOString();
  const key = generateLicenseKey();
  const displayName = `${request.first_name || ''}`.trim() || request.telegram_username || request.telegram_id || 'User';
  const requestType = normalizeLicenseType(request.request_type);

  const { data: license, error: licenseError } = await supabase
    .from('license_keys')
    .insert({
      license_key: key,
      label: `${displayName} - Approved Request`,
      telegram_id: request.telegram_id,
      telegram_username: request.telegram_username,
      allowed_account_type: requestType,
      valid_until: validUntil,
      is_active: true
    })
    .select('*')
    .single();

  if (licenseError) throw licenseError;

  const { data: updated, error: updateError } = await supabase
    .from('license_requests')
    .update({
      status: 'approved',
      license_key: key,
      admin_note,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select('*')
    .single();

  if (updateError) throw updateError;

  const typeLabel =
    requestType === 'demo'
      ? 'Demo Only'
      : requestType === 'real'
        ? 'Real Only'
        : 'Demo + Real';

  let telegramSent = false;
  let telegramError = '';

  try {
    await sendTelegramMessage(request.telegram_id,
`✅ Pipzo License Approved

Your license key is:

${key}

Access Type: ${typeLabel}
Valid Until: ${new Date(validUntil).toLocaleDateString('en-GB')}

Open the Pipzo Mini App and paste this key to continue.`);
    telegramSent = true;
  } catch (err) {
    telegramError = err?.message || 'Telegram message failed.';
  }

  return json(res, 200, {
    ok: true,
    message: telegramSent
      ? 'License request approved and key sent to user'
      : `License request approved, but Telegram message failed: ${telegramError}`,
    telegram_sent: telegramSent,
    telegram_error: telegramError,
    request: updated,
    license
  });
}

async function handleAdminResendLicenseMessage(req, res, supabase) {
  if (!requireAdminPassword(req, res)) return;

  const {
    request_id = '',
    license_id = ''
  } = req.body || {};

  let request = null;
  let license = null;

  if (request_id) {
    const { data, error } = await supabase
      .from('license_requests')
      .select('*')
      .eq('id', request_id)
      .maybeSingle();

    if (error) throw error;
    request = data;

    if (!request) {
      return json(res, 404, {
        ok: false,
        message: 'License request not found'
      });
    }

    const licenseKey = request.license_key || '';

    if (licenseKey) {
      const { data: licenseData, error: licenseError } = await supabase
        .from('license_keys')
        .select('*')
        .eq('license_key', licenseKey)
        .maybeSingle();

      if (licenseError) throw licenseError;
      license = licenseData;
    }

    if (!license) {
      const { data: licenseData, error: licenseError } = await supabase
        .from('license_keys')
        .select('*')
        .eq('telegram_id', request.telegram_id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (licenseError) throw licenseError;
      license = licenseData;
    }
  } else if (license_id) {
    const { data, error } = await supabase
      .from('license_keys')
      .select('*')
      .eq('id', license_id)
      .maybeSingle();

    if (error) throw error;
    license = data;

    if (!license) {
      return json(res, 404, {
        ok: false,
        message: 'License not found'
      });
    }
  }

  if (!license) {
    return json(res, 404, {
      ok: false,
      message: 'Approved license was not found for this request.'
    });
  }

  const chatId = request?.telegram_id || license.telegram_id;

  if (!chatId) {
    return json(res, 400, {
      ok: false,
      message: 'This license has no Telegram ID to send the message to.'
    });
  }

  const requestType = normalizeLicenseType(license.allowed_account_type || request?.request_type);
  const typeLabel =
    requestType === 'demo'
      ? 'Demo Only'
      : requestType === 'real'
        ? 'Real Only'
        : 'Demo + Real';

  await sendTelegramMessage(chatId,
`✅ Pipzo License Approved

Your license key is:

${license.license_key}

Access Type: ${typeLabel}
Valid Until: ${new Date(license.valid_until).toLocaleDateString('en-GB')}

Open the Pipzo Mini App and paste this key to continue.`);

  return json(res, 200, {
    ok: true,
    message: 'License key message sent to user'
  });
}

async function handleAdminDashboard(req, res, supabase) {
  if (!requireAdminPassword(req, res)) return;

  const [licenses, requests, users, accountsRaw, commands, statuses] = await Promise.all([
    safeSelect(supabase, 'license_keys', q => q.select('*').order('created_at', { ascending: false }).limit(300)),
    safeSelect(supabase, 'license_requests', q => q.select('*').order('created_at', { ascending: false }).limit(300)),
    safeSelect(supabase, 'app_users', q => q.select('*').order('created_at', { ascending: false }).limit(300)),
    safeSelect(supabase, 'mt5_accounts', q => q.select('*').order('created_at', { ascending: false }).limit(300)),
    safeSelect(supabase, 'ea_commands', q => q.select('*').order('created_at', { ascending: false }).limit(80)),
    safeSelect(supabase, 'ea_status', q => q.select('*').order('updated_at', { ascending: false }).limit(300))
  ]);

  const statusMap = new Map();
  for (const status of statuses) {
    const key = `${status.license_key || ''}:${status.mt5_account || ''}`;
    if (!statusMap.has(key)) {
      statusMap.set(key, status);
    }
  }

  const accounts = (accountsRaw || []).map(account => {
    const status = statusMap.get(`${account.license_key || ''}:${account.mt5_login || ''}`) || {};

    return {
      ...account,
      algo_trading_allowed: status.algo_trading_allowed,
      account_trade_allowed: status.account_trade_allowed,
      balance: status.balance,
      equity: status.equity,
      open_trades: status.open_trades,
      last_seen: status.last_seen
    };
  });

  return json(res, 200, {
    ok: true,
    licenses,
    requests,
    users,
    accounts,
    commands
  });
}

async function handleAdminUpdateLicense(req, res, supabase) {
  if (!requireAdminPassword(req, res)) return;

  const {
    id = '',
    action = '',
    days = 30,
    is_active = null,
    valid_until = ''
  } = req.body || {};

  if (!id) {
    return json(res, 400, {
      ok: false,
      message: 'License id is required'
    });
  }

  const update = {};

  if (action === 'set_active') {
    update.is_active = Boolean(is_active);
  } else if (action === 'extend') {
    const { data: current, error: currentError } = await supabase
      .from('license_keys')
      .select('valid_until')
      .eq('id', id)
      .maybeSingle();

    if (currentError) throw currentError;

    const baseTime = current?.valid_until && new Date(current.valid_until).getTime() > Date.now()
      ? new Date(current.valid_until).getTime()
      : Date.now();

    const extraDays = Number(days || 30);
    update.valid_until = new Date(baseTime + extraDays * 24 * 60 * 60 * 1000).toISOString();
    update.is_active = true;
  } else if (action === 'set_valid_until') {
    if (!valid_until) {
      return json(res, 400, {
        ok: false,
        message: 'valid_until is required'
      });
    }
    update.valid_until = new Date(`${valid_until}T23:59:59.000Z`).toISOString();
  } else if (action === 'delete') {
    const { data: current, error: currentError } = await supabase
      .from('license_keys')
      .select('id, license_key')
      .eq('id', id)
      .maybeSingle();

    if (currentError) throw currentError;

    if (!current) {
      return json(res, 404, {
        ok: false,
        message: 'License not found'
      });
    }

    const licenseKey = current.license_key;

    // Clean linked records first so deleted licenses do not leave users/accounts stuck.
    await supabase
      .from('mt5_accounts')
      .delete()
      .eq('license_key', licenseKey);

    await supabase
      .from('ea_commands')
      .delete()
      .eq('license_key', licenseKey);

    await supabase
      .from('ea_status')
      .delete()
      .eq('license_key', licenseKey);

    await supabase
      .from('open_trades')
      .delete()
      .eq('license_key', licenseKey);

    await supabase
      .from('app_users')
      .update({ license_key: null })
      .eq('license_key', licenseKey);

    const { error: deleteError } = await supabase
      .from('license_keys')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    return json(res, 200, {
      ok: true,
      deleted: true,
      id,
      license_key: licenseKey
    });
  } else {
    return json(res, 400, {
      ok: false,
      message: 'Invalid license action'
    });
  }

  const { data, error } = await supabase
    .from('license_keys')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    license: data
  });
}

async function handleAdminUpdateAccount(req, res, supabase) {
  if (!requireAdminPassword(req, res)) return;

  const {
    id = '',
    action = '',
    is_active = null
  } = req.body || {};

  if (!id) {
    return json(res, 400, {
      ok: false,
      message: 'MT5 account id is required'
    });
  }

  const now = new Date().toISOString();
  let update = {
    updated_at: now
  };

  if (action === 'set_active') {
    update.is_active = Boolean(is_active);
    if (!update.is_active) {
      update.connection_status = 'disabled';
      update.start_requested = false;
      update.start_request_id = null;
      update.claimed_start_request_id = null;
    }
  } else if (action === 'reset_start') {
    update = {
      ...update,
      start_requested: false,
      start_request_id: null,
      start_requested_at: null,
      claimed_start_request_id: null,
      claimed_at: null,
      connection_status: 'stopped'
    };
  } else if (action === 'force_stop') {
    update = {
      ...update,
      start_requested: false,
      start_request_id: null,
      start_requested_at: null,
      claimed_start_request_id: null,
      claimed_at: null,
      connection_status: 'stopped',
      assigned_worker_id: null,
      worker_pid: null,
      last_worker_heartbeat: null
    };
  } else if (action === 'clear_error') {
    update.last_error = null;
  } else {
    return json(res, 400, {
      ok: false,
      message: 'Invalid account action'
    });
  }

  const { data, error } = await supabase
    .from('mt5_accounts')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    account: data
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

  let query = supabase
    .from('ea_commands')
    .select('*')
    .eq('license_key', licenseKey)
    .eq('status', 'pending');

  // Important for multi-account mode:
  // each worker/terminal only picks commands for its own MT5 login.
  if (mt5Account) {
    query = query.eq('mt5_account', mt5Account);
  }

  const { data: command, error: cmdError } = await query
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
    algo_trading_allowed: typeof body.algo_trading_allowed === 'boolean' ? body.algo_trading_allowed : null,
    account_trade_allowed: typeof body.account_trade_allowed === 'boolean' ? body.account_trade_allowed : null,
    is_online: true,
    last_seen: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('ea_status')
    .upsert(payload, {
      onConflict: 'license_key,mt5_account'
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

  const serverValidation = validateMt5ServerAgainstLicense(license.allowed_account_type, mt5_server);

  if (!serverValidation.ok) {
    return json(res, 403, {
      ok: false,
      message: serverValidation.message,
      allowed_account_type: license.allowed_account_type,
      detected_account_type: serverValidation.detected
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
    assigned_worker_id: null,
    assigned_terminal_dir: null,
    worker_pid: null,
    claimed_at: null,
    last_worker_heartbeat: null,
    last_error: null,
    updated_at: new Date().toISOString()
  };

  // Do not use onConflict: license_key here, because cloud mode can have
  // more than one MT5 account under the same Telegram user/license.
  const { data: existing, error: existingError } = await supabase
    .from('mt5_accounts')
    .select('id')
    .eq('telegram_id', telegramId)
    .eq('mt5_login', payload.mt5_login)
    .eq('mt5_server', payload.mt5_server)
    .maybeSingle();

  if (existingError) throw existingError;

  let result;
  let saveError;

  if (existing) {
    const updateRes = await supabase
      .from('mt5_accounts')
      .update(payload)
      .eq('id', existing.id)
      .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, created_at, updated_at')
      .single();
    result = updateRes.data;
    saveError = updateRes.error;
  } else {
    const insertRes = await supabase
      .from('mt5_accounts')
      .insert(payload)
      .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, created_at, updated_at')
      .single();
    result = insertRes.data;
    saveError = insertRes.error;
  }

  if (saveError) throw saveError;

  return json(res, 200, {
    ok: true,
    message: 'MT5 account saved. Worker will connect shortly.',
    account: result
  });
}

async function handleGetMt5Accounts(req, res, supabase) {
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
      accounts: []
    });
  }

  const { data, error } = await supabase
    .from('mt5_accounts')
    .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, last_error, is_active, start_requested, start_requested_at, created_at, updated_at')
    .eq('telegram_id', telegramId)
    .eq('license_key', appUser.license_key)
    .eq('is_active', true)
    .order('created_at', {
      ascending: false
    });

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    accounts: data || []
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
    .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, last_error, is_active, start_requested, start_requested_at, created_at, updated_at')
    .eq('license_key', appUser.license_key)
    .eq('telegram_id', telegramId)
    .eq('is_active', true)
    .order('created_at', {
      ascending: false
    })
    .limit(1)
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

  let accountQuery = supabase
    .from('mt5_accounts')
    .select('*')
    .eq('license_key', licenseKey)
    .eq('is_active', true);

  const mt5AccountId = String((req.body || {}).mt5_account_id || '').trim();
  if (mt5AccountId) {
    accountQuery = accountQuery.eq('id', mt5AccountId);
  }

  const { data: account, error: accountError } = await accountQuery
    .order('created_at', {
      ascending: false
    })
    .limit(1)
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
      id: account.id,
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
    .eq('start_requested', true)
    .not('start_request_id', 'is', null)
    .eq('connection_status', 'pending')
    .order('start_requested_at', {
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
      id: account.id,
      license_key: account.license_key,
      mt5_login: account.mt5_login,
      mt5_password: account.mt5_password,
      mt5_server: account.mt5_server,
      telegram_username: account.telegram_username
    }
  });
}

async function handleWorkerClaimNextAccount(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    worker_id = '',
    base_terminal_dir = ''
  } = req.body || {};

  const workerId = String(worker_id).trim();

  if (!workerId) {
    return json(res, 400, {
      ok: false,
      message: 'worker_id required'
    });
  }

  const { data: candidates, error: candidateError } = await supabase
    .from('mt5_accounts')
    .select('*')
    .eq('is_active', true)
    .eq('start_requested', true)
    .not('start_request_id', 'is', null)
    // Important: do not auto-reopen old connected/running/stale accounts when the master worker starts.
    // The VM should only claim accounts that have a fresh start_request_id from the Mini App Start button.
    .eq('connection_status', 'pending')
    .order('start_requested_at', {
      ascending: true
    })
    .limit(10);

  if (candidateError) throw candidateError;

  if (!candidates || candidates.length === 0) {
    return json(res, 404, {
      ok: false,
      message: 'No pending MT5 account found'
    });
  }

  for (const account of candidates) {
    const { data: license, error: licenseError } = await supabase
      .from('license_keys')
      .select('*')
      .eq('license_key', account.license_key)
      .maybeSingle();

    if (licenseError) throw licenseError;

    if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
      continue;
    }

    const terminalDir = base_terminal_dir
      ? `${base_terminal_dir}\\${account.mt5_login}`
      : account.assigned_terminal_dir;

    const { data: updated, error: updateError } = await supabase
      .from('mt5_accounts')
      .update({
        assigned_worker_id: workerId,
        assigned_terminal_dir: terminalDir,
        connection_status: 'claimed',
        // Consume the exact Start request after this selected account is claimed.
        // This prevents every old/stale account from opening when VM/master restarts.
        start_requested: false,
        claimed_start_request_id: account.start_request_id,
        start_request_id: null,
        started_at: new Date().toISOString(),
        claimed_at: new Date().toISOString(),
        last_worker_heartbeat: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', account.id)
      .eq('start_request_id', account.start_request_id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return json(res, 200, {
      ok: true,
      account: {
        id: updated.id,
        license_key: updated.license_key,
        mt5_login: updated.mt5_login,
        mt5_password: updated.mt5_password,
        mt5_server: updated.mt5_server,
        telegram_username: updated.telegram_username,
        assigned_terminal_dir: updated.assigned_terminal_dir,
        claimed_start_request_id: updated.claimed_start_request_id
      }
    });
  }

  return json(res, 404, {
    ok: false,
    message: 'No valid active account found'
  });
}

async function handleWorkerListAssignedAccounts(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const { worker_id = '' } = req.body || {};
  const workerId = String(worker_id).trim();

  if (!workerId) {
    return json(res, 400, {
      ok: false,
      message: 'worker_id required'
    });
  }

  const { data, error } = await supabase
    .from('mt5_accounts')
    .select('id, license_key, mt5_login, mt5_server, telegram_username, connection_status, assigned_terminal_dir, worker_pid, last_worker_heartbeat')
    .eq('assigned_worker_id', workerId)
    .eq('is_active', true)
    .order('updated_at', {
      ascending: true
    });

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    accounts: data || []
  });
}

async function handleWorkerHeartbeat(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    license_key = '',
    mt5_account_id = '',
    mt5_account = '',
    worker_id = '',
    worker_pid = null,
    connection_status = 'running'
  } = req.body || {};

  const licenseKey = String(license_key).trim();
  const mt5AccountId = String(mt5_account_id).trim();
  const mt5Account = String(mt5_account).trim();
  const workerId = String(worker_id).trim();

  if (!licenseKey || !workerId) {
    return json(res, 400, {
      ok: false,
      message: 'license_key and worker_id required'
    });
  }

  let query = supabase
    .from('mt5_accounts')
    .update({
      assigned_worker_id: workerId,
      worker_pid,
      connection_status,
      last_worker_heartbeat: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('license_key', licenseKey);

  if (mt5AccountId) {
    query = query.eq('id', mt5AccountId);
  } else if (mt5Account) {
    query = query.eq('mt5_login', mt5Account);
  }

  const { data, error } = await query
    .select('id, license_key, mt5_login, connection_status, last_worker_heartbeat')
    .single();

  if (error) throw error;

  return json(res, 200, {
    ok: true,
    account: data
  });
}

async function handleWorkerUpdateAccountStatus(req, res, supabase) {
  if (!requireEaSecret(req, res)) return;

  const {
    license_key = '',
    mt5_account_id = '',
    mt5_account = '',
    connection_status = '',
    last_error = '',
    account_name = '',
    broker = ''
  } = req.body || {};

  const licenseKey = String(license_key).trim();
  const mt5AccountId = String(mt5_account_id).trim();
  const mt5Account = String(mt5_account).trim();

  if (!licenseKey) {
    return json(res, 400, {
      ok: false,
      message: 'license_key required'
    });
  }

  let query = supabase
    .from('mt5_accounts')
    .update({
      connection_status,
      last_error,
      account_name,
      broker,
      updated_at: new Date().toISOString()
    })
    .eq('license_key', licenseKey);

  if (mt5AccountId) {
    query = query.eq('id', mt5AccountId);
  } else if (mt5Account) {
    query = query.eq('mt5_login', mt5Account);
  }

  const { data, error } = await query
    .select('id, license_key, mt5_login, connection_status, last_error')
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
    if (route === 'start_mt5_account') return await handleStartMt5Account(req, res, supabase);
    if (route === 'list_commands') return await handleListCommands(req, res, supabase);
    if (route === 'status') return await handleStatus(req, res, supabase);

    if (route === 'admin_generate_key') return await handleAdminGenerateKey(req, res, supabase);
    if (route === 'admin_list_keys') return await handleAdminListKeys(req, res, supabase);
    if (route === 'admin_dashboard') return await handleAdminDashboard(req, res, supabase);
    if (route === 'admin_update_license') return await handleAdminUpdateLicense(req, res, supabase);
    if (route === 'admin_update_license_request') return await handleAdminUpdateLicenseRequest(req, res, supabase);
    if (route === 'admin_resend_license_message') return await handleAdminResendLicenseMessage(req, res, supabase);
    if (route === 'admin_update_account') return await handleAdminUpdateAccount(req, res, supabase);

    if (route === 'ea_poll') return await handleEaPoll(req, res, supabase);
    if (route === 'ea_update_command') return await handleEaUpdateCommand(req, res, supabase);
    if (route === 'ea_update_status') return await handleEaUpdateStatus(req, res, supabase);

    if (route === 'save_mt5_account') return await handleSaveMt5Account(req, res, supabase);
    if (route === 'get_mt5_account') return await handleGetMt5Account(req, res, supabase);
    if (route === 'get_mt5_accounts') return await handleGetMt5Accounts(req, res, supabase);

    if (route === 'worker_get_account') return await handleWorkerGetAccount(req, res, supabase);
    if (route === 'worker_get_next_account') return await handleWorkerGetNextAccount(req, res, supabase);
    if (route === 'worker_claim_next_account') return await handleWorkerClaimNextAccount(req, res, supabase);
    if (route === 'worker_list_assigned_accounts') return await handleWorkerListAssignedAccounts(req, res, supabase);
    if (route === 'worker_heartbeat') return await handleWorkerHeartbeat(req, res, supabase);
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
