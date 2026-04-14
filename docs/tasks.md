#  Tasks Architecture

TeamOS tasks (todos) are the member-owned list of work items the runner uses to pace cycles. Each item has a title, a priority level, and an optional blocked status. The protocol is designed so the same agent-facing contract can later be backed by an external tracker (GitHub Issues, Linear, Jira, …) without the agent or runner caring which store is underneath.

Only one adapter ships today: the **file adapter**, which keeps todos in `team/members/<name>/todo.json`. The MCP tools documented below are the stable contract; future adapters implement the same surface.

## Design Principles

- **Per-member ownership.** A todo lives in exactly one member's list. There is no cross-member task; collaboration happens through messages.
- **Only open items.** The list holds incomplete work only. Completing a todo removes it from the list — there is no "done" state. History belongs in `state.md` or commit messages, not the todo store.
- **Priority is the scheduling knob.** Each item carries a priority (`pressing` / `today` / `thisWeek` / `later`) that feeds directly into the runner's fair scheduler. Mislabelling wastes the member's cycles.
- **Blocked items are skipped, not hidden.** An item with `status: "blocked"` remains in the list and in the agent's prompt, but the scheduler does not count it as actionable work. Agents should explain the block in `notes` so future cycles (or other members) can unblock it.
- **Ids are opaque to agents.** Every item has an id allocated by the adapter. Agents pass ids through — they do not parse, compare, or construct them. This leaves room for a future adapter to use issue numbers, URLs, or UUIDs.
- **Agents never write the file directly.** All mutations go through MCP tools. The runner still *reads* the list (via the adapter) to build the cycle prompt so the agent sees its todos without having to call a tool.

## On-Disk Layout (file adapter)

```
team/
└── members/
    └── <name>/
        └── todo.json
```

### File format

```json
{
  "items": [
    {
      "id": "2026-04-14T09-30-12.441Z-a3f2",
      "title": "Review auth module PR",
      "description": "Focus on the token rotation changes.",
      "priority": "today",
      "notes": "Waiting on Bob's response re: refresh window.",
      "projectCode": "AUTH"
    },
    {
      "id": "2026-04-13T18-00-00.000Z-9c1b",
      "title": "Write migration plan",
      "priority": "thisWeek",
      "status": "blocked",
      "notes": "Blocked on infra approval — see message 2026-04-13T17-55-…"
    }
  ]
}
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Adapter-allocated, opaque, stable for the life of the item |
| `title` | yes | One-line summary |
| `description` | no | Longer body — rationale, acceptance criteria, links |
| `priority` | yes | `pressing` / `today` / `thisWeek` / `later` |
| `status` | no | `blocked` or omitted; blocked items are skipped by the scheduler |
| `notes` | no | Free-form updates — progress, blockers, context |
| `projectCode` | no | Optional project tag for filtering/grouping |

### Id format (file adapter)

```
<isoTimestamp>-<4charRand>
```

Same shape as message ids. Lexically sortable by creation time; four random base-36 characters disambiguate concurrent adds in the same millisecond. Other adapters are free to use a different id shape — agents treat ids as opaque strings.

## MCP Tools

These are the tools the tasks adapter exposes to the agent. The contract is intentionally small: list, add, update, complete.

### `list_todos`

```
list_todos() → TodoItem[]
```

Returns every open todo for the caller, in priority order (`pressing` → `later`), with insertion order as the tiebreaker. Blocked items appear after actionable ones within each priority level.

```
{
  id, title, description?, priority, status?, notes?, projectCode?
}
```

### `add_todo`

```
add_todo({
  title: string,            // required
  priority: string,         // required — pressing | today | thisWeek | later
  description?: string,
  notes?: string,
  projectCode?: string,
  status?: "blocked",       // rare; usually added unblocked and blocked later
}) → { id: string }
```

Allocates a new id and appends the item to the caller's list. Returns the id so the agent can reference the new todo in the same cycle (e.g., mention it in `state.md` or a message).

### `update_todo`

```
update_todo(id: string, patch: {
  title?: string,
  description?: string,
  priority?: string,
  notes?: string,
  projectCode?: string,
  status?: "blocked" | null,   // null clears the blocked status
}) → void
```

Partial update. Only supplied fields change; others are left untouched. Setting `status: "blocked"` marks the item blocked; `status: null` clears it. This is the canonical way to demote priorities, record progress in `notes`, or block/unblock an item.

Errors if `id` is not in the caller's list.

### `complete_todo`

```
complete_todo(id: string) → void
```

Removes the item from the caller's list. There is no "done" state — completed work simply disappears from the store. If the agent needs to record that something was finished, it belongs in `state.md`, a commit message, or a message to another member.

Errors if `id` is not in the caller's list.

## Cycle Integration

When the runner builds a cycle prompt for a member, it:

1. Calls `adapter.listTodos(member)` to get the full open list
2. Embeds the list in the prompt under a "TODOs" section, formatted for readability
3. Passes the MCP tools through so the agent can call `add_todo`, `update_todo`, `complete_todo` during the cycle

The agent sees its todos without ever calling `list_todos` in the common case — the list is already in context. The MCP tool is there for when the agent needs a fresh view after several mutations, or when it wants to confirm state before a decision.

The runner does **not** filter the list to the current priority level when building the prompt. The agent sees everything so it can reason about the full backlog, then decide what to work on this cycle.

## Work Detection

A member has task work at a given priority when their list contains at least one item whose `priority` is at or above the requested level and whose `status` is not `blocked`. The `work-detection` module asks the adapter this question directly:

```
adapter.hasActionableTodos(member, priority) → boolean
```

For the file adapter this is an O(1)-per-member check: read `todo.json`, scan for any non-blocked item at or above the priority. Future adapters (e.g. GitHub Issues) may cache or paginate; the contract only requires a boolean answer.

## Priority Discipline

The adapter does not enforce priority discipline — it trusts the agent's labels. The runner's fair scheduler translates those labels into cycle allocation (see `README.md` → Loop Mode). Mislabelling doesn't corrupt anything, but it does distort how often the member is cycled, which is why `agent-rules/cycle.md` treats priority as a first-class responsibility.

## Future Adapters

The MCP contract above is the stable surface. A future GitHub Issues adapter might:

- Map `add_todo` → `POST /repos/:owner/:repo/issues`, returning the issue number as the id
- Map `list_todos` → `GET /repos/:owner/:repo/issues?assignee=<member>&state=open`
- Map `update_todo` → `PATCH /repos/:owner/:repo/issues/:number` for title/body/labels
- Map `complete_todo` → `PATCH … {state: "closed"}`
- Store TeamOS priority in an issue label (`priority:today`) and the blocked status in another (`status:blocked`)
- Store `projectCode` in a label or project field

A Linear or Jira adapter follows the same shape — the only per-backend wrinkles are the id format and how priority/blocked map onto the backend's native fields. Because agents treat ids as opaque and never assume item content lives on local disk, swapping adapters does not change the cycle prompt, the agent's mental model, or work detection.
