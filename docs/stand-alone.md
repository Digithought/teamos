# TeamOS Stand-alone: Cloud Deployment Plan

TeamOS currently runs as a local process tightly coupled to a git repo. This document plans the migration to a stand-alone, cloud-deployable architecture that can run on Fly.io (or locally for development) while keeping the file-based workspace model that agents depend on.

## Goals

1. **Modular messaging** — Replace the file-drop inbox with an adapter layer. Ship two adapters: file-based (current behavior) and Discord.
2. **Modular sync** — Replace the git-commit-after-cycle pattern with an adapter layer. Ship two adapters: git (current) and S3/Tigris.
3. **Decompose the runner** — Break the 1,700-line `run.mjs` into focused modules.
4. **Containerize** — Dockerfile + Fly.io config for hosted deployment.
5. **Local dev parity** — Everything runs on a Windows/Mac/Linux dev box with MinIO as the S3 stand-in.

## Architecture Overview

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

Local volume: /workspace/team/  (Fly Volume or local dir)
```

### Key principle: agents always see a local filesystem

Agents are trained around files. They read `state.md`, edit `todo.json`, write scripts, create documents. The sync adapter handles durability *around* the cycle — pull before, push after — so the agent never knows it's running in a container. The local volume is the working copy; Tigris/S3 is the durable store.

## Runner Decomposition

The current `scripts/run.mjs` (~1,700 lines) handles everything: CLI parsing, scheduling, work detection, prompt building, agent invocation, git operations, housekeeping, and the main loop. It decomposes into these modules:

### Module map

```
teamos/scripts/
├── run.mjs                  # Entry point — CLI parsing, main loop (slim)
└── lib/
    ├── scheduler.mjs        # Vruntime fair scheduler, cadence, budgets
    ├── work-detection.mjs   # Member loading, work scanning, recurring events
    ├── cycle.mjs            # Cycle execution, prompt building, inbox reading
    ├── maintenance.mjs      # Housekeeping, clerk invocation, efficiency analysis
    ├── agents/              # Agent adapters
    │   ├── index.mjs        #   Registry + common invocation (spawn, timeout, logging)
    │   ├── claude.mjs       #   Claude CLI adapter + stream parser
    │   ├── cursor.mjs       #   Cursor agent adapter + stream parser
    │   └── auggie.mjs       #   Augment adapter
    ├── messaging/           # Messaging adapters
    │   ├── index.mjs        #   Interface + factory
    │   ├── file.mjs         #   File-based inbox (current behavior)
    │   └── discord.mjs      #   Discord bot adapter
    ├── sync/                # Sync adapters
    │   ├── index.mjs        #   Interface + factory
    │   ├── git.mjs          #   Git add/commit/push (current behavior)
    │   └── s3.mjs           #   S3-compatible sync (Tigris, MinIO)
    ├── state.mjs            # Scheduler state persistence (load/save)
    └── util.mjs             # Path helpers, time formatting, stop-file check
```

### Module responsibilities

**`run.mjs`** (entry point) — Parses CLI args, resolves paths, instantiates adapters from config/flags, runs the main loop or single pass. Delegates everything else. Target: ~200 lines.

**`scheduler.mjs`** — The weighted fair scheduler. Exports `pickNextPriority()`, `normalizeVruntimes()`, `rotateAfter()`. Owns the vruntime/cadence/budget logic. No I/O — pure scheduling math. Extracted from lines 274–381 of current runner.

**`work-detection.mjs`** — `loadMembers()`, `memberHasWork()`, `getMembersWithWork()`, `isEventDue()`, `nextOccurrence()`, `advanceRecurringEvents()`, and the recurring-event injectors (`ensureDailyCheckinEvents`, `ensureSelfAssessmentEvents`). Reads `members.json`, todo files, schedule files, inbox directories. Uses the messaging adapter to check for messages rather than directly scanning `inbox/`.

**`cycle.mjs`** — `runCycle()` and `buildCyclePrompt()`. Assembles the full context (org, memos, projects, member files, inbox via messaging adapter, cycle rules), invokes the agent adapter, handles exit codes and backoff, calls sync adapter after completion.

**`maintenance.mjs`** — `runMaintenance()`, `runHousekeeping()`, `scanRecentLogs()`, `buildLogSummary()`, `buildEfficiencyPrompt()`. Post-pass lifecycle: automated cleanup, conditional clerk invocation, weekly efficiency analysis.

**`agents/`** — Each adapter exports `{ cmd, args, formatStream }` (or `{ shellCmd, formatStream }`). The `index.mjs` provides `runAgent(adapterName, prompt, cwd, logFile)` — the common spawn/timeout/logging logic extracted from lines 1076–1182.

**`messaging/`** — See Messaging Adapter section below.

**`sync/`** — See Sync Adapter section below.

**`state.mjs`** — `loadSchedulerState()`, `saveSchedulerState()`, `idleWait()`. Handles `scheduler-state.json` persistence and the idle-wait polling loop.

**`util.mjs`** — `pathExists()`, `readTextOrEmpty()`, `checkStop()`, `formatTimestamp()`, `slugify()`. Stateless helpers.

## Messaging Adapter

### Interface

```js
/**
 * @typedef {Object} Message
 * @property {string} from
 * @property {string} sentAt      - ISO-8601
 * @property {boolean} [requestResponse]
 * @property {string} [projectCode]
 * @property {string} [conversationId] - thread/group ID
 * @property {string} [replyTo]        - message being replied to
 * @property {string} body
 */

/**
 * @typedef {Object} MessagingAdapter
 * @property {(member: string) => Promise<boolean>} hasMessages
 * @property {(member: string) => Promise<Message[]>} getMessages
 * @property {(member: string, messageId: string) => Promise<void>} acknowledgeMessage
 * @property {(recipients: string[], message: Message) => Promise<void>} sendMessage
 * @property {(member: string) => Promise<Conversation[]>} listConversations
 * @property {() => McpToolDef[]} getMcpTools - MCP tool definitions (all adapters must provide these)
 */
```

### MCP tools — all adapters

Every messaging adapter exposes the same MCP tools to the agent. The agent always uses these tools to send and read messages, regardless of which backend is active. The abstraction is in the adapter implementation, not in whether MCP is used.

Tools provided by all adapters:

| Tool | Description |
|---|---|
| `send_message` | Send a message to one or more recipients. Params: `recipients[]`, `body`, `projectCode?`, `conversationId?`, `replyTo?` |
| `read_messages` | Read pending messages for the current member. Returns `Message[]` |
| `acknowledge_message` | Mark a message as processed. Params: `messageId` |
| `list_conversations` | List active conversations the member is part of |

This means the cycle prompt no longer needs to inline inbox contents or explain the file format. The agent discovers messaging through its tools and interacts uniformly. The adapter decides what happens underneath — writing `.md` files to disk, posting to Discord, etc.

### File adapter (`file.mjs`)

Wraps the current behavior behind the common MCP interface:
- `hasMessages()` — checks for `.md` files in `team/members/{name}/inbox/`
- `getMessages()` — reads and parses frontmatter from each `.md` file
- `acknowledgeMessages()` — deletes processed inbox files
- `sendMessage()` — writes `.md` file with frontmatter to each recipient's `inbox/`
- MCP `send_message` → calls `sendMessage()` to write inbox files
- MCP `read_messages` → calls `getMessages()` to read inbox files
- MCP `acknowledge_message` → deletes the specific inbox file

### Discord adapter (`discord.mjs`)

Uses Discord.js bot API:
- Each team member maps to a Discord user or bot identity
- Team channels for group conversations, DMs for 1:1
- `hasMessages()` — checks for unread messages since last acknowledged timestamp
- `getMessages()` — fetches messages from member's channels/DMs since last cycle
- `acknowledgeMessages()` — updates the last-read timestamp
- `sendMessage()` — posts to the appropriate channel or DM thread; supports `conversationId` for threading
- MCP tools map to the same underlying methods, posting to Discord instead of writing files

Configuration:
```json
{
  "messaging": {
    "adapter": "discord",
    "discord": {
      "botToken": "$DISCORD_BOT_TOKEN",
      "guildId": "...",
      "memberMap": {
        "alice": "discord-user-id-or-bot-id",
        "bob": "discord-user-id-or-bot-id"
      }
    }
  }
}
```

### Integration with cycle

The cycle prompt builder tells the agent it has messaging tools available and provides a brief roster of who's on the team. The agent uses MCP tools to read and send messages. It does not need to know the backend — the adapter handles everything.

### Integration with work detection

`memberHasWork()` calls `messagingAdapter.hasMessages(member)` instead of scanning the inbox directory directly. This makes work detection adapter-agnostic.

## Sync Adapter

### Interface

```js
/**
 * @typedef {Object} SyncAdapter
 * @property {(workDir: string) => Promise<void>} pull - pull latest state to local working dir
 * @property {(workDir: string, label: string) => Promise<void>} push - push local changes with label
 * @property {() => Promise<void>} init - one-time setup (create bucket, init repo, etc.)
 */
```

### Git adapter (`git.mjs`)

Wraps the current behavior:
- `pull()` — no-op (local repo is always current)
- `push()` — `git add -A && git commit -m "{label}"`, optionally `git push`
- `init()` — no-op (assumes repo exists)

### S3 adapter (`s3.mjs`)

Uses the AWS SDK (`@aws-sdk/client-s3`) or `rclone` CLI:
- `pull()` — sync from S3 bucket to local working directory (`rclone sync remote:bucket/team/ /workspace/team/` or equivalent SDK calls)
- `push()` — sync local working directory back to S3 (`rclone sync /workspace/team/ remote:bucket/team/`). The `label` is logged but S3 doesn't have commits — versioning on the bucket provides history.
- `init()` — create bucket if it doesn't exist, enable versioning

For efficiency, `push()` can compute changed files since the last pull (via timestamps or checksums) and upload only diffs rather than full sync every cycle.

Configuration:
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

For local dev with MinIO:
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

## Configuration

Adapters are selected via a `teamos.config.json` at the project root (or `team/` directory), with CLI flags as overrides:

```json
{
  "messaging": { "adapter": "file" },
  "sync": { "adapter": "git" },
  "agent": "claude"
}
```

CLI overrides: `--messaging discord`, `--sync s3`, `--agent claude`.

Loop mode is the default. Use `--once` for a single pass (replaces the old default behavior). The `--loop` flag is retained as a no-op for backwards compatibility.

Environment variables for secrets (`DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, S3 credentials) — never in config files.

## Container Deployment

### Dockerfile

```dockerfile
FROM node:22-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install rclone (for S3 sync)
RUN apt-get update && apt-get install -y rclone && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY teamos/ ./teamos/

# Working directory for the team workspace (Fly Volume mount point)
RUN mkdir -p /workspace/team
```

### Fly.io config (`fly.toml`)

```toml
app = "teamos-runner"

[build]
  dockerfile = "Dockerfile"

[mounts]
  source = "team_workspace"
  destination = "/workspace"

[env]
  NODE_ENV = "production"
  TEAMOS_TEAM_DIR = "/workspace/team"

# Secrets set via: fly secrets set ANTHROPIC_API_KEY=... DISCORD_BOT_TOKEN=... etc.
```

### Startup

The container entry point runs the runner (loop mode is the default):

```bash
node teamos/scripts/run.mjs --sync s3 --messaging discord
```

On startup:
1. S3 adapter pulls latest workspace to `/workspace/team/`
2. Runner enters main loop
3. Each cycle: agent works on local files, then sync adapter pushes changes to Tigris

### Local dev

No container needed. Run MinIO for S3:

```bash
# Start MinIO (one-time)
minio server ./minio-data --console-address ":9001"

# Run the runner against local MinIO
node teamos/scripts/run.mjs --sync s3 --messaging file
```

Or just use the current git mode with file messaging — zero additional dependencies:

```bash
node teamos/scripts/run.mjs
```

For a single pass (e.g. CI or one-off run):

```bash
node teamos/scripts/run.mjs --once
```

## Agent Authentication

Hosted deployment is limited to API-based agents. Desktop tools (Cursor, Augment) require a GUI and can't run headless in a container.

| Agent | Local dev | Hosted | Auth |
|---|---|---|---|
| Claude Code CLI | Yes | Yes | `ANTHROPIC_API_KEY` env var |
| Cursor | Yes | No | Desktop IDE |
| Augment | Yes | No | Desktop IDE |

The agent adapter registry validates at startup that the selected agent is available in the current environment. In a container, only `claude` is valid.

## Implementation Phases

### Phase 1: Decompose the runner

Break `run.mjs` into the module structure described above. No new features — the file adapter and git adapter extract the existing code. Everything works exactly as before. This is pure refactoring.

Modules to extract in order (each step keeps the runner functional):
1. `util.mjs` — stateless helpers, no dependencies
2. `state.mjs` — scheduler state persistence
3. `scheduler.mjs` — pure scheduling math
4. `agents/` — adapter registry + invocation + per-agent stream parsers
5. `work-detection.mjs` — member loading, work scanning, recurring events
6. `maintenance.mjs` — housekeeping, clerk, efficiency
7. `sync/git.mjs` — extract current commit/push logic behind the adapter interface
8. `messaging/file.mjs` — extract current inbox read/write behind the adapter interface
9. `cycle.mjs` — cycle execution and prompt building (depends on agents, messaging, sync)
10. Slim down `run.mjs` to CLI parsing + main loop + adapter wiring

### Phase 2: S3 sync adapter

Implement `sync/s3.mjs`. Test locally with MinIO. The runner gains `--sync s3` and reads S3 config from `teamos.config.json` or environment variables.

### Phase 3: Discord messaging adapter

Implement `messaging/discord.mjs`. Create a Discord bot, map members to Discord identities, wire up `hasMessages` / `getMessages` / `sendMessage`. The runner gains `--messaging discord`. MCP tool definitions let agents send Discord messages during cycles.

### Phase 4: Configuration file

Implement `teamos.config.json` loading so adapter selection and credentials can be declared rather than passed as CLI flags every time.

### Phase 5: Containerize

Write the Dockerfile and `fly.toml`. Test locally with `docker build` + `docker run`. Deploy to Fly.io with a Tigris bucket and Discord bot token.

### Phase 6: Dashboard for hosted mode

The current dashboard runs as a Vite dev server reading local files. For hosted mode, it needs to either:
- Talk to the same S3 bucket (read workspace files from Tigris)
- Or expose the runner's local workspace via an API (the runner already has the Vite plugin pattern)

This is a later concern — the runner is the priority.
