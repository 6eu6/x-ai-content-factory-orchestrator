/**
 * مساعدات قاعدة البيانات — وظائف مشتركة
 */
export async function insertIfMissing(supabase: any, table: string, where: Record<string, any>, payload: Record<string, any>) {
  let query = supabase.from(table).select('id').limit(1);
  for (const [key, val] of Object.entries(where)) query = val == null ? query.is(key, null) : query.eq(key, val);
  const existing = await query.maybeSingle();
  if (existing.data?.id) return false;
  const inserted = await supabase.from(table).insert(payload).select('id').single();
  if (inserted.error) throw inserted.error;
  return true;
}
