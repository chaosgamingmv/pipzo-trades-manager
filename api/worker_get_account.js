import { allowOptions, getSupabase, json, requireEaSecret, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!requireEaSecret(req, res)) return;

  try {
    const { license_key = '' } = req.body || {};
    const licenseKey = String(license_key).trim();

    if (!licenseKey) {
      return json(res, 400, { ok: false, message: 'license_key required' });
    }

    const supabase = getSupabase();

    const { data: license, error: licenseError } = await supabase
      .from('license_keys')
      .select('*')
      .eq('license_key', licenseKey)
      .maybeSingle();

    if (licenseError) throw licenseError;

    if (!license || !license.is_active || new Date(license.valid_until).getTime() < Date.now()) {
      return json(res, 403, { ok: false, message: 'License inactive or expired' });
    }

    const { data: account, error: accountError } = await supabase
      .from('mt5_accounts')
      .select('*')
      .eq('license_key', licenseKey)
      .eq('is_active', true)
      .maybeSingle();

    if (accountError) throw accountError;

    if (!account) {
      return json(res, 404, { ok: false, message: 'No active MT5 account found for this license' });
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
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
