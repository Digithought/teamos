import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from './util.mjs';

/**
 * Load teamos.config.json from the project root or team/ directory.
 * Returns the parsed config, or defaults if no config file exists.
 */
export async function loadConfig(repoRoot) {
	const candidates = [join(repoRoot, 'teamos.config.json'), join(repoRoot, 'team', 'teamos.config.json')];

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
 * Load a .env file into process.env. Existing env vars are NOT overridden.
 * Supports # comments, KEY=VALUE, and quoted values ("val" or 'val').
 */
export function loadDotEnv(dir) {
	const candidates = [join(dir, '.env')];
	for (const filePath of candidates) {
		try {
			const content = readFileSync(filePath, 'utf-8');
			let loaded = 0;
			for (const line of content.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				const eqIdx = trimmed.indexOf('=');
				if (eqIdx <= 0) continue;
				const key = trimmed.slice(0, eqIdx).trim();
				const value = trimmed
					.slice(eqIdx + 1)
					.trim()
					.replace(/^["']|["']$/g, '');
				if (!(key in process.env)) {
					process.env[key] = value;
					loaded++;
				}
			}
			if (loaded > 0) console.log(`[runner] Loaded ${loaded} env var(s) from ${filePath}`);
			return;
		} catch {
			// No .env file — that's fine
		}
	}
}

/**
 * Resolve environment variable references in config values.
 * Values like "$FOO" are replaced with process.env.FOO.
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
