import { allowOptions, getSupabase, json, requireEaSecret, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!requireEaSecret(req, res)) return;

  try {
    const { license_key = '', mt5_account = '' } = req.body || {};
    const licenseKey = String(license_key).trim();
    const mt5Account = String(mt5_account).trim();

    if (!licenseKey) return json(res, 400, { ok: false, message: 'license_key required' });

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

    if (mt5Account && !license.mt5_account) {
      const { error: lockError } = await supabase
        .from('license_keys')
        .update({ mt5_account: mt5Account })
        .eq('license_key', licenseKey);
      if (lockError) throw lockError;
    } else if (mt5Account && license.mt5_account && license.mt5_account !== mt5Account) {
      return json(res, 403, { ok: false, message: 'This license is locked to another MT5 account' });
    }

    const { data: command, error: cmdError } = await supabase
      .from('ea_commands')
      .select('*')
      .eq('license_key', licenseKey)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (cmdError) throw cmdError;

    if (!command) return json(res, 200, { ok: true, command: null });

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

    return json(res, 200, { ok: true, command: updated });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
