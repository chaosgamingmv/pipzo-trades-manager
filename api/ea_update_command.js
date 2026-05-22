import { allowOptions, getSupabase, json, requireEaSecret, requirePost } from './_utils.js';

export default async function handler(req, res) {
  if (allowOptions(req, res)) return;
  if (!requirePost(req, res)) return;
  if (!requireEaSecret(req, res)) return;

  try {
    const { id = '', status = '', result = '' } = req.body || {};

    if (!id || !['executed', 'failed'].includes(status)) {
      return json(res, 400, { ok: false, message: 'Invalid request' });
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('ea_commands')
      .update({
        status,
        result,
        executed_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return json(res, 200, { ok: true, data });
  } catch (error) {
    return json(res, 500, { ok: false, message: error.message || 'Server error' });
  }
}
