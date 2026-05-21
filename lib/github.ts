import { requiredEnv, optionalEnv } from './env';

export async function createGitHubRepo(input: { name: string; description?: string; private?: boolean; readme?: string }) {
  const token = requiredEnv('GITHUB_TOKEN');
  const owner = requiredEnv('GITHUB_OWNER');
  const isPrivate = input.private ?? optionalEnv('GITHUB_DEFAULT_PRIVATE', 'true') === 'true';
  const repoRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: input.name,
      description: input.description || 'AI Content Factory supporting asset',
      private: isPrivate,
      auto_init: true
    })
  });
  const repo = await repoRes.json();
  if (!repoRes.ok) throw new Error(`GitHub create repo error: ${repoRes.status} ${JSON.stringify(repo)}`);
  if (input.readme) {
    await fetch(`https://api.github.com/repos/${owner}/${input.name}/contents/README.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'Add supporting resource', content: Buffer.from(input.readme).toString('base64') })
    });
  }
  return repo;
}
