/**
 * @typedef {Object} ScheduleEvent
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string} time
 * @property {{ frequency: 'daily'|'weekly'|'monthly', interval: number, endDate?: string }} [recurrence]
 * @property {string} [projectCode]
 * @property {boolean} [isDue]
 */

/**
 * @typedef {Object} ScheduleAdapter
 * @property {(member: string) => Promise<ScheduleEvent[]>} listEvents
 * @property {(member: string, input: { title: string, time: string, description?: string, recurrence?: { frequency: string, interval: number, endDate?: string }, projectCode?: string }) => Promise<{ id: string }>} addEvent
 * @property {(member: string, id: string, patch: { title?: string, description?: string, time?: string, recurrence?: Object | null, projectCode?: string }) => Promise<void>} updateEvent
 * @property {(member: string, id: string) => Promise<void>} removeEvent
 * @property {(member: string, now: Date) => Promise<boolean>} hasDueEvents
 * @property {(member: string, cycleStartTime: Date) => Promise<void>} acknowledgeDue
 * @property {(member: string, title: string) => Promise<boolean>} hasEventWithTitle
 */

import { FileScheduleAdapter } from './file.mjs';

/**
 * Create a schedule adapter based on configuration.
 *
 * Currently only the file adapter ships; see teamos/docs/schedule.md for the
 * MCP contract a future Google Calendar / CalDAV adapter would implement.
 */
export async function createScheduleAdapter(adapterName, _config, teamDir) {
	switch (adapterName) {
		case 'file':
			return new FileScheduleAdapter(teamDir);
		default:
			throw new Error(`Unknown schedule adapter: ${adapterName}. Available: file`);
	}
}
