import { allowOptions, getSupabase, json, requirePost, validateTelegramInitData } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const {
      initData = '',
      mt5_login = '',
      mt5_password = '',
      mt5_server = ''
    } = req.body || {};

    const tg = validateTelegramInitData(initData);
    if (!tg.ok) return json(res, 401, tg);

    const telegramId = String(tg.user?.id || '');
    const username = String(tg.user?.username || '');

    if (!telegramId) {
      return json(res, 400, { ok: false, message: 'Telegram user not found' });
    }

    if (!mt5_login || !mt5_password || !mt5_server) {
      return json(res, 400, { ok: false, message: 'MT5 login, password, and server are required' });
    }

    const supabase = getSupabase();

    const { data: appUser, error: userError } = await supabase
      .from('app_users')
      .select('license_key')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userError) throw userError;

    if (!appUser?.license_key) {
      return json(res, 403, { ok: false, message: 'Activate your license first' });
    }

    const { data: license, error: licenseError } = await supabase
      .from('license_keys')
      .select('*')
      .eq('license_key', appUser.license_key)
      .maybeSingle();

    if (licenseError) throw licenseError;

    if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
      return json(res, 403, { ok: false, message: 'License expired or inactive' });
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
      .upsert(payload, { onConflict: 'license_key' })
      .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, created_at, updated_at')
      .single();

    if (error) throw error;

    return json(res, 200, {
      ok: true,
      message: 'MT5 account saved. Worker will connect shortly.',
      account: data
    });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
