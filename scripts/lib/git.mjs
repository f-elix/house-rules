// @ts-check
import { spawnSync } from 'node:child_process';

/** Thrown when a git command exits with a status the caller didn't allow. */
export class GitError extends Error {}

/**
 * @typedef {object} GitResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Runs git without a shell and returns its output, whatever the exit status.
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input] Written to stdin.
 * @returns {GitResult}
 * @throws {GitError} When git can't start or is killed by a signal.
 */
export function runGit(cwd, args, input) {
	const result = spawnSync('git', args, {
		cwd,
		input,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
	});

	if (result.error) throw new GitError(`git ${args[0]}: ${result.error.message}`);

	if (result.status === null) throw new GitError(`git ${args[0]} was killed by ${result.signal}`);

	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs git and returns stdout.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 * @throws {GitError} When git exits with a non-zero status.
 */
export function git(cwd, args) {
	const result = runGit(cwd, args);

	if (result.status !== 0) {
		throw new GitError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
	}

	return result.stdout;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null} stdout, or `null` when git exits with a non-zero status.
 */
export function gitOrNull(cwd, args) {
	const result = runGit(cwd, args);

	return result.status === 0 ? result.stdout : null;
}
