/**
 * Lean Core — Media vision
 *
 * Lets the system actually SEE the media a tweet uses (image, or the
 * poster/thumbnail of a gif/video) via a multimodal model, so a reply responds
 * to the media — not just the blind text.
 *
 * It also classifies the media's ROLE and emotional TONE and produces an
 * ORIGINAL sourcing plan: how the user can obtain an equivalent legitimately
 * (X's built-in licensed GIF picker, royalty-free libraries, their own
 * screen/recording, or the original source). It NEVER downloads or re-hosts
 * other people's media.
 *
 * Cost-bounded: only called for opportunity candidates that have media and
 * survive the deterministic prefilter, capped per cycle.
 */

import OpenAI from 'openai';
import { requiredEnv, optionalEnv } from '../env';
import { parseModelJson } from '../model-router';
import { languageName } from './config';

export type MediaRole = 'source' | 'meme_reaction' | 'demo' | 'decorative' | 'unknown';

export type MediaInsight = {
  description: string;       // what the image/thumbnail actually shows
  role: MediaRole;           // why the media is there
  tone: string;              // emotional beat (hype, celebratory, sad, deadpan, ...)
  sourcing_plan: string;     // how to get an ORIGINAL equivalent (legit channels)
};

function visionClient(): OpenAI {
  const baseURL = optionalEnv('OPENAI_BASE_URL') || undefined;
  const headers: Record<string, string> = {};
  if (baseURL && baseURL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = optionalEnv('OPENROUTER_REFERER', 'https://x.com/30piq');
    headers['X-OpenRouter-Title'] = optionalEnv('OPENROUTER_TITLE', 'X Growth Brain');
  }
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL, defaultHeaders: Object.keys(headers).length ? headers : undefined });
}

const SYSTEM = (lang: string) => [
  'You look at the still image (a photo, or the thumbnail/first frame of a gif or video) attached to a tweet and explain its role.',
  `Write the description and sourcing_plan in ${languageName(lang)}.`,
  'Classify role as one of: source (a screenshot/news/data image used as evidence), meme_reaction (a meme or reaction gif/clip, often emotional), demo (a product/tool/screen demo), decorative (adds little), unknown.',
  'tone = the emotional beat (e.g. hype, celebratory, sad, deadpan, awe, frustration).',
  'sourcing_plan = how the USER can obtain an ORIGINAL equivalent legitimately. NEVER tell them to download or re-post this exact media. Prefer, depending on role:',
  '  - source: find and screenshot the ORIGINAL source yourself (official site / the data); do not copy this image.',
  "  - meme_reaction: use X's built-in GIF button (Tenor) — give the exact search term and the vibe; it is licensed for posting on X. Or a royalty-free clip (Pexels/Pixabay), or your own reaction. Note if the original looks copyrighted (movie/music) and should not be copied.",
  '  - demo: record your own short screen capture of the tool/feature.',
  '  - decorative: a clean screenshot or none.',
  'Return ONLY JSON: {"description":"...","role":"...","tone":"...","sourcing_plan":"..."}',
].join('\n');

export async function describeMedia(imageUrl: string, tweetText: string, niche: string, language = 'en'): Promise<MediaInsight | null> {
  if (!imageUrl || !/^https?:\/\//.test(imageUrl)) return null;
  let client: OpenAI;
  try { client = visionClient(); } catch { return null; }
  const model = optionalEnv('VISION_MODEL', 'meta-llama/llama-4-maverick');

  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' } as any,
      messages: [
        { role: 'system', content: SYSTEM(language) },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Niche: ${niche}\nTweet text: ${tweetText.slice(0, 280)}` },
            { type: 'image_url', image_url: { url: imageUrl } },
          ] as any,
        },
      ],
    });
    const parsed = parseModelJson(res.choices[0]?.message?.content || '');
    const role = String(parsed?.role || 'unknown').toLowerCase();
    const validRole: MediaRole = (['source', 'meme_reaction', 'demo', 'decorative', 'unknown'] as const).includes(role as MediaRole)
      ? (role as MediaRole) : 'unknown';
    return {
      description: String(parsed?.description || '').slice(0, 400),
      role: validRole,
      tone: String(parsed?.tone || '').slice(0, 60),
      sourcing_plan: String(parsed?.sourcing_plan || '').slice(0, 400),
    };
  } catch {
    return null; // vision is optional; never block the radar on it
  }
}
