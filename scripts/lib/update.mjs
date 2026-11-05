// @ts-check
import path from 'node:path';
import { findBlock, normalizeBlock, replaceBlock } from './blocks.mjs';
import { DecodeError } from './decode.mjs';
import {
	blocksContribution,
	describeChange,
	detectIndent,
	formatJson,
	mergeContribution,
	parseJsonObject,
	readJsonFile,
	stringsAt
} from './jsonc.mjs';
import { diffOxlintConfig } from './lint-changes.mjs';
import {
	blockKey,
	jsonKey,
	linkUnit,
	LOCK_FILE,
	pendingHint,
	readLock,
	settlePending,
	sourceChange,
	writeLock
} from './lock.mjs';
import {
	buildPayload,
	collectRequirements,
	declinedFiles,
	expandModules,
	readManifest,
	readPayload,
	readRendered,
	splitFolders
} from './manifest.mjs';
import { mergeText } from './merge.mjs';
import { heldDetail, plan, stage } from './plan.mjs';
import { hash, keyMatches, keyMatchesAny } from './render.mjs';
import { createReport, refuse } from './report.mjs';
import { diffRequirements, servedRequirements, unmetRequirements } from './requirements.mjs';
import { findRenames, hasCommit, resolveCommit, useFetchableUrl } from './source.mjs';
import { Staging } from './staging.mjs';
import { dirtyPaths, isOccupied } from './workspace.mjs';

/** @typedef {import('./source.mjs').Source} Source */
/** @typedef {import('./plan.mjs').Decisions} Decisions */
/** @typedef {import('./report.mjs').Report} Report */
/** @typedef {import('./report.mjs').ReportEntry} ReportEntry */
/** @typedef {import('./lock.mjs').Lock} Lock */
/** @typedef {import('./lock.mjs').LockEntry} LockEntry */
/** @typedef {import('./lock.mjs').JsonEntry} JsonEntry */
/** @typedef {import('./manifest.mjs').Payload} Payload */
/** @typedef {import('./manifest.mjs').Declined} Declined */
/** @typedef {import('./manifest.mjs').FileItem} FileItem */
/** @typedef {import('./manifest.mjs').BlockItem} BlockItem */
/** @typedef {import('./manifest.mjs').JsonItem} JsonItem */
/** @typedef {import('./manifest.mjs').LinkItem} LinkItem */
/** @typedef {import('./manifest.mjs').Manifest} Manifest */

/**
 * @typedef {object} UpdateOptions
 * @property {string | undefined} ref Defaults to the locked ref.
 * @property {string[]} add New items to install, by key prefix.
 * @property {Decisions} decisions Applies to the added items; `skip` also declines new items, and
 * `keep` leaves a file upstream moved where it is.
 * @property {boolean} followRenames
 * @property {boolean} allowDirty
 * @property {boolean} dryRun
 */

/**
 * The state one update threads through its steps.
 * @typedef {object} Run
 * @property {string} repo
 * @property {Source} source
 * @property {UpdateOptions} options
 * @property {Lock} lock The lockfile as read; never mutated. Its maps rendered the merge bases.
 * @property {Lock} next The lockfile being built. Its maps render the incoming content.
 * @property {string} commit The commit being updated to.
 * @property {Staging} staging
 * @property {Report} report
 * @property {Map<string, Map<string, string>>} renames By base commit.
 * @property {{ from: string, to: string }[]} moved Files that followed an upstream rename.
 * @property {Manifest | null} previous The manifest at the locked commit, for advice only: `null`
 * when the source lacks that commit or this engine can't read it.
 * @property {(target: string) => Declined | null} declined From `declinedFiles`, once the payload
 * is final.
 */

/** @typedef {'unchanged' | 'kept' | 'updated' | 'merged' | 'conflict' | 'no-base'} Outcome */

const HELD_RENAMES =
	'upstream moved managed files, and its links point at the new paths; settle each move as its detail says';

/** @type {Record<Outcome, string | undefined>} */
const OUTCOME_DETAIL = {
	unchanged: undefined,
	kept: 'local changes kept; upstream unchanged',
	updated: undefined,
	merged: 'local changes merged with upstream',
	conflict: 'fix the conflict markers, then run `resolve`',
	'no-base': 'no base to merge against: review the markers, keep what applies, then run `resolve`'
};

/**
 * Three-way reconciles one file or block. The entry's hash identifies the base; the base text is
 * read only when both sides changed.
 * @param {LockEntry} entry
 * @param {string} local
 * @param {string} incoming
 * @param {() => string | null} readBase
 * @returns {{ outcome: Outcome, text: string | null }} `text` is what to write, or `null` to leave the local copy.
 */
function reconcile(entry, local, incoming, readBase) {
	if (hash(incoming) === entry.hash) {
		return { outcome: local === incoming ? 'unchanged' : 'kept', text: null };
	}

	if (hash(local) === entry.hash) return { outcome: 'updated', text: incoming };

	if (local === incoming) return { outcome: 'unchanged', text: null };

	const base = readBase();
	const known = base !== null && hash(base) === entry.hash;
	const merged = mergeText(local, known ? base : '', incoming);

	if (!known) return { outcome: 'no-base', text: merged.text };

	return { outcome: merged.conflicts === 0 ? 'merged' : 'conflict', text: merged.text };
}

/**
 * @typedef {object} Settled
 * @property {'file' | 'block'} item
 * @property {string} key
 * @property {Outcome} outcome
 * @property {string} incoming
 * @property {string} source
 * @property {string} target
 */

/**
 * Records an outcome: advances the entry, or leaves its base as is and adds a pending record that
 * `resolve` applies.
 * @param {Run} run
 * @param {LockEntry} entry Mutated.
 * @param {Settled} result
 * @returns {void}
 */
function settle(run, entry, result) {
	const detail = OUTCOME_DETAIL[result.outcome];

	run.report.entries.push(
		detail
			? { status: result.outcome, target: result.key, detail }
			: { status: result.outcome, target: result.key }
	);
	entry.source = result.source;
	entry.target = result.target;

	if (result.outcome !== 'conflict' && result.outcome !== 'no-base') {
		entry.commit = run.commit;
		entry.hash = hash(result.incoming);

		return;
	}

	run.next.pending.push({
		kind: result.outcome,
		item: result.item,
		module: entry.module,
		source: result.source,
		target: result.target,
		commit: run.commit,
		hash: hash(result.incoming)
	});
}

/**
 * @param {Run} run
 * @param {string} from
 * @returns {Map<string, string>}
 */
function renamesFrom(run, from) {
	const cached = run.renames.get(from);

	if (cached) return cached;

	const renames = hasCommit(run.source, from)
		? findRenames(run.source, from, run.commit)
		: new Map();

	run.renames.set(from, renames);

	return renames;
}

/**
 * @param {Run} run
 * @param {LockEntry} entry
 * @param {FileItem} item Where the file comes from and goes to after the update.
 * @returns {void}
 */
function updateFile(run, entry, item) {
	const local = run.staging.read(entry.target);

	if (local === null) {
		run.report.entries.push({
			status: 'missing',
			target: entry.target,
			detail: 'deleted locally: restore it, or keep it deleted and run `untrack`'
		});

		return;
	}

	const incoming = readPayload(run.source, run.commit, item, run.next.maps);

	const readBase = () =>
		readRendered(run.source, entry.commit, entry.source, run.lock.maps, entry.target);

	const { outcome, text } = reconcile(entry, local, incoming, readBase);

	if (item.kind === 'oxlint-config' && hash(incoming) !== entry.hash) {
		run.report.lintChanges.push(...diffOxlintConfig(item.target, readBase() ?? '{}', incoming));
	}

	if (item.target !== entry.target) {
		run.staging.remove(entry.target);
		run.staging.write(item.target, text ?? local);
		run.moved.push({ from: entry.target, to: item.target });
		run.report.entries.push({
			status: 'moved',
			target: entry.target,
			detail: `moved to ${item.target}, where upstream put it`
		});
	} else if (text !== null) {
		run.staging.write(item.target, text);
	}

	settle(run, entry, {
		item: 'file',
		key: item.target,
		outcome,
		incoming,
		source: item.source,
		target: item.target
	});
}

/**
 * @param {Run} run
 * @param {LockEntry} entry
 * @param {FileItem} item
 * @returns {ReportEntry | null} Why the local copy stays where it is although upstream moved it, or
 * `null` when upstream didn't move it or it follows with `--follow-renames` to a free destination.
 */
function heldRename(run, entry, item) {
	if (item.target === entry.target) return null;

	const taken = run.staging.read(item.target) !== null || isOccupied(run.repo, item.target);

	if (run.options.followRenames && !taken) return null;

	return run.options.followRenames
		? {
				status: 'collision',
				target: entry.target,
				detail: `upstream moved it to ${item.target}, which is taken: clear that path and rerun with --follow-renames, or rerun with --keep ${entry.target}`
			}
		: {
				status: 'renamed',
				target: entry.target,
				detail: `upstream moved it to ${item.target}: rerun with --follow-renames, or with --keep ${entry.target} to leave it here`
			};
}

/**
 * Updates a file upstream still ships. When upstream moved it, the local copy follows only with
 * `--follow-renames` and a free destination; otherwise it updates in place, which only a dry run
 * does, since a real run refuses while a move is undecided.
 * @param {Run} run
 * @param {LockEntry} entry
 * @param {FileItem} item
 * @returns {void}
 */
function updateTracked(run, entry, item) {
	const held = heldRename(run, entry, item);

	if (held) run.report.entries.push(held);

	updateFile(run, entry, held ? { ...item, target: entry.target } : item);
}

/**
 * @param {Run} run
 * @param {Payload} payload
 * @returns {{ entry: LockEntry, item: FileItem, renamed: boolean }[]} Each tracked file with the
 * payload item it now comes from; files upstream deleted are left out.
 */
function matchTracked(run, payload) {
	const incoming = new Map(payload.files.map((item) => [item.source, item]));
	const locked = new Set(run.lock.files.map((entry) => entry.source));
	const matches = [];

	for (const entry of run.next.files) {
		const item = incoming.get(entry.source);

		if (item) {
			matches.push({ entry, item, renamed: false });
			continue;
		}

		const renamedTo = renamesFrom(run, entry.commit).get(entry.source);
		const renamed = renamedTo && !locked.has(renamedTo) ? incoming.get(renamedTo) : undefined;

		if (renamed) matches.push({ entry, item: renamed, renamed: true });
	}

	return matches;
}

/**
 * Maps the new default path of each moved file that `--keep` names to its current target, so the
 * file stays put and the payload's links to it follow.
 * @param {Run} run
 * @param {Payload} payload
 * @returns {boolean} Whether a map was added, which calls for a payload built with the new maps.
 */
function keepMoved(run, payload) {
	let added = false;

	for (const { entry, item } of matchTracked(run, payload)) {
		const moved = item.target !== entry.target;

		if (!moved || !keyMatchesAny(entry.target, run.options.decisions.keep)) continue;

		run.next.maps[item.defaultTarget] = entry.target;
		run.report.entries.push({
			status: 'mapped',
			target: entry.target,
			detail: `upstream moved it to ${item.target}; it stays here, and the lockfile maps the new path to it`
		});
		added = true;
	}

	return added;
}

/**
 * @param {Run} run
 * @param {Payload} payload
 * @param {Set<string>} claimed Collects the sources a rename points at, so they aren't also new.
 * @returns {void}
 */
function updateFiles(run, payload, claimed) {
	const matches = matchTracked(run, payload);

	for (const { entry, item, renamed } of matches) {
		if (renamed) claimed.add(item.source);

		updateTracked(run, entry, item);
	}

	for (const entry of run.next.files) {
		if (matches.some((match) => match.entry === entry)) continue;

		run.report.entries.push({
			status: 'deleted',
			target: entry.target,
			detail: `upstream removed ${entry.source}: delete the file or keep it, then run \`untrack\``
		});
	}
}

/**
 * @param {Run} run
 * @param {LockEntry} entry
 * @param {BlockItem} item
 * @returns {void}
 */
function updateBlock(run, entry, item) {
	const key = blockKey(entry);
	const text = run.staging.read(entry.target);
	const found = text === null ? null : findBlock(text, item.style, entry.module);

	if (text === null || found === null || found === 'malformed') {
		run.report.entries.push({
			status: 'missing',
			target: key,
			detail:
				found === 'malformed'
					? 'one marker missing, repeated or out of order: fix them, then rerun `update`'
					: 'host file or markers missing: restore them, or run `untrack`'
		});

		return;
	}

	const incoming = normalizeBlock(readPayload(run.source, run.commit, item, run.next.maps));

	const result = reconcile(entry, found.content, incoming, () => {
		const base = readRendered(
			run.source,
			entry.commit,
			entry.source,
			run.lock.maps,
			entry.target
		);

		return base === null ? null : normalizeBlock(base);
	});

	if (result.text !== null) {
		const content = normalizeBlock(result.text);

		run.staging.write(
			entry.target,
			replaceBlock(text, found, item.style, entry.module, content)
		);
	}

	settle(run, entry, {
		item: 'block',
		key,
		outcome: result.outcome,
		incoming,
		source: item.source,
		target: entry.target
	});
}

/**
 * @param {Run} run
 * @param {Payload} payload
 * @returns {void}
 */
function updateBlocks(run, payload) {
	for (const entry of run.next.blocks) {
		const item = payload.blocks.find(
			(block) => block.module === entry.module && block.target === entry.target
		);

		if (item) {
			updateBlock(run, entry, item);
			continue;
		}

		run.report.entries.push({
			status: 'deleted',
			target: blockKey(entry),
			detail: 'upstream removed the block: delete it or keep it, then run `untrack`'
		});
	}
}

/**
 * @param {import('./jsonc.mjs').JsonFile} file
 * @param {string} key
 * @param {string} change
 * @returns {string} Why the engine can't make `change` to `key` in `file`, and what to do instead.
 */
function manualDetail(file, key, change) {
	const steps = `${change} by hand, then run \`resolve\``;

	if (file.status === 'jsonc') return `has comments; ${steps}`;

	if (file.status === 'invalid') return `isn't valid JSON; fix it, ${steps}`;

	return `"${key}" isn't a JSON array; ${steps}`;
}

/**
 * Applies an upstream change to a contribution as a set change. A JSON file with comments or
 * invalid JSON, or a key that isn't an array, gets a manual action instead, pending until `resolve`.
 * @param {Run} run
 * @param {JsonEntry} entry
 * @param {string[]} incoming
 * @param {string[]} shared Values other modules still contribute to the same key.
 * @returns {boolean} Whether the entry moves to the new values.
 */
function updateContribution(run, entry, incoming, shared) {
	const key = jsonKey(entry);
	const staged = run.staging.read(entry.target);
	const change = describeChange(entry.values, incoming);

	if (staged === null) {
		run.report.entries.push({
			status: 'missing',
			target: key,
			detail: `file deleted locally; upstream would ${change}`
		});

		return false;
	}

	const value = parseJsonObject(staged);

	if (value === null || blocksContribution(value, entry.key)) {
		const file = readJsonFile(path.join(run.repo, entry.target));
		const { module, target } = entry;

		run.next.pending.push({
			kind: 'manual',
			item: 'json',
			module,
			target,
			key: entry.key,
			values: incoming,
			commit: run.commit
		});
		run.report.entries.push({
			status: 'manual',
			target: key,
			detail: manualDetail(file, entry.key, change)
		});

		return false;
	}

	const before = stringsAt(value, entry.key).join('\n');

	mergeContribution(value, entry.key, entry.values, incoming, shared);
	run.staging.write(entry.target, formatJson(value, detectIndent(staged)));

	const status = before === stringsAt(value, entry.key).join('\n') ? 'kept' : 'updated';

	run.report.entries.push({ status, target: key, detail: change });

	return true;
}

/**
 * @param {Payload} payload
 * @param {JsonEntry} entry
 * @returns {JsonItem | undefined}
 */
function findJsonItem(payload, entry) {
	return payload.json.find((json) => jsonKey(json) === jsonKey(entry));
}

/**
 * Runs after new items are staged, so a value naming a file this update installs goes in with it.
 * @param {Run} run
 * @param {Payload} payload
 * @param {readonly JsonEntry[]} entries The entries the lockfile had.
 * @returns {void}
 */
function updateJson(run, payload, entries) {
	/** @param {string} target */
	const available = (target) => run.staging.exists(target);

	for (const entry of entries) {
		const item = findJsonItem(payload, entry);

		if (!item) {
			run.report.entries.push({
				status: 'deleted',
				target: jsonKey(entry),
				detail: `upstream no longer adds ${entry.values.join(', ')}`
			});
			continue;
		}

		const shared = run.next.json
			.filter(
				(other) =>
					other !== entry && other.target === entry.target && other.key === entry.key
			)
			// Old values too: the file still holds them until that entry's own turn.
			.flatMap((other) => [...other.values, ...(findJsonItem(payload, other)?.values ?? [])]);

		const held = item.values.filter(
			(value) => !entry.values.includes(value) && !(item.needs[value] ?? []).every(available)
		);

		if (held.length > 0) {
			run.report.entries.push({
				status: 'held',
				target: jsonKey(entry),
				detail: heldDetail(item, held, available, run.declined)
			});
		}

		const incoming = item.values.filter((value) => !held.includes(value));
		const changed = incoming.join('\n') !== entry.values.join('\n');

		if (changed && updateContribution(run, entry, incoming, shared)) entry.values = incoming;
	}
}

/**
 * Moves the skill links whose folder moved with `--follow-renames`: removes the old link and
 * installs the one upstream ships for the new folder.
 * @param {Run} run
 * @param {Payload} payload
 * @returns {void}
 */
function updateLinks(run, payload) {
	/** @param {string} unit */
	const tracked = (unit) => run.next.files.some((entry) => keyMatches(entry.target, unit));

	const stale = run.next.links.filter(
		(link) =>
			!tracked(linkUnit(link)) &&
			run.moved.some((move) => keyMatches(move.from, linkUnit(link)))
	);

	if (stale.length === 0) return;

	for (const link of stale) {
		run.staging.unlink(link.target);
		run.report.entries.push({
			status: 'removed',
			target: link.target,
			detail: 'its skill folder moved'
		});
	}

	run.next.links = run.next.links.filter((link) => !stale.includes(link));

	const replacements = payload.links.filter(
		(item) =>
			run.moved.some((move) => keyMatches(move.to, item.unit)) &&
			!run.next.links.some((link) => link.target === item.target)
	);

	stageNew(run, { files: [], links: replacements, blocks: [], json: [] });
}

/**
 * @param {Run} run
 * @param {Pick<Payload, 'files' | 'links' | 'blocks' | 'json'>} items
 * @returns {string[]} The keys of the items installed.
 */
function stageNew(run, items) {
	const context = {
		repo: run.repo,
		source: run.source,
		commit: run.commit,
		maps: run.next.maps,
		decisions: run.options.decisions,
		staging: run.staging,
		declined: run.declined,
		contributions: [...run.next.json, ...items.json]
	};

	const { installed, entries, next } = stage(context, plan(context, items));

	/** @param {string} target */
	const written = (target) =>
		entries.some((entry) => entry.target === target && entry.status === 'written');

	for (const item of items.files) {
		if (item.kind !== 'oxlint-config' || !written(item.target)) continue;

		const content = readPayload(run.source, run.commit, item, run.next.maps);

		run.report.lintChanges.push(...diffOxlintConfig(item.target, '{}', content));
	}

	run.report.entries.push(...entries);
	run.report.next.push(...next);
	run.next.files.push(...installed.files);
	run.next.blocks.push(...installed.blocks);
	run.next.links.push(...installed.links);
	run.next.json.push(...installed.json);
	run.next.excluded.push(...installed.excluded);
	run.next.pending.push(...installed.pending);

	return [
		...installed.files.map((entry) => entry.target),
		...installed.links.flatMap((entry) => [entry.target, linkUnit(entry)]),
		...installed.blocks.map(blockKey),
		...installed.json.map(jsonKey)
	];
}

/**
 * @param {Run} run
 * @param {Payload} payload
 * @param {Set<string>} claimed
 * @returns {Pick<Payload, 'files' | 'links' | 'blocks' | 'json'>} Items the enabled modules gained
 * upstream that the consumer hasn't installed or declined. A declined item comes back when `--add`
 * names it.
 */
function findNewItems(run, payload, claimed) {
	const { next, options } = run;

	/** @param {string[]} keys */
	const declined = (keys) =>
		keys.some((key) => keyMatchesAny(key, run.lock.excluded)) &&
		!keys.some((key) => keyMatchesAny(key, options.add));

	const lockedSources = new Set(next.files.map((entry) => entry.source));

	const files = payload.files.filter(
		(item) =>
			!lockedSources.has(item.source) && !claimed.has(item.source) && !declined([item.target])
	);

	/** @param {string} unit */
	const hasFiles = (unit) =>
		[...next.files, ...files].some((entry) => keyMatches(entry.target, unit));

	return {
		files,
		links: payload.links.filter(
			(item) =>
				!next.links.some((entry) => entry.target === item.target) &&
				hasFiles(item.unit) &&
				!declined([item.target, item.unit])
		),
		blocks: payload.blocks.filter(
			(item) =>
				!next.blocks.some((entry) => blockKey(entry) === blockKey(item)) &&
				!declined([blockKey(item)])
		),
		json: payload.json.filter(
			(item) =>
				!next.json.some((entry) => jsonKey(entry) === jsonKey(item)) &&
				!declined([jsonKey(item)])
		)
	};
}

/**
 * Installs or declines the new items the options name, and reports the rest grouped by the
 * `--add` argument that covers them. A new file in a folder or skill the repo already has needs no
 * `--add`: it comes with the update, since the files beside it may import or link to it.
 * @param {Run} run
 * @param {Payload} payload
 * @param {Set<string>} claimed
 * @returns {void}
 */
function handleNewItems(run, payload, claimed) {
	const { options } = run;
	const items = findNewItems(run, payload, claimed);
	const chosenPatterns = [...options.add, ...options.decisions.skip];
	/** @param {string[]} keys */
	const chosen = (keys) => keys.some((key) => keyMatchesAny(key, chosenPatterns));

	const installedUnits = new Set(
		payload.files.flatMap((item) =>
			item.unit !== item.target &&
			run.next.files.some((entry) => entry.source === item.source)
				? [item.unit]
				: []
		)
	);

	/** @param {FileItem} item */
	const joinsUnit = (item) => installedUnits.has(item.unit);

	const units = [
		...items.files
			.filter((item) => !joinsUnit(item))
			.map((item) => ({ keys: [item.target], unit: item.unit })),
		...items.links.map((item) => ({ keys: [item.target, item.unit], unit: item.unit })),
		...items.blocks.map((item) => ({ keys: [blockKey(item)], unit: blockKey(item) })),
		...items.json.map((item) => ({ keys: [jsonKey(item)], unit: jsonKey(item) }))
	];

	const staged = run.report.entries.length;

	const added = stageNew(run, {
		files: items.files.filter((item) => chosen([item.target]) || joinsUnit(item)),
		links: items.links.filter((item) => chosen([item.target, item.unit])),
		blocks: items.blocks.filter((item) => chosen([blockKey(item)])),
		json: items.json.filter((item) => chosen([jsonKey(item)]))
	});

	for (const entry of run.report.entries.slice(staged)) {
		if (entry.status !== 'collision') continue;

		const key = entry.target;

		entry.detail = `${entry.detail}: rerun with --add ${key} and --overwrite or --keep ${key}, or with --skip ${key}`;
	}

	run.next.excluded = run.next.excluded.filter(
		(pattern) => !keyMatchesAny(pattern, [...options.add, ...added])
	);

	const waiting = new Map();

	for (const { keys, unit } of units) {
		if (!chosen(keys)) waiting.set(unit, (waiting.get(unit) ?? 0) + 1);
	}

	for (const [unit, count] of waiting) {
		const counted = count === 1 ? '' : ` (${count} items)`;

		run.report.entries.push({
			status: 'new',
			target: unit,
			unit,
			detail: `--add ${unit} to install, --skip ${unit} to decline${counted}`
		});
	}

	const newKeys = [
		...units.flatMap(({ keys }) => keys),
		...items.files.filter(joinsUnit).map((item) => item.target)
	];

	for (const pattern of chosenPatterns) {
		if (!newKeys.some((key) => keyMatches(key, pattern))) {
			run.report.next.push(`\`${pattern}\` matched no new item`);
		}
	}

	for (const key of newDeclinedItems(run, payload, claimed)) {
		const pattern = run.lock.excluded.find((excluded) => keyMatches(key, excluded));

		run.report.entries.push({
			status: 'excluded',
			target: key,
			detail: `new upstream under declined ${pattern}; --add ${key} to install`
		});
	}
}

/**
 * @param {Run} run
 * @returns {Set<string> | null} The files, blocks and JSON values the locked modules had at the
 * locked commit, or `null` when the source no longer has that commit.
 */
function lockedItems(run) {
	if (!run.previous) return null;

	const { modules } = expandModules(run.previous, run.lock.modules);

	const payload = buildPayload(
		run.source,
		run.lock.source.commit,
		run.previous,
		modules,
		run.next.maps
	);

	return new Set([
		...payload.files.map((item) => item.source),
		...payload.blocks.map(blockKey),
		...payload.json.map(jsonKey)
	]);
}

/**
 * Reads the manifest at the locked commit, which only feeds advice: the requirement changes and
 * the new items under declined paths. A newer house-rules may have written it, for example before
 * `--ref` went back to an older commit; this engine then skips that advice and says so.
 * @param {Source} source
 * @param {string} commit
 * @param {Report} report
 * @returns {Manifest | null}
 */
function readPreviousManifest(source, commit, report) {
	if (!hasCommit(source, commit)) return null;

	try {
		return readManifest(source, commit);
	} catch (error) {
		if (!(error instanceof DecodeError)) throw error;

		report.next.push(
			`skipped the requirement changes and new items under declined paths: this engine can't read modules.json at ${commit.slice(0, 7)} (${error.message})`
		);

		return null;
	}
}

/**
 * Finds items upstream added since the locked commit under a path the repo declined, such as a
 * file in an untracked folder. They stay out like the rest of that path; the report names them
 * once, so the repo can still take one with `--add`.
 * @param {Run} run
 * @param {Payload} payload
 * @param {Set<string>} claimed
 * @returns {string[]} The target or key of each.
 */
function newDeclinedItems(run, payload, claimed) {
	const { lock, options } = run;
	const lockedSources = new Set(run.next.files.map((entry) => entry.source));

	/** @param {string} key */
	const declined = (key) => keyMatchesAny(key, lock.excluded) && !keyMatchesAny(key, options.add);

	const candidates = [
		...payload.files
			.filter((item) => !lockedSources.has(item.source) && !claimed.has(item.source))
			.map((item) => ({ key: item.target, id: item.source })),
		...payload.blocks.map((item) => ({ key: blockKey(item), id: blockKey(item) })),
		...payload.json.map((item) => ({ key: jsonKey(item), id: jsonKey(item) }))
	].filter(({ key }) => declined(key));

	if (candidates.length === 0) return [];

	const before = lockedItems(run);

	return before ? candidates.flatMap(({ id, key }) => (before.has(id) ? [] : [key])) : [];
}

/**
 * @param {Lock} lock
 * @returns {string[]} The files the lockfile manages, for the dirty check. Links are left out: git
 * refuses a path under a symlinked folder.
 */
function managedPaths(lock) {
	const paths = new Set([
		LOCK_FILE,
		...lock.files.map((entry) => entry.target),
		...lock.blocks.map((entry) => entry.target),
		...lock.json.map((entry) => entry.target)
	]);

	return [...paths];
}

/**
 * @param {string} repo
 * @param {Lock} lock
 * @returns {string | null} Why the update won't run over the managed files' uncommitted changes, or
 * `null` when they're clean.
 */
function dirtyRefusal(repo, lock) {
	const dirty = dirtyPaths(repo, managedPaths(lock));

	if (dirty instanceof Error) {
		return `can't check managed files for uncommitted changes (${dirty.message}); pass --allow-dirty to update anyway`;
	}

	if (dirty.length === 0) return null;

	return `commit or discard the changes to managed files first, or pass --allow-dirty: ${dirty.join(', ')}`;
}

/**
 * @param {Run} run
 * @returns {void}
 */
function summarize(run) {
	const { report } = run;
	/** @param {string} status */
	const has = (status) => report.entries.some((entry) => entry.status === status);
	const quiet = new Set(['unchanged', 'kept', 'new', 'excluded', 'missing', 'deleted', 'held']);
	const changed = report.entries.some((entry) => !quiet.has(entry.status));

	report.status = run.commit === run.lock.source.commit && !changed ? 'up-to-date' : 'updated';

	if (run.next.pending.length > 0) {
		report.status = 'pending';
		report.next.push(pendingHint(run.next.pending));
	}

	if (has('collision')) {
		report.next.push('settle each collision as its detail says, then rerun the update');
	}

	if (has('renamed')) {
		report.next.push(
			'ask the user whether each renamed file moves; the update refuses until each one has --follow-renames or --keep'
		);
	}

	if (report.lintChanges.length > 0) {
		report.next.push(
			'ask the user to approve each lint change; revert the declined ones in the local config'
		);
	}

	if (has('new'))
		report.next.push('ask the user about each new item, then rerun with --add or --skip');

	if (has('deleted') || has('missing')) {
		report.next.push(
			'for each deleted or missing item, do what its detail says; `untrack <target>` only what the repo gives up on purpose'
		);
	}

	if (report.requirementChanges.length > 0 || report.requirements.length > 0) {
		report.next.push('update package.json for the changed and unmet requirements');
	}
}

/**
 * @param {Lock} next
 * @param {readonly string[]} expanded The locked modules and every module they now require.
 * @returns {string[]} The locked modules, and the newly required ones the repo took items from. A
 * required module whose items all wait as `new` stays out until the repo adds one.
 */
function installedModules(next, expanded) {
	const used = new Set(
		[...next.files, ...next.links, ...next.blocks, ...next.json].map((entry) => entry.module)
	);

	return [...new Set([...next.modules, ...expanded.filter((name) => used.has(name))])];
}

/**
 * Updates the installed modules to `ref`. Each managed file and block gets a three-way merge against
 * the upstream content it was last reconciled with; conflicts stay in the files as markers and in the
 * lockfile as pending records. New, deleted and renamed upstream items are reported, and applied only
 * when the options say so.
 * @param {string} repo
 * @param {Source} source
 * @param {UpdateOptions} options
 * @returns {Report}
 */
export function update(repo, source, options) {
	const report = createReport('update');
	const lock = readLock(repo);

	if (!lock) return refuse(report, 'no house-rules.lock.json; run `install` first');

	if (lock.pending.length > 0) {
		return refuse(report, `finish the pending work first: ${pendingHint(lock.pending)}`);
	}

	const ref = options.ref ?? lock.source.ref;
	const commit = resolveCommit(source, ref);

	if (!commit) return refuse(report, `${ref} isn't in ${source.url}`);

	useFetchableUrl(source, commit);

	const manifest = readManifest(source, commit);

	if (!manifest) return refuse(report, `${commit} has no modules.json`);

	const dirty = options.allowDirty ? null : dirtyRefusal(repo, lock);

	if (dirty && !options.dryRun) return refuse(report, dirty);

	const expanded = expandModules(manifest, lock.modules);
	const staging = new Staging(repo);
	let payload = buildPayload(source, commit, manifest, expanded.modules, lock.maps);

	/** @type {Run} */
	const run = {
		repo,
		source,
		options,
		lock,
		next: structuredClone(lock),
		commit,
		staging,
		report,
		renames: new Map(),
		moved: [],
		previous: readPreviousManifest(source, lock.source.commit, report),
		declined: () => null
	};

	const claimed = new Set();

	report.source = { url: source.url, ref, commit, from: lock.source.commit };
	report.modules = expanded.modules;

	for (const name of expanded.unknown) {
		report.next.push(
			`upstream has no ${name} module anymore; \`untrack\` its entries when you're done with them`
		);
	}

	if (keepMoved(run, payload)) {
		payload = buildPayload(source, commit, manifest, expanded.modules, run.next.maps);
	}

	run.declined = declinedFiles(payload, {
		tracked: new Set(lock.files.map((entry) => entry.target)),
		skip: options.decisions.skip,
		excluded: lock.excluded,
		add: options.add
	});

	const split = splitFolders(payload, run.declined);

	if (split.length > 0) {
		for (const message of split) refuse(report, message);

		return report;
	}

	const held = matchTracked(run, payload).flatMap(({ entry, item }) => {
		const reason = heldRename(run, entry, item);

		return reason ? [reason] : [];
	});

	if (held.length > 0 && !options.dryRun) {
		report.entries = held;

		return refuse(report, `nothing was written: ${HELD_RENAMES}`);
	}

	updateFiles(run, payload, claimed);
	updateLinks(run, payload);
	updateBlocks(run, payload);

	const lockedJson = [...run.next.json];

	handleNewItems(run, payload, claimed);
	updateJson(run, payload, lockedJson);
	run.next.modules = installedModules(run.next, expanded.modules);

	if (run.previous) {
		const before = collectRequirements(run.previous, lock.modules);

		report.requirementChanges = diffRequirements(before, payload.requirements);
	}

	report.requirements = unmetRequirements(
		repo,
		servedRequirements(payload, new Set(run.next.files.map((entry) => entry.target)))
	);
	summarize(run);
	report.next.push(...sourceChange(lock, source.url));

	if (options.dryRun) {
		// The real run would refuse; the preview goes on, so it lists every other change too.
		if (dirty) refuse(report, `the update will refuse: ${dirty}`);

		if (held.length > 0) refuse(report, `the update will refuse: ${HELD_RENAMES}`);

		return report;
	}

	run.next.source = { url: source.url, ref, commit: lock.source.commit };
	settlePending(run.next, run.next.pending, commit);
	staging.flush();
	writeLock(repo, run.next);

	return report;
}
