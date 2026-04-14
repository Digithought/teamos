import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teamosApi } from './src/server/api-plugin.js';

const here = dirname(fileURLToPath(import.meta.url));
const teamosRoot = resolve(here, '..');
const projectRoot = process.env.TEAMOS_PROJECT_ROOT || resolve(here, '../..');
const teamDir = resolve(projectRoot, 'team');

export default defineConfig(async () => {
	const { loadConfig, resolveEnvVars, loadDotEnv } = await import(
		pathToFileURL(resolve(teamosRoot, 'scripts/lib/config.mjs')).href
	);
	const { createMessagingAdapter } = await import(
		pathToFileURL(resolve(teamosRoot, 'scripts/lib/messaging/index.mjs')).href
	);
	const { createScheduleAdapter } = await import(
		pathToFileURL(resolve(teamosRoot, 'scripts/lib/schedule/index.mjs')).href
	);

	loadDotEnv(projectRoot);
	const config = resolveEnvVars(await loadConfig(projectRoot));
	const adapterName: string = config.messaging?.adapter || 'file';
	const scheduleAdapterName: string = config.schedule?.adapter || 'file';
	const messagingAdapter = await createMessagingAdapter(adapterName, config, teamDir);
	const scheduleAdapter = await createScheduleAdapter(scheduleAdapterName, config, teamDir);

	return {
		plugins: [
			svelte(),
			teamosApi({
				teamDir,
				ticketsDir: resolve(projectRoot, 'tickets'),
				siblingDir: resolve(projectRoot, 'tess'),
				messagingAdapter,
				messagingAdapterName: adapterName,
				scheduleAdapter,
				scheduleAdapterName,
			}),
		],
		server: {
			port: 3003,
		},
	};
});
