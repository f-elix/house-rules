// @ts-check
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, GitError, gitOrNull, runGit } from './git.mjs';

/** The house-rules checkout this engine runs from. */
const ENGINE_REPO = path.resolve(import.meta.dirname, '../..');

/**
 * A local git repository holding the house-rules payload: the engine's own checkout, a local path,
 * or a temporary clone of a URL.
 * @typedef {object} Source
 * @property {string} dir
 * @property {string} url Recorded in the lockfile: the clone URL, or the absolute path of a local repo.
 * The engine's own checkout records its origin URL, see {@link useFetchableUrl}.
 * @property {string | null} temp Directory to remove when the command ends.
 * @property {Map<string, string | null>} cache Blob contents by `commit:path`.
 */

/**
 * Whether a `--source` value names something that exists on this machine; anything else is a URL.
 * @param {string} spec
 * @returns {boolean}
 */
function isLocalPath(spec) {
	return existsSync(path.resolve(spec));
}

/**
 * Opens the payload repository. A URL is cloned into a temporary directory, without blobs: `git`
 * fetches each file the first time a command reads it.
 * @param {string | undefined} spec `--source`: a local path or a git URL. Defaults to the engine's checkout.
 * @returns {Source}
 */
export function openSource(spec) {
	if (spec === undefined) {
		const origin = gitOrNull(ENGINE_REPO, ['config', '--get', 'remote.origin.url'])?.trim();

		return { dir: ENGINE_REPO, url: origin || ENGINE_REPO, temp: null, cache: new Map() };
	}

	if (isLocalPath(spec)) {
		const dir = git(path.resolve(spec), ['rev-parse', '--show-toplevel']).trim();

		return { dir, url: dir, temp: null, cache: new Map() };
	}

	const temp = mkdtempSync(path.join(tmpdir(), 'house-rules-'));
	const dir = path.join(temp, 'source');

	try {
		git(temp, ['clone', '--quiet', '--filter=blob:none', '--no-checkout', spec, dir]);
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		throw error;
	}

	return { dir, url: spec, temp, cache: new Map() };
}

/**
 * Records the engine checkout's path instead of its origin URL when `commit` is on none of the
 * origin's branches and tags, since nobody could fetch it from that URL. The local path then gets
 * the usual warning.
 * @param {Source} source Mutated.
 * @param {string} commit
 * @returns {void}
 */
export function useFetchableUrl(source, commit) {
	const isEngineCheckout = source.temp === null && source.url !== source.dir;

	if (!isEngineCheckout) return;

	const containing = gitOrNull(source.dir, [
		'for-each-ref',
		'--count=1',
		'--format=%(refname)',
		'--contains',
		commit,
		'refs/remotes/origin/',
		'refs/tags/'
	]);

	if (!containing?.trim()) source.url = source.dir;
}

/**
 * Removes the temporary clone of a URL source; leaves a local checkout alone.
 * @param {Source} source
 * @returns {void}
 */
export function closeSource(source) {
	if (source.temp) rmSync(source.temp, { recursive: true, force: true });
}

/**
 * Resolves a branch, tag or commit to a commit SHA, trying the remote-tracking branch when the local
 * name doesn't exist.
 * @param {Source} source
 * @param {string} ref
 * @returns {string | null}
 */
export function resolveCommit(source, ref) {
	for (const candidate of [ref, `origin/${ref}`]) {
		const sha = gitOrNull(source.dir, [
			'rev-parse',
			'--verify',
			'--quiet',
			`${candidate}^{commit}`
		]);

		if (sha) return sha.trim();
	}

	return null;
}

/**
 * Whether the source has `commit`.
 * @param {Source} source
 * @param {string} commit
 * @returns {boolean}
 */
export function hasCommit(source, commit) {
	return gitOrNull(source.dir, ['cat-file', '-e', `${commit}^{commit}`]) !== null;
}

/**
 * @param {Source} source
 * @param {string} commit
 * @param {string} filePath
 * @returns {string | null} The file's text at `commit`, or `null` when the commit or the file
 * doesn't exist.
 * @throws {GitError} When the file exists but git can't read it, for example when a partial clone
 * can't fetch it.
 */
export function readAt(source, commit, filePath) {
	const key = `${commit}:${filePath}`;
	const cached = source.cache.get(key);

	if (cached !== undefined) return cached;

	const result = runGit(source.dir, ['cat-file', 'blob', key]);

	if (
		result.status !== 0 &&
		hasCommit(source, commit) &&
		listFiles(source, commit, filePath).length > 0
	) {
		throw new GitError(`git cat-file blob ${key} failed: ${result.stderr.trim()}`);
	}

	const content = result.status === 0 ? result.stdout : null;

	source.cache.set(key, content);

	return content;
}

/**
 * @param {Source} source
 * @param {string} commit
 * @param {string} payloadPath A file or a directory.
 * @returns {string[]} Every file at or under `payloadPath`.
 */
export function listFiles(source, commit, payloadPath) {
	const out = git(source.dir, ['ls-tree', '-r', '--name-only', '-z', commit, '--', payloadPath]);

	return out.split('\0').filter((line) => line !== '');
}

/**
 * @typedef {object} PathChange One `--name-status` line.
 * @property {string} status Its letter: `R` rename, `C` copy, `D` delete, `A`, `M` or `T`.
 * @property {string} path The changed path, or the old path of a rename or copy.
 * @property {string | undefined} to The new path of a rename or copy.
 */

/**
 * @param {string} out `--name-status -z` output of `git diff` or `git log`.
 * @returns {PathChange[]} In output order.
 */
function parseNameStatus(out) {
	const fields = out.split('\0');
	/** @type {PathChange[]} */
	const changes = [];

	for (let index = 0; index < fields.length; index++) {
		const status = (fields[index] ?? '').trim().charAt(0);

		if (status === '') continue;

		const twoPaths = status === 'R' || status === 'C';

		changes.push({
			status,
			path: fields[index + 1] ?? '',
			to: twoPaths ? (fields[index + 2] ?? '') : undefined
		});
		index += twoPaths ? 2 : 1;
	}

	return changes;
}

/**
 * Finds the files renamed between two commits. Renames also chain through the commits in between,
 * so a file moved in one commit and rewritten in a later one still counts as moved. A chain ends
 * where a commit deletes the file, and a path a rename already claims isn't claimed twice.
 * @param {Source} source
 * @param {string} from
 * @param {string} to
 * @returns {Map<string, string>} New path by old path.
 */
export function findRenames(source, from, to) {
	const renames = new Map();

	for (const change of parseNameStatus(
		git(source.dir, ['diff', '--name-status', '-M', '-z', from, to])
	)) {
		if (change.status === 'R' && change.to !== undefined) renames.set(change.path, change.to);
	}

	const steps = parseNameStatus(
		git(source.dir, [
			'log',
			'--reverse',
			'--format=',
			'--name-status',
			'-M',
			'-z',
			`${from}..${to}`
		])
	);

	/** @type {Map<string, string | null>} Where each path at `from` is so far; `null` once deleted. */
	const chained = new Map();

	/** @param {string} current */
	const originsAt = (current) =>
		[...chained].flatMap(([origin, at]) => (at === current ? [origin] : []));

	for (const { status, path: changed, to: renamedTo } of steps) {
		if (status !== 'R' && status !== 'D') continue;

		const next = status === 'R' ? (renamedTo ?? null) : null;
		const origins = originsAt(changed);

		for (const origin of origins) chained.set(origin, next);

		if (origins.length === 0 && !chained.has(changed)) chained.set(changed, next);
	}

	const claimed = new Set(renames.values());

	for (const [origin, current] of chained) {
		if (current === null || origin === current || renames.has(origin) || claimed.has(current))
			continue;

		renames.set(origin, current);
		claimed.add(current);
	}

	return renames;
}

/**
 * @param {Source} source
 * @param {string} from
 * @param {string} to
 * @returns {number | null} Commits in `to` that `from` lacks, or `null` when `from` isn't an ancestor.
 */
export function commitsBehind(source, from, to) {
	const ancestor = runGit(source.dir, ['merge-base', '--is-ancestor', from, to]);

	if (ancestor.status !== 0) return null;

	return Number(git(source.dir, ['rev-list', '--count', `${from}..${to}`]).trim());
}
