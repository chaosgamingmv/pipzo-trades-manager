import { allowOptions, getSupabase, json, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const { admin_password = '' } = req.body || {};

    if (!process.env.ADMIN_PASSWORD || admin_password !== process.env.ADMIN_PASSWORD) {
      return json(res, 401, { ok: false, message: 'Invalid admin password' });
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('license_keys')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return json(res, 200, { ok: true, keys: data || [] });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
