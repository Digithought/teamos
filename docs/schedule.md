# Schedule Architecture

TeamOS schedules hold each member's time-based work: one-off reminders, recurring check-ins, project deadlines, and system-injected events like the daily check-in and weekly self-assessment. The protocol is designed so the same agent-facing contract can later be backed by a calendar service (Google Calendar, CalDAV, Microsoft Graph, …) without the agent or runner caring which store is underneath.

Only one adapter ships today: the **file adapter**, which keeps events in `team/members/<name>/schedule.json`. The MCP tools documented below are the stable contract; future adapters implement the same surface.

## Design Principles

- **Per-member ownership.** An event lives in exactly one member's schedule. There is no shared calendar; cross-member coordination happens through messages and project docs.
- **Recurrence is owned by the adapter.** Agents never advance a recurring event's `time`. They create it once with a recurrence spec, and the adapter handles both "when is it next due?" and "now that it fired, compute the next occurrence." The agent sees only a `nextOccurrence` field and the original recurrence descriptor.
- **One-time events auto-clear.** Once a non-recurring event has fired (its due cycle completed), the adapter removes it. The agent does not call `complete_event` or manually delete past reminders.
- **Ids are opaque to agents.** Every event has an id allocated by the adapter. Agents pass ids through — they do not parse, compare, or construct them. This leaves room for a future calendar adapter to use calendar-native ids or URLs.
- **Agents never write the file directly.** All mutations go through MCP tools. The runner still *reads* the schedule (via the adapter) to build the cycle prompt so the agent sees its upcoming and due events without having to call a tool.

## On-Disk Layout (file adapter)

```
team/
└── members/
    └── <name>/
        └── schedule.json
```

### File format

```json
{
  "events": [
    {
      "id": "2026-04-14T09-00-00.000Z-b4c5",
      "title": "Daily Check-in",
      "description": "Daily check-in following teamos/agent-rules/daily-checkin.md.",
      "time": "2026-04-15T09:00:00.000Z",
      "recurrence": { "frequency": "daily", "interval": 1 }
    },
    {
      "id": "2026-04-10T14-22-17.903Z-7a1e",
      "title": "Auth review deadline",
      "description": "Sign off on the token rotation design.",
      "time": "2026-04-20T17:00:00.000Z",
      "projectCode": "AUTH"
    }
  ]
}
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Adapter-allocated, opaque, stable for the life of the event |
| `title` | yes | One-line summary |
| `description` | no | Longer body — what to do when this fires, links to rules, etc. |
| `time` | yes | ISO-8601 timestamp of the **next occurrence**. The adapter keeps this up to date for recurring events. |
| `recurrence` | no | Recurrence descriptor; absent means one-time |
| `projectCode` | no | Optional project tag for filtering/grouping |

### Recurrence descriptor

```json
{
  "frequency": "daily" | "weekly" | "monthly",
  "interval": 1,
  "endDate": "2026-06-30T00:00:00.000Z"
}
```

- `frequency` — required
- `interval` — required positive integer (every N days/weeks/months)
- `endDate` — optional; after this point the adapter removes the event instead of advancing it

The previous file format used a `recurring: true` flag alongside `recurrence`. The new contract drops the flag — presence of `recurrence` is the signal. File-adapter migration is a one-line strip on read.

### Id format (file adapter)

```
<isoTimestamp>-<4charRand>
```

Same shape as message and todo ids. Lexically sortable by creation time. Other adapters are free to use a different id shape — agents treat ids as opaque strings.

## MCP Tools

The tasks adapter exposes four tools. Notably, there is **no** `advance_event`, `bump_event`, `complete_event`, or recurrence-manipulation tool — that surface is hidden by design.

### `list_events`

```
list_events() → ScheduleEvent[]
```

Returns every event in the caller's schedule, sorted by `time` ascending:

```
{
  id,
  title,
  description?,
  time,                // next occurrence (for recurring events, the adapter keeps this fresh)
  recurrence?,         // present iff the event recurs
  projectCode?,
  isDue                // true iff time <= now
}
```

`isDue` is a computed convenience so the agent can see at a glance what is firing this cycle.

### `add_event`

```
add_event({
  title: string,            // required
  time: string,             // required — ISO-8601 of the first occurrence
  description?: string,
  recurrence?: {
    frequency: "daily" | "weekly" | "monthly",
    interval: number,
    endDate?: string,
  },
  projectCode?: string,
}) → { id: string }
```

Allocates a new id and inserts the event. Returns the id so the agent can reference the new event in the same cycle (e.g., mention it in `state.md` or a message).

For recurring events, `time` is the first occurrence. The adapter is responsible for advancing `time` to subsequent occurrences as they fire — the agent supplies only the initial anchor and the recurrence rule.

### `update_event`

```
update_event(id: string, patch: {
  title?: string,
  description?: string,
  time?: string,
  recurrence?: { … } | null,   // null removes recurrence (converts to one-time)
  projectCode?: string,
}) → void
```

Partial update. Only supplied fields change. Setting `recurrence: null` converts a recurring event into a one-time event at its current `time`. Passing a new `time` resets the next occurrence; for recurring events the adapter continues to advance from the new anchor.

Errors if `id` is not in the caller's schedule.

### `remove_event`

```
remove_event(id: string) → void
```

Deletes the event entirely, including cancelling all future occurrences of a recurring event. Used when a member decides something is no longer needed (e.g., a cancelled meeting, a deprecated check-in).

Errors if `id` is not in the caller's schedule.

## Cycle Integration

When the runner builds a cycle prompt for a member, it:

1. Calls `adapter.listEvents(member)` to get the full schedule with `isDue` populated
2. Embeds **due events** prominently in the prompt under a "Due Events" section — these are the reason the member is being cycled (in part)
3. Embeds **upcoming events** in a separate "Upcoming" section for context, so the agent can plan ahead
4. Passes the MCP tools through so the agent can call `add_event`, `update_event`, `remove_event` during the cycle

The agent sees its due and upcoming events without ever calling `list_events` in the common case — the list is already in context. The MCP tool is there for when the agent needs a fresh view after several mutations.

### Post-cycle acknowledgement

After a successful cycle, the runner calls:

```
adapter.acknowledgeDue(member, cycleStartTime) → void
```

For every event that was due at `cycleStartTime`:

- If it has a `recurrence`: the adapter computes the next occurrence after `cycleStartTime` and writes it back to `time`. If the computed next occurrence is past `endDate`, the event is removed instead.
- If it is one-time: the adapter removes it.

This is the mechanism that keeps the schedule clean. Agents never see the advancement logic; they just notice that due events disappear (one-time) or reappear with a future `time` (recurring) on the next cycle.

If a cycle fails (agent crashes, timeout), `acknowledgeDue` is not called, and the due events fire again on the next cycle. This gives at-least-once semantics — a transient failure never silently drops a reminder.

### Deferring work the agent couldn't finish

If an event fires and the agent can't complete the associated work in one cycle, the right move is usually to convert it into a todo (via `add_todo`) or add a new follow-up event (`add_event`). The original event still gets acknowledged and advanced — don't try to block acknowledgement by leaving work visible, because the runner will advance it anyway.

## Work Detection

A member has scheduled work when any event in their schedule is due (i.e., `time <= now`). The `work-detection` module asks the adapter directly:

```
adapter.hasDueEvents(member, now) → boolean
```

For the file adapter this is an O(events)-per-member scan. Future adapters (e.g. Google Calendar) may cache or use server-side filters; the contract only requires a boolean answer.

## System-Injected Events

The runner ensures every active AI member has two recurring events:

- **Daily Check-in** (09:00 UTC daily) — see `agent-rules/daily-checkin.md`
- **Weekly Self-Assessment** (Fridays 18:00 UTC) — see `agent-rules/self-assessment.md`

These are injected on startup via the adapter's `add_event` path (not by writing the file directly) so any backend picks them up transparently. The runner checks for existing events by title before injecting to avoid duplicates.

Once injected, these events are indistinguishable from agent-created events — the adapter owns their recurrence advancement just like any other recurring event.

## Future Adapters

The MCP contract above is the stable surface. A future Google Calendar adapter might:

- Map `add_event` → `events.insert` on the member's calendar, returning the Google event id
- Map `list_events` → `events.list` with `timeMin` / `timeMax` filters, translating Google's `recurrence` (RRULE) strings to TeamOS's simplified descriptor
- Map `update_event` → `events.patch`
- Map `remove_event` → `events.delete`
- Map `acknowledgeDue` to a no-op for recurring events (Google handles recurrence natively) and a `events.delete` for one-time events

A CalDAV adapter follows the same shape — the wire format is different but the semantics line up. Because agents treat ids as opaque and never own recurrence logic, swapping adapters does not change the cycle prompt, the agent's mental model, or work detection.
