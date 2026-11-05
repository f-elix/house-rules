// @ts-check
import path from 'node:path';
import { findAnyBlock } from './blocks.mjs';
import { readJsonFile, stringsAt } from './jsonc.mjs';
import {
	blockKey,
	jsonKey,
	linkUnit,
	pendingKey,
	readLock,
	settlePending,
	writeLock
} from './lock.mjs';
import { hasConflictMarkers, keyMatches, keyMatchesAny } from './render.mjs';
import { createReport, refuse } from './report.mjs';
import { readText } from './workspace.mjs';

/** @typedef {import('./report.mjs').Report} Report */
/** @typedef {import('./lock.mjs').Lock} Lock */
/** @typedef {import('./lock.mjs').PendingEntry} PendingEntry */

/**
 * @param {string} repo
 * @param {PendingEntry} entry
 * @returns {string | null} Why the entry can't be resolved yet, or `null` when it can.
 */
function unresolvedReason(repo, entry) {
	const missing = `${entry.target} is missing: restore it, or run \`untrack\``;

	if (entry.item === 'json') {
		const file = readJsonFile(path.join(repo, entry.target));

		if (file.status === 'missing') return missing;

		return file.status === 'invalid' ? `${entry.target} is ${file.error}` : null;
	}

	const text = readText(repo, entry.target);

	if (text === null) return missing;

	if (entry.item === 'file')
		return hasConflictMarkers(text) ? 'still has conflict markers' : null;

	const found = findAnyBlock(text, entry.module);

	if (found === null || found === 'malformed') return 'the block markers are missing or unpaired';

	return hasConflictMarkers(found.content) ? 'still has conflict markers' : null;
}

/**
 * @param {string} repo
 * @param {PendingEntry} entry
 * @returns {string[]} The values of a manual JSON entry that the file doesn't hold.
 */
function missingValues(repo, entry) {
	if (entry.item !== 'json') return [];

	const file = readJsonFile(path.join(repo, entry.target));

	if (file.status !== 'json' && file.status !== 'jsonc') return [];

	const present = stringsAt(file.value, entry.key);

	return entry.values.filter((value) => !present.includes(value));
}

/**
 * @param {Lock} lock Mutated.
 * @param {PendingEntry} entry
 * @returns {void}
 */
function applyPending(lock, entry) {
	if (entry.item === 'json') {
		const { module, target, key, values } = entry;
		const locked = lock.json.find((candidate) => jsonKey(candidate) === jsonKey(entry));

		if (locked) locked.values = values;
		else lock.json.push({ module, target, key, values });

		return;
	}

	const entries = entry.item === 'file' ? lock.files : lock.blocks;

	const locked = entries.find(
		(candidate) => candidate.target === entry.target && candidate.module === entry.module
	);

	if (locked)
		Object.assign(locked, { source: entry.source, commit: entry.commit, hash: entry.hash });
}

/**
 * Marks pending items as done: a merged entry's base moves to the commit the update brought, so the
 * next update merges against it, and a manual JSON change counts as made. Once nothing is pending,
 * the lockfile's commit moves too.
 * @param {string} repo
 * @param {readonly string[]} patterns Keys or their prefixes, such as a folder or a block's file.
 * @param {{ dryRun: boolean }} options
 * @returns {Report}
 */
export function resolve(repo, patterns, options) {
	const report = createReport('resolve');
	const lock = readLock(repo);

	if (!lock) return refuse(report, 'no house-rules.lock.json; run `install` first');

	if (lock.pending.length === 0) return refuse(report, 'nothing is pending');

	const unmatched = patterns.filter(
		(pattern) => !lock.pending.some((entry) => keyMatches(pendingKey(entry), pattern))
	);

	if (unmatched.length > 0) {
		const pending = lock.pending.map(pendingKey).join(', ');

		return refuse(report, `not pending: ${unmatched.join(', ')} (pending: ${pending})`);
	}

	const remaining = [];

	for (const entry of lock.pending) {
		const key = pendingKey(entry);

		if (!keyMatchesAny(key, patterns)) {
			remaining.push(entry);
			continue;
		}

		const reason = unresolvedReason(repo, entry);

		if (reason) {
			remaining.push(entry);
			report.entries.push({ status: entry.kind, target: key, detail: reason });
			continue;
		}

		applyPending(lock, entry);

		const skipped = missingValues(repo, entry);

		if (skipped.length === 0) {
			report.entries.push({ status: 'resolved', target: key });
			continue;
		}

		report.entries.push({
			status: 'resolved',
			target: key,
			detail: `without ${skipped.join(', ')}; later updates treat that as a local removal`
		});
		report.next.push(
			`confirm with the user that ${key} leaves out ${skipped.join(', ')} on purpose; if not, add them`
		);
	}

	settlePending(lock, remaining);
	report.source = { ...lock.source };
	report.status = remaining.length === 0 ? 'resolved' : 'pending';

	if (remaining.length > 0)
		report.next.push(`still pending: ${remaining.map(pendingKey).join(', ')}`);

	if (!options.dryRun) writeLock(repo, lock);

	return report;
}

/**
 * Stops managing the matching entries and records the patterns as excluded, so updates don't offer
 * them again. Leaves the files as they are.
 * @param {string} repo
 * @param {readonly string[]} patterns Keys or their prefixes. A skill folder also matches its
 * `.claude/skills` link.
 * @param {{ dryRun: boolean }} options
 * @returns {Report}
 */
export function untrack(repo, patterns, options) {
	const report = createReport('untrack');
	const lock = readLock(repo);

	if (!lock) return refuse(report, 'no house-rules.lock.json; run `install` first');

	const used = new Set();

	/**
	 * @param {string[]} keys
	 * @returns {boolean} Whether to drop the entry, after reporting it.
	 */
	const drop = (keys) => {
		const [key = ''] = keys;
		const matching = patterns.filter((pattern) => keys.some((k) => keyMatches(k, pattern)));

		for (const pattern of matching) used.add(pattern);

		if (matching.length > 0) report.entries.push({ status: 'untracked', target: key });

		return matching.length > 0;
	};

	const next = {
		...lock,
		files: lock.files.filter((entry) => !drop([entry.target])),
		blocks: lock.blocks.filter((entry) => !drop([blockKey(entry)])),
		links: lock.links.filter((entry) => !drop([entry.target, linkUnit(entry)])),
		json: lock.json.filter((entry) => !drop([jsonKey(entry)]))
	};

	const unmatched = patterns.filter((pattern) => !used.has(pattern));

	report.source = { ...lock.source };

	if (unmatched.length > 0) {
		report.entries = [];

		return refuse(report, `nothing managed matches ${unmatched.join(', ')}`);
	}

	const normalized = patterns.map((pattern) => pattern.replace(/\/+$/, ''));

	next.excluded = [...new Set([...lock.excluded, ...normalized])];
	settlePending(
		next,
		lock.pending.filter((entry) => !keyMatchesAny(pendingKey(entry), patterns))
	);

	report.status = 'untracked';

	if (!options.dryRun) writeLock(repo, next);

	return report;
}
