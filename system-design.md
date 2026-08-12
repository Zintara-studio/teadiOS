# Building a distributed agent pipeline

> **A system-design prompt.** Hand this to an engineer or a coding agent and they
> should be able to build this shape of system from nothing. It is deliberately
> not about video — it is about the general problem: **an AI agent doing long,
> expensive, multi-stage work on a fleet of machines, driven from a web console.**
>
> Everything marked **WHY** is a decision with a cost attached. Everything under
> "Failure modes" is something that actually happened, not something imagined.
> The failure modes are the valuable part; the architecture is comparatively easy.

---

## 1. The shape of the problem

A user writes a short brief. Hours later, an expensive finished artifact exists.
In between, an AI agent plans, builds, critiques its own work, fixes it, and
publishes.

Concretely, per job:

| | |
|---|---|
| Duration | **1–4 hours** |
| Cost | **tens of dollars** in model + API spend |
| Interactivity | **none** — nobody is watching most of it |
| Failure cost | high; a failure at the last stage wastes everything before it |
| Output | a large binary or artifact that must outlive the machine that made it |

**Design consequence, and the one that governs everything else:** this is not a
request/response system and not a CRUD app. It is a system for *dispatching* work
and *watching* it. Optimise for: submit and walk away; come back and understand
state in five seconds; catch failure early; never lose paid-for work.

If your instinct is to add a spinner, you have the wrong model. The right model
is a build system crossed with a flight tracker.

---

## 2. The five decisions that define the architecture

### 2.1 The database is the message broker

Workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`. No Redis, no SQS, no
broker.

```sql
update jobs set status = 'claimed', claimed_by = $1, claimed_at = now()
where id = (
  select id from jobs
   where status = 'pending' and (target_machine is null or target_machine = $2)
   order by id
   for update skip locked
   limit 1
)
returning *;
```

**WHY.** `SKIP LOCKED` *is* the load balancer. Two workers can never take the
same job, there is no second system to operate, and the queue is queryable with
the same tools as everything else. At this scale — jobs measured in hours, a
fleet measured in single digits — a broker is a component to run, monitor and be
paged for, in exchange for throughput you will never need.

**Cost:** polling, not push. Workers poll every ~2s. Accept it.

**Ceiling:** this stops being right somewhere around thousands of jobs/minute.
You are not there and probably never will be.

### 2.2 The database is the only authorization layer

Row-level security decides everything. The browser talks **directly** to the
database over HTTP (PostgREST or equivalent) with the signed-in user's JWT.

**There is no server-side data tier. The web tier holds no database credential.**

**WHY.** Every authorization rule lives in exactly one place, expressed in one
language, enforced race-free by the database. There is no route handler that
"forgot" a check. Deployment is a static frontend and nothing else — nothing to
leak, nothing to scale, no secret on the hosting platform.

**Cost, and it is real:**
- Anything the UI shows must already be a column. New data = a migration, not a
  frontend change.
- Anything needing elevated privilege (admin user management) has no home. You
  need a separate small server or a managed function.
- Server-rendered pages cannot know who is signed in if the auth provider sets
  its session cookie on *its own* hostname — that cookie is third-party to you
  and your server never receives it. **Test this before you design around it.**
  It decides whether your auth gate is middleware or client-side.

### 2.3 The agent is the worker

The worker process does not implement the pipeline. It claims a job, writes the
brief to disk, and spawns a **headless AI coding agent** with a prompt naming a
command file. The command file is the pipeline.

**WHY.** The work is creative and judgement-heavy. Every stage is "produce
something, look at it, decide if it is good, fix it". That is what an agent is
for. Encoding it as functions means encoding taste as branches, and you will
lose. It also means the pipeline is edited in prose by whoever understands the
craft, not in code by whoever understands the codebase.

**Cost:** the agent is non-deterministic and can lie about success. §5 exists
entirely because of that.

### 2.4 Output profiles are prose, not code

"What kind of artifact is this" lives in a markdown file per profile —
structure, tone, audience, which components are permitted, review rules, numeric
caps — plus a small JSON file of brand values.

**WHY.** The agent reads instructions. A profile is instructions. Making it a
plugin system or a config schema buys nothing and costs a release every time
someone wants a new kind of output. A profile can be written by a domain expert
in an afternoon.

**Watch for:** components that *look* generic but are not. Anything built for
your first profile will have that profile's assumptions baked in — labels,
badges, vocabulary, sometimes hardcoded content. Audit before allowlisting, and
document the props that strip the original chrome. Expect only ~10% of an
existing component library to be genuinely portable to a second profile.

### 2.5 Artifacts go to object storage, never to the machine that made them

The worker uploads before reporting success. One URL on the job row.

**WHY.** Worker machines sleep, change IP, get rebuilt, and are sometimes
laptops. A "completed" job whose artifact exists only on the box that made it is
the failure this system exists to prevent.

**Corollary:** upload failure must fail the job. A run that rendered and could
not upload is not a success.

---

## 3. Data model

Six tables is enough.

```
projects          the unit of ownership and grouping
project_members   who may see and submit  (keyed by EMAIL, see the warning)
jobs              ★ the queue
job_files         submitter's reference documents, inline
job_events        append-only feed — the live log and the audit trail
workers           one row per worker PROCESS, with a heartbeat
```

Non-obvious columns on `jobs`, each earned:

| Column | Why it exists |
|---|---|
| `status` | `pending claimed running completed failed cancelled`. No "awaiting review" — a terminal state pretending not to be terminal breaks every filter. |
| `stage` | Where in the pipeline. **The single most useful field in the product.** |
| `resume_from_stage` | A job whose machine vanished restarts from here, not from zero. |
| `session_id` | Lets the worker resume the same agent conversation rather than start over. |
| `cost_usd` | Per job. Non-negotiable when jobs cost real money. |
| `artifact_url` | Where the output actually lives. |
| `revision_of` + `feedback` | A revision is a NEW job with the SAME slug, linked to its parent. It *edits* the previous output rather than rebuilding. |
| `kind` | What the job builds. One queue serves multiple job types; the worker branches. Cheaper than a second table by a mile. |
| `profile` | Which output profile (§2.4) this was built against. |

**Two warnings, both learned the hard way:**

**Keying membership by email is a standing pre-authorization.** It lets you
invite someone before they sign up — genuinely useful — but it means whoever
ends up holding that address becomes a member. That is only safe if sign-up is
closed and email verification is enforced. If your auth provider does not ship a
verification flow (several do not), you must build it, and until you do, an
"unverified" account is an unproven claim to an address. **Treat these settings
as load-bearing architecture, not deployment hygiene.** A member can queue a job
that runs an agent with broad filesystem permissions on your machines.

**One live job per (project, kind, slug)**, as a partial unique index over
non-terminal statuses. It stops two runs fighting over the same working
directory. Include `kind` — different job types own different directories and
should not collide with each other.

---

## 4. The worker

A long-lived process. One job at a time. N processes per machine = N concurrency.

```
register(hostname, machine, capabilities)     hostname is per PROCESS
loop:
  release_stale_jobs()                        no separate cron; any worker sweeps
  job = claim_next(machine)
  if none: sleep(poll); continue
  spawn agent, stream stdout → job_events
  verify the artifact actually exists
  upload, then mark completed
```

Requirements that are not optional:

- **`hostname` is per process, `machine` is per box.** They are different things.
  A box runs several worker slots; they share a disk, which is what makes a
  machine special. Jobs pin to a *machine*, never a slot. If both default to the
  system hostname, N processes upsert one row and fight over its heartbeat — and
  a dead worker's job looks alive forever, so nothing ever reclaims it.
- **Heartbeat, and derive liveness from the DATABASE clock.** Computing "online"
  in the browser makes the viewer's laptop clock the arbiter of fleet health.
- **Stale reclaim.** A worker whose machine died must have its job handed back.
- **Fenced writes.** Every write includes "…and I still own this job". A job
  released for a stale heartbeat and re-claimed elsewhere must not be overwritten
  by the original worker finishing late. Both would bill.
- **Cancellation is the worker's job.** A UI can only mark a row cancelled; it
  cannot signal a process on another machine. The worker watches its own row.
- **Sanitise anything you copy into the event feed.** That feed is read in a
  browser, so it is an egress path. Redact credential shapes; drop long base64
  runs (those are file contents, not prose).

---

## 5. The agent contract

This is where systems like this actually fail. Everything here is mandatory.

**Never end a turn with work outstanding.** A headless agent has no next turn.
When it stops producing output the process exits, killing anything it
backgrounded. "Rendering in the background, will report when done" is a total
loss of a paid-for run. If it backgrounds something, it must poll it to
completion in the same turn.

**Verify completion from outside the agent.** Never trust a summary. Check that
the artifact exists — and check the thing that proves it is *valid*, not merely
present. A file can exist and still be unregistered, unreadable or empty. Pick
the cheapest external check that cannot be faked by a cheerful report.

**Resume rather than restart.** An agent that exits cleanly without producing the
artifact should be resumed with its own session, told what is already on disk,
and asked to finish. Cap the attempts. Restarting from zero throws away hours.

**Never pause, never ask.** Every "wait for approval" in the interactive version
is a silent hang here. The agent decides, records the decision as a stated
assumption, and continues. A shipped artifact built on three stated assumptions
is a success; a run that stopped to ask a question is a total loss.

**Replace human checkpoints with adversarial critics.** Spawn independent
reviewers with distinct lenses, have them return structured verdicts, and let the
agent act on blocking issues. This is the only quality gate in an unattended run.

**Structured final summary.** The last message is read in a browser by someone
who was not watching. State what was produced, what was assumed, what was
skipped — and have a separate, honest BLOCKED shape for when it could not finish.
A cheerful summary hiding a missing artifact is worse than a loud failure.

---

## 6. Concurrency on one machine

Running several pipelines on one box is where the subtle corruption lives. The
rule, and it generalises: **anything shared must be per-run.**

Temp directories. Log files. Compiler/build caches. Ports. Bundle output
directories. Lock files. A fixed path is a collision waiting for a second run.

Specific traps worth stating outright:

- **Never kill by broad process name.** `pkill -f chrome` takes out every other
  run's browser and every other run's render. Scope kills to your own temp
  directory, or do not kill at all. (This will also kill your own shell if the
  pattern matches your command line. It has happened more than once.)
- **Never let one run's half-written input break every other run's build.**
  If a build validates all inputs at module scope, one job's in-progress file
  fails everyone's build. Validate per item, skip invalid ones with a warning.
- **Enumerate work by glob, not by a hand-edited registry.** If every run must
  append itself to a shared file, concurrent runs will interleave those edits and
  silently drop registrations — discovered only after the expensive work is paid
  for.
- **Check what a build tool actually copies.** Bundlers that inline a static
  assets directory will copy *all* of it per build. If that directory grows with
  every job you have ever run, per-run bundles become gigabytes each.
- **Containers are the honest way to run N.** They give a private PID namespace,
  network namespace and build-cache volume for free. Several dev servers in one
  checkout will fight over a lockfile no matter which ports you assign.
- **Disk runs out before RAM.** Nothing in your concurrency limiter knows about
  disk. An out-of-space error mid-run costs the whole run — and can corrupt build
  caches that then need rebuilding. Check free space in preflight and refuse.

---

## 7. Failure modes to design against

Each of these is real. Each looked like something else at first.

**A queued job with no online workers sits forever, silently.** The UI shows
"pending", which looks like progress. **Detect it and say so in the interface** —
"all workers offline, queued runs will not start". This is the highest-value
piece of UI in the whole console.

**An identity failure looks exactly like a permissions failure.** If the client
cannot obtain a token — expired, rate-limited, misconfigured — requests go out
unauthenticated and row-level security correctly returns *nothing*. The UI renders
empty lists and "not authorised", and you go hunting for a missing grant that is
already there. **Always check whether the identity resolved before touching
permissions.**

**Rate limits on the auth service.** A console polling every 2s that re-checks
the session per poll will hit them. Cache the client (and therefore its token)
for the life of the page. In a browser there is exactly one user, so a
module-scoped client is correct — but keep it out of any server-evaluated path.

**Cost estimates that assume a clean run.** Budget for the iteration loop, not
the happy path. A critic that finds two blockers and triggers five iterations is
the system *working*, and it can double the bill.

**A destructive schema file that also destroys its dependencies.** If your setup
script drops and recreates a schema, check what else lives in it — extensions
installed there go too, taking their functions with them, and every policy that
calls those functions then fails.

**Adding a column to a query before the migration is applied.** Many HTTP data
layers fail the *entire* query on an unknown column, blanking the whole console
rather than the one widget that wanted it. Verify the column exists first.

**Overloaded stored procedures after a migration.** Adding a defaulted parameter
creates a *second* function beside the first. The HTTP layer then cannot choose
and every call fails. Drop the old signature explicitly, and re-grant — grants
name the full signature.

**Rules duplicated across layers drift.** A name validated by the database, the
UI and a build script, with three different regexes, means one combination passes
two of them and is silently rejected by the third — after the expensive work.
Make the strictest one authoritative and write the other two against it.

---

## 8. Build order

1. **Schema + RLS + the claim query.** Test the policies with an adversarial SQL
   suite before any UI exists: prove an outsider sees nothing, a member cannot
   escalate, the worker role cannot read identities. This suite is the most
   valuable test you will write.
2. **The worker loop**, with a fake agent binary. Prove claim, heartbeat, stale
   reclaim, fenced writes and cancellation before real work is involved.
3. **The agent command file.** Get one artifact produced end to end by hand.
4. **Verification and resume.** Everything in §5.
5. **The console.** Submit, watch, the live feed, the artifact.
6. **A second output profile.** This is what proves your first one was a profile
   and not just hardcoded assumptions.
7. **Concurrency.** Only now, and expect §6 to bite.

---

## 9. Anti-patterns

- A spinner. This is hours of work; show stages and time-in-stage.
- A progress bar with a percentage. You do not know the percentage. Do not lie.
- Trusting the agent's own report of success.
- Colour as the only carrier of status.
- Reflowing or stealing focus on every poll.
- Truncating identifiers. The slug is what people talk about; let it wrap.
- Silently capping work ("top 10 findings") without saying so — it reads as
  "covered everything".
- Adding a server-side data tier for one feature, and with it a credential to
  leak and a second authorization model to keep in sync.

---

## 10. One paragraph

A queue in Postgres, claimed with `SKIP LOCKED` by long-lived workers that spawn
headless AI agents; row-level security as the only authorization layer, with the
browser talking straight to the database and no server data tier; output kinds
defined in prose rather than code; artifacts pushed to object storage before a
job is called done; and a console whose real job is to make hours of unattended,
expensive, occasionally-failing work legible at a glance. The architecture is a
week. The failure modes in §6 and §7 are the rest of it.
