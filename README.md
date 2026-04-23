# TeamOS

TeamOS is a virtual workplace system that orchestrates AI and human team members through structured work cycles. Each AI member gets a small *cycle* at a time to perform a unit of work, respond to messages, advance projects, and collaborate with other members.

TeamOS lives as its own repository and integrates into any project, giving every repo the same team orchestration without duplicating code. It can run locally against a git repo or be deployed to the cloud (Fly.io) with S3 storage.

## How It Works

Team members are defined in a `team/` workspace directory within the host project. Each member has a profile, current state, todo list, schedule, and inbox. A runner script processes members through fair-scheduled, priority-weighted cycles, invoking an AI agent (Claude, Cursor, Augment) for each.

The runner provides full context — organization docs, news, projects, and the member's own files — then syncs after each member completes. A clerk agent runs after each pass for cleanup (archiving old news, removing stale schedule items, etc.).

**Adapters** make the system pluggable:
- **Messaging** — File-backed master store exposed to agents over MCP (see `teamos/docs/messages.md`). The contract is designed so a future SMTP/IMAP adapter could drop in without changing the agent contract.
- **Tasks** — File-backed per-member todo list exposed to agents over MCP (see `teamos/docs/tasks.md`). A future GitHub Issues / Linear / Jira adapter can drop in against the same tool surface.
- **Sync** — Git commit/push (default) or S3-compatible storage (Tigris, MinIO)
- **Agent** — Claude Code CLI (default, works headless), Cursor, or Augment (local only)

### Package Structure

```
teamos/
├── README.md                    # This file — system architecture reference
├── teamos.config.json           # Default adapter configuration
├── Dockerfile                   # Container image for cloud deployment
├── fly.toml                     # Fly.io deployment config
├── scripts/
│   ├── run.mjs                  # Entry point — CLI parsing, main loop (slim)
│   ├── init.mjs                 # Project initialization
│   ├── detach.mjs               # Package removal
│   └── lib/
│       ├── util.mjs             # Path helpers, time formatting, stop-file check
│       ├── scheduler.mjs        # Vruntime fair scheduler, weights, cadences
│       ├── state.mjs            # Scheduler state persistence (load/save/idle)
│       ├── config.mjs           # Config file loader + env var resolver
│       ├── work-detection.mjs   # Member loading, work scanning, system-event injection
│       ├── cycle.mjs            # Cycle/pass execution, prompt building
│       ├── maintenance.mjs      # Housekeeping, clerk invocation, efficiency
│       ├── agents/
│       │   ├── index.mjs        # Registry + common invocation (spawn, timeout, logging)
│       │   ├── claude.mjs       # Claude CLI adapter + stream parser
│       │   ├── cursor.mjs       # Cursor agent adapter + stream parser
│       │   └── auggie.mjs       # Augment adapter
│       ├── messaging/
│       │   ├── index.mjs        # Interface + factory
│       │   ├── file.mjs         # File-backed master store + mailbox json
│       │   └── mcp-server.mjs   # Stdio MCP server exposing messaging + task + schedule tools
│       ├── tasks/
│       │   ├── index.mjs        # Interface + factory
│       │   └── file.mjs         # File-backed todo.json adapter
│       ├── schedule/
│       │   ├── index.mjs        # Interface + factory
│       │   └── file.mjs         # File-backed schedule.json adapter + recurrence advancement
│       └── sync/
│           ├── index.mjs        # Interface + factory
│           ├── git.mjs          # Git add/commit/push (default)
│           └── s3.mjs           # S3-compatible sync (Tigris, MinIO)
├── agent-rules/
│   ├── cycle.md                 # Rules for member cycle agents
│   ├── clerk.md                 # Rules for clerk agent
│   ├── clerk-efficiency.md      # Rules for weekly efficiency analysis
│   ├── daily-checkin.md         # Rules for daily check-in
│   ├── self-assessment.md       # Rules for weekly self-assessment
│   └── root.md                  # Section appended to host AGENTS.md
├── templates/
│   ├── *.d.ts                   # TypeScript type definitions
│   └── *-template.*             # File templates for new members
└── ui/                          # Web dashboard (Svelte + Vite)
    ├── package.json
    ├── vite.config.ts
    └── src/
```

### Workspace Structure

```
team/
├── org.md               # Organization description
├── members.json         # Member manifest
├── projects.json        # Goals and projects
├── memos.json           # Timely information for all members
├── messages/            # Master store — one file per message
│   └── <id>.md
├── members/
│   └── [memberName]/
│       ├── profile.md       # Member description
│       ├── state.md         # Current state of work
│       ├── todo.json        # Task list
│       ├── schedule.json
│       ├── inbox.json       # { items: [<messageId>, ...] } — current mail
│       ├── sent.json        # { items: [...] } — what this member has sent
│       └── archives.json    # { items: [...] } — handled / archived mail
├── data/                # Shared data artifacts
├── docs/                # Shared documentation
├── archives/            # Archived org-level items (memos, projects)
└── .logs/               # Agent execution logs (git-ignored)
```

Messages live in a single master store (`team/messages/`). Per-member mailboxes are just lists of message ids — content is never duplicated. See `teamos/docs/messages.md` for the full protocol.

## Quick Start

### 1. Install teamos into your project

```bash
# Git submodule (recommended):
git submodule add https://github.com/Digithought/teamos.git teamos
node teamos/scripts/init.mjs

# Git subtree (works with git worktrees; submodules do not):
git subtree add --prefix=teamos https://github.com/Digithought/teamos.git main --squash
node teamos/scripts/init.mjs

# Symlink (teamos cloned elsewhere):
node /path/to/teamos/scripts/init.mjs
```

This creates the `team/` workspace with directories, empty manifests, and agent-rule references.

### 2. Add a team member

Create a member directory with a profile:

```bash
mkdir -p team/members/alice
```

The member's `inbox.json`/`sent.json`/`archives.json` are created on demand the first time a message lands for or from them — there's no scaffolding step.

`team/members/alice/profile.md`:
```markdown
---
name: alice
title: Software Engineer
roles: [developer]
active: true
type: ai
personality:
  openness: 8
  conscientiousness: 9
  extraversion: 5
  agreeableness: 7
  neuroticism: 3
---
Alice is a detail-oriented software engineer focused on backend systems.
```

Add her to `team/members.json`:
```json
{
  "members": [
    {
      "name": "alice",
      "title": "Software Engineer",
      "roles": ["developer"],
      "active": true,
      "type": "ai"
    }
  ]
}
```

Human members may also carry an optional `"email"` field that the dashboard uses to map proxy/SSO identity headers to the member — see the **Authentication** section below.

Create her initial files:
```bash
cp teamos/templates/todo-template.json team/members/alice/todo.json
cp teamos/templates/schedule-template.json team/members/alice/schedule.json
cp teamos/templates/state-template.md team/members/alice/state.md
```

### 3. Run cycles

```bash
# See who has work
node teamos/scripts/run.mjs --dry-run

# Run in loop mode (default) — continuous scheduling with 2-hour intervals
node teamos/scripts/run.mjs

# Run a single pass, then exit
node teamos/scripts/run.mjs --once

# Run only a specific member
node teamos/scripts/run.mjs --member alice

# Use a different agent
node teamos/scripts/run.mjs --agent cursor

# Use S3 sync instead of git
node teamos/scripts/run.mjs --sync s3

# Don't auto-commit
node teamos/scripts/run.mjs --no-commit
```

### Runner Options

| Option | Default | Description |
|---|---|---|
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, or `auggie` |
| `--messaging <name>` | `file` | Messaging adapter: `file` |
| `--tasks <name>` | `file` | Tasks adapter: `file` |
| `--schedule <name>` | `file` | Schedule adapter: `file` |
| `--sync <name>` | `git` | Sync adapter: `git` or `s3` |
| `--priority <level>` | `pressing` | Highest priority to include |
| `--member <name>` | — | Only run cycles for a specific member |
| `--max-cycles <n>` | `10` | Maximum cycle passes per scheduling pass |
| `--once` | — | Run a single pass, then exit |
| `--loop` | *(default)* | Enable continuous scheduling loop |
| `--interval <min>` | `120` | Minutes between passes |
| `--push` | — | Push to remote after each commit (git sync) |
| `--no-commit` | — | Skip automatic sync after each cycle |
| `--no-clerk` | — | Skip clerk agent after each pass |
| `--clerk-only` | — | Run only the clerk agent, then exit |
| `--weight <pri:n>` | `pressing:8, today:4, thisWeek:2, later:1` | Priority weight for fair scheduling (repeatable) |
| `--cadence <pri:dur>` | `pressing:0h, today:4h, thisWeek:1d, later:3d` | Min time between serving a priority (repeatable) |
| `--budget <pri:n>` | — | Optional max member cycles at a priority per pass (repeatable) |
| `--dry-run` | — | List members with work, don't invoke agent |

### Loop Mode (Default)

The runner operates as a long-lived process with its own scheduling loop by default. Use `--once` for a single pass (e.g. CI or one-off run).

```bash
# Default: loop mode with 2-hour interval
node teamos/scripts/run.mjs

# Custom interval (90 minutes)
node teamos/scripts/run.mjs --interval 90

# Single pass, then exit
node teamos/scripts/run.mjs --once
```

In loop mode the runner:

1. Runs a full scheduling pass (no hard time limit)
2. If the pass completes before the interval elapses, **idles** — polling every 30 seconds for new work or a `.stop` file
3. If new work arrives during idle at **pressing** or **today** priority, starts the next pass early. Lower-priority work waits for the interval timer.
4. If the pass overruns the interval, starts the next pass immediately

**Fair scheduling** — Priority levels are assigned weights that determine their proportional share of cycles:

| Priority | Default weight | Approximate share |
|---|---|---|
| `pressing` | 8 | ~53% |
| `today` | 4 | ~27% |
| `thisWeek` | 2 | ~13% |
| `later` | 1 | ~7% |

The scheduler tracks a virtual runtime (vruntime) for each priority. Each pass, it picks the priority with the lowest vruntime that has work. After running a cycle, vruntime advances by `1 / weight` — so higher-weight priorities advance slower and accumulate more cycles over time. A deficit cap prevents a newly-active priority from monopolizing cycles to "catch up" after a long idle period. Override weights with `--weight <priority>:<n>` (repeatable).

**Cadence** — Each priority has a minimum cooldown between serves, matching its urgency tempo:

| Priority | Default cadence | Effect |
|---|---|---|
| `pressing` | 0 | Always eligible |
| `today` | 4 hours | Served a few times per day |
| `thisWeek` | 1 day | Served daily |
| `later` | 3 days | Served every few days |

If there's no pressing work, the runner won't churn through lower-priority work every pass — it waits until each priority's cadence elapses before making it eligible again. Override with `--cadence <priority>:<duration>` (e.g. `--cadence today:2h`, `--cadence later:5d`).

**Cycle budgets** — Optional per-pass safety rails to cap how many member cycles run at a given priority. By default all priorities are unlimited. Use `--budget <priority>:<count>` to cap a level (e.g. `--budget later:3`).

**Member ordering** — Within each priority level, members are served in **round-robin** order so that no single member monopolizes. The rotation state is persisted in `scheduler-state.json` across restarts.

Scheduling state (vruntimes, last-served timestamps, round-robin positions) is persisted to `team/.logs/scheduler-state.json` so that interruptions and restarts maintain fairness. On startup the runner restores the saved state; if the file is missing or corrupted it initializes all priorities at equal footing.

With `--once`, the runner behaves as a single pass with a 1-hour hard time limit.

### Stopping the Runner

Create a `team/.stop` file to gracefully halt the runner between members:

```bash
touch team/.stop
```

The runner checks for this file before each cycle, between each member, and during idle waits. When found, it commits any completed work, removes the stop file, and exits. In loop mode, this exits the outer loop as well.

### Daily Check-in

The runner automatically ensures every active AI member has a recurring **Daily Check-in** schedule event (09:00 UTC daily). This prevents members from going dormant when they have no explicit tasks, messages, or events — giving them at least one cycle per day to be proactive.

When the event fires, the member follows the rules in `teamos/agent-rules/daily-checkin.md`. Check-ins are intentionally lightweight — if there's nothing to do, the member just goes back to sleep.

Automatic injection is on by default. Disable it by setting `schedule.autoEvents.dailyCheckin` to `false` in `teamos.config.json`:

```json
{
  "schedule": {
    "adapter": "file",
    "autoEvents": { "dailyCheckin": false }
  }
}
```

### Weekly Self-Assessment

The runner automatically ensures every active AI member has a recurring **Weekly Self-Assessment** schedule event (Fridays at 18:00 UTC). On startup, if a member's `schedule.json` lacks this event, the runner injects it.

Automatic injection is on by default. Disable it by setting `schedule.autoEvents.weeklySelfAssessment` to `false` in `teamos.config.json`.

When the event fires, the member follows the rules in `teamos/agent-rules/self-assessment.md` to produce a reflective evaluation covering:

- **Role fulfillment** — delivering on the job description
- **Strategic vs tactical balance** — big-picture and day-to-day
- **Cycle efficiency** — right-sized work, no wasted context
- **Tool & document effectiveness** — building, maintaining, and reusing
- **State/task/schedule hygiene** — keeping files concise and current
- **Communication quality** — clear, actionable, appropriately targeted
- **Project impact** — meaningful progress toward team goals

Assessments are saved to `team/members/<name>/archives/self-assessments/assessment-YYYY-MM-DD.md`. The runner advances the recurring event's `time` automatically after a successful cycle — the member never bumps it manually. See `teamos/docs/schedule.md` for the full schedule protocol.

## Priority Levels

```
pressing  →  today  →  thisWeek  →  later
```

- **Pressing** — Timely; should be processed within an hour
- **Today** — Should be handled today
- **ThisWeek** — Handle this week
- **Later** — Nibble at when there is time

The runner uses a weighted fair scheduler to allocate cycles across priorities. Higher-weight priorities receive proportionally more cycles, but lower priorities are never starved. See the Loop Mode section for weight details.

## Work Detection

A member is given a cycle when any of these are true:
- Their `inbox.json` has at least one id (O(1) — the runner reads the json directly)
- They have **todo items** at or above the current priority level (checked via the tasks adapter's `hasActionableTodos` contract)
- They have **schedule events** that are due

## Cycle Behavior

During a cycle, the agent:
1. Reviews organization context (org, memos, projects)
2. Processes inbox messages — reads them via MCP and calls `archive_message` for each one it has fully handled. Anything left in the inbox carries to the next cycle.
3. Performs one unit of work at the current priority
4. Updates state.md with what was accomplished
5. Maintains todos through MCP tools — `complete_todo` / `update_todo` / `add_todo`. The cycle prompt already lists the member's open todos, so `list_todos` is only needed after several mutations.

A unit of work can include:
- Maintaining TODOs or schedule
- Advancing a project by a modest increment
- Building a tool (JS/TS library) for self or team
- Sending messages to other members via `send_message`
- Outputting artifacts to `team/data/` or `team/docs/`

## Member Communication

Messages behave like email — `from`, `to`, `cc`, `subject`, `body`, and an optional `replyTo` back-pointer that forms a thread. Every message is stored once in `team/messages/<id>.md` with YAML frontmatter; per-member mailboxes (`inbox.json`, `sent.json`, `archives.json`) are lists of message ids.

Agents interact with messages exclusively through MCP tools — they never touch `team/messages/` or the mailbox json files directly:

| Tool | Purpose |
|---|---|
| `send_message` | Send to one or more members. `subject` required on new threads; replies may omit it and the adapter derives `Re: <parent>`. |
| `read_message` | Fetch any message by id. The immediate parent is inlined as `parent` (one hop); walk further back via `parent.replyTo`. |
| `list_inbox` / `list_sent` / `list_archives` | Summaries (newest first) of the member's mailboxes. |
| `archive_message` / `unarchive_message` | Move a message between inbox and archives. |

Example stored message (`team/messages/2026-04-13T10-30-45.123Z-a3f2.md`):

```markdown
---
id: 2026-04-13T10-30-45.123Z-a3f2
from: alice
to: [bob, carol]
cc: [dave]
subject: Auth module review
sentAt: 2026-04-13T10:30:45.123Z
projectCode: AUTH
---
The auth module is ready for review.
```

See `teamos/docs/messages.md` for the full protocol — id format, retention policy, and the mapping to a future SMTP/IMAP backend.

## Acting as a Team Member (Interactive Mode)

If you're an interactive agent (e.g. Cursor, Claude chat) asked to "be" a team member rather than running through the automated runner, read the following files to replicate the context the runner provides:

1. **Cycle rules** — `teamos/agent-rules/cycle.md` (how to execute a cycle)
2. **System architecture** — `teamos/README.md` (this file)
3. **Organization** — `team/org.md`
4. **Memos** — `team/memos.json` (timely info for all members)
5. **Projects** — `team/projects.json`
6. **Team roster** — `team/members.json`
7. **Your profile** — `team/members/<you>/profile.md`
8. **Your state** — `team/members/<you>/state.md`
9. **Your TODOs** — `team/members/<you>/todo.json` (read-only; mutate via the task MCP tools — see `teamos/docs/tasks.md`)
10. **Your schedule** — `team/members/<you>/schedule.json`
11. **Your inbox** — ids listed in `team/members/<you>/inbox.json`, with bodies in `team/messages/<id>.md`

The runner also passes a header with the current priority level and timestamp. When working interactively, default to priority `pressing` and follow the priority levels as described above.

Depending on your interaction, you may update your state file (`state.md`) directly. TODOs and schedule must be mutated through the MCP tools — never edit `todo.json` or `schedule.json` by hand. Do not commit — let the human handle that.

## Adapters

TeamOS uses a pluggable adapter architecture. Agents always work on a local filesystem — adapters handle how messages are delivered and how state is persisted.

### Messaging Adapters

| Adapter | Flag | Description |
|---|---|---|
| `file` | `--messaging file` | File-backed master store at `team/messages/<id>.md` with per-member `inbox.json`/`sent.json`/`archives.json` id lists. Exposed to agents via an MCP server (default, and currently the only adapter). |

All adapters implement the stable MCP contract documented in `teamos/docs/messages.md`: `send_message`, `read_message`, `list_inbox`, `list_sent`, `list_archives`, `archive_message`, `unarchive_message`. A future SMTP/IMAP adapter can drop in without changing the agent contract.

### Tasks Adapters

| Adapter | Flag | Description |
|---|---|---|
| `file` | `--tasks file` | Per-member open todo list at `team/members/<name>/todo.json`. Only holds incomplete items — completion removes the item. Exposed through the same MCP server as messaging. |

All adapters implement the stable MCP contract documented in `teamos/docs/tasks.md`: `list_todos`, `add_todo`, `update_todo`, `complete_todo`. A future GitHub Issues / Linear / Jira adapter can drop in without changing the agent contract — agents treat ids as opaque strings.

### Schedule Adapters

| Adapter | Flag | Description |
|---|---|---|
| `file` | `--schedule file` | Per-member events at `team/members/<name>/schedule.json`. Opaque ids, recurrence descriptors, and automatic advancement of recurring events / cleanup of fired one-time events on each successful cycle. Exposed through the same MCP server as messaging and tasks. |

All adapters implement the stable MCP contract documented in `teamos/docs/schedule.md`: `list_events`, `add_event`, `update_event`, `remove_event`. The runner owns recurrence advancement (`acknowledgeDue`); agents never bump `time` by hand. A future Google Calendar / CalDAV adapter can drop in without changing the agent contract — agents treat ids as opaque strings and never own recurrence logic.

Legacy `schedule.json` files (missing ids, using the old `recurring: true` flag alongside `recurrence`) are migrated on read — the adapter allocates ids and strips the redundant flag, then persists the canonical form.

### Sync Adapters

| Adapter | Flag | Description |
|---|---|---|
| `git` | `--sync git` | Git add/commit/push (default). Local repo is always current; push after each cycle. |
| `s3` | `--sync s3` | S3-compatible storage (Tigris, MinIO). Pull before each pass, push after each cycle. |

All adapters expose the same interface: `pull()`, `push()`, `init()`.

### Agent Adapters

| Agent | Local dev | Hosted (container) | Auth |
|---|---|---|---|
| Claude Code CLI | Yes | Yes | `ANTHROPIC_API_KEY` env var |
| Cursor | Yes | No | Desktop IDE |
| Augment | Yes | No | Desktop IDE |

In a container, only `claude` is valid — desktop tools require a GUI.

## Configuration

Adapters can be configured via `teamos.config.json` at the project root, with CLI flags as overrides:

```json
{
  "messaging": { "adapter": "file" },
  "tasks": { "adapter": "file" },
  "schedule": { "adapter": "file" },
  "sync": { "adapter": "git" },
  "agent": "claude"
}
```

For S3 sync (Tigris or MinIO):
```json
{
  "sync": {
    "adapter": "s3",
    "s3": {
      "endpoint": "https://fly.storage.tigris.dev",
      "bucket": "teamos-workspace",
      "region": "auto",
      "accessKeyId": "$AWS_ACCESS_KEY_ID",
      "secretAccessKey": "$AWS_SECRET_ACCESS_KEY"
    }
  }
}
```

Values prefixed with `$` are resolved from environment variables. Secrets should always use env vars, never be placed directly in config files.

## Cloud Deployment

TeamOS ships a generic container image (`teamos/Dockerfile`) that clones a host project from a git URL on first boot, then runs the loop with `git` sync. Nothing in the image is host-specific — every project-specific value is supplied via environment variables, so the same image deploys for any team.

### What the container does on boot

`teamos/scripts/entrypoint.sh` runs before the runner:

1. Configures git identity and (optionally) credentials from `GITHUB_TOKEN`
2. Clones `TEAMOS_REPO_URL@TEAMOS_REPO_BRANCH` into `/workspace/repo` (or pulls if already present)
3. Optionally backgrounds `code tunnel` for VSCode remote development
4. Execs `node teamos/scripts/run.mjs "$@"` with whatever args the platform passes

`HOME` is set to `/workspace` so git credentials and `code tunnel` auth persist on the volume across restarts.

### Required environment

| Variable | Required | Description |
|---|---|---|
| `TEAMOS_REPO_URL` | yes | HTTPS URL of the host project (e.g. `https://github.com/<owner>/<repo>.git`) |
| `TEAMOS_REPO_BRANCH` | no | Branch to track (default: `main`) |
| `TEAMOS_REPO_DIR` | no | Where to clone (default: `/workspace/repo`) |
| `GITHUB_TOKEN` | for private repos / push | PAT with `repo` scope; used as `x-access-token:<token>` for HTTPS auth |
| `GIT_AUTHOR_NAME` | no | Commit author (default: `teamos-runner`) |
| `GIT_AUTHOR_EMAIL` | no | Commit email (default: `runner@teamos.local`) |
| `TEAMOS_TUNNEL_NAME` | no | If set, runs `code tunnel --name <value>` in the background |
| `TEAMOS_UI_PORT` | no | If set, starts the `teamos/ui` Vite dev server on this port (bound to `0.0.0.0`). Expose via `fly proxy <port>` or a Fly HTTP service with auth in front. |
| `CLAUDE_CODE_OAUTH_TOKEN` | recommended | Subscription auth for the Claude CLI (see below). Falls back to `ANTHROPIC_API_KEY` if absent. |

### Authenticating the Claude CLI

The default `claude` agent adapter spawns the Claude Code CLI as a subprocess for each member cycle. Two ways to authenticate:

- **Subscription** (Pro/Max/Team/Enterprise) — run `claude setup-token` once on a machine where you're signed in to Claude.ai. It mints a one-year OAuth token that you set as `CLAUDE_CODE_OAUTH_TOKEN`. Cycles bill against your subscription rather than API rates. Note: `--bare` mode does not honor this token; teamos's adapter does not use `--bare`.
- **API key** — set `ANTHROPIC_API_KEY` instead. Bills per-token at API rates.

Token expires after one year — set a reminder to re-run `claude setup-token` and update the secret.

### Quick deploy to Fly.io

```bash
# 1. From your host project root, copy the template fly.toml.
cp teamos/fly.toml ./fly.toml
# Edit fly.toml: set `app = "<your-unique-name>"` and set TEAMOS_REPO_URL.

# 2. Create app + volume.
fly apps create <your-unique-name>
fly volumes create teamos_workspace --size 2

# 3. Set secrets.
fly secrets set \
  CLAUDE_CODE_OAUTH_TOKEN="<token from `claude setup-token`>" \
  GITHUB_TOKEN="<github PAT>"

# 4. Deploy.
fly deploy
```

The runner starts in loop mode with `--sync git --push` by default. Logs from each member cycle land in `/workspace/repo/team/.logs/` on the volume.

### VSCode remote development

To attach VSCode (or vscode.dev in a browser) to the running pod:

1. Set `TEAMOS_TUNNEL_NAME = "<unique-name>"` in `[env]` and redeploy.
2. One-time auth: `fly ssh console`, then inside the machine:
   ```sh
   pkill -f 'code tunnel' || true   # stop the failing background tunnel
   code tunnel user login           # device-code flow, opens a github.com URL
   ```
   Auth is written to `/workspace/.vscode-cli/` and survives restarts. Restart the machine (`fly machine restart`) and the entrypoint will start the tunnel cleanly.
3. Connect from VSCode: install the "Remote - Tunnels" extension, sign in with the same GitHub account, pick `<unique-name>` from the tunnel list.

The tunnel is outbound-only — no Fly ports need to be exposed.

### Alternative: S3 sync instead of git

For setups where you'd rather sync the workspace to object storage than commit it back to git, swap the runner args:

```toml
# fly.toml — override the default CMD
[processes]
  app = "teamos-entrypoint --sync s3 --messaging file"
```

Then add S3 settings to the host project's `teamos.config.json` and provide `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` as secrets. Tigris (Fly's S3-compatible storage) and MinIO are both supported — see the **Adapters** section.

### Local dev with MinIO

```bash
# Start MinIO (one-time)
minio server ./minio-data --console-address ":9001"

# Run against local MinIO
node teamos/scripts/run.mjs --sync s3 --messaging file
```

Or just use the default git sync — zero additional dependencies:

```bash
node teamos/scripts/run.mjs
```

### Container architecture

```
┌──────────────────────────────────────────────────┐
│  Runner Process (Node.js)                        │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Scheduler  │  │   Cycle    │  │Maintenance │  │
│  │            │→ │  Executor  │→ │  & Clerk   │  │
│  └────────────┘  └─────┬──────┘  └────────────┘  │
│                        │                         │
│              ┌─────────┼─────────┐               │
│              ▼         ▼         ▼               │
│        ┌──────────┐ ┌──────┐ ┌──────────┐        │
│        │Messaging │ │Agent │ │  Sync    │        │
│        │ Adapter  │ │Adapter│ │ Adapter  │        │
│        └────┬─────┘ └──┬───┘ └────┬─────┘        │
│             │          │          │               │
└─────────────┼──────────┼──────────┼───────────────┘
              │          │          │
         Files /      Claude /   Tigris /
         MCP          Cursor     Git
```

Agents always see a local filesystem. The sync adapter handles durability *around* the cycle — pull before, push after — so the agent never knows it's running in a container.

## Design Philosophy

- **Priority-weighted** — Higher-priority work receives proportionally more cycles, while lower priorities are guaranteed fair access
- **Right-sized cycles** — Each cycle does a modest amount of work to maintain continuity without overrunning context windows
- **Modular adapters** — Messaging, sync, and agent concerns are pluggable; the same runner works locally or in the cloud
- **Agent-owned changes** — The agent modifies files freely; the runner handles sync
- **Commit per member** — Clean history for human review between runs
- **Clerk cleanup** — Automated housekeeping after each pass (archiving, fixing inconsistencies)

## Web Dashboard

TeamOS includes a web dashboard for viewing team status, member details, inboxes, todos, and sending messages.

### Running the Dashboard

```bash
cd teamos/ui
npm install
npm run dev
```

The dashboard starts on `http://localhost:3003` by default.

### Identity ("Me")

On first launch, the dashboard prompts you to select your identity from the member list. This determines:
- The default **From** field when composing messages
- Visual indicators showing which member is "you" in the team grid and detail views

Your identity is stored in the browser's localStorage and can be changed anytime via the dropdown in the navigation bar.

### Configuration

The dashboard auto-discovers the `team/` directory by resolving `../../` from the `teamos/ui/` directory (which maps to the host project root for all installation modes). Override this by setting the `TEAMOS_PROJECT_ROOT` environment variable:

```bash
TEAMOS_PROJECT_ROOT=/path/to/project npm run dev
```

The dashboard reads `teamos.config.json` at startup and instantiates the configured messaging adapter, so inbox views, compose, reply, archive, and delete all flow through the same adapter the runner uses. Archive moves a message id from `inbox.json` to `archives.json` — the master store at `team/messages/<id>.md` holds the single copy of the body.

If a `tickets/` directory exists at the project root (e.g. from a ticket management system like tess), the dashboard displays a ticket pipeline summary. This feature is optional and hidden when no tickets directory is found.

### Authentication

The dashboard picks its "Me" identity from one of two sources:

1. **A trusted proxy header** (Cloudflare Access, Tailscale Serve, oauth2-proxy, Fly OIDC) — only honored when `auth.trustProxy: true` is set in `teamos.config.json`. The header value is looked up against an `email` field on each entry in `team/members.json` and the matched member becomes a locked identity the client can't change.
2. **Local selection** — the existing localStorage picker. Used when no header is present (or when `trustProxy` is off, which is the default).

This lets the same dashboard run on your desktop *and* behind a cloud auth proxy without code changes — just flip `trustProxy` and set `identityHeaders`.

```json
{
  "auth": {
    "trustProxy": false,
    "identityHeaders": [
      "cf-access-authenticated-user-email",
      "x-forwarded-email",
      "x-auth-request-email",
      "tailscale-user-login"
    ]
  }
}
```

Default is `trustProxy: false`, so localhost dev is safe — header spoofing has no effect. When you enable it, make sure the dashboard port is only reachable through the proxy (private network, Tailscale interface, loopback). See `teamos/docs/auth.md` for the full protocol, threat model, and deployment recipes.

## Removing TeamOS

```bash
node teamos/scripts/detach.mjs
```

This removes teamos-created artifacts (agent rule files, symlinks, gitignore entries) but never touches the `team/` workspace data.
