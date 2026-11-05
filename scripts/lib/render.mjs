// @ts-check
import { createHash } from 'node:crypto';
import path from 'node:path';

const TEMPLATE = /\{\{(path|rel):([^}\s]+)\}\}/g;

const CONFLICT_MARKER = /^(<{7}|\|{7}|>{7})( |$)/m;

/**
 * Moves a payload path into the consumer's layout. A map moves every path under its `from` prefix;
 * the longest matching prefix wins.
 * @param {Record<string, string>} maps `from` prefix to `to` prefix, both repo-relative.
 * @param {string} target
 * @returns {string}
 */
export function mapPath(maps, target) {
	let best = '';

	for (const from of Object.keys(maps)) {
		const matches = target === from || target.startsWith(`${from}/`);

		if (matches && from.length > best.length) best = from;
	}

	if (!best) return target;

	return `${maps[best] ?? best}${target.slice(best.length)}`;
}

/**
 * @param {string} target
 * @returns {boolean} Whether `target` is a relative path that stays inside the repo.
 */
export function isRepoPath(target) {
	const normalized = path.posix.normalize(target.replaceAll('\\', '/'));

	return (
		target !== '' &&
		!path.posix.isAbsolute(normalized) &&
		!path.win32.isAbsolute(target) &&
		normalized !== '..' &&
		!normalized.startsWith('../')
	);
}

/**
 * Fills the payload templates for a file written at `target`: `{{path:X}}` becomes X's mapped path,
 * `{{rel:X}}` the relative path from `target`'s folder to it.
 * @param {string} text
 * @param {Record<string, string>} maps
 * @param {string} target
 * @returns {string}
 */
export function render(text, maps, target) {
	return text.replace(TEMPLATE, (_match, kind, ref) => {
		const mapped = mapPath(maps, ref);

		if (kind === 'path') return mapped;

		const relative = path.posix.relative(path.posix.dirname(target), mapped);

		return relative.startsWith('..') ? relative : `./${relative}`;
	});
}

/**
 * @param {string} text Payload text, before rendering.
 * @returns {string[]} The default target of every path its templates name.
 */
export function templatePaths(text) {
	return [...text.matchAll(TEMPLATE)].map((match) => match[2] ?? '');
}

/**
 * The content hash the lockfile records.
 * @param {string} content
 * @returns {string}
 */
export function hash(content) {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Looks for the `<<<<<<<`, `|||||||` and `>>>>>>>` lines `git merge-file --diff3` writes. `=======` alone is a valid
 * setext heading underline, so it doesn't count.
 * @param {string} text
 * @returns {boolean}
 */
export function hasConflictMarkers(text) {
	return CONFLICT_MARKER.test(text);
}

/**
 * Whether `key` is `pattern` or sits under it. A key is a repo-relative path, followed by `#name`
 * for a managed block or a JSON contribution inside that file.
 * @param {string} key
 * @param {string} pattern
 * @returns {boolean}
 */
export function keyMatches(key, pattern) {
	const trimmed = pattern.replace(/\/+$/, '');

	return key === trimmed || key.startsWith(`${trimmed}/`) || key.startsWith(`${trimmed}#`);
}

/**
 * Whether `key` is any of `patterns`, or sits under one of them.
 * @param {string} key
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function keyMatchesAny(key, patterns) {
	return patterns.some((pattern) => keyMatches(key, pattern));
}
