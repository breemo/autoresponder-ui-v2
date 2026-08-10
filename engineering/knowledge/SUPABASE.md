# Supabase

> Verified from repository inspection on 2026-08-10. See [[DATABASE]] for the schema accessed, [[ARCHITECTURE]] for how this fits the system.

## Client setup

`src/lib/supabaseClient.js`:
```js
import { createClient } from '@supabase/supabase-js'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```
- Uses the **anon (public) key**, read from Vite env vars `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at build time. No values are present in this repo (as expected for env vars) — see [[DEPLOYMENT]] for where they'd be configured.
- This single client instance is imported directly by nearly every page component in `src/pages/**` — there is no data-access/service layer or React Query-style cache; each page performs its own `supabase.from(...)` calls in `useEffect`.

## Usage pattern

- Reads: `.select()` with explicit column lists (and occasional joins via PostgREST's embedded-resource syntax, e.g. `clients` joined to `subscriptions`, or `client_feature_integrations` joined to `features`).
- Writes: `.insert()`, `.update()`, `.delete()` called directly from React event handlers (no optimistic-update library).
- No use of Supabase Auth, Storage, Edge Functions, or Realtime subscriptions was found anywhere in `src/`.

## Access control

- Authentication is custom, not Supabase Auth (see [[DATABASE]] security note and [[ARCHITECTURE]]) — the anon key is used for every request regardless of which portal user is logged in.
- Whether Row Level Security (RLS) policies are configured on these tables is **Unknown / Not available in repository** — RLS, if present, is configured in the Supabase project itself, not in this codebase.

## External consumer

The n8n workflow (see [[N8N_WORKFLOWS]]) also talks to the same Supabase project's REST API directly over HTTP (not via this repo's client code), using its own configured URL/key inside the workflow definition.

## Not verifiable from this repository

- Supabase project plan, region, or dashboard configuration.
- Actual RLS policies, database functions/triggers, or extensions in use.
