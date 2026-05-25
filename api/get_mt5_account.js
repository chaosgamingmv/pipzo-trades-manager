import { allowOptions, getSupabase, json, requirePost, validateTelegramInitData } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const { initData = '' } = req.body || {};

    const tg = validateTelegramInitData(initData);
    if (!tg.ok) return json(res, 401, tg);

    const telegramId = String(tg.user?.id || '');
    const supabase = getSupabase();

    const { data: appUser, error: userError } = await supabase
      .from('app_users')
      .select('license_key')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userError) throw userError;

    if (!appUser?.license_key) {
      return json(res, 200, { ok: true, account: null });
    }

    const { data, error } = await supabase
      .from('mt5_accounts')
      .select('id, license_key, telegram_username, mt5_login, mt5_server, connection_status, last_error, is_active, created_at, updated_at')
      .eq('license_key', appUser.license_key)
      .maybeSingle();

    if (error) throw error;

    return json(res, 200, { ok: true, account: data || null });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
