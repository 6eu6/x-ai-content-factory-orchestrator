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

function bearerHeaders() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) throw new Error('X_BEARER_TOKEN missing; live X scan skipped.');
  return { Authorization: `Bearer ${bearer}` };
}

export async function getXUserByUsername(username = optionalEnv('X_USERNAME', '30piq')): Promise<XAccountSnapshot> {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { username, raw: { warning: 'X_BEARER_TOKEN missing; live X check skipped.' } };
  const params = new URLSearchParams({ 'user.fields': 'description,public_metrics,verified,verified_type,profile_image_url,created_at' });
  const res = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?${params}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: 'no-store'
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`X API error: ${res.status} ${JSON.stringify(json)}`);
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

export async function getXUserTimeline(userId: string) {
  const params = new URLSearchParams({
    max_results: '20',
    exclude: 'retweets,replies',
    'tweet.fields': 'created_at,public_metrics,conversation_id,lang,entities,referenced_tweets'
  });
  const res = await fetch(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?${params}`, {
    headers: bearerHeaders(),
    cache: 'no-store'
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`X timeline error: ${res.status} ${JSON.stringify(json)}`);
  return json.data || [];
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
