# Commit Triggers Architecture

TeamOS members wake on three built-in signals: new inbox messages, actionable todos, and due schedule events. **Commit triggers** add a fourth: a member can subscribe itself to new commits in the host repo, and matching commits wake it at the priority it declared — useful for code review, security sweeps, or watching areas of the codebase the member owns.

Only one adapter ships today: the **file adapter**, which keeps subscriptions in `team/members/<name>/triggers.json` and uses local `git log` to detect new commits. The MCP tools below are the stable contract; a future GitHub / GitLab webhook adapter could drop in against the same surface.

Triggers only fire on commits to the **host project repo**. Peer repos (`TEAMOS_PEER_REPOS`) and teamos itself are not watched.

## Design Principles

- **Per-member ownership.** A trigger lives in exactly one member's subscription list. Cross-member "everyone watch the auth module" patterns compose from multiple individual subscriptions.
- **Conjunctive filters.** Every supplied field on a trigger narrows the match. A commit must satisfy **all** filters the trigger declares.
- **Self-commits ignored by default.** A trigger skips commits where the author equals the member (by name or email). Override by setting `author` or clearing `authorNot` explicitly.
- **Merge commits ignored.** The file adapter runs `git log --no-merges` so merge commits never wake anyone.
- **Cursor advances on successful cycle (at-least-once).** The member's cursor moves to HEAD-at-cycle-start only when the cycle exits with code 0. A failed or killed cycle keeps the cursor where it was, so the same commits re-fire next pass.
- **First-run anchors to HEAD, no backfill.** The first time a member has triggers but no cursor, the cursor is set to the current HEAD — adding a trigger does not replay a week of history.
- **Ids are opaque to agents.** Triggers are allocated adapter-side and agents pass ids through without parsing.
- **Agents never write the file directly.** All mutations go through MCP tools.

## On-Disk Layout (file adapter)

```
team/
└── members/
    └── <name>/
        └── triggers.json
```

### File format

```json
{
  "cursor": "a3f2e1b9c08d5f4b6e7a8c9d0e1f2a3b4c5d6e7f",
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
| `cursor` | managed | Last commit SHA the member has been notified through. Managed by the runner — never edit by hand. |
| `id` | yes | Adapter-allocated, opaque, stable for the life of the trigger |
| `priority` | yes | `pressing` / `today` / `thisWeek` / `later` — the priority at which a match wakes the member |
| `reason` | no | Short note explaining why the subscription exists |
| `paths` | no | Array of glob patterns (`**`, `*`, `?`); match if the commit touches any matching file. Omit to match any path. |
| `author` | no | Only match commits whose author name or email equals this |
| `authorNot` | no | Skip commits by this author. Defaults to the member's own name; set explicitly to override (`""` to allow self-commits through) |
| `messageMatches` | no | JavaScript regex (string) tested against the commit subject line |

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

Allocates a new trigger id and inserts it. If this is the member's first trigger, the adapter anchors `cursor` at the current HEAD so no backlog is replayed.

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

Deletes the trigger. The cursor is left alone, so remaining triggers (if any) continue scanning from where they were.

Errors if `id` is not in the caller's trigger list.

## Cycle Integration

When building a cycle prompt, the runner:

1. Captures HEAD so commits created during the cycle don't get silently acknowledged
2. Calls `adapter.pendingMatches(member)` to get commits between the cursor and HEAD that match at least one trigger
3. Emits a **"Commit Triggers Fired"** section in the prompt with each match (short hash, subject, author, files). Files are capped at 10 per commit with an "and N more" tail so large merges don't blow the prompt
4. Passes the MCP tools so the agent can manage subscriptions mid-cycle

The commits shown in the prompt are the reason the member is being cycled (along with any other wake signals).

### Post-cycle acknowledgement

After a successful cycle, the runner calls:

```
adapter.acknowledgeHead(member, headAtCycleStart) → void
```

The cursor advances to the captured HEAD, clearing every commit the agent saw. If the cycle fails, `acknowledgeHead` is not called — the same commits re-fire next pass. This gives at-least-once semantics: a transient failure never silently drops a review.

Commits created **during** the cycle (e.g. the agent itself writes code and the sync adapter commits it) are NOT acknowledged — they remain pending and fire on the next pass where they match a trigger.

## Work Detection

A member has commit-trigger work when any pending match has a trigger priority at or above the current scan priority. `work-detection` asks the adapter:

```
adapter.hasPendingMatches(member, priority) → boolean
```

Inside a pass, `pendingMatches` caches by HEAD so a single pass doesn't run `git log` repeatedly across the 4 priority levels. The cache is invalidated on `acknowledgeHead` and on any trigger mutation.

## Failure modes

- **Invalid cursor (rebased away).** `git log cursor..HEAD` fails; the adapter resets the cursor to the current HEAD so subsequent passes proceed normally. One pass's worth of commits may be skipped — this is deliberate: forcing a replay after a branch rewrite would likely produce noise.
- **Not a git repo / git missing.** `pendingMatches` returns an empty array; the member is simply never woken by triggers.
- **`messageMatches` regex invalid at scan time.** Silently fails to match (the adapter catches the `new RegExp` throw). Agents who call `update_trigger` with a bad pattern get an error at mutation time instead of silent breakage, so this path should be unreachable in practice.

## Future Adapters

The MCP contract above is stable. A future GitHub webhook adapter might:

- Map `add_trigger` → create a webhook subscription + persist the trigger locally
- Map `pendingMatches` → consume queued webhook events rather than running `git log`
- Map `acknowledgeHead` → clear consumed events from the queue

Because agents treat trigger ids as opaque and the match shape stays the same, swapping adapters does not change the cycle prompt or the agent's mental model.
