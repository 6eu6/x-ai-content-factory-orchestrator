import { optionalEnv } from './env';

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

function twitterApiHeaders() {
  const key = optionalEnv('TWITTERAPI_IO_KEY') || optionalEnv('TWITTERAPI_KEY');
  if (!key) throw new Error('TWITTERAPI_IO_KEY missing. Add it in Vercel env.');
  return { 'X-API-Key': key };
}

function twitterApiBase() {
  return optionalEnv('TWITTERAPI_IO_BASE_URL', 'https://api.twitterapi.io');
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: twitterApiHeaders(), cache: 'no-store' });
  const json = await res.json();
  if (!res.ok || json?.status === 'error' || json?.error) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

function normalizeTwitterApiUser(username: string, json: any): XAccountSnapshot {
  const u = json.data || json.user || json.result || json;
  const metrics = u.public_metrics || u.metrics || {};
  return {
    username: u.userName || u.username || username,
    id: String(u.id || u.rest_id || u.userId || ''),
    name: u.name,
    description: u.description || u.bio,
    followers_count: Number(u.followers || u.followers_count || metrics.followers_count || 0),
    following_count: Number(u.following || u.following_count || metrics.following_count || 0),
    tweet_count: Number(u.statuses_count || u.tweet_count || metrics.tweet_count || 0),
    verified: Boolean(u.verified || u.isBlueVerified),
    profile_image_url: u.profilePicture || u.profile_image_url,
    raw: json
  };
}

function normalizeTwitterApiTweet(t: any) {
  const m = t.public_metrics || t.metrics || {};
  return {
    id: String(t.id || t.tweetId || t.rest_id || ''),
    text: t.text || t.full_text || t.content || '',
    created_at: t.created_at || t.createdAt,
    public_metrics: {
      like_count: Number(t.likeCount || t.likes || m.like_count || 0),
      reply_count: Number(t.replyCount || t.replies || m.reply_count || 0),
      retweet_count: Number(t.retweetCount || t.retweets || m.retweet_count || 0),
      quote_count: Number(t.quoteCount || t.quotes || m.quote_count || 0)
    },
    entities: t.entities || {},
    raw: t
  };
}

export async function getXUserByUsername(username = optionalEnv('X_USERNAME', '30piq')): Promise<XAccountSnapshot> {
  const base = twitterApiBase();
  const candidates = [
    `${base}/twitter/user/info?userName=${encodeURIComponent(username)}`,
    `${base}/twitter/user/info?username=${encodeURIComponent(username)}`,
    `${base}/twitter/user/by_username?username=${encodeURIComponent(username)}`
  ];
  let last = '';
  for (const url of candidates) {
    try { return normalizeTwitterApiUser(username, await fetchJson(url)); } catch (e: any) { last = e.message; }
  }
  throw new Error(`TwitterAPI.io user lookup failed: ${last}`);
}

export async function getXUserTimeline(user: string | XAccountSnapshot, maxResults = 5) {
  const username = typeof user === 'string' ? user : user.username;
  const safeMax = Math.min(Math.max(Number(maxResults) || 5, 5), 50);
  const base = twitterApiBase();
  const candidates = [
    `${base}/twitter/user/last_tweets?userName=${encodeURIComponent(username)}&count=${safeMax}`,
    `${base}/twitter/user/last_tweets?username=${encodeURIComponent(username)}&count=${safeMax}`,
    `${base}/twitter/tweet/advanced_search?query=from:${encodeURIComponent(username)}&queryType=Latest&count=${safeMax}`
  ];
  let last = '';
  for (const url of candidates) {
    try {
      const json = await fetchJson(url);
      const arr = json.tweets || json.data || json.results || json.result?.tweets || [];
      return (Array.isArray(arr) ? arr : []).slice(0, safeMax).map(normalizeTwitterApiTweet);
    } catch (e: any) { last = e.message; }
  }
  throw new Error(`TwitterAPI.io timeline failed: ${last}`);
}

export function scoreXTweet(tweet: any) {
  const m = tweet.public_metrics || {};
  return (m.like_count || 0) + (m.reply_count || 0) * 2 + (m.retweet_count || 0) * 3 + (m.quote_count || 0) * 4;
}

export function analyzeXTweet(tweet: any, user: any) {
  const text = tweet.text || '';
  const created = tweet.created_at ? new Date(tweet.created_at) : null;
  const followers = user?.followers_count || user?.public_metrics?.followers_count || 0;
  const score = scoreXTweet(tweet);
  return {
    tweet_id: tweet.id,
    tweet_url: `https://x.com/${user.username}/status/${tweet.id}`,
    username: user.username,
    text,
    created_at: tweet.created_at,
    hour_utc: created ? created.getUTCHours() : null,
    weekday_utc: created ? created.getUTCDay() : null,
    metrics: tweet.public_metrics || {},
    followers_count: followers,
    engagement_score: score,
    engagement_per_1k_followers: followers ? Number(((score / followers) * 1000).toFixed(2)) : null,
    length: text.length,
    line_count: text.split('\n').length,
    has_question: text.includes('?'),
    has_link: Boolean(tweet.entities?.urls?.length),
    has_list: /(^|\n)\s*(\d+\.|-|•)/.test(text)
  };
}
