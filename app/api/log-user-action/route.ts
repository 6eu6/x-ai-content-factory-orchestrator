import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();
    const supabase = supabaseAdmin();
    const { data, error } = await supabase.from('verification_events').insert({
      event_type: body.event_type || 'user_report',
      subject_key: body.target_key || body.subject_key || null,
      status_after: body.status || 'reported',
      verification_source: body.verification_source || 'user_report',
      evidence_url: body.evidence_url || null,
      evidence_payload: body,
      notes: body.evidence_text || body.notes || null
    }).select('*').single();
    if (error) throw error;
    if (body.target_key && body.status) {
      await supabase.from('requirement_status').update({
        status: body.status,
        verification_source: body.verification_source || 'user_report',
        evidence_url: body.evidence_url || null,
        completed_at: body.status === 'complete' ? new Date().toISOString() : null,
        last_checked_at: new Date().toISOString(),
        notes: body.evidence_text || body.notes || null
      }).eq('requirement_key', body.target_key);
    }
    await insertSessionLog({ actions_completed: ['logged_user_action'], db_updates: [{ table: 'verification_events', id: data.id }] });
    return Response.json({ ok: true, event: data });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
