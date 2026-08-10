# Deployment

> Verified from repository inspection on 2026-08-10. See [[ARCHITECTURE]] for the components being deployed.

## Frontend + serverless function: Vercel

`vercel.json`:
```json
{
  "buildCommand": "pnpm install && pnpm run build",
  "installCommand": "pnpm install",
  "outputDirectory": "dist"
}
```
- Build tool: Vite (`vite build`, configured via `vite.config.js` with `outDir: 'dist'` and `base: './'` — the comment in that file notes `base: './'` is specifically needed to fix an asset-path issue on Vercel).
- `api/create-whatsapp-instance.js` is auto-deployed as a Vercel serverless function via Vercel's file-system convention for the `api/` directory (see [[BACKEND]]).
- Required env vars referenced in code: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (frontend, see [[SUPABASE]]), `VITE_WEBHOOK_BASE_URL` (frontend, used to build integration webhook URLs shown to clients/admins), `N8N_EVOLUTION_GATEWAY_URL` (serverless function, see [[BACKEND]]). No values are stored in this repo, as expected.

## Package manager ambiguity

Both `package-lock.json` and `pnpm-lock.yaml` are present in the repo root, but `vercel.json` explicitly uses `pnpm`. Which lockfile is authoritative/current is **Unknown / Not available in repository**.

## n8n workflow: hosted separately

The automation/AI workflow (see [[N8N_WORKFLOWS]]) is not deployed as part of this repo's build. URLs referenced in the codebase (e.g. default webhook URLs in `AdminWhatsappServers.jsx`, and the exported workflow's own filename) point to an n8n instance hosted on Railway (`https://n8n-production-fcd4.up.railway.app/...`). How that instance is deployed/updated is **Unknown / Not available in repository** — the JSON file in `n8n flow/` appears to be an export/backup, not a deploy source.

## WhatsApp Evolution API servers

External, self-hosted gateway servers registered manually through the admin UI (`whatsapp_servers` table, see [[DATABASE]]) — their own deployment is entirely outside this repo.

## Supabase

Hosted Supabase project (see [[SUPABASE]]) — provisioning/deployment of the database itself is outside this repo (no IaC, migrations, or SQL files present).

## Not verifiable from this repository

- CI/CD pipeline details (no GitHub Actions or other CI config found in this repo).
- Environments (staging/production) or branch-to-deployment mapping.
- How/where the env vars above are actually set (e.g. Vercel dashboard) — not part of this repo.
