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
  return { 'x-api-key': key };
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
  return {
    username: u.userName || u.username || username,
    id: String(u.id || ''),
    name: u.name,
    description: u.description || u.profile_bio?.description || '',
    followers_count: Number(u.followers || 0),
    following_count: Number(u.following || 0),
    tweet_count: Number(u.statusesCount || u.statuses_count || 0),
    verified: Boolean(u.isBlueVerified || u.verified),
    verified_type: u.verifiedType,
    profile_image_url: u.profilePicture,
    raw: json
  };
}

function normalizeTwitterApiTweet(t: any) {
  return {
    id: String(t.id || ''),
    text: t.text || '',
    created_at: t.createdAt || t.created_at,
    public_metrics: {
      like_count: Number(t.likeCount || 0),
      reply_count: Number(t.replyCount || 0),
      retweet_count: Number(t.retweetCount || 0),
      quote_count: Number(t.quoteCount || 0),
      bookmark_count: Number(t.bookmarkCount || 0),
      view_count: Number(t.viewCount || 0)
    },
    entities: t.entities || {},
    is_reply: Boolean(t.isReply),
    author: t.author,
    raw: t
  };
}

export async function getXUserByUsername(username = optionalEnv('X_USERNAME', '30piq')): Promise<XAccountSnapshot> {
  const base = twitterApiBase();
  const url = new URL(`${base}/twitter/user/info`);
  url.searchParams.set('userName', username.replace(/^@/, ''));
  return normalizeTwitterApiUser(username, await fetchJson(url.toString()));
}

export async function getXUserTimeline(user: string | XAccountSnapshot, maxResults = 5, includeReplies = false) {
  const username = typeof user === 'string' ? user : user.username;
  const safeMax = Math.min(Math.max(Number(maxResults) || 5, 5), 20);
  const base = twitterApiBase();
  const url = new URL(`${base}/twitter/user/last_tweets`);
  url.searchParams.set('userName', username.replace(/^@/, ''));
  url.searchParams.set('includeReplies', String(Boolean(includeReplies)));
  const json = await fetchJson(url.toString());
  const arr = Array.isArray(json.tweets) ? json.tweets : [];
  return arr.slice(0, safeMax).map(normalizeTwitterApiTweet);
}

export async function searchXTweets(query: string, queryType: 'Latest' | 'Top' = 'Top', maxResults = 20) {
  const safeMax = Math.min(Math.max(Number(maxResults) || 20, 1), 20);
  const base = twitterApiBase();
  const url = new URL(`${base}/twitter/tweet/advanced_search`);
  url.searchParams.set('query', query);
  url.searchParams.set('queryType', queryType);
  const json = await fetchJson(url.toString());
  const arr = Array.isArray(json.tweets) ? json.tweets : [];
  return arr.slice(0, safeMax).map(normalizeTwitterApiTweet);
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
    has_list: /(^|\n)\s*(\d+\.|-|•)/.test(text),
    is_reply: Boolean(tweet.is_reply)
  };
}
