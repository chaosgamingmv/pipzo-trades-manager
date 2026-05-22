import { allowOptions, getSupabase, json, requirePost, validateTelegramInitData } from './_utils.js';

const ALLOWED_COMMANDS = [
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

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const { initData = '', command = '', params = {} } = req.body || {};
    if (!ALLOWED_COMMANDS.includes(command)) {
      return json(res, 400, { ok: false, message: 'Invalid command' });
    }

    const tg = validateTelegramInitData(initData);
    if (!tg.ok) return json(res, 401, tg);

    const telegramId = String(tg.user?.id || '');
    const supabase = getSupabase();

    const { data: appUser, error: userError } = await supabase
      .from('app_users')
      .select('*')
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

    return json(res, 200, { ok: true, message: 'Command queued', command: inserted });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
