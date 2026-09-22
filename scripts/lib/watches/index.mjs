/**
 * @typedef {Object} Probe
 * @property {string} name
 * @property {string} command            — executable, run without a shell
 * @property {string[]} args             — argv, with `{{param}}` placeholders
 * @property {string[]} params           — parameter names a watch may supply
 * @property {number} timeoutMs          — kill the probe after this long
 * @property {string} [cwd]              — working directory (relative to the repo root)
 * @property {string} [description]
 */

/**
 * @typedef {Object} Watch
 * @property {string} id
 * @property {string} probe              — name of a probe registered in teamos.config.json
 * @property {'pressing'|'today'|'thisWeek'|'later'} priority
 * @property {'nonEmptyOutput'|'exitCode'|'outputChanged'} fires — hit semantics
 * @property {number} [exitCode]         — the exit code that counts as a hit (`fires: 'exitCode'`)
 * @property {Object<string,string>} [params] — probe parameters
 * @property {string} [reason]
 * @property {number} cooldownMinutes    — minimum re-arm interval between wakes
 */

/**
 * @typedef {Object} WatchObservation
 * @property {string} watchId
 * @property {string} probe
 * @property {'pressing'|'today'|'thisWeek'|'later'} priority
 * @property {string} [reason]
 * @property {'nonEmptyOutput'|'exitCode'|'outputChanged'} fires
 * @property {'hit'|'clear'|'changed'|'error'} status
 * @property {string|null} previousStatus — the status the member was last woken with
 * @property {number|null} exitCode
 * @property {string} output             — stdout (or stderr when stdout was empty), clipped
 * @property {string} [error]            — set when the probe could not be executed at all
 * @property {string} observedAt
 * @property {string|null} since         — when the acknowledged state was first observed
 */

/**
 * @typedef {Object} WatchesAdapter
 * @property {(member: string) => Promise<Watch[]>} listWatches
 * @property {(member: string, input: Omit<Watch, 'id'>) => Promise<{ id: string }>} addWatch
 * @property {(member: string, id: string) => Promise<void>} removeWatch
 * @property {() => Probe[]} listProbes
 * @property {(member: string, now?: Date) => Promise<void>} poll
 * @property {(member: string, now?: Date) => Promise<WatchObservation[]>} pendingObservations
 * @property {(member: string, priority: string) => Promise<boolean>} hasPendingObservations
 * @property {(member: string, now?: Date) => Promise<void>} acknowledgeObservations
 */

import { FileWatchesAdapter } from './file.mjs';

/**
 * Create a watches adapter based on configuration.
 *
 * Currently only the file adapter ships; see teamos/docs/watches.md for the
 * MCP contract future adapters would implement. The probe registry lives in
 * the `probes` section of teamos.config.json and is host-owned — agents never
 * define probes, only subscribe to them.
 */
export async function createWatchesAdapter(adapterName, config, teamDir, repoRoot) {
	switch (adapterName) {
		case 'file':
			return new FileWatchesAdapter(teamDir, repoRoot, config?.probes);
		default:
			throw new Error(`Unknown watches adapter: ${adapterName}. Available: file`);
	}
}
