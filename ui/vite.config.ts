import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { teamosApi } from './src/server/api-plugin.js';

const projectRoot = process.env.TEAMOS_PROJECT_ROOT || resolve(process.cwd(), '../..');

export default defineConfig({
	plugins: [
		svelte(),
		teamosApi({
			teamDir: resolve(projectRoot, 'team'),
			ticketsDir: resolve(projectRoot, 'tickets'),
			siblingDir: resolve(projectRoot, 'tess'),
		}),
	],
	server: {
		port: 3003,
	},
});
