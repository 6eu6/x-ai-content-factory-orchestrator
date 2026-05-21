import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from './env';

export function supabaseAdmin() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false }
  });
}

export async function insertSessionLog(input: Record<string, any>) {
  const supabase = supabaseAdmin();
  const payload = {
    ai_tool: input.ai_tool || 'orchestrator',
    session_type: input.session_type || 'api_run',
    actions_completed: input.actions_completed || [],
    decisions_made: input.decisions_made || [],
    content_created: input.content_created || [],
    db_updates: input.db_updates || [],
    github_updates: input.github_updates || [],
    pending_tasks: input.pending_tasks || [],
    next_recommendation: input.next_recommendation || null,
    notes: input.notes || null,
    ended_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('session_logs').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}
