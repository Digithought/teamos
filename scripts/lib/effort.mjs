import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Model and reasoning effort for an agent spawn — the one place the levels, the defaults and the
 * precedence live. README § *Model and effort* is the prose for it.
 *
 *   run-wide:  CLI flag (or the `chat` section, for chats) → config top level → default
 *   member:    `model:` / `effort:` in the member's profile.md frontmatter → run-wide
 *   cycle:     each work item the cycle serves contributes its own `effort`, or the member's when
 *              it has none; the highest wins. Model has no per-item override.
 *
 * The highest-wins rule is what lets one item lower the effort as well as raise it: a lone
 * low-effort event runs low, but the same event beside an ordinary todo runs at the member's.
 */

/** Reasoning-effort levels, lowest first — the Claude CLI's `--effort` values. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_MODEL = 'opus';
export const DEFAULT_EFFORT = 'medium';

export function isEffort(value) {
	return EFFORT_LEVELS.includes(value);
}

/** An effort supplied on an add: absent → undefined; anything but a level throws. */
export function optionalEffort(value, where) {
	if (value === undefined || value === null || value === '') return undefined;
	if (!isEffort(value)) throw new Error(`${where}: effort must be one of ${EFFORT_LEVELS.join(', ')}`);
	return value;
}

/**
 * Apply an effort patch to `next` in place: absent leaves it, null or '' clears it, a level sets
 * it, anything else throws.
 */
export function patchEffort(next, value, where) {
	if (value === undefined) return;
	if (value === null || value === '') next.effort = undefined;
	else next.effort = optionalEffort(value, where);
}

/** The highest of `levels` (unset entries skipped), or undefined when none is set. */
export function highestEffort(levels) {
	let best;
	for (const level of levels) {
		if (isEffort(level) && (best === undefined || EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(best)))
			best = level;
	}
	return best;
}

/**
 * Run-wide settings. `overrides` is the CLI flags for the runner, or the `chat` section for
 * dashboard chats. An invalid effort throws: it is a typo a person made, not one to run past.
 */
export function resolveBaseSettings(config = {}, overrides = {}) {
	const model = overrides.model || config.model || DEFAULT_MODEL;
	const effort = overrides.effort || config.effort || DEFAULT_EFFORT;
	if (!isEffort(effort)) throw new Error(`Invalid effort "${effort}": use one of ${EFFORT_LEVELS.join(', ')}`);
	return { model, effort };
}

/**
 * `model` and `effort` from profile.md frontmatter. A profile is edited by hand and by the member
 * itself, so an unknown effort is warned about and ignored rather than failing the cycle.
 */
export function parseProfileSettings(profileText, memberName = '?') {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(profileText ?? '');
	if (!fm) return {};
	const field = (key) => {
		const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(fm[1]);
		return m?.[1].replace(/^(["'])(.*)\1$/, '$2') || undefined;
	};
	const out = {};
	const model = field('model');
	if (model) out.model = model;
	const effort = field('effort');
	if (effort && isEffort(effort)) out.effort = effort;
	else if (effort) console.warn(`[runner] ${memberName}'s profile has unknown effort "${effort}" — ignored.`);
	return out;
}

/** Member settings: the profile's frontmatter over the run-wide `base`. */
export async function memberSettings(teamDir, memberName, base) {
	const text = await readFile(join(teamDir, 'members', memberName, 'profile.md'), 'utf-8').catch(() => '');
	const profile = parseProfileSettings(text, memberName);
	return { model: profile.model || base.model, effort: profile.effort || base.effort };
}

/**
 * The effort a cycle runs at, given the member's effort and the work items it serves
 * (`{ source, effort? }`). Returns the effort and the items that set it, for the log.
 */
export function cycleEffort(memberEffort, items) {
	const effort = highestEffort(items.map((i) => i.effort ?? memberEffort)) ?? memberEffort;
	const setBy = items.filter((i) => i.effort === effort && effort !== memberEffort).map((i) => i.source);
	return { effort, setBy };
}
