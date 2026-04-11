import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from './util.mjs';

/**
 * Load teamos.config.json from the project root or team/ directory.
 * Returns the parsed config, or defaults if no config file exists.
 */
export async function loadConfig(repoRoot) {
	const candidates = [
		join(repoRoot, 'teamos.config.json'),
		join(repoRoot, 'team', 'teamos.config.json'),
	];

	for (const configPath of candidates) {
		if (await pathExists(configPath)) {
			try {
				const raw = await readFile(configPath, 'utf-8');
				const config = JSON.parse(raw);
				console.log(`[runner] Loaded config from ${configPath}`);
				return config;
			} catch (err) {
				console.error(`[runner] Failed to parse ${configPath}: ${err.message}`);
			}
		}
	}

	// Default config
	return {
		messaging: { adapter: 'file' },
		sync: { adapter: 'git' },
		agent: 'claude',
	};
}

/**
 * Resolve environment variable references in config values.
 * Values like "$DISCORD_BOT_TOKEN" are replaced with process.env.DISCORD_BOT_TOKEN.
 */
export function resolveEnvVars(obj) {
	if (typeof obj === 'string' && obj.startsWith('$')) {
		const envKey = obj.slice(1);
		return process.env[envKey] || obj;
	}
	if (typeof obj === 'object' && obj !== null) {
		const result = Array.isArray(obj) ? [] : {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = resolveEnvVars(value);
		}
		return result;
	}
	return obj;
}
