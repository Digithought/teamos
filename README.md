# TeamOS

TeamOS is a virtual workplace system that orchestrates AI and human team members through structured work cycles. Each AI member gets a small *cycle* at a time to perform a unit of work, respond to messages, advance projects, and collaborate with other members.

TeamOS lives as its own repository and integrates into any project, giving every repo the same team orchestration without duplicating code.

## How It Works

Team members are defined in a `team/` workspace directory within the host project. Each member has a profile, current state, todo list, schedule, and inbox. A runner script processes members through priority-cascading cycles, invoking an AI agent (Claude, Cursor, Augment) for each.

The runner provides full context — organization docs, news, projects, and the member's own files — then commits after each member completes. A clerk agent runs after each pass for cleanup (archiving old news, removing stale schedule items, etc.).

### Package Structure

```
teamos/
├── README.md                # This file — system architecture reference
├── scripts/
│   ├── run.mjs              # Runner — orchestrates member cycles
│   ├── init.mjs             # Project initialization
│   └── detach.mjs           # Package removal
├── agent-rules/
│   ├── cycle.md             # Rules for member cycle agents
│   ├── clerk.md             # Rules for clerk agent
│   └── root.md              # Section appended to host AGENTS.md
└── templates/
    ├── *.d.ts               # TypeScript type definitions
    └── *-template.*         # File templates for new members
```

### Workspace Structure

```
team/
├── org.md               # Organization description
├── members.json         # Member manifest
├── projects.json        # Goals and projects
├── news.json            # Timely information for all members
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
sequenceOrder: 1
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
      "sequenceOrder": 1,
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

# Run cycles for all members
node teamos/scripts/run.mjs

# Run only a specific member
node teamos/scripts/run.mjs --member alice

# Use a different agent
node teamos/scripts/run.mjs --agent cursor
```

### Runner Options

| Option | Default | Description |
|---|---|---|
| `--agent <name>` | `claude` | Agent adapter: `claude`, `cursor`, or `auggie` |
| `--priority <level>` | `pressing` | Starting priority level |
| `--member <name>` | — | Only run cycles for a specific member |
| `--max-cycles <n>` | `10` | Maximum cycle passes before stopping |
| `--no-commit` | — | Skip automatic git commit after each cycle |
| `--no-clerk` | — | Skip clerk agent after each pass |
| `--dry-run` | — | List members with work, don't invoke agent |

## Priority Cascade

```
pressing  →  today  →  thisWeek  →  later
```

- **Pressing** — Timely; should be processed within an hour
- **Today** — Should be handled today
- **ThisWeek** — Handle this week
- **Later** — Nibble at when there is time

The runner starts at the highest priority and cascades down. It only advances to the next level when no members have work at the current level.

## Work Detection

A member is given a cycle when any of these are true:
- They have **inbox messages** (JSON files in their `inbox/` directory)
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

Members communicate by dropping JSON files into each other's `inbox/` directories:

```json
{
  "from": "alice",
  "content": "The auth module is ready for review.",
  "sentAt": "2026-03-13T10:00:00Z",
  "requestResponse": true,
  "projectCode": "AUTH"
}
```

## Design Philosophy

- **Priority-driven** — Pressing work is always handled before less urgent tasks
- **Right-sized cycles** — Each cycle does a modest amount of work to maintain continuity without overrunning context windows
- **Agent-owned changes** — The agent modifies files freely; the runner handles git commits
- **Commit per member** — Clean git history for human review between runs
- **Clerk cleanup** — Automated housekeeping after each pass (archiving, fixing inconsistencies)
- **Zero dependencies** — Uses only Node.js built-in modules

## Removing TeamOS

```bash
node teamos/scripts/detach.mjs
```

This removes teamos-created artifacts (agent rule files, symlinks, gitignore entries) but never touches the `team/` workspace data.
