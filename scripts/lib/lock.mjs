// @ts-check
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	DecodeError,
	decodeArray,
	decodeInteger,
	decodeJson,
	decodeOptionalStringRecord,
	decodeRecord,
	decodeString,
	decodeStringArray
} from './decode.mjs';

/** The lockfile at the root of a consuming repo. */
export const LOCK_FILE = 'house-rules.lock.json';

const LOCK_VERSION = 1;

/**
 * Upgrades an older lockfile one version at a time: `MIGRATIONS[n - 1]` turns version `n` into
 * `n + 1`. The bootstrap runs the engine at the locked ref or `--ref`, so a newer engine may meet
 * any lockfile shape an older one wrote; an older engine refuses a newer version.
 * @type {((raw: Record<string, unknown>) => Record<string, unknown>)[]}
 */
const MIGRATIONS = [];

/**
 * A managed file or block. `commit` and `hash` describe the upstream content the local copy was last
 * reconciled with: the merge base of the next update.
 * @typedef {object} LockEntry
 * @property {string} module
 * @property {string} source Payload path in house-rules.
 * @property {string} target Repo-relative path in the consumer; the host file for a block.
 * @property {string} commit
 * @property {string} hash `sha256:` of the rendered upstream content at `commit`.
 */

/**
 * @typedef {object} LinkEntry
 * @property {string} module
 * @property {string} target
 * @property {string} to
 */

/**
 * Values a module added to an array in a JSON file. Local removals survive updates.
 * @typedef {object} JsonEntry
 * @property {string} module
 * @property {string} target
 * @property {string} key
 * @property {string[]} values
 */

/**
 * A file or block an update couldn't merge. The entry itself keeps its previous commit and hash
 * until `resolve` moves it to this record's.
 * @typedef {object} PendingMerge
 * @property {'conflict' | 'no-base'} kind
 * @property {'file' | 'block'} item
 * @property {string} module
 * @property {string} source
 * @property {string} target
 * @property {string} commit
 * @property {string} hash
 */

/**
 * Values the engine left for a person to write, because the JSON file has comments or the key isn't
 * an array. The entry keeps its previous values until `resolve` moves it to these.
 * @typedef {object} PendingJson
 * @property {'manual'} kind
 * @property {'json'} item
 * @property {string} module
 * @property {string} target
 * @property {string} key
 * @property {string[]} values
 * @property {string} commit
 */

/** @typedef {PendingMerge | PendingJson} PendingEntry */

/**
 * @typedef {object} Lock
 * @property {{ url: string, ref: string, commit: string }} source
 * @property {string[]} modules
 * @property {Record<string, string>} maps
 * @property {LockEntry[]} files
 * @property {LockEntry[]} blocks
 * @property {LinkEntry[]} links
 * @property {JsonEntry[]} json
 * @property {string[]} excluded Keys the consumer declined; updates don't offer them again.
 * @property {PendingEntry[]} pending
 */

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {LockEntry}
 */
function decodeEntry(value, at) {
	const raw = decodeRecord(value, at);

	return {
		module: decodeString(raw.module, `${at}.module`),
		source: decodeString(raw.source, `${at}.source`),
		target: decodeString(raw.target, `${at}.target`),
		commit: decodeString(raw.commit, `${at}.commit`),
		hash: decodeString(raw.hash, `${at}.hash`)
	};
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {JsonEntry}
 */
function decodeJsonEntry(value, at) {
	const raw = decodeRecord(value, at);

	return {
		module: decodeString(raw.module, `${at}.module`),
		target: decodeString(raw.target, `${at}.target`),
		key: decodeString(raw.key, `${at}.key`),
		values: decodeStringArray(raw.values, `${at}.values`)
	};
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {PendingEntry}
 */
function decodePending(value, at) {
	const raw = decodeRecord(value, at);
	const { kind, item } = raw;

	if (kind === 'manual' && item === 'json') {
		return {
			kind,
			item,
			...decodeJsonEntry(raw, at),
			commit: decodeString(raw.commit, `${at}.commit`)
		};
	}

	if ((kind === 'conflict' || kind === 'no-base') && (item === 'file' || item === 'block')) {
		return { kind, item, ...decodeEntry(raw, at) };
	}

	throw new DecodeError(
		`${at}: expected a "conflict" or "no-base" file or block, or a "manual" json entry`
	);
}

/**
 * @param {string} text
 * @returns {Lock}
 * @throws {DecodeError} When the text isn't a valid lockfile, or was written by a newer engine.
 */
export function parseLock(text) {
	let raw = decodeRecord(decodeJson(text, LOCK_FILE), LOCK_FILE);
	const version = decodeInteger(raw.version, `${LOCK_FILE}: version`);

	if (version > LOCK_VERSION) {
		throw new DecodeError(
			`${LOCK_FILE}: version ${version} needs a newer house-rules engine (this one reads up to ${LOCK_VERSION}); rerun with a newer --ref`
		);
	}

	if (version < 1) throw new DecodeError(`${LOCK_FILE}: unknown version ${version}`);

	for (const migrate of MIGRATIONS.slice(version - 1)) raw = migrate(raw);

	try {
		return decodeLockFields(raw);
	} catch (error) {
		if (error instanceof DecodeError) throw new DecodeError(`${LOCK_FILE}: ${error.message}`);

		throw error;
	}
}

/**
 * @param {Record<string, unknown>} raw A lockfile at the current version.
 * @returns {Lock}
 */
function decodeLockFields(raw) {
	const source = decodeRecord(raw.source, 'source');

	return {
		source: {
			url: decodeString(source.url, 'source.url'),
			ref: decodeString(source.ref, 'source.ref'),
			commit: decodeString(source.commit, 'source.commit')
		},
		modules: decodeStringArray(raw.modules, 'modules'),
		maps: decodeOptionalStringRecord(raw.maps, 'maps'),
		files: decodeArray(raw.files, 'files').map((item, index) =>
			decodeEntry(item, `files[${index}]`)
		),
		blocks: decodeArray(raw.blocks, 'blocks').map((item, index) =>
			decodeEntry(item, `blocks[${index}]`)
		),
		links: decodeArray(raw.links, 'links').map((item, index) => {
			const link = decodeRecord(item, `links[${index}]`);

			return {
				module: decodeString(link.module, `links[${index}].module`),
				target: decodeString(link.target, `links[${index}].target`),
				to: decodeString(link.to, `links[${index}].to`)
			};
		}),
		json: decodeArray(raw.json, 'json').map((item, index) =>
			decodeJsonEntry(item, `json[${index}]`)
		),
		excluded: decodeStringArray(raw.excluded, 'excluded'),
		pending: decodeArray(raw.pending, 'pending').map((item, index) =>
			decodePending(item, `pending[${index}]`)
		)
	};
}

/**
 * @param {string} repo
 * @returns {Lock | null} `null` when the repo has no lockfile.
 * @throws {DecodeError} When the lockfile is invalid.
 */
export function readLock(repo) {
	const file = path.join(repo, LOCK_FILE);

	if (!existsSync(file)) return null;

	return parseLock(readFileSync(file, 'utf8'));
}

/**
 * @param {{ target: string }} a
 * @param {{ target: string }} b
 * @returns {number}
 */
function byTarget(a, b) {
	return a.target < b.target ? -1 : Number(a.target > b.target);
}

/**
 * Writes the lockfile with entries sorted by target, so its diffs stay small.
 * @param {string} repo
 * @param {Lock} lock
 * @returns {void}
 */
export function writeLock(repo, lock) {
	const sorted = {
		version: LOCK_VERSION,
		source: lock.source,
		modules: lock.modules,
		maps: lock.maps,
		files: lock.files.toSorted(byTarget),
		blocks: lock.blocks.toSorted(byTarget),
		links: lock.links.toSorted(byTarget),
		json: lock.json.toSorted(byTarget),
		excluded: [...new Set(lock.excluded)].toSorted(),
		pending: lock.pending.toSorted(byTarget)
	};

	writeFileSync(path.join(repo, LOCK_FILE), `${JSON.stringify(sorted, null, '\t')}\n`);
}

/**
 * Keys name managed items in reports and in path arguments: a file is its target, a block
 * `<file>#<module>`, a JSON contribution `<file>#<key>#<module>`. A pattern matches every key that
 * starts with it, so `.oxlintrc.json#extends` covers every module's contribution to that key.
 * @param {{ target: string, module: string }} entry
 * @returns {string}
 */
export function blockKey(entry) {
	return `${entry.target}#${entry.module}`;
}

/**
 * @param {{ target: string, key: string, module: string }} entry
 * @returns {string}
 * @see {@link blockKey} for the key format.
 */
export function jsonKey(entry) {
	return `${entry.target}#${entry.key}#${entry.module}`;
}

/**
 * The key a pending record goes by in reports and in `resolve <target>`.
 * @param {PendingEntry} entry
 * @returns {string}
 */
export function pendingKey(entry) {
	if (entry.item === 'json') return jsonKey(entry);

	return entry.item === 'block' ? blockKey(entry) : entry.target;
}

/**
 * @param {{ target: string, to: string }} link
 * @returns {string} The skill folder the link points at.
 */
export function linkUnit(link) {
	return path.posix.join(path.posix.dirname(link.target), link.to);
}

/**
 * Replaces the lockfile's pending records. They all come from the one update that left them, so they
 * share the commit it brought, and the lockfile moves to that commit once none is left.
 * @param {Lock} lock Mutated.
 * @param {PendingEntry[]} remaining
 * @param {string} [brought] The commit the update brought; defaults to the pending records' commit.
 * @returns {void}
 */
export function settlePending(
	lock,
	remaining,
	brought = lock.pending[0]?.commit ?? lock.source.commit
) {
	lock.pending = remaining;

	if (remaining.length === 0) lock.source = { ...lock.source, commit: brought };
}

/**
 * @param {readonly PendingEntry[]} pending
 * @returns {string} What to do about the pending items, by kind.
 */
export function pendingHint(pending) {
	const conflicts = pending.filter((entry) => entry.kind !== 'manual').map(pendingKey);
	const manual = pending.filter((entry) => entry.kind === 'manual').map(pendingKey);

	const steps = [
		...(conflicts.length > 0 ? [`fix the conflicts in ${conflicts.join(', ')}`] : []),
		...(manual.length > 0 ? [`make the manual changes to ${manual.join(', ')}`] : [])
	];

	return `${steps.join(' and ')}, then run \`resolve <target>\` for each`;
}

/**
 * @param {Lock} lock
 * @param {string} url The source this run reads.
 * @returns {string[]} A next step naming the change when `url` replaces the source `lock` records,
 * which happens when the engine runs from another checkout or `--source` names another one.
 */
export function sourceChange(lock, url) {
	if (lock.source.url === url) return [];

	return [
		`the lockfile's source changes from ${lock.source.url} to ${url}; rerun with --source ${lock.source.url} to keep it`
	];
}
