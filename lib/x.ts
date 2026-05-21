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
