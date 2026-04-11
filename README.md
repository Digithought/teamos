# TeamOS

TeamOS is a virtual workplace system that orchestrates AI and human team members through structured work cycles. Each AI member gets a small *cycle* at a time to perform a unit of work, respond to messages, advance projects, and collaborate with other members.

TeamOS lives as its own repository and integrates into any project, giving every repo the same team orchestration without duplicating code. It can run locally against a git repo or be deployed to the cloud (Fly.io) with S3 storage and Discord messaging.

## How It Works

Team members are defined in a `team/` workspace directory within the host project. Each member has a profile, current state, todo list, schedule, and inbox. A runner script processes members through fair-scheduled, priority-weighted cycles, invoking an AI agent (Claude, Cursor, Augment) for each.

The runner provides full context — organization docs, news, projects, and the member's own files — then syncs after each member completes. A clerk agent runs after each pass for cleanup (archiving old news, removing stale schedule items, etc.).

**Adapters** make the system pluggable:
- **Messaging** — File-based inbox (default) or Discord bot
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
│       ├── work-detection.mjs   # Member loading, work scanning, recurring events
│       ├── cycle.mjs            # Cycle/pass execution, prompt building
│       ├── maintenance.mjs      # Housekeeping, clerk invocation, efficiency
│       ├── agents/
│       │   ├── index.mjs        # Registry + common invocation (spawn, timeout, logging)
│       │   ├── claude.mjs       # Claude CLI adapter + stream parser
│       │   ├── cursor.mjs       # Cursor agent adapter + stream parser
│       │   └── auggie.mjs       # Augment adapter
│       ├── messaging/
│       │   ├── index.mjs        # Interface + factory
│       │   ├── file.mjs         # File-based inbox (default)
│       │   └── discord.mjs      # Discord bot adapter
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
├── members/
│   └── [memberName]/
│       ├── profile.md   # Member description
│       ├── state.md     # Current state of work
│       ├── todo.json    # Task list
│       ├── schedule.json
│       ├── inbox/       # Messages from other members
│       └── archives/
├── data/                # Shared data artifacts
├── docs/                # Shared documentation
├── archives/            # Archived org-level items
└── .logs/               # Agent execution logs (git-ignored)
```

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
mkdir -p team/members/alice/inbox
```

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

# Use Discord messaging instead of file inbox
node teamos/scripts/run.mjs --messaging discord

# Don't auto-commit
node teamos/scripts/run.mjs --no-commit
```

### Runner Options

| Option | Default | Description |
|---|---|---|
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, or `auggie` |
| `--messaging <name>` | `file` | Messaging adapter: `file` or `discord` |
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

### Weekly Self-Assessment

The runner automatically ensures every active AI member has a recurring **Weekly Self-Assessment** schedule event (Fridays at 18:00 UTC). On startup, if a member's `schedule.json` lacks this event, the runner injects it.

When the event fires, the member follows the rules in `teamos/agent-rules/self-assessment.md` to produce a reflective evaluation covering:

- **Role fulfillment** — delivering on the job description
- **Strategic vs tactical balance** — big-picture and day-to-day
- **Cycle efficiency** — right-sized work, no wasted context
- **Tool & document effectiveness** — building, maintaining, and reusing
- **State/task/schedule hygiene** — keeping files concise and current
- **Communication quality** — clear, actionable, appropriately targeted
- **Project impact** — meaningful progress toward team goals

Assessments are saved to `team/members/<name>/archives/self-assessments/assessment-YYYY-MM-DD.md`. After completing the assessment, the member bumps the event's `time` forward by one week to maintain the recurrence.

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
- They have **inbox messages** (markdown files in their `inbox/` directory)
- They have **todo items** at or above the current priority level
- They have **schedule events** that are due

## Cycle Behavior

During a cycle, the agent:
1. Reviews organization context (org, news, projects)
2. Processes inbox messages (reads and deletes them)
3. Performs one unit of work at the current priority
4. Updates state.md with what was accomplished
5. Maintains todos (completes items, adds new ones)

A unit of work can include:
- Maintaining TODOs or schedule
- Advancing a project by a modest increment
- Building a tool (JS/TS library) for self or team
- Sending messages to other members' inboxes
- Outputting artifacts to `team/data/` or `team/docs/`

## Member Communication

Members communicate through the messaging adapter. With the default file adapter, messages are markdown files in each other's `inbox/` directories:

```markdown
---
from: alice
sentAt: 2026-03-13T10:00:00Z
requestResponse: true
projectCode: AUTH
---

The auth module is ready for review.
```

With the Discord adapter, messages are posted to channels or DMs instead. The message format and semantics are the same regardless of backend.

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
9. **Your TODOs** — `team/members/<you>/todo.json`
10. **Your schedule** — `team/members/<you>/schedule.json`
11. **Your inbox** — all `.md` files in `team/members/<you>/inbox/`

The runner also passes a header with the current priority level and timestamp. When working interactively, default to priority `pressing` and follow the priority levels as described above.

Depending on your interaction, you may update your state, TODOs, and schedule. Do not commit — let the human handle that.

## Adapters

TeamOS uses a pluggable adapter architecture. Agents always work on a local filesystem — adapters handle how messages are delivered and how state is persisted.

### Messaging Adapters

| Adapter | Flag | Description |
|---|---|---|
| `file` | `--messaging file` | File-based inbox (default). Messages are markdown files in `inbox/` directories. |
| `discord` | `--messaging discord` | Discord bot. Messages are posted to channels/DMs. |

All adapters expose the same interface: `hasMessages()`, `getMessages()`, `sendMessage()`, `acknowledgeMessage()`, `listConversations()`.

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
  "sync": { "adapter": "git" },
  "agent": "claude"
}
```

For Discord messaging:
```json
{
  "messaging": {
    "adapter": "discord",
    "discord": {
      "botToken": "$DISCORD_BOT_TOKEN",
      "guildId": "...",
      "memberMap": {
        "alice": "discord-user-id",
        "bob": "discord-user-id"
      }
    }
  }
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

TeamOS can run as a container on Fly.io (or any container host) with S3 storage and Discord messaging.

### Quick deploy to Fly.io

```bash
# Create app and volume
fly apps create teamos-runner
fly volumes create team_workspace --size 1

# Set secrets
fly secrets set ANTHROPIC_API_KEY=sk-... DISCORD_BOT_TOKEN=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...

# Deploy
fly deploy
```

### Local dev with MinIO

```bash
# Start MinIO (one-time)
minio server ./minio-data --console-address ":9001"

# Run against local MinIO
node teamos/scripts/run.mjs --sync s3 --messaging file
```

With `teamos.config.json` for MinIO:
```json
{
  "sync": {
    "adapter": "s3",
    "s3": {
      "endpoint": "http://localhost:9000",
      "bucket": "teamos-workspace",
      "region": "us-east-1",
      "accessKeyId": "minioadmin",
      "secretAccessKey": "minioadmin",
      "forcePathStyle": true
    }
  }
}
```

Or just use the default git sync with file messaging — zero additional dependencies:

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
         Discord /    Claude /   Tigris /
         Files        Cursor     Git
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

If a `tickets/` directory exists at the project root (e.g. from a ticket management system like tess), the dashboard displays a ticket pipeline summary. This feature is optional and hidden when no tickets directory is found.

## Removing TeamOS

```bash
node teamos/scripts/detach.mjs
```

This removes teamos-created artifacts (agent rule files, symlinks, gitignore entries) but never touches the `team/` workspace data.
