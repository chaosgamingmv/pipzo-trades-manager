import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-EA-SECRET');
}

export function json(res, status, data) {
  cors(res);
  res.status(status).json(data);
}

export function allowOptions(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.status(200).end();
    return true;
  }
  return false;
}

export function getSupabase() {
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

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, message: 'Method not allowed' });
    return false;
  }
  return true;
}

export function requireEaSecret(req, res) {
  const sent = req.headers['x-ea-secret'] || '';
  const expected = process.env.EA_API_SECRET || '';

  if (!expected || sent !== expected) {
    json(res, 401, { ok: false, message: 'Invalid EA secret' });
    return false;
  }

  return true;
}

export function generateLicenseKey() {
  const a = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b = crypto.randomBytes(3).toString('hex').toUpperCase();
  const c = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `PZ-${a}-${b}-${c}`;
}

export function validateTelegramInitData(initData) {
  if (!initData) {
    return { ok: false, message: 'Missing Telegram initData. Open inside Telegram.' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');

  if (!hash) {
    return { ok: false, message: 'Missing Telegram hash.' };
  }

  params.delete('hash');

  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) {
    return { ok: false, message: 'Missing TELEGRAM_BOT_TOKEN on server.' };
  }

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash !== hash) {
    return { ok: false, message: 'Invalid Telegram initData.' };
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

  return { ok: true, user };
}
