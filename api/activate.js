import { allowOptions, getSupabase, json, requirePost, validateTelegramInitData } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const { initData = '', license_key = '' } = req.body || {};
    const licenseKey = String(license_key).trim();

    if (!licenseKey) {
      return json(res, 400, { ok: false, message: 'License key is required' });
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
      return json(res, 400, { ok: false, message: 'Telegram user not found' });
    }

    const supabase = getSupabase();

    const { data: license, error: licenseError } = await supabase
      .from('license_keys')
      .select('*')
      .eq('license_key', licenseKey)
      .maybeSingle();

    if (licenseError) throw licenseError;
    if (!license) return json(res, 404, { ok: false, message: 'License key not found' });

    if (!license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
      return json(res, 403, { ok: false, message: 'License key is expired or inactive' });
    }

    if (license.telegram_id && license.telegram_id !== telegramId) {
      return json(res, 403, { ok: false, message: 'This key is already assigned to another Telegram account' });
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
      }, { onConflict: 'telegram_id' });

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
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
