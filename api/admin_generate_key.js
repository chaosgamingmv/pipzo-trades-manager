import { allowOptions, generateLicenseKey, getSupabase, json, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const { admin_password = '', label = '', valid_until = '', allowed_account_type = 'both' } = req.body || {};

    if (!process.env.ADMIN_PASSWORD || admin_password !== process.env.ADMIN_PASSWORD) {
      return json(res, 401, { ok: false, message: 'Invalid admin password' });
    }

    if (!valid_until) {
      return json(res, 400, { ok: false, message: 'Validity date is required' });
    }

    if (!['demo', 'real', 'both'].includes(allowed_account_type)) {
      return json(res, 400, { ok: false, message: 'Invalid account type' });
    }

    const supabase = getSupabase();
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

    return json(res, 200, { ok: true, license: data });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
