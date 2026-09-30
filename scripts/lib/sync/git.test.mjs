import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSyncAdapter } from './git.mjs';

// All fixtures below reference a local filesystem path as a submodule URL,
// which git treats as the "file" transport and blocks by default (CVE-2022-39253).
// Everything here is throwaway temp-dir plumbing, so allow it for this process.
process.env.GIT_ALLOW_PROTOCOL = 'file';

function sh(cmd, cwd) {
	return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function initRepo(dir) {
	mkdirSync(dir, { recursive: true });
	sh('git init -q -b main', dir);
	sh('git config user.email test@example.com', dir);
	sh('git config user.name Test', dir);
}

function commitFile(dir, file, content, message) {
	writeFileSync(join(dir, file), content);
	sh(`git add ${file}`, dir);
	sh(`git commit -q -m "${message}"`, dir);
}

/**
 * A main repo carrying a submodule, its bare "origin" pair for both, and a
 * fresh clone (workDir) — a runner checkout right after the initial
 * `--recurse-submodules` clone, before any pin bump has landed.
 */
function buildFixture(root) {
	const subBare = join(root, 'sub-bare.git');
	sh(`git init -q --bare -b main ${subBare}`, root);

	const subSeed = join(root, 'sub-seed');
	initRepo(subSeed);
	commitFile(subSeed, 'file.txt', 'v1', 'seed v1');
	sh(`git push -q ${subBare} main:main`, subSeed);

	const mainBare = join(root, 'main-bare.git');
	sh(`git init -q --bare -b main ${mainBare}`, root);

	const mainSeed = join(root, 'main-seed');
	initRepo(mainSeed);
	commitFile(mainSeed, 'root.txt', 'root', 'seed root');
	sh(`git submodule add -q ${subBare} sub`, mainSeed);
	sh('git commit -q -m "add submodule"', mainSeed);
	sh(`git push -q ${mainBare} main:main`, mainSeed);

	const workDir = join(root, 'work');
	sh(`git clone -q --recurse-submodules ${mainBare} ${workDir}`, root);
	sh('git config user.email test@example.com', workDir);
	sh('git config user.name Test', workDir);

	return { subBare, mainBare, mainSeed, subSeed, workDir };
}

/** Simulates a "teamos pin bump" landing on origin: a new submodule commit, plus the superproject commit that points at it. */
function bumpSubmodulePin({ mainSeed, subSeed, subBare, mainBare }) {
	commitFile(subSeed, 'file.txt', 'v2', 'bump to v2');
	sh(`git push -q ${subBare} main:main`, subSeed);

	sh('git pull -q origin main', join(mainSeed, 'sub'));
	sh('git add sub', mainSeed);
	sh('git commit -q -m "bump submodule pin"', mainSeed);
	sh(`git push -q ${mainBare} main:main`, mainSeed);
}

function submoduleFileContent(workDir) {
	return readFileSync(join(workDir, 'sub', 'file.txt'), 'utf-8');
}

test('pull() updates the submodule checkout content on the fast-forward path', async () => {
	const root = mkdtempSync(join(tmpdir(), 'git-sync-'));
	const fixture = buildFixture(root);
	assert.equal(submoduleFileContent(fixture.workDir), 'v1');

	bumpSubmodulePin(fixture);

	await new GitSyncAdapter({}).pull(fixture.workDir);

	assert.equal(sh('git rev-parse HEAD', fixture.workDir), sh('git rev-parse main', fixture.mainBare));
	assert.equal(
		submoduleFileContent(fixture.workDir),
		'v2',
		'fast-forward pull left the physical submodule checkout on its old content'
	);
});

test('pull() updates the submodule checkout content on the rebase path', async () => {
	const root = mkdtempSync(join(tmpdir(), 'git-sync-'));
	const fixture = buildFixture(root);

	// Diverge: a local-only commit forces pull() onto the rebase branch
	// instead of the fast-forward one.
	commitFile(fixture.workDir, 'local.txt', 'local', 'local-only commit');

	bumpSubmodulePin(fixture);

	await new GitSyncAdapter({}).pull(fixture.workDir);

	assert.equal(
		sh('git rev-parse HEAD~1', fixture.workDir),
		sh('git rev-parse main', fixture.mainBare),
		'local commit should now sit rebased on top of origin/main'
	);
	assert.equal(
		submoduleFileContent(fixture.workDir),
		'v2',
		'rebase pull left the physical submodule checkout on its old content'
	);
});
