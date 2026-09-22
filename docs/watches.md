# Watches Architecture

TeamOS members wake on four built-in signals: new inbox messages, actionable todos, due schedule events, and commit triggers. **Watches** add a fifth: a member can subscribe itself to a named *probe* — a small command the humans registered on the host — and wake when that probe's result **changes**.

Watches exist for the class of condition none of the other four can see: host-side state. A supervisor process that exited cleanly with an empty queue is not a message, not a todo, not an event, and not a commit. Nothing notices, and the member responsible for restarting it sleeps through the night. A watch on a `runner-alive` probe notices at the next pass.

Only one adapter ships today: the **file adapter**, which keeps subscriptions in `team/members/<name>/watched.json` and runs probes between cycles. The MCP tools below are the stable contract; a future push-based adapter (a monitoring system posting events) could drop in against the same surface.

## Design Principles

- **Per-member ownership.** A watch lives in exactly one member's subscription list. "Everyone should know when the runner dies" composes from several individual subscriptions.
- **Named probes, never inline commands.** A watch references a probe by name plus parameters. It cannot carry a command. Agents mutate their own watch list over MCP, so a watch that carried a shell string would be an agent writing code the runner executes as the runner's user — and an agent able to silence its own alarm by rewriting the command. The registry is host-owned; an unknown probe name is a validation error at mutation time, not a silent no-op later.
- **Edge-triggered, not level-triggered.** A watch fires on *transition*, not on the condition being true. A runner that has been down six hours is one wake, not one wake per cycle forever — otherwise a persistently-true condition starves the member of every other kind of work. Recovery is a transition too, so a member learns that the thing it fixed stayed fixed.
- **Acknowledged state advances on successful cycle (at-least-once).** The stored signature moves to what the agent saw only when the cycle exits 0 — the same discipline as the commit-trigger `cursor`. A failed or killed cycle re-fires the same transition next pass.
- **First observation is a silent baseline, no backfill.** The first time a watch is polled, whatever it sees becomes the acknowledged state. Subscribing to an already-broken runner does not manufacture a wake for a condition that predates the subscription.
- **Flap control by cooldown.** A watch will not wake its member more than once per `cooldownMinutes`. A probe that oscillates back to the acknowledged state inside the cooldown produces nothing at all — by the time the cooldown expires there is no transition left to report.
- **A probe that fails to run is not a probe that found nothing.** "Could not execute" is its own status, reported distinctly, and is itself edge-triggered — a permanently missing binary reports once.
- **Ids are opaque to agents.** Watch ids are allocated adapter-side and agents pass them through without parsing.
- **Agents never write the file directly.** All mutations go through MCP tools.

## The Probe Registry

Probes live in the `probes` section of `teamos.config.json`, alongside the adapter selections:

```json
{
	"watches": { "adapter": "file" },
	"probes": {
		"runner-alive": {
			"description": "Exit 0 if the named runner's supervisor unit is running",
			"command": "systemctl",
			"args": ["is-active", "--quiet", "teamos-{{runner}}"],
			"params": ["runner"],
			"timeoutMs": 5000
		}
	}
}
```

**Why the config file and not a `team/probes/` directory of scripts?** `team/` is the agents' workspace — they write files there every cycle. A probe directory inside it would put the executed code on the writable side of exactly the boundary this feature exists to hold. `teamos.config.json` sits at the host repo root beside the code, is already the file that decides what the runner does, and a change to it is a reviewable diff rather than a new file appearing in a member's directory. It is also one file to read, with no execute-bit, shebang, or interpreter questions.

Probe fields:

| Field | Required | Description |
|---|---|---|
| `command` | yes | Executable, run **without a shell**. No pipes, redirection or interpolation — put anything that needs a shell in a script and register that script's path. |
| `args` | no | Argv array. `{{name}}` placeholders are substituted from the watch's `params`. |
| `params` | no | Parameter names a watch may (and must) supply. Anything not listed here is rejected at `add_watch`. |
| `timeoutMs` | no | Kill the probe after this long. Default 10000, capped at 60000. |
| `cwd` | no | Working directory, relative to the host repo root. Defaults to the repo root. |
| `description` | no | Shown to agents by `list_watches` so they can pick a probe |

Parameter values must be simple strings — no whitespace, quoting, or leading `-` — so a watch cannot smuggle an extra option into the probe's own command line. A malformed probe entry is dropped from the registry, and every watch referencing it then reports an unknown-probe error by name.

## On-Disk Layout (file adapter)

```
team/
└── members/
    └── <name>/
        └── watched.json
```

### File format

```json
{
	"items": [
		{
			"id": "2026-04-23T14-05-11.903Z-7a1e",
			"probe": "runner-alive",
			"params": { "runner": "tess" },
			"priority": "pressing",
			"fires": "exitCode",
			"exitCode": 3,
			"reason": "I own restarting the tess runner",
			"cooldownMinutes": 30
		}
	],
	"observed": {
		"2026-04-23T14-05-11.903Z-7a1e": {
			"signature": "clear",
			"status": "clear",
			"since": "2026-04-23T14:06:02.111Z",
			"lastFiredAt": "2026-04-23T09:31:40.006Z",
			"latest": {
				"status": "hit",
				"signature": "hit",
				"observedAt": "2026-04-23T15:02:11.440Z",
				"exitCode": 3,
				"output": ""
			}
		}
	}
}
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Adapter-allocated, opaque, stable for the life of the watch |
| `probe` | yes | Name of a probe in the registry. Unknown names are rejected at mutation time. |
| `priority` | yes | `pressing` / `today` / `thisWeek` / `later` — the priority at which a transition wakes the member |
| `fires` | no | Hit semantics; see below. Default `nonEmptyOutput`. |
| `exitCode` | no | With `fires: "exitCode"`, the code that counts as a hit. Default `0`. |
| `params` | no | Probe parameters. Every name the probe declares is required; anything else is an error. |
| `reason` | no | Short note explaining why the subscription exists |
| `cooldownMinutes` | no | Minimum minutes between wakes from this watch. Default 15; `0` disables. |
| `observed` | managed | Per-watch observation state. Managed by the runner — never edit by hand. |

### Hit semantics (`fires`)

Each poll turns a probe run into a **status** (what the member reads) and a **signature** (what the adapter diffs). Two runs with the same signature are the same observation and never wake anyone twice.

| `fires` | Status | Signature |
|---|---|---|
| `nonEmptyOutput` (default) | `hit` when the probe printed anything on stdout, else `clear` | `hit` / `clear` |
| `exitCode` | `hit` when the exit code equals `exitCode`, else `clear` | `hit` / `clear` |
| `outputChanged` | `changed` — every difference in stdout is a transition | hash of stdout |
| *(any mode)* | `error` when the probe could not be executed at all | `error` |

`nonEmptyOutput` suits a probe that prints a complaint and stays silent when healthy. `exitCode` suits an existing check that already signals through its status. `outputChanged` suits a probe that reports a value — a queue depth, a version string — where any movement is worth a look.

Because the `error` signature is a single value, a probe that is permanently broken (missing binary, bad `cwd`) wakes the member once, not every pass. The error message is carried in the observation so the member can see *why* it could not run.

## MCP Tools

### `list_watches`

```
list_watches() → { watches: Watch[], registeredProbes: Probe[] }
```

Returns every watch the caller has subscribed to, plus the probes registered on this host — that is how an agent discovers what it can watch. The cycle prompt does not list these by default; use `list_watches` to audit or prune.

### `add_watch`

```
add_watch({
  probe: string,                                          // required
  priority: "pressing" | "today" | "thisWeek" | "later",  // required
  fires?: "nonEmptyOutput" | "exitCode" | "outputChanged",
  exitCode?: number,
  params?: { [name: string]: string },
  reason?: string,
  cooldownMinutes?: number,
}) → { id: string }
```

Allocates a new watch id and inserts it. The probe name, its parameters, the priority and the `fires` mode are all validated now, so a bad subscription is an error at mutation time instead of a watch that quietly never fires. The first poll after adding establishes the baseline without waking anyone.

### `remove_watch`

```
remove_watch(id: string) → void
```

Deletes the watch and discards its observation state — re-adding it starts from a fresh baseline.

Errors if `id` is not in the caller's watch list.

There is deliberately no `update_watch`. A watch is a probe name plus how to read it; changing either of those is a different subscription, and re-adding it re-baselines the observation state rather than leaving a stale signature attached to new semantics.

## Where Probes Run

Probes run **in the runner loop, between cycles** — never inside a cycle, and never in the agent's process. Two places call `poll`:

1. At the top of each cycle in a pass, before work detection scans the priorities
2. On each idle tick between passes, so a host-side condition can pull the next pass forward instead of waiting out the interval

`poll` is throttled to once per member per minute, so calling it from a 30-second idle tick costs nothing. Every probe in a member's list runs concurrently, each under its own `timeoutMs` with `SIGKILL` on expiry: a hung probe costs its own timeout and cannot hang the loop. `poll` never throws — a probe failure becomes an `error` observation.

Work detection reads the recorded observations only; it never runs a probe:

```
adapter.hasPendingObservations(member, priority) → boolean
```

## Cycle Integration

When building a cycle prompt, the runner:

1. Calls `adapter.pendingObservations(member)` for watches whose latest observation differs from the acknowledged one and whose cooldown has elapsed
2. Emits a **"Watches Fired"** section with each observation (probe, status, what it was before, exit code, and the probe's output capped at 10 lines)
3. Passes the MCP tools so the agent can manage subscriptions mid-cycle

### Post-cycle acknowledgement

After a successful cycle, the runner calls:

```
adapter.acknowledgeObservations(member) → void
```

Each fired watch's acknowledged signature advances to what the agent saw and `lastFiredAt` is stamped (starting the cooldown). If the cycle fails, `acknowledgeObservations` is not called — the same transition fires next pass. This gives at-least-once semantics: a transient failure never silently drops an alert.

## Failure modes

- **Probe missing / not executable / bad `cwd`.** Reported as status `error` with the message, once per transition into that state.
- **Probe hangs.** Killed at `timeoutMs`; reported as status `error` (`timed out after Nms`).
- **Probe removed from the registry while a watch references it.** The watch reports an unknown-probe `error` — visible to the member rather than silently dead.
- **`watched.json` hand-edited into nonsense.** Unparseable entries are dropped on load and the file is rewritten, matching the triggers adapter. Observation state for watches that no longer exist is discarded.
- **No probes registered at all.** `add_watch` errors saying so; nothing else changes.

## Future Adapters

The MCP contract above is stable. A push-based adapter (Prometheus Alertmanager, a healthcheck service) might:

- Map `add_watch` → create a subscription to a named alert + persist the watch locally
- Map `poll` → no-op; observations arrive over a webhook instead
- Map `acknowledgeObservations` → acknowledge the alert upstream

Because agents treat watch ids as opaque, never supply a command, and read the same `status` vocabulary either way, swapping adapters does not change the cycle prompt or the agent's mental model.
