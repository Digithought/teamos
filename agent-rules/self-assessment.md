# Weekly Self-Assessment

It's time for an honest review of how well you are performing your role, not a status update. Writing the assessment is the smaller part of the cycle; the larger part is *changing* your state, profile, tasks and events so next week goes better.

The runner has already queued next week's self-assessment — don't call `update_event` to bump its `time`.

Work through the steps in order. Keep it to one cycle: find the top signals, act on them, and move on.

## 1. Read last week's assessment

Open your most recent file in `team/members/<your name>/archives/assessments/` and note its scores and action items. Then read only what has happened since: `state.md`, anything added to `archives/state-history/` since that date, and your sent mail (`list_sent`). Don't trawl older archives; last week's assessment already summarizes them.

## 2. Move permanent knowledge out of `state.md`

`state.md` is the current picture and is regularly cut down — by you here, and by mid-week rollups when it goes over budget. Anything in it that should hold for as long as you hold this role will eventually be cut with the rest. Find those entries and move them to your profile, which is never rolled up.

Permanent means it stays true after the current work is finished:

- standing directives from a human or your manager ("always ask Nate before…", "never touch X")
- boundaries of your role and agreed hand-offs with other members
- lasting preferences about how you work or how others want to hear from you
- lessons that apply to every future cycle, not just to one system or one piece of work

Not permanent: current focus, open threads, what you're waiting on, and knowledge about a topic, system or procedure. Topic knowledge goes to `team/docs/<topic>/` (`teamos/agent-rules/cycle.md` § Guidelines).

Where it goes:

- **Short, needed every cycle** → a `## Standing notes` section in the body of `team/members/<your name>/profile.md`, one line each. The profile is pasted into every cycle prompt, so keep that section lean.
- **Longer, or needed only sometimes** → a doc at `team/members/<your name>/docs/<topic>.md`, with a line in `## Standing notes` that links it and says when to read it. Linked docs are not loaded automatically, so a link with no "read when…" is a link nobody follows.

You own `## Standing notes` and the docs it links. The profile's frontmatter (title, roles, duties, personality) and the rest of its body belong to your manager. If one of your entries contradicts them, or would change them, don't edit them: raise it with your manager in the summary message (step 5).

Delete each entry from `state.md` once it has landed. If you moved nothing, say "None" in the assessment's *Moved to profile* section — don't omit the section.

## 3. State budget check

Run `wc -c team/members/<your name>/state.md` and compare it against the 16 KB budget (`teamos/agent-rules/cycle.md` § Guidelines). Do this every week; size creeps back up between assessments even after a clean rollup.

If it's over budget, roll it up now, before the ratings:

1. Archive the current file verbatim to `team/members/<your name>/archives/state-history/<YYYY-MM-DD>-pre-rollup.md`.
2. Rewrite `state.md` under 16 KB, sorting each entry rather than dropping it, as `cycle.md` § Guidelines describes: the current picture stays, topic knowledge goes to `team/docs/<topic>/` (keeping that folder's `index.md` and the top-level `team/docs/index.md` current), and finished narrative stays in the archive from step 1. Step 2 above has already taken out the permanent entries.

An assessment that finds `state.md` over budget and doesn't fix it in the same cycle cannot score "State, Tasks & Schedule Hygiene" above 2.

## 4. Write the assessment and make the changes

Save it to `team/members/<your name>/archives/assessments/YYYY-MM-DD.md` (create the directory if needed), using the template below. Rate each area 1-5 (1 = poor, 5 = excellent) with a brief justification that cites specific examples. Be candid. Where a score moved since last week, say why.

Make the changes as you go: update state, todos and events in this cycle rather than listing them as intentions. Anything you can't do this cycle becomes a todo or event, and its id goes in *Changes*.

```markdown
# Self-Assessment — <Your Name> — YYYY-MM-DD

## Moved to profile
(Each entry moved from state.md in step 2, and whether it went to Standing notes or a linked doc. "None" if nothing moved.)

## Role Fulfillment (1-5)
Am I fulfilling my job description and delivering on what my role demands?

## Strategic vs Tactical Balance (1-5)
Am I attending to both big-picture goals and day-to-day execution, or getting lost in minutiae or neglecting details?

## Cycle Efficiency (1-5)
Are my units of work right-sized — not so small that overhead dominates, not so large that they overrun context?

## Tool & Document Effectiveness (1-5)
Am I building reusable tools where appropriate, keeping team/docs/ and team/data/ useful, and reusing existing tools rather than reinventing them?

## State, Tasks & Schedule Hygiene (1-5)
- State: the size from step 3, and whether anything moved out landed in a findable doc rather than being deleted. Is the rest current, or stale?
- Tasks: are todos correctly prioritized and labeled, and kept actionable with `update_todo` / `complete_todo`?
- Schedule: am I using events for deferred work instead of leaving unactionable items at high priority?

## Communication Quality (1-5)
Am I communicating effectively, or over- or under-communicating?

## Project Impact (1-5)
Am I making meaningful progress on assigned projects?

## Last week's action items
(Each one: done, partly done, or dropped, and why.)

## Key Accomplishments
- (3-5 concrete things completed this week)

## Changes
- (1-3 improvements for next week, each with what you changed this cycle or the todo/event id that carries it)
```

## 5. Send the summary

Call `send_message` with your manager in `to`, subject `"Weekly self-assessment — YYYY-MM-DD"`. If step 2 moved anything, the body opens with it: a first line such as **"Moved to my profile: …"** naming each entry, followed by any proposed change to the manager-owned parts of your profile. Then your scores and the changes you made. Keep it short; the full assessment is in the archive.
