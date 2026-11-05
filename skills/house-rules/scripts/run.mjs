#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Bootstrap for the house-rules engine. It clones house-rules (a URL or a local checkout) at the ref
 * the repo's lockfile names, or `--ref`, else `main`, and runs that clone's `scripts/house-rules.mjs`
 * on the clone's own payload. Arguments pass through, with two changes: `--source` is dropped, since
 * the engine reads the source from the clone's origin, and `--repo <work tree root>` is added when
 * absent, since the engine runs from the clone.
 */

const DEFAULT_URL = 'https://github.com/f-elix/house-rules.git';

const DEFAULT_REF = 'main';

const ENGINE = path.join('scripts', 'house-rules.mjs');

/**
 * Runs git with its output captured, so the bootstrap's own error line comes first.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function git(cwd, args) {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		stdio: ['ignore', 'pipe', 'pipe']
	});

	return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined} The value of the last `--name value` or `--name=value`, the one
 * the engine's argument parser keeps.
 */
function option(args, name) {
	const flag = `--${name}`;
	const index = args.findLastIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
	const arg = args[index];

	if (arg === undefined) return undefined;

	return arg === flag ? args[index + 1] : arg.slice(flag.length + 1);
}

/**
 * Reads `source.url` and `source.ref`, which keep their names and meaning in every lockfile version.
 * @param {string} repo
 * @returns {{ url: string, ref: string } | null | Error} The source the lockfile records, `null`
 * when the repo has no lockfile, or an error when the lockfile doesn't record a source.
 */
function lockedSource(repo) {
	const file = path.join(repo, 'house-rules.lock.json');

	if (!existsSync(file)) return null;

	try {
		const { source } = JSON.parse(readFileSync(file, 'utf8')) ?? {};
		const url = source?.url;
		const ref = source?.ref;

		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the bootstrap parses the lockfile here, before any engine runs
		if (typeof url === 'string' && typeof ref === 'string') return { url, ref };

		return new Error('house-rules.lock.json has no source.url and source.ref');
	} catch (error) {
		return new Error(
			`house-rules.lock.json: ${error instanceof Error ? error.message : error}`
		);
	}
}

/**
 * Clones `url` and checks out `ref`, which may be a branch, tag or commit. A remote clone skips
 * blobs until a file is read; a local one shares objects with the checkout instead.
 * @param {string} url
 * @param {string} ref
 * @param {string} dir
 * @returns {string | null} `null` once `ref` is checked out, or git's error output.
 */
function fetchEngine(url, ref, dir) {
	const filter = existsSync(url) ? [] : ['--filter=blob:none'];
	const clone = git(tmpdir(), ['clone', '--quiet', ...filter, '--no-checkout', url, dir]);

	if (clone.status !== 0) return clone.stderr;

	const checkout = git(dir, ['checkout', '--quiet', ref]);

	if (checkout.status === 0) return null;

	const detached = git(dir, ['checkout', '--quiet', '--detach', `origin/${ref}`]);

	return detached.status === 0 ? null : checkout.stderr;
}

/**
 * @param {string} engineRepo
 * @param {string[]} args
 * @returns {number}
 */
function runEngine(engineRepo, args) {
	const result = spawnSync(process.execPath, [path.join(engineRepo, ENGINE), ...args], {
		stdio: 'inherit'
	});

	return result.status ?? 1;
}

/**
 * @param {string} dir
 * @returns {string} The root of the git work tree containing `dir`, or `dir` outside git.
 */
function localRoot(dir) {
	const root = git(dir, ['rev-parse', '--show-toplevel']);

	return root.status === 0 ? root.stdout.trim() : dir;
}

/**
 * @param {string[]} args
 * @returns {number}
 */
function main(args) {
	const repo = localRoot(path.resolve(option(args, 'repo') ?? process.cwd()));
	const locked = lockedSource(repo);

	if (locked instanceof Error) {
		process.stderr.write(`house-rules: ${locked.message}\n`);

		return 1;
	}

	const spec = option(args, 'source') ?? locked?.url ?? DEFAULT_URL;
	const ref = option(args, 'ref') ?? locked?.ref ?? DEFAULT_REF;
	const passed = option(args, 'repo') === undefined ? [...args, '--repo', repo] : args;
	const url = existsSync(spec) ? localRoot(path.resolve(spec)) : spec;
	const temp = mkdtempSync(path.join(tmpdir(), 'house-rules-'));
	const dir = path.join(temp, 'house-rules');

	try {
		const failure = fetchEngine(url, ref, dir);

		if (failure !== null) {
			process.stderr.write(`house-rules: couldn't fetch ${ref} from ${url}\n${failure}`);

			return 1;
		}

		const withoutSource = passed.filter(
			(arg, index) =>
				!(
					arg === '--source' ||
					arg.startsWith('--source=') ||
					passed[index - 1] === '--source'
				)
		);

		return runEngine(dir, withoutSource);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

process.exitCode = main(process.argv.slice(2));
