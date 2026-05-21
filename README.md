# X AI Content Factory Orchestrator

Execution layer for the X AI Content Factory experiment.

The human publishes manually. The system prepares content, checks state, writes logs to Supabase, and creates supporting GitHub assets when needed.

## Safety

- This repository is dedicated to the X AI Content Factory only.
- Do not touch existing repositories.
- Do not auto-post to X in this MVP.
- Supabase is the source of truth for account state, requirements, targets, daily check-ins, and logs.

## Required environment variables

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ORCHESTRATOR_SECRET
OPENAI_API_KEY
X_BEARER_TOKEN
X_USERNAME
GITHUB_TOKEN
GITHUB_OWNER

## API routes

- /api/health
- /api/check-account
- /api/daily-run
- /api/log-user-action
- /api/github-create-repo
- /api/weekly-review
