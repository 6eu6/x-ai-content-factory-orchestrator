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

function provider() {
  return optionalEnv('X_DATA_PROVIDER', 'auto').toLowerCase();
}

function officialHeaders() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) throw new Error('X_BEARER_TOKEN missing.');
  return { Authorization: `Bearer ${bearer}` };
}

function twitterApiHeaders() {
  const key = optionalEnv('TWITTERAPI_IO_KEY') || optionalEnv('TWITTERAPI_KEY');
  if (!key) throw new Error('TWITTERAPI_IO_KEY missing.');
  return { 'X-API-Key': key };
}

function twitterApiBase() {
  return optionalEnv('TWITTERAPI_IO_BASE_URL', 'https://api.twitterapi.io');
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, cache: 'no-store' });
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
    entities: t.entities || {}
  };
}

async function getOfficialUser(username: string): Promise<XAccountSnapshot> {
  const params = new URLSearchParams({ 'user.fields': 'description,public_metrics,verified,verified_type,profile_image_url,created_at' });
  const json = await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?${params}`, officialHeaders());
  const u = json.data || {};
  return {
    username,
    id: u.id,
    name: u.name,
    description: u.description,
    followers_count: u.public_metrics?.followers_count,
    following_count: u.public_metrics?.following_count,
    tweet_count: u.public_metrics?.tweet_count,
    verified: u.verified,
    verified_type: u.verified_type,
    profile_image_url: u.profile_image_url,
    raw: json
  };
}

async function getTwitterApiUser(username: string): Promise<XAccountSnapshot> {
  const base = twitterApiBase();
  const candidates = [
    `${base}/twitter/user/info?userName=${encodeURIComponent(username)}`,
    `${base}/twitter/user/info?username=${encodeURIComponent(username)}`,
    `${base}/twitter/user/by_username?username=${encodeURIComponent(username)}`
  ];
  let last = '';
  for (const url of candidates) {
    try { return normalizeTwitterApiUser(username, await fetchJson(url, twitterApiHeaders())); } catch (e: any) { last = e.message; }
  }
  throw new Error(`TwitterAPI.io user lookup failed: ${last}`);
}

export async function getXUserByUsername(username = optionalEnv('X_USERNAME', '30piq')): Promise<XAccountSnapshot> {
  const p = provider();
  if (p === 'twitterapi') return getTwitterApiUser(username);
  if (p === 'x_official') return getOfficialUser(username);
  try { return await getTwitterApiUser(username); } catch { return getOfficialUser(username); }
}

async function getOfficialTimeline(userId: string, maxResults = 5) {
  const safeMax = Math.min(Math.max(Number(maxResults) || 5, 5), 20);
  const params = new URLSearchParams({ max_results: String(safeMax), exclude: 'retweets,replies', 'tweet.fields': 'created_at,public_metrics,conversation_id,lang,entities,referenced_tweets' });
  const json = await fetchJson(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?${params}`, officialHeaders());
  return json.data || [];
}

async function getTwitterApiTimeline(user: XAccountSnapshot | string, maxResults = 5) {
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
      const json = await fetchJson(url, twitterApiHeaders());
      const arr = json.tweets || json.data || json.results || json.result?.tweets || [];
      return (Array.isArray(arr) ? arr : []).slice(0, safeMax).map(normalizeTwitterApiTweet);
    } catch (e: any) { last = e.message; }
  }
  throw new Error(`TwitterAPI.io timeline failed: ${last}`);
}

export async function getXUserTimeline(userIdOrUser: string | XAccountSnapshot, maxResults = 5) {
  const p = provider();
  if (p === 'twitterapi') return getTwitterApiTimeline(userIdOrUser, maxResults);
  if (p === 'x_official') return getOfficialTimeline(String(userIdOrUser), maxResults);
  try { return await getTwitterApiTimeline(userIdOrUser, maxResults); } catch { return getOfficialTimeline(typeof userIdOrUser === 'string' ? userIdOrUser : String(userIdOrUser.id), maxResults); }
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
