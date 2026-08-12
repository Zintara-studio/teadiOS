# Deploying teadiOS

Five accounts, in this order. Nothing here is reversible-hard; the only step
that costs money is R2 storage, and only above the free tier.

1. [Neon](#1-neon) — Postgres, and the queue
2. [Clerk](#2-clerk) — who is signed in
3. [Cloudflare R2](#3-cloudflare-r2) — where the videos live
4. [Vercel](#4-vercel) — the console
5. [Laptops](#5-the-laptops) — the fleet

---

## 1. Neon

Create a project, then load the schema:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_rls.sql   # should print ALL PASSED
```

**Enable the Data API** on the branch (Console → Data API). Choose **Other
Provider** and give it the Clerk JWKS URL from step 2. This is what lets the
browser talk to Postgres with no server in between.

Then create a login role for the fleet:

```sql
create role teadio_w1 login password 'generate-a-long-one';
grant teadio_worker to teadio_w1;
```

`teadio_worker` is NOLOGIN and carries the grants; `teadio_w1` is the account
that actually connects. One shared role for the whole fleet is fine — every
laptop runs the same container and is equally trusted. Revoking one laptop means
rotating for all; if that ever matters, make it a role per machine.

> **Check before you go further:** `select * from worker_status;` should return
> zero rows without error, and the Data API's advisor page should report no
> tables with RLS disabled.

## 2. Clerk

Create an application. Then, and this part is load-bearing:

- **Restrict sign-ups.** Either turn off public sign-up entirely or restrict it
  to your team's email domain. A member can queue a job that runs code on a
  colleague's laptop, so who may sign up *is* an authorization decision.
- **Require email verification.** Invitations are keyed by email address, and an
  unverified address is an unproven claim to one.
- **Add a JWT template** (Configure → JWT Templates) containing `email` and
  `email_verified`. Without them `redeem_invites()` returns 0 forever and nobody
  can ever join a project. It fails closed, and silently, so set it now.

Copy the **JWKS URL** (Configure → Developers → API Keys → Show JWT Public Key)
back into Neon's Data API settings.

## 3. Cloudflare R2

Create a bucket (`teadio-artifacts`) and an **S3 API token** scoped to it. Attach
a custom domain to the bucket for public reads — that domain becomes the CDN
base, and every `artifact_url` in the database points at it.

Object keys are UUIDs, so finished videos are unguessable but not access
controlled. If a team needs genuinely private output, put the reads behind the
upload Worker too.

Then deploy the upload Worker:

```bash
cd upload && npx wrangler deploy
npx wrangler secret put R2_ACCESS_KEY_ID     # and the others below
```

## 4. Vercel

Import the repo. Today the console is a static page, so:

- **Build command:** *(none)*
- **Output directory:** `web`

When the Vite console lands, that becomes `npm run build -w web` and `web/dist`,
plus a rewrite sending everything to `index.html`. `vercel.json` carries this.

---

## Every variable, and where it goes

### `web/` — the console (Vercel project env)

Everything here is compiled into the bundle and **served to the browser**. That
is not a leak; it is the design. There is no secret in the web tier because
authorization is row-level security, not a hidden key.

| Variable | Example | What it is |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_…` | Clerk publishable key. Never the secret key — that has no home here. |
| `VITE_NEON_DATA_API_URL` | `https://ep-x.apirest.us-east-2.aws.neon.tech/neondb/rest/v1` | Neon Data API base. |
| `VITE_UPLOAD_URL` | `https://teadio-upload.you.workers.dev` | The presigned-upload Worker. |
| `VITE_CDN_BASE` | `https://cdn.yourteam.com` | R2 custom domain, for playing finished videos. |

### `worker/` — each laptop (`.env` next to the container)

These **are** secrets. They live on people's personal machines, so keep the
database role narrow — it is `teadio_worker`, which by design cannot read who
anyone is.

| Variable | Example | What it is |
|---|---|---|
| `TEADIO_DATABASE_URL` | `postgresql://teadio_w1:…@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require` | Connects as the fleet role. |
| `TEADIO_MACHINE` | `mira-mbp` | Per **box**. Jobs pin to this, never to a slot. Every slot on one laptop shares it. |
| `TEADIO_SLOTS` | `2` | Worker processes on this box. Hostnames become `mira-mbp.slot0`, `.slot1`. |
| `TEADIO_OWNER_ID` | `user_2abc…` | Clerk user id of whoever owns the laptop, so the console can show whose fans are spinning and let them pause it. |
| `TEADIO_POLL_MS` | `2000` | Claim poll. |
| `TEADIO_HEARTBEAT_MS` | `15000` | Must stay well under `teadio.stale_after()`, which is 45s. If it does not, healthy jobs get reclaimed out from under a working laptop. |
| `TEADIO_REQUIRE_AC` | `true` | Only claim work while plugged in. |
| `TEADIO_MIN_FREE_DISK_GB` | `25` | Refuse in preflight. Disk runs out before RAM, and an out-of-space error mid-run costs the whole run. |
| `TEADIO_MAX_CONCURRENCY` | *(blank)* | Remotion's per-render concurrency. Blank lets it decide from core count. |
| `R2_ACCOUNT_ID` | | Cloudflare account id. |
| `R2_ACCESS_KEY_ID` | | R2 S3 token. |
| `R2_SECRET_ACCESS_KEY` | | |
| `R2_BUCKET` | `teadio-artifacts` | |
| `TEADIO_CDN_BASE` | `https://cdn.yourteam.com` | What gets written to `artifact_url`. |
| `TEADIO_AGENT_CMD` | `claude` | `kind='generate'` only: the headless agent binary. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | `kind='generate'` only. |

### `upload/` — the Cloudflare Worker (`wrangler secret put`)

| Variable | What it is |
|---|---|
| `CLERK_JWKS_URL` | Verifies the caller's token before signing anything. |
| `NEON_DATA_API_URL` | The Worker re-asks Postgres "may this token see this project?" with the caller's own JWT, so it never needs a database credential or its own idea of who may upload. |
| `R2_ACCOUNT_ID` | |
| `R2_ACCESS_KEY_ID` | The only credential this Worker holds. |
| `R2_SECRET_ACCESS_KEY` | |
| `R2_BUCKET` | |

---

## 5. The laptops

```bash
docker run -d --name teadio --env-file .env --restart unless-stopped teadios/worker
```

On Apple Silicon make sure you are pulling the **arm64** image. Headless Chrome
under x86 emulation is slower than not having the laptop in the fleet at all.

---

## When it does not work

**The console is empty and says you are not authorised.** Check whether the
identity resolved *before* you go looking for a missing grant. If the Clerk
token failed to mint, requests go out unauthenticated, row-level security
correctly returns nothing, and it looks exactly like a permissions bug.

**Every query fails at once after a migration.** Two causes, both in
`system-design.md` §7: a column added to a query before the migration was
applied (PostgREST fails the *whole* query on an unknown column), or an
overloaded function — adding a defaulted parameter creates a second function
beside the first, and the API then cannot choose between them. Drop the old
signature explicitly and re-grant.

**Jobs sit at `pending` forever.** `select * from worker_status where online;`
If that is empty, no laptop is awake. The console is supposed to say so in
words; if it does not, that is the highest-value bug you can fix.
