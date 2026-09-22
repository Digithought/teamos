import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { PRIORITY_ORDER } from '../scheduler.mjs';

/**
 * File-backed watches adapter.
 *
 * Per-member state at team/members/<name>/watched.json:
 *   {
 *     "items": [ Watch, ... ],
 *     "observed": { "<watch id>": WatchState, ... }
 *   }
 *
 * A watch subscribes the member to a *named probe* — a small command registered
 * by a human under `probes` in teamos.config.json. The runner executes the
 * probe between cycles and turns its result into a signature; the member is
 * woken when that signature *changes* (edge-triggered), not while it is merely
 * true. That is the whole point: a runner that has been down for six hours is
 * one wake, not one wake per cycle forever.
 *
 * The acknowledged signature advances only after a cycle exits 0 — same
 * at-least-once discipline as the commit-trigger cursor. A failed or killed
 * cycle re-fires the same transition next pass.
 *
 * Watches carry no command of their own. Agents can add and remove their own
 * watches over MCP, so a watch that carried a shell string would be an agent
 * writing code the runner executes — and an agent able to silence its own
 * alerts by rewriting it. Probe names are validated against the registry at
 * mutation time; an unknown name is an error, not a silent no-op.
 */

const execFileAsync = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 10 * 1000; // per probe run
const MAX_PROBE_TIMEOUT_MS = 60 * 1000; // registry ceiling — a probe never holds the loop longer
const DEFAULT_COOLDOWN_MINUTES = 15; // minimum re-arm interval between wakes
const MIN_POLL_INTERVAL_MS = 60 * 1000; // don't re-run probes more than once a minute
const MAX_OUTPUT_CHARS = 2000; // probe output retained for the prompt

/** Declared hit semantics. See teamos/docs/watches.md for the field reference. */
const FIRES_MODES = ['nonEmptyOutput', 'exitCode', 'outputChanged'];

/**
 * Probe parameters are substituted into registry-declared argv slots, never
 * into a shell. The charset still excludes anything that would let a watch
 * smuggle an option into the probe's own command line (a leading `-` is
 * rejected separately below).
 */
const SAFE_PARAM = /^[A-Za-z0-9._@:/+=,-]+$/;

function makeWatchId() {
	const iso = new Date().toISOString().replace(/:/g, '-');
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

function isValidPriority(p) {
	return PRIORITY_ORDER.includes(p);
}

function sha1(text) {
	return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function clip(text) {
	if (!text) return '';
	return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : text;
}

/**
 * Normalize the `probes` section of teamos.config.json into a name → probe
 * map. Malformed entries are dropped rather than thrown on: a typo in the
 * host's config should cost that one probe, and every watch referencing it
 * then reports a validation error by name.
 */
export function normalizeProbes(probes) {
	const out = new Map();
	if (!probes || typeof probes !== 'object') return out;
	for (const [name, entry] of Object.entries(probes)) {
		if (!entry || typeof entry !== 'object') continue;
		if (typeof entry.command !== 'string' || !entry.command) continue;
		const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
		const params = Array.isArray(entry.params) ? entry.params.filter((p) => typeof p === 'string' && p) : [];
		const timeoutMs =
			typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0
				? Math.min(entry.timeoutMs, MAX_PROBE_TIMEOUT_MS)
				: DEFAULT_PROBE_TIMEOUT_MS;
		out.set(name, {
			name,
			command: entry.command,
			args,
			params,
			timeoutMs,
			cwd: typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null,
			description: typeof entry.description === 'string' ? entry.description : undefined,
		});
	}
	return out;
}

/**
 * Substitute `{{param}}` placeholders in the probe's declared argv. Only names
 * the probe declares are substitutable; anything else is rejected at mutation
 * time by `validateParams`.
 */
function renderArgs(probe, params) {
	return probe.args.map((arg) =>
		arg.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in params ? params[key] : whole)),
	);
}

function validateParams(probe, params, toolName) {
	const supplied = params ?? {};
	for (const key of Object.keys(supplied)) {
		if (!probe.params.includes(key)) {
			throw new Error(
				`${toolName}: probe "${probe.name}" accepts no parameter "${key}"` +
					(probe.params.length ? ` (accepts: ${probe.params.join(', ')})` : ''),
			);
		}
		const value = supplied[key];
		if (typeof value !== 'string' || !SAFE_PARAM.test(value) || value.startsWith('-')) {
			throw new Error(`${toolName}: parameter "${key}" must be a simple string (no spaces, quoting, or leading "-")`);
		}
	}
	for (const key of probe.params) {
		if (!(key in supplied)) throw new Error(`${toolName}: probe "${probe.name}" requires parameter "${key}"`);
	}
	return { ...supplied };
}

function normalizeWatch(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const out = {};
	out.id = typeof entry.id === 'string' && entry.id ? entry.id : makeWatchId();
	if (typeof entry.probe !== 'string' || !entry.probe) return null;
	out.probe = entry.probe;
	out.priority = isValidPriority(entry.priority) ? entry.priority : null;
	if (!out.priority) return null;
	out.fires = FIRES_MODES.includes(entry.fires) ? entry.fires : 'nonEmptyOutput';
	if (out.fires === 'exitCode') {
		out.exitCode = Number.isInteger(entry.exitCode) ? entry.exitCode : 0;
	}
	if (entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)) {
		const params = {};
		for (const [k, v] of Object.entries(entry.params)) {
			if (typeof v === 'string') params[k] = v;
		}
		if (Object.keys(params).length) out.params = params;
	}
	if (typeof entry.reason === 'string' && entry.reason) out.reason = entry.reason;
	out.cooldownMinutes =
		typeof entry.cooldownMinutes === 'number' && entry.cooldownMinutes >= 0
			? entry.cooldownMinutes
			: DEFAULT_COOLDOWN_MINUTES;
	return out;
}

/**
 * Turn a probe run into the (status, signature) pair the edge detector
 * compares. `status` is what the member reads; `signature` is what the adapter
 * diffs — two runs with the same signature are the same observation and never
 * wake anyone twice.
 */
function classify(watch, run) {
	if (run.error) return { status: 'error', signature: 'error' };
	switch (watch.fires) {
		case 'exitCode': {
			const hit = run.exitCode === watch.exitCode;
			return { status: hit ? 'hit' : 'clear', signature: hit ? 'hit' : 'clear' };
		}
		case 'outputChanged':
			return { status: 'changed', signature: `out:${sha1(run.stdout)}` };
		default: {
			const hit = run.stdout.trim().length > 0;
			return { status: hit ? 'hit' : 'clear', signature: hit ? 'hit' : 'clear' };
		}
	}
}

export class FileWatchesAdapter {
	/**
	 * @param {string} teamDir
	 * @param {string} repoRoot — probes with a relative `cwd` run under this
	 * @param {Object} [probes] — the `probes` section of teamos.config.json
	 */
	constructor(teamDir, repoRoot, probes) {
		this.teamDir = teamDir;
		this.repoRoot = repoRoot;
		this.probes = normalizeProbes(probes);
		// Per-member throttle so a short pass (or a 30s idle tick) doesn't run
		// every member's probes over and over.
		this._lastPollAt = new Map(); // member → epoch ms
	}

	_path(member) {
		return join(this.teamDir, 'members', member, 'watched.json');
	}

	_probe(name, toolName) {
		const probe = this.probes.get(name);
		if (!probe) {
			const known = [...this.probes.keys()];
			throw new Error(
				`${toolName}: unknown probe "${name}"` +
					(known.length ? ` (registered: ${known.join(', ')})` : ' (no probes are registered in teamos.config.json)'),
			);
		}
		return probe;
	}

	async _readRaw(member) {
		try {
			const raw = await readFile(this._path(member), 'utf-8');
			const data = JSON.parse(raw);
			return {
				items: Array.isArray(data.items) ? data.items : [],
				observed: data.observed && typeof data.observed === 'object' ? data.observed : {},
			};
		} catch {
			return { items: [], observed: {} };
		}
	}

	async _writeRaw(member, state) {
		const path = this._path(member);
		await mkdir(dirname(path), { recursive: true });
		const body = { items: state.items ?? [], observed: state.observed ?? {} };
		await writeFile(path, `${JSON.stringify(body, null, '\t')}\n`, 'utf-8');
	}

	async _loadNormalized(member) {
		const raw = await this._readRaw(member);
		let mutated = false;
		const items = [];
		for (const entry of raw.items) {
			const n = normalizeWatch(entry);
			if (!n) {
				mutated = true;
				continue;
			}
			if (n !== entry) mutated = true;
			items.push(n);
		}
		// Drop observation state for watches that no longer exist.
		const observed = {};
		for (const item of items) {
			if (raw.observed[item.id]) observed[item.id] = raw.observed[item.id];
		}
		if (Object.keys(observed).length !== Object.keys(raw.observed).length) mutated = true;
		const state = { items, observed };
		if (mutated) await this._writeRaw(member, state);
		return state;
	}

	async listWatches(member) {
		const { items } = await this._loadNormalized(member);
		return items;
	}

	async addWatch(member, input) {
		if (!input || typeof input !== 'object') throw new Error('add_watch: input required');
		if (typeof input.probe !== 'string' || !input.probe) throw new Error('add_watch: probe is required');
		if (!isValidPriority(input.priority)) {
			throw new Error(`add_watch: priority must be one of ${PRIORITY_ORDER.join(', ')}`);
		}
		const probe = this._probe(input.probe, 'add_watch');
		const params = validateParams(probe, input.params, 'add_watch');
		if (input.fires !== undefined && !FIRES_MODES.includes(input.fires)) {
			throw new Error(`add_watch: fires must be one of ${FIRES_MODES.join(', ')}`);
		}
		if (input.fires === 'exitCode' && input.exitCode !== undefined && !Number.isInteger(input.exitCode)) {
			throw new Error('add_watch: exitCode must be an integer');
		}
		if (input.cooldownMinutes !== undefined) {
			const cooldown = input.cooldownMinutes;
			if (typeof cooldown !== 'number' || !Number.isFinite(cooldown) || cooldown < 0) {
				throw new Error('add_watch: cooldownMinutes must be a non-negative number');
			}
		}
		const state = await this._loadNormalized(member);
		const watch = normalizeWatch({
			...input,
			params: Object.keys(params).length ? params : undefined,
			id: makeWatchId(),
		});
		if (!watch) throw new Error('add_watch: invalid watch');
		state.items.push(watch);
		await this._writeRaw(member, state);
		this._lastPollAt.delete(member);
		return { id: watch.id };
	}

	async removeWatch(member, id) {
		if (!id) throw new Error('remove_watch: id is required');
		const state = await this._loadNormalized(member);
		const idx = state.items.findIndex((w) => w.id === id);
		if (idx === -1) throw new Error(`remove_watch: ${id} is not in ${member}'s watches`);
		state.items.splice(idx, 1);
		delete state.observed[id];
		await this._writeRaw(member, state);
		this._lastPollAt.delete(member);
	}

	/** Every probe the host has registered — for `list_probes` and the docs. */
	listProbes() {
		return [...this.probes.values()].map((p) => ({
			name: p.name,
			description: p.description,
			params: p.params,
			timeoutMs: p.timeoutMs,
		}));
	}

	/**
	 * Run every watch's probe and record the latest observation. The
	 * acknowledged signature is NOT touched — `acknowledgeObservations` does
	 * that after a successful cycle.
	 *
	 * The first observation for a watch becomes its baseline silently: adding a
	 * watch to an already-down runner should not backfill a wake for a state
	 * that was true before anyone subscribed.
	 *
	 * Throttled to one run per member per MIN_POLL_INTERVAL_MS, and safe to
	 * call from the idle loop.
	 */
	async poll(member, now = new Date()) {
		const last = this._lastPollAt.get(member) ?? 0;
		if (now.getTime() - last < MIN_POLL_INTERVAL_MS) return;
		const state = await this._loadNormalized(member);
		if (state.items.length === 0) {
			this._lastPollAt.set(member, now.getTime());
			return;
		}
		this._lastPollAt.set(member, now.getTime());

		// Probes run concurrently — each has its own kill timeout, so one that
		// hangs costs its timeout, not the loop.
		const runs = await Promise.all(state.items.map((watch) => this._runProbe(watch)));

		for (let i = 0; i < state.items.length; i++) {
			const watch = state.items[i];
			const run = runs[i];
			const { status, signature } = classify(watch, run);
			const latest = {
				status,
				signature,
				observedAt: now.toISOString(),
				exitCode: run.exitCode,
				output: clip(run.stdout || run.stderr),
			};
			if (run.error) latest.error = run.error;
			const prior = state.observed[watch.id];
			if (!prior) {
				// Baseline — acknowledged immediately, nothing fires.
				state.observed[watch.id] = { signature, status, since: latest.observedAt, latest };
				continue;
			}
			state.observed[watch.id] = { ...prior, latest };
		}
		await this._writeRaw(member, state);
	}

	/**
	 * Watches whose latest observation differs from the acknowledged one and
	 * whose cooldown has elapsed. Reads state only — call `poll` to refresh it.
	 *
	 * A watch that flaps A → B → A inside its cooldown produces nothing: by the
	 * time the cooldown expires the live signature matches the acknowledged one
	 * again, so there is no transition left to report.
	 */
	async pendingObservations(member, now = new Date()) {
		const state = await this._loadNormalized(member);
		const out = [];
		for (const watch of state.items) {
			const obs = state.observed[watch.id];
			if (!obs?.latest) continue;
			if (obs.latest.signature === obs.signature) continue;
			if (watch.cooldownMinutes > 0 && obs.lastFiredAt) {
				const elapsed = now.getTime() - Date.parse(obs.lastFiredAt);
				if (Number.isFinite(elapsed) && elapsed < watch.cooldownMinutes * 60 * 1000) continue;
			}
			out.push({
				watchId: watch.id,
				probe: watch.probe,
				priority: watch.priority,
				reason: watch.reason,
				fires: watch.fires,
				status: obs.latest.status,
				previousStatus: obs.status ?? null,
				exitCode: obs.latest.exitCode,
				output: obs.latest.output,
				error: obs.latest.error,
				observedAt: obs.latest.observedAt,
				since: obs.since ?? null,
			});
		}
		return out;
	}

	async hasPendingObservations(member, priority) {
		const ceiling = PRIORITY_ORDER.indexOf(priority);
		if (ceiling < 0) return false;
		const pending = await this.pendingObservations(member);
		return pending.some((p) => PRIORITY_ORDER.indexOf(p.priority) <= ceiling);
	}

	/**
	 * Advance the acknowledged signature for everything the member just saw.
	 * Called only after a cycle exits 0 — a failed cycle leaves the transition
	 * pending so it fires again next pass.
	 */
	async acknowledgeObservations(member, now = new Date()) {
		const state = await this._loadNormalized(member);
		const pending = await this.pendingObservations(member, now);
		if (pending.length === 0) return;
		const pendingIds = new Set(pending.map((p) => p.watchId));
		for (const watch of state.items) {
			if (!pendingIds.has(watch.id)) continue;
			const obs = state.observed[watch.id];
			if (!obs?.latest) continue;
			state.observed[watch.id] = {
				signature: obs.latest.signature,
				status: obs.latest.status,
				since: obs.latest.observedAt,
				lastFiredAt: now.toISOString(),
				latest: obs.latest,
			};
		}
		await this._writeRaw(member, state);
	}

	/**
	 * Execute one watch's probe. Never throws: a probe that cannot be executed
	 * at all (missing binary, bad cwd, timeout) comes back with `error` set,
	 * which classifies distinctly from a probe that ran and reported nothing.
	 */
	async _runProbe(watch) {
		let probe;
		let params;
		try {
			probe = this._probe(watch.probe, 'watch');
			// `add_watch` validates too, but members can reach watched.json with a plain
			// editor, and this is the only check standing between a hand-edited params
			// block and the probe's argv. Re-check here so the file, not just the tool,
			// is the thing that has to be safe.
			params = validateParams(probe, watch.params, 'watch');
		} catch (err) {
			return { stdout: '', stderr: '', exitCode: null, error: err.message };
		}
		const cwd = probe.cwd ? (isAbsolute(probe.cwd) ? probe.cwd : join(this.repoRoot, probe.cwd)) : this.repoRoot;
		try {
			const { stdout, stderr } = await execFileAsync(probe.command, renderArgs(probe, params), {
				cwd,
				timeout: probe.timeoutMs,
				killSignal: 'SIGKILL',
				maxBuffer: 1024 * 1024,
			});
			return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, error: null };
		} catch (err) {
			// A non-zero exit is a result, not a failure — execFile rejects on it.
			if (typeof err.code === 'number') {
				return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code, error: null };
			}
			const reason = err.killed ? `timed out after ${probe.timeoutMs}ms` : err.message;
			return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: null, error: reason };
		}
	}
}
