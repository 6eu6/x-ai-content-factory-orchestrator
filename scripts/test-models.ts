/**
 * test-models.ts — Test which OpenRouter models work from this region
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import OpenAI from 'openai';

const API_KEY = process.env.OPENAI_API_KEY!;
const BASE_URL = process.env.OPENAI_BASE_URL!;

const MODELS_TO_TEST = [
  'openai/gpt-4.1-mini',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat-v3-0324',
  'meta-llama/llama-4-maverick',
  'mistralai/mistral-small-3.1-24b-instruct',
  'google/gemini-2.0-flash-001',
  'google/gemini-2.5-flash-preview',
  'qwen/qwen3-235b-a22b',
  'anthropic/claude-sonnet-4-20250514',
];

async function testModel(model: string) {
  const client = new OpenAI({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': 'https://x.com/30piq',
      'X-OpenRouter-Title': 'X AI Content Factory',
    },
  });

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
      max_tokens: 10,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content || '';
    const tokens = (response as any).usage;
    console.log(`  ✅ ${model}: "${text.trim()}" (in=${tokens?.prompt_tokens}, out=${tokens?.completion_tokens})`);
    return true;
  } catch (err: any) {
    const msg = err?.message || 'unknown';
    const short = msg.length > 100 ? msg.slice(0, 100) + '...' : msg;
    console.log(`  ❌ ${model}: ${short}`);
    return false;
  }
}

async function main() {
  console.log('Testing OpenRouter models from this region...');
  console.log('Base URL:', BASE_URL);
  console.log('');

  for (const model of MODELS_TO_TEST) {
    await testModel(model);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
