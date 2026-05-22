import { allowOptions, getSupabase, json, requireEaSecret, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!requireEaSecret(req, res)) return;

  try {
    const body = req.body || {};
    const licenseKey = String(body.license_key || '').trim();

    if (!licenseKey) return json(res, 400, { ok: false, message: 'license_key required' });

    const supabase = getSupabase();

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
      .upsert(payload, { onConflict: 'license_key' })
      .select()
      .single();

    if (error) throw error;

    return json(res, 200, { ok: true, data });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
