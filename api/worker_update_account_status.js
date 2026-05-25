import { allowOptions, getSupabase, json, requireEaSecret, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!requireEaSecret(req, res)) return;

  try {
    const {
      license_key = '',
      connection_status = '',
      last_error = '',
      account_name = '',
      broker = ''
    } = req.body || {};

    const licenseKey = String(license_key).trim();

    if (!licenseKey) {
      return json(res, 400, { ok: false, message: 'license_key required' });
    }

    const supabase = getSupabase();

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

    return json(res, 200, { ok: true, account: data });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
