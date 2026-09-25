# Commit Triggers Architecture

TeamOS members wake on three built-in signals: new inbox messages, actionable todos, and due schedule events. **Commit triggers** add a fourth: a member can subscribe itself to new commits in the host repo, and matching commits wake it at the priority it declared — useful for code review, security sweeps, or watching areas of the codebase the member owns.

Only one adapter ships today: the **file adapter**, which keeps subscriptions in `team/members/<name>/triggers.json`, keeps scan state and durable matches in `team/.logs/triggers/<name>.json`, and uses local `git log` to detect new commits. The MCP tools below are the stable contract; a future GitHub / GitLab webhook adapter could drop in against the same surface.

Triggers only fire on commits to the **host project repo**. Peer repos (`TEAMOS_PEER_REPOS`) and teamos itself are not watched.

## Design Principles

- **Per-member ownership.** A trigger lives in exactly one member's subscription list. Cross-member "everyone watch the auth module" patterns compose from multiple individual subscriptions.
- **Conjunctive filters.** Every supplied field on a trigger narrows the match. A commit must satisfy **all** filters the trigger declares.
- **Self-commits ignored by default.** A trigger skips commits where the author equals the member (by name or email). Override by setting `author` or clearing `authorNot` explicitly.
- **Merge commits ignored.** The file adapter runs `git log --no-merges` so merge commits never wake anyone.
- **A match is durable until explicitly cleared.** Once a commit matches a trigger, it stays in the member's match ledger — and keeps appearing in every cycle prompt — until `clear_trigger_matches` removes it. This is the same "must be actively cleared" contract an unarchived inbox message already has. The scan cursor (which commits have been *checked* against the filters) is a separate, much cheaper concept: it advances eagerly on essentially every scan, independent of whether any cycle that saw a match acted on it. See "On-Disk Layout" and "No post-cycle acknowledgement step" below.
- **First-run anchors to HEAD, no backfill.** The first time a member has triggers but no cursor, the cursor is set to the current HEAD — adding a trigger does not replay a week of history.
- **Ids are opaque to agents.** Triggers are allocated adapter-side and agents pass ids through without parsing.
- **Agents never write the file directly.** All mutations go through MCP tools.

## On-Disk Layout (file adapter)

```
team/
├── members/
│   └── <name>/
│       └── triggers.json      # subscriptions — hand-reviewable, git-synced
└── .logs/
    └── triggers/
        └── <name>.json        # scan cursor + durable match ledger — runner-managed, gitignored
```

The two files are split because they change at completely different rates. Subscriptions change when a member decides to watch something. Scan state changes on essentially every scan — including ones that happen during work-detection, well before any cycle actually runs — so keeping it in the git-synced half would mean a commit every scan. `team/.logs/` is already the directory teamos gitignores for exactly this kind of churn (see `watches.md` for the same split applied to watch observations).

### Subscriptions file format (`triggers.json`)

```json
{
  "items": [
    {
      "id": "2026-04-23T14-05-11.903Z-7a1e",
      "priority": "today",
      "reason": "code review for the auth module",
      "paths": ["packages/auth/**", "docs/auth/*.md"],
      "authorNot": "alice",
      "messageMatches": "^(fix|refactor)\\b"
    }
  ]
}
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Adapter-allocated, opaque, stable for the life of the trigger |
| `priority` | yes | `pressing` / `today` / `thisWeek` / `later` — the priority at which a match wakes the member |
| `reason` | no | Short note explaining why the subscription exists |
| `paths` | no | Array of glob patterns (`**`, `*`, `?`); match if the commit touches any matching file. Omit to match any path. |
| `author` | no | Only match commits whose author name or email equals this |
| `authorNot` | no | Skip commits by this author. Defaults to the member's own name; set explicitly to override (`""` to allow self-commits through) |
| `messageMatches` | no | JavaScript regex (string) tested against the commit subject line |

A `triggers.json` written before this split may still carry a `cursor` field inline — the adapter migrates it into the ledger file the first time it's loaded (adopting it as the initial scan position, not re-anchoring at HEAD, so nothing already pending gets silently skipped) and rewrites this file without it.

### Ledger file format (`.logs/triggers/<name>.json`)

```json
{
  "cursor": "a3f2e1b9c08d5f4b6e7a8c9d0e1f2a3b4c5d6e7f",
  "matches": [
    {
      "hash": "b7e...full sha...",
      "shortHash": "b7e1a2c3",
      "author": "bob",
      "email": "bob@example.com",
      "subject": "fix: tighten the auth guard",
      "files": ["packages/auth/guard.ts"],
      "matchedTriggerIds": ["2026-04-23T14-05-11.903Z-7a1e"],
      "priority": "today",
      "matchedAt": "2026-09-25T01:00:00.000Z"
    }
  ]
}
```

`cursor` is the last commit SHA that has been *scanned* against the current filters — not the same as "seen by the member." `matches` is every commit that matched at least one trigger and has not yet been cleared via `clear_trigger_matches`. Never edit either by hand.

### Glob syntax

The file adapter ships a tiny matcher — there are no external deps. Supported metacharacters:

- `**` — any sequence of characters including `/` (consumes a trailing `/` so `foo/**/bar` also matches `foo/bar`)
- `*` — any run of non-slash characters
- `?` — a single non-slash character

Anything else is matched literally. This covers the common cases; if you need richer matching, compose several `paths` entries.

## MCP Tools

### `list_triggers`

```
list_triggers() → CommitTrigger[]
```

Returns every trigger the caller has subscribed to. The cycle prompt does not list these by default — use `list_triggers` when you want to audit or prune your subscriptions.

### `add_trigger`

```
add_trigger({
  priority: "pressing" | "today" | "thisWeek" | "later",  // required
  reason?: string,
  paths?: string[],
  author?: string,
  authorNot?: string,
  messageMatches?: string,
}) → { id: string }
```

Allocates a new trigger id and inserts it. If this is the member's first trigger (no ledger cursor exists yet), the adapter anchors the ledger's `cursor` at the current HEAD so no backlog is replayed.

### `update_trigger`

```
update_trigger(id: string, patch: {
  priority?: ...,
  reason?: string | null,
  paths?: string[] | null,
  author?: string | null,
  authorNot?: string | null,
  messageMatches?: string | null,
}) → void
```

Partial update. Pass `null` (or `""` for strings, `[]` for paths) to clear an optional field. `messageMatches` is validated as a regex at mutation time — a bad pattern is rejected now instead of silently failing later.

Errors if `id` is not in the caller's trigger list.

### `remove_trigger`

```
remove_trigger(id: string) → void
```

Deletes the trigger. The scan cursor is left alone, so remaining triggers (if any) continue scanning from where they were. Any ledger matches that existed only because of this trigger are dropped; a match that was also matched by a different surviving trigger keeps showing, narrowed to that trigger's id.

Errors if `id` is not in the caller's trigger list.

### `clear_trigger_matches`

```
clear_trigger_matches({
  triggerId?: string,   // clear this trigger's share of its matches
  hashes?: string[],    // clear these specific commits outright, for every trigger that matched them
}) → { cleared: number }
```

Marks matches as handled so they stop reappearing. At least one of `triggerId` or `hashes` is required.

- `triggerId` alone clears **every currently pending match for that trigger** — the common case, since a cycle typically disposes of one trigger's whole fired batch as a single review. A commit that was *also* matched by a different trigger the caller didn't name keeps showing, for that trigger.
- `hashes` alone clears those exact commits outright, regardless of which trigger(s) matched them.
- Both together scope the clear to just that trigger's reference on those specific commits.

Matches are durable by design — see "Design Principles" above — so this is the only way a match stops appearing. Letting it go unread is not enough; the cycle prompt (`formatCommitMatchForPrompt`) prints the full hash and matched trigger ids specifically so this call has what it needs.

## Cycle Integration

When building a cycle prompt, the runner:

1. Calls `adapter.pendingMatches(member)`, which durably records any newly-discovered matches (scanning cursor..HEAD) and returns the member's *entire* unresolved ledger — not just what's new this call
2. Emits a **"Commit Triggers Fired"** section in the prompt with each match (short hash, full hash, subject, author, matched trigger ids, files). Files are capped at 10 per commit with an "and N more" tail so large merges don't blow the prompt
3. Passes the MCP tools so the agent can manage subscriptions, and clear matches, mid-cycle

The commits shown in the prompt are the reason the member is being cycled (along with any other wake signals). Because matches are durable, a member is shown the same match on every cycle — even unrelated ones — until it calls `clear_trigger_matches`.

### No post-cycle acknowledgement step

Unlike inbox and schedule, commit triggers need nothing done after the cycle. `pendingMatches` already advanced the scan cursor and persisted any new matches to the ledger *before* the agent ran (during prompt-building) — so a commit created **during** the cycle (e.g. the agent itself writes code and the sync adapter commits it) is naturally excluded, exactly as before. Whether the cycle's agent exits 0 or not has no bearing on the ledger: a failed cycle doesn't need to re-scan, because the match it would have re-discovered is already durably recorded. The only thing that removes a match is an explicit `clear_trigger_matches` call.

This replaces a design where the cursor only advanced after a successful cycle (`acknowledgeHead`, removed 2026-09-25). That scheme conflated two different things under one cursor: "which commits has this member's git log scan reached" and "which matches has the member actually dealt with." A cycle that ran for an unrelated reason (an inbox reply, a todo) and exited 0 still advanced the cursor past every match shown that cycle, whether or not the agent acted on it — so a match shown once and not handled could vanish permanently, with no record it had ever fired. See the 2026-09-25 incident that prompted this split.

## Work Detection

A member has commit-trigger work when any pending match has a trigger priority at or above the current scan priority. `work-detection` asks the adapter:

```
adapter.hasPendingMatches(member, priority) → boolean
```

Inside a pass, `pendingMatches` caches (per member) the HEAD it has already scanned to, so a single pass doesn't run `git log` repeatedly across the 4 priority levels — it still re-reads the ledger from disk each call, but skips the expensive git invocation. The cache is invalidated on any trigger mutation (`addTrigger`, `updateTrigger`, `removeTrigger`), since a changed filter set needs re-evaluating even at an already-scanned HEAD.

Because the scan runs (and the cursor advances) on every `pendingMatches` call — including the ones work-detection makes before deciding whether to cycle anyone — a member's ledger can pick up new matches without that member ever being cycled that pass. This is safe by construction: the match is written to the ledger before the cursor moves past its commit, so nothing is lost by scanning early: it's just discovered sooner than it's shown.

## Failure modes

- **Invalid cursor (rebased away).** `git log cursor..HEAD` fails; the adapter resets the cursor to the current HEAD so subsequent passes proceed normally. One pass's worth of *new* commits may go unscanned — this is deliberate: forcing a replay after a branch rewrite would likely produce noise. Matches already in the ledger are unaffected.
- **Not a git repo / git missing.** `pendingMatches` returns whatever is already in the ledger rather than scanning; a member with no ledger yet and no readable HEAD is simply never woken by triggers.
- **`messageMatches` regex invalid at scan time.** Silently fails to match (the adapter catches the `new RegExp` throw). Agents who call `update_trigger` with a bad pattern get an error at mutation time instead of silent breakage, so this path should be unreachable in practice.

## Future Adapters

The MCP contract above is stable. A future GitHub webhook adapter might:

- Map `add_trigger` → create a webhook subscription + persist the trigger locally
- Map `pendingMatches` → consume queued webhook events into the same kind of durable ledger, rather than running `git log`
- Map `clear_trigger_matches` → remove the corresponding entries from its own ledger

Because agents treat trigger ids as opaque and the match shape stays the same, swapping adapters does not change the cycle prompt or the agent's mental model.
