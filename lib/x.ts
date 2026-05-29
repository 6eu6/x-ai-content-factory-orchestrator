import { optionalEnv } from './env';
import { withRetry, isTransientError } from './retry';
import { startCostEvent, completeCostEvent, failCostEvent } from './cost-ledger';
import { getCostContext } from './cost-context';

export type XAccountSnapshot = {
  username: string;
  id?: string;
  name?: string;
  description?: string;
  followers_count?: number;
  following_count?: number;
  tweet_count?: number;
  verified?: boolean;
  verified_type?: string;
  profile_image_url?: string;
  raw?: unknown;
};

let lastRequestAt = 0;

export function cleanTwitterApiKey(raw: string) {
  return String(raw || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

export function getTwitterApiKey() {
  const raw = optionalEnv('TWITTERAPI_IO_KEY') || optionalEnv('TWITTERAPI_IO_API_KEY') || optionalEnv('TWITTERAPI_KEY');
  const key = cleanTwitterApiKey(raw);
  if (!key) throw new Error('TWITTERAPI_IO_KEY missing. Add it in Vercel env.');
  return key;
}

function twitterApiHeaders() {
  return { 'X-API-Key': getTwitterApiKey() };
}

export function twitterApiBase() {
  return optionalEnv('TWITTERAPI_IO_BASE_URL', 'https://api.twitterapi.io').replace(/\/+$/, '');
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const delay = Number(optionalEnv('TWITTERAPI_IO_MIN_DELAY_MS', '5200'));
  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + delay - now);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export async function fetchTwitterApiJson(url: string, costMeta?: { run_id?: string; task_id?: string; task_type?: string }) {
  // Phase 2A: Resolve run_id/task_id from explicit costMeta, then AsyncLocalStorage context
  const costCtx = getCostContext();
  const runId = costMeta?.run_id ?? costCtx.run_id;
  const taskId = costMeta?.task_id ?? costCtx.task_id;

  // Start cost event for TwitterAPI.io call
  const costEventId = await startCostEvent({
    run_id: runId,
    task_id: taskId,
    task_type: costMeta?.task_type || costCtx.task_type || 'twitter_api_call',
    provider: 'twitterapi_io',
    model: null,
    request_url: url
  });

  try {
    const result = await withRetry(async () => {
      await throttle();
      const res = await fetch(url, { headers: twitterApiHeaders(), cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || json?.status === 'error' || json?.error) {
        const err = new Error(`${res.status} ${JSON.stringify(json)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return json;
    }, { attempts: 3, baseDelayMs: 1500, label: 'twitterapi', shouldRetry: isTransientError });

    // Complete cost event (TwitterAPI is flat subscription, cost = 0)
    await completeCostEvent(costEventId, {
      estimated_cost_usd: 0
    });

    return result;
  } catch (err: any) {
    // Fail cost event
    await failCostEvent(costEventId, err?.message || 'TwitterAPI.io call failed');
    throw err;
  }
}

export function extractTweets(json: any) {
  const candidates = [
    json?.tweets,
    json?.data?.tweets,
    json?.result?.tweets,
    json?.results,
    json?.data,
    json?.result
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function userFromAuthor(username: string, author: any): XAccountSnapshot {
  return {
    username: author?.userName || author?.username || username,
    id: String(author?.id || ''),
    name: author?.name,
    description: author?.description || author?.profile_bio?.description || '',
    followers_count: Number(author?.followers || 0),
    following_count: Number(author?.following || 0),
    tweet_count: Number(author?.statusesCount || 0),
    verified: Boolean(author?.isBlueVerified || author?.verified),
    verified_type: author?.verifiedType,
    profile_image_url: author?.profilePicture,
    raw: author
  };
}

function normalizeTwitterApiUser(username: string, json: any): XAccountSnapshot {
  const u = json.data || json.user || json.result || json;
  return userFromAuthor(username, u);
}

function normalizeTwitterApiTweet(t: any) {
  return {
    id: String(t.id || t.tweetId || t.rest_id || ''),
    text: t.text || t.full_text || t.content || '',
    created_at: t.createdAt || t.created_at || t.created_at_iso,
    public_metrics: {
      like_count: Number(t.likeCount || t.likes || t.favorite_count || 0),
      reply_count: Number(t.replyCount || t.replies || t.reply_count || 0),
      retweet_count: Number(t.retweetCount || t.retweets || t.retweet_count || 0),
      quote_count: Number(t.quoteCount || t.quotes || t.quote_count || 0),
      bookmark_count: Number(t.bookmarkCount || t.bookmarks || 0),
      view_count: Number(t.viewCount || t.views || 0)
    },
    // Merge entities + extendedEntities (TwitterAPI.io sends media in extendedEntities)
    entities: t.entities || t.extendedEntities || {},
    extended_entities: t.extendedEntities || t.extended_entities || t.entities || {},
    is_reply: Boolean(t.isReply || t.in_reply_to_status_id),
    in_reply_to_tweet_id: t.inReplyToStatusId || t.in_reply_to_status_id || null,
    is_quote_tweet: Boolean(t.isQuote || t.quotedStatusId || t.quoted_status_id),
    quoted_tweet_id: t.quotedStatusId || t.quoted_status_id || null,
    quoted_tweet_text: t.quotedStatus?.text || t.quoted_status?.text || t.quotedTweet?.text || '',
    quoted_tweet_author: t.quotedStatus?.author?.userName || t.quoted_status?.author?.userName || t.quotedTweet?.author?.userName || '',
    conversation_id: t.conversationId || t.conversation_id || null,
    is_thread_starter: Boolean(t.conversationId && String(t.conversationId) === String(t.id || t.tweetId || t.rest_id)),
    language: t.lang || t.language || null,
    author: t.author || t.user,
    raw: t
  };
}

export async function getXUserByUsername(username = optionalEnv('X_USERNAME', '30piq')): Promise<XAccountSnapshot> {
  const url = new URL(`${twitterApiBase()}/twitter/user/info`);
  url.searchParams.set('userName', username.replace(/^@/, ''));
  return normalizeTwitterApiUser(username, await fetchTwitterApiJson(url.toString()));
}

export async function searchXTweets(query: string, queryType: 'Latest' | 'Top' = 'Top', maxResults = 20) {
  const safeMax = Math.min(Math.max(Number(maxResults) || 20, 1), 20);
  const url = new URL(`${twitterApiBase()}/twitter/tweet/advanced_search`);
  url.searchParams.set('query', query);
  url.searchParams.set('queryType', queryType);
  const json = await fetchTwitterApiJson(url.toString());
  return extractTweets(json).slice(0, safeMax).map(normalizeTwitterApiTweet);
}

export async function getXUserTimeline(user: string | XAccountSnapshot, maxResults = 5, includeReplies = false) {
  const username = typeof user === 'string' ? user : user.username;
  const safeMax = Math.min(Math.max(Number(maxResults) || 5, 5), 20);
  const url = new URL(`${twitterApiBase()}/twitter/user/last_tweets`);
  url.searchParams.set('userName', username.replace(/^@/, ''));
  url.searchParams.set('includeReplies', String(Boolean(includeReplies)));
  const json = await fetchTwitterApiJson(url.toString());
  const fromTimeline = extractTweets(json).slice(0, safeMax).map(normalizeTwitterApiTweet);
  if (fromTimeline.length > 0) return fromTimeline;
  return searchXTweets(`from:${username.replace(/^@/, '')}`, 'Latest', safeMax);
}

export async function getXUserAndTimeline(username: string, maxResults = 5, includeReplies = false) {
  const tweets = await getXUserTimeline(username, maxResults, includeReplies);
  const author = tweets.find((t: any) => t.author)?.author;
  const user = author ? userFromAuthor(username, author) : await getXUserByUsername(username);
  return { user, tweets };
}

export function scoreXTweet(tweet: any) {
  const m = tweet.public_metrics || {};
  return (m.like_count || 0) + (m.reply_count || 0) * 2 + (m.retweet_count || 0) * 3 + (m.quote_count || 0) * 4 + (m.bookmark_count || 0) * 2 + Math.min(m.view_count || 0, 100000) / 1000;
}

export function analyzeXTweet(tweet: any, user: any) {
  const text = tweet.text || '';
  const created = tweet.created_at ? new Date(tweet.created_at) : null;
  const followers = user?.followers_count || user?.public_metrics?.followers_count || 0;
  const score = scoreXTweet(tweet);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Determine tweet type
  let tweetType: 'original' | 'quote' | 'reply' | 'thread_starter' = 'original';
  if (tweet.is_quote_tweet) tweetType = 'quote';
  else if (tweet.is_reply) tweetType = 'reply';
  else if (tweet.is_thread_starter) tweetType = 'thread_starter';

  return {
    tweet_id: tweet.id,
    tweet_url: `https://x.com/${user.username}/status/${tweet.id}`,
    username: user.username,
    text,
    created_at: tweet.created_at,
    hour_utc: created ? created.getUTCHours() : null,
    weekday_utc: created ? created.getUTCDay() : null,
    weekday_name: created ? dayNames[created.getUTCDay()] : null,
    time_label: created ? `${created.getUTCHours()}:00 UTC, ${dayNames[created.getUTCDay()]}` : null,
    metrics: tweet.public_metrics || {},
    followers_count: followers,
    engagement_score: score,
    engagement_per_1k_followers: followers ? Number(((score / followers) * 1000).toFixed(2)) : null,
    length: text.length,
    line_count: text.split('\n').length,
    has_question: text.includes('?'),
    has_link: Boolean(tweet.entities?.urls?.length),
    has_list: /(^|\n)\s*(\d+\.|-|•)/.test(text),
    is_reply: Boolean(tweet.is_reply),
    is_quote_tweet: Boolean(tweet.is_quote_tweet),
    tweet_type: tweetType,
    quoted_tweet_id: tweet.quoted_tweet_id || null,
    quoted_tweet_text: tweet.quoted_tweet_text || '',
    quoted_tweet_author: tweet.quoted_tweet_author || '',
    in_reply_to_tweet_id: tweet.in_reply_to_tweet_id || null,
    conversation_id: tweet.conversation_id || null,
    is_thread_starter: Boolean(tweet.is_thread_starter),
    language: tweet.language || null,
  };
}
