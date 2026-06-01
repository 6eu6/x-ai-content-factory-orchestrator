/**
 * Brain — Embeddings
 *
 * Turns text into vectors for semantic retrieval (pgvector). Uses an
 * OpenAI-compatible /embeddings endpoint. Configurable so it can point at
 * OpenAI directly (recommended for embeddings) even when chat goes through
 * OpenRouter.
 *
 * Graceful by design: if embeddings are unavailable, callers fall back to
 * lexical retrieval, so the brain keeps working without an embeddings key.
 */

import OpenAI from 'openai';
import { optionalEnv } from '../env';

export const EMBEDDING_DIM = 1536; // text-embedding-3-small

let client: OpenAI | null = null;

function embedClient(): OpenAI | null {
  const apiKey = optionalEnv('EMBEDDINGS_API_KEY') || optionalEnv('OPENAI_API_KEY');
  if (!apiKey) return null;
  if (client) return client;
  // Embeddings base URL defaults to the standard OpenAI endpoint. Only fall back
  // to OPENAI_BASE_URL if it is NOT OpenRouter (which lacks reliable embeddings).
  let baseURL = optionalEnv('EMBEDDINGS_BASE_URL');
  if (!baseURL) {
    const chatBase = optionalEnv('OPENAI_BASE_URL');
    baseURL = chatBase && !chatBase.includes('openrouter.ai') ? chatBase : 'https://api.openai.com/v1';
  }
  client = new OpenAI({ apiKey, baseURL });
  return client;
}

export function embeddingsEnabled(): boolean {
  return Boolean(optionalEnv('EMBEDDINGS_API_KEY') || optionalEnv('OPENAI_API_KEY'));
}

/** Returns the embedding vector, or null if embeddings are unavailable/failed. */
export async function embed(text: string): Promise<number[] | null> {
  const c = embedClient();
  if (!c) return null;
  const model = optionalEnv('EMBEDDINGS_MODEL', 'text-embedding-3-small');
  const input = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
  if (!input) return null;
  try {
    const res = await c.embeddings.create({ model, input });
    return res.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

/** Batch embed; preserves order. Failed items are null. */
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  const c = embedClient();
  if (!c) return texts.map(() => null);
  const model = optionalEnv('EMBEDDINGS_MODEL', 'text-embedding-3-small');
  const inputs = texts.map((t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 8000));
  try {
    const res = await c.embeddings.create({ model, input: inputs });
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    return ordered.map((d) => d.embedding ?? null);
  } catch {
    return texts.map(() => null);
  }
}

/** pgvector literal format: "[0.1,0.2,...]" */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
