// @ts-check
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitError, runGit } from './git.mjs';

/**
 * Three-way merges text with `git merge-file`, in diff3 style so a conflict shows the base too.
 * @param {string} local
 * @param {string} base
 * @param {string} incoming
 * @returns {{ text: string, conflicts: number }}
 * @throws {GitError} When `git merge-file` fails.
 */
export function mergeText(local, base, incoming) {
	const dir = mkdtempSync(path.join(tmpdir(), 'house-rules-merge-'));

	try {
		writeFileSync(path.join(dir, 'local'), local);
		writeFileSync(path.join(dir, 'base'), base);
		writeFileSync(path.join(dir, 'incoming'), incoming);

		const result = runGit(dir, [
			'merge-file',
			'-p',
			'--diff3',
			'-L',
			'local',
			'-L',
			'base',
			'-L',
			'incoming',
			'local',
			'base',
			'incoming'
		]);

		// merge-file exits with the number of conflicts, capped at 127, and with a negative
		// status, read as 128 or more, when it fails.
		if (result.status > 127)
			throw new GitError(`git merge-file failed: ${result.stderr.trim()}`);

		return { text: result.stdout, conflicts: result.status };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
