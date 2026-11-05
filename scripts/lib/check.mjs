// @ts-check
import path from 'node:path';
import { findAnyBlock } from './blocks.mjs';
import { describeChange, readJsonFile, stringsAt } from './jsonc.mjs';
import { blockKey, jsonKey, LOCK_FILE, pendingKey, readLock } from './lock.mjs';
import { hasConflictMarkers, hash } from './render.mjs';
import { createReport, refuse } from './report.mjs';
import { commitsBehind, resolveCommit } from './source.mjs';
import { isOccupied, linkResolves, readText } from './workspace.mjs';

/** @typedef {import('./source.mjs').Source} Source */
/** @typedef {import('./report.mjs').Report} Report */
/** @typedef {import('./report.mjs').ReportEntry} ReportEntry */
/** @typedef {import('./lock.mjs').Lock} Lock */
/** @typedef {import('./lock.mjs').LockEntry} LockEntry */
/** @typedef {import('./lock.mjs').PendingEntry} PendingEntry */

/**
 * @typedef {object} CheckOptions
 * @property {boolean} strict Fail on warnings too.
 */

/** Statuses that fail the check. */
const CHECK_FAILURES = new Set([
	'missing',
	'occupied',
	'malformed',
	'markers',
	'broken-link',
	'invalid',
	'pending'
]);

/** Statuses that warn, and fail only with `--strict`. */
const CHECK_WARNINGS = new Set(['behind', 'diverged', 'unknown-ref', 'unreachable']);

/**
 * @param {string} repo
 * @param {LockEntry} entry
 * @returns {ReportEntry}
 */
function checkFile(repo, entry) {
	const { target } = entry;

	if (isOccupied(repo, target)) {
		return { status: 'occupied', target, detail: 'something other than a file is in the way' };
	}

	const text = readText(repo, target);

	if (text === null) return { status: 'missing', target };

	if (hasConflictMarkers(text))
		return { status: 'markers', target, detail: 'has conflict markers' };

	if (hash(text) !== entry.hash)
		return { status: 'modified', target, detail: 'differs from upstream' };

	return { status: 'ok', target };
}

/**
 * @param {string} repo
 * @param {LockEntry} entry
 * @returns {ReportEntry}
 */
function checkBlock(repo, entry) {
	const target = blockKey(entry);
	const text = readText(repo, entry.target);

	if (text === null) return { status: 'missing', target, detail: `${entry.target} is missing` };

	const found = findAnyBlock(text, entry.module);

	if (found === null) return { status: 'missing', target, detail: 'markers are missing' };

	if (found === 'malformed')
		return { status: 'malformed', target, detail: 'markers are unpaired' };

	if (hasConflictMarkers(found.content)) {
		return { status: 'markers', target, detail: 'has conflict markers' };
	}

	if (hash(found.content) !== entry.hash) {
		return { status: 'modified', target, detail: 'differs from upstream' };
	}

	return { status: 'ok', target };
}

/**
 * @param {string} repo
 * @param {Lock} lock
 * @returns {ReportEntry[]}
 */
function checkJson(repo, lock) {
	return lock.json.map((entry) => {
		const target = jsonKey(entry);
		const file = readJsonFile(path.join(repo, entry.target));

		if (file.status === 'missing')
			return { status: 'missing', target, detail: `${entry.target} is missing` };

		if (file.status === 'invalid') return { status: 'invalid', target, detail: file.error };

		const present = stringsAt(file.value, entry.key);
		const absent = entry.values.filter((value) => !present.includes(value));

		if (absent.length > 0)
			return { status: 'modified', target, detail: `without ${absent.join(', ')}` };

		return { status: 'ok', target };
	});
}

/**
 * @param {Lock} lock
 * @param {PendingEntry} entry
 * @returns {ReportEntry}
 */
function checkPending(lock, entry) {
	const target = pendingKey(entry);

	if (entry.kind === 'manual') {
		const before = lock.json.find((candidate) => jsonKey(candidate) === target)?.values ?? [];

		return {
			status: 'pending',
			target,
			detail: `manual change: ${describeChange(before, entry.values)}; make it, then run \`resolve\``
		};
	}

	return {
		status: 'pending',
		target,
		detail: `unresolved ${entry.kind} from an update; fix it, then run \`resolve\``
	};
}

/**
 * @param {Lock} lock
 * @param {Source | Error | null} source
 * @returns {ReportEntry[]}
 */
function checkBehind(lock, source) {
	if (source === null) return [];

	if (source instanceof Error) {
		return [{ status: 'unreachable', target: LOCK_FILE, detail: source.message.trim() }];
	}

	const { ref, commit } = lock.source;
	const head = resolveCommit(source, ref);

	if (!head)
		return [
			{ status: 'unknown-ref', target: LOCK_FILE, detail: `${ref} isn't in ${source.url}` }
		];

	if (head === commit) return [];

	const behind = commitsBehind(source, commit, head);

	if (behind === null) {
		return [
			{
				status: 'diverged',
				target: LOCK_FILE,
				detail: `the locked commit isn't in ${ref}'s history; run \`update\``
			}
		];
	}

	const commits = behind === 1 ? '1 commit' : `${behind} commits`;

	return [
		{ status: 'behind', target: LOCK_FILE, detail: `${commits} behind ${ref}; run \`update\`` }
	];
}

/**
 * Verifies the managed content against the lockfile. Missing files, broken links, conflict markers
 * and pending work fail; local modifications are information; a locked commit behind the ref
 * warns, or fails with `strict`.
 * @param {string} repo
 * @param {Source | Error | null} source `null` skips the comparison with the ref; an error is why
 * the source couldn't be opened.
 * @param {CheckOptions} options
 * @returns {Report}
 */
export function check(repo, source, options) {
	const report = createReport('check');
	const lock = readLock(repo);

	if (!lock) return refuse(report, 'no house-rules.lock.json; run `install` first');

	report.source = { ...lock.source };
	report.modules = lock.modules;
	report.entries = [
		...lock.files.map((entry) => checkFile(repo, entry)),
		...lock.links.map((link) =>
			linkResolves(repo, link)
				? { status: 'ok', target: link.target }
				: {
						status: 'broken-link',
						target: link.target,
						detail: `should point at ${link.to}`
					}
		),
		...lock.blocks.map((entry) => checkBlock(repo, entry)),
		...checkJson(repo, lock),
		...lock.pending.map((entry) => checkPending(lock, entry)),
		...checkBehind(lock, source)
	];

	const failed = report.entries.some((entry) => CHECK_FAILURES.has(entry.status));
	const warned = report.entries.some((entry) => CHECK_WARNINGS.has(entry.status));

	if (failed || (warned && options.strict)) report.status = 'failed';
	else if (warned) report.status = 'warnings';

	return report;
}
