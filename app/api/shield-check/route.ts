import { assertAuthorized } from '../../../lib/env';
import { shieldCheck } from '../../../lib/account-shield';

/**
 * POST /api/shield-check
 * 
 * يفحص أي محتوى قبل التسليم:
 * - Slop detection (كلمات وأنماط AI)
 * - Low-follower safety rules
 * - Algorithm violation check
 * - Originality gate
 * - Claim verification
 * 
 * Body: { text, type, sources?, originality_element?, mechanic_used?, reply_trigger?, bookmark_trigger? }
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();
    const result = await shieldCheck({
      text: body.text || '',
      type: body.type || 'tweet',
      sources: body.sources || [],
      originality_element: body.originality_element,
      mechanic_used: body.mechanic_used,
      reply_trigger: body.reply_trigger,
      bookmark_trigger: body.bookmark_trigger
    });
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
