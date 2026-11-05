// @ts-check
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { gitOrNull } from './git.mjs';
import { readJsonFile } from './jsonc.mjs';

/**
 * @param {string} repo
 * @param {string} target
 * @returns {string | null} The file's text, or `null` when it is missing or not a regular file.
 */
export function readText(repo, target) {
	const file = path.join(repo, target);

	if (!existsSync(file) || !lstatSync(file).isFile()) return null;

	return readFileSync(file, 'utf8');
}

/**
 * @param {string} repo
 * @param {string} target
 * @returns {boolean} Whether something other than a regular file is in the way.
 */
export function isOccupied(repo, target) {
	const file = path.join(repo, target);

	return existsSync(file) && !lstatSync(file).isFile();
}

/**
 * Writes a file at a repo-relative path, creating its folders.
 * @param {string} repo
 * @param {string} target
 * @param {string} text
 * @returns {void}
 */
export function writeText(repo, target, text) {
	const file = path.join(repo, target);

	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/**
 * Removes the file, then each parent folder it leaves empty.
 * @param {string} repo
 * @param {string} target
 * @returns {void}
 */
export function removeFile(repo, target) {
	rmSync(path.join(repo, target), { force: true });

	for (let dir = path.dirname(target); dir !== '.'; dir = path.dirname(dir)) {
		const folder = path.join(repo, dir);

		if (!existsSync(folder) || readdirSync(folder).length > 0) return;

		rmdirSync(folder);
	}
}

/**
 * Removes `target` if it is a symlink, and leaves anything else alone.
 * @param {string} repo
 * @param {string} target
 * @returns {void}
 */
export function removeLink(repo, target) {
	if (isSymlink(repo, target)) rmSync(path.join(repo, target));
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function realpathOrNull(file) {
	try {
		return realpathSync(file);
	} catch {
		return null;
	}
}

/**
 * @param {string} repo
 * @param {string} target
 * @returns {boolean} Whether anything, including a dangling symlink, exists at `target`.
 */
export function pathTaken(repo, target) {
	try {
		lstatSync(path.join(repo, target));

		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} repo
 * @param {string} alternative A path, or `file#key` for a top-level key in a JSON file.
 * @returns {boolean} Whether the repo has that other config.
 */
export function alternativeTaken(repo, alternative) {
	const [file = '', key] = alternative.split('#');

	if (key === undefined) return pathTaken(repo, file);

	const json = readJsonFile(path.join(repo, file));

	return (json.status === 'json' || json.status === 'jsonc') && json.value[key] !== undefined;
}

/**
 * Whether `target` reaches the same directory as the symlink `to` would. True as well when a parent
 * directory is itself a link, such as `.claude/skills` pointing at `.agents/skills`.
 * @param {string} repo
 * @param {{ target: string, to: string }} link
 * @returns {boolean}
 */
export function linkResolves(repo, link) {
	const actual = realpathOrNull(path.join(repo, link.target));
	const expected = realpathOrNull(path.join(repo, path.dirname(link.target), link.to));

	return actual !== null && actual === expected;
}

/**
 * Whether `target` is a symlink, broken or not.
 * @param {string} repo
 * @param {string} target
 * @returns {boolean}
 */
export function isSymlink(repo, target) {
	return pathTaken(repo, target) && lstatSync(path.join(repo, target)).isSymbolicLink();
}

/**
 * Creates the relative symlink, replacing a symlink already at `target`.
 * @param {string} repo
 * @param {{ target: string, to: string }} link
 * @returns {void}
 */
export function createLink(repo, link) {
	const file = path.join(repo, link.target);

	mkdirSync(path.dirname(file), { recursive: true });

	if (isSymlink(repo, link.target)) rmSync(file);

	symlinkSync(link.to, file, 'dir');
}

/**
 * @param {string} dir
 * @returns {string} `dir` with every symlink resolved, including in a missing tail.
 */
function realDir(dir) {
	if (existsSync(dir)) return realpathSync(dir);

	return path.join(realDir(path.dirname(dir)), path.basename(dir));
}

/**
 * @param {string} repo
 * @param {readonly string[]} targets
 * @returns {string[] | Error} Targets with uncommitted changes, or why git can't tell: the repo
 * isn't a git work tree, or a target sits under a symlink that leads out of it.
 */
export function dirtyPaths(repo, targets) {
	if (gitOrNull(repo, ['rev-parse', '--is-inside-work-tree']) === null) {
		return new Error(`${repo} isn't a git work tree`);
	}

	const root = realpathSync(repo);
	/** @type {Map<string, string>} Each target by the path git tracks it under. */
	const targetsByPath = new Map();

	for (const target of targets) {
		const file = path.join(repo, target);
		const resolved = path.join(realDir(path.dirname(file)), path.basename(file));
		const real = path.relative(root, resolved);

		if (real.split(path.sep)[0] === '..' || path.isAbsolute(real)) {
			return new Error(`${target} leads out of the repo`);
		}

		targetsByPath.set(real.split(path.sep).join('/'), target);
	}

	const out = gitOrNull(repo, [
		'status',
		'--porcelain',
		'-z',
		'--untracked-files=all',
		'--',
		...targetsByPath.keys()
	]);

	if (out === null) return new Error('git status failed');

	const fields = out.split('\0');
	const paths = [];

	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index] ?? '';

		if (field.length <= 3) continue;

		paths.push(field.slice(3));

		// A rename or copy is followed by its original path, in a field of its own.
		if (/[RC]/.test(field.slice(0, 2))) {
			index += 1;
			paths.push(fields[index] ?? '');
		}
	}

	return paths.flatMap((found) => (found ? [targetsByPath.get(found) ?? found] : []));
}
