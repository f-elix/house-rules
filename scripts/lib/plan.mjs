// @ts-check
import { findBlock, insertBlock, normalizeBlock, replaceBlock, scaffoldBlock } from './blocks.mjs';
import {
	blocksContribution,
	describeChange,
	detectIndent,
	formatJson,
	mergeContribution,
	parseJsonFile,
	parseJsonObject
} from './jsonc.mjs';
import { blockKey, jsonKey } from './lock.mjs';
import { readPayload } from './manifest.mjs';
import { hash, keyMatches, keyMatchesAny } from './render.mjs';
import { alternativeTaken, isSymlink, linkResolves, pathTaken } from './workspace.mjs';

/** @typedef {import('./manifest.mjs').Payload} Payload */
/** @typedef {import('./manifest.mjs').FileItem} FileItem */
/** @typedef {import('./manifest.mjs').LinkItem} LinkItem */
/** @typedef {import('./manifest.mjs').BlockItem} BlockItem */
/** @typedef {import('./manifest.mjs').JsonItem} JsonItem */
/** @typedef {import('./manifest.mjs').Declined} Declined */
/** @typedef {import('./lock.mjs').LockEntry} LockEntry */
/** @typedef {import('./lock.mjs').LinkEntry} LinkEntry */
/** @typedef {import('./lock.mjs').JsonEntry} JsonEntry */
/** @typedef {import('./lock.mjs').PendingEntry} PendingEntry */
/** @typedef {import('./source.mjs').Source} Source */
/** @typedef {import('./staging.mjs').Staging} Staging */
/** @typedef {import('./report.mjs').ReportEntry} ReportEntry */

/**
 * How to treat a target that already exists, by key prefix.
 * @typedef {object} Decisions
 * @property {string[]} overwrite Replace the local content with upstream's.
 * @property {string[]} keep Keep the local content and track it as a local change. Another config
 * for the same tool, or a link pointing elsewhere, can't be tracked, so the item is declined.
 * @property {string[]} skip Don't install; record the pattern as excluded.
 */

/**
 * @typedef {'write' | 'adopt' | 'keep' | 'skip' | 'manual' | 'hold' | 'collision'} Action
 * `hold` leaves JSON values out until the paths they name exist.
 */

/**
 * @typedef {object} Step
 * @property {'file' | 'link' | 'block' | 'json'} type
 * @property {string} key
 * @property {Action} action
 * @property {string} [detail]
 * @property {FileItem} [file]
 * @property {LinkItem} [link]
 * @property {BlockItem} [block]
 * @property {JsonItem} [json]
 * @property {string} [content] Rendered upstream content of a file or block.
 * @property {string} [replaces] Another config for the same tool that `--overwrite` let the step
 * write next to; the user retires it by hand.
 */

/**
 * The lock entries a plan adds.
 * @typedef {object} Installed
 * @property {LockEntry[]} files
 * @property {LockEntry[]} blocks
 * @property {LinkEntry[]} links
 * @property {JsonEntry[]} json
 * @property {string[]} excluded
 * @property {PendingEntry[]} pending JSON values left for a person to write.
 */

/**
 * @typedef {object} PlanContext
 * @property {string} repo
 * @property {Source} source
 * @property {string} commit
 * @property {Record<string, string>} maps
 * @property {Decisions} decisions
 * @property {Staging} staging Reads of file, block and JSON content go through it, so a step sees
 * what earlier steps of the same run write or remove. The checks for alternatives and skill links
 * read the disk: no step stages those paths.
 * @property {(target: string) => Declined | null} declined Whether the repo leaves a path out, and
 * the `--add` argument that installs it; see `declinedFiles`.
 * @property {readonly Pick<JsonItem, 'module' | 'target' | 'key' | 'values'>[]} contributions Every
 * JSON value the modules add, installed or being installed, so a new value lands after the others.
 */

/**
 * @param {PlanContext} context
 * @param {string} key
 * @returns {'overwrite' | 'keep' | null}
 */
function decisionFor(context, key) {
	if (keyMatchesAny(key, context.decisions.overwrite)) return 'overwrite';

	if (keyMatchesAny(key, context.decisions.keep)) return 'keep';

	return null;
}

/**
 * @param {PlanContext} context
 * @param {FileItem} file
 * @returns {Step}
 */
function planFile(context, file) {
	const content = readPayload(context.source, context.commit, file, context.maps);

	const step = {
		type: /** @type {const} */ ('file'),
		key: file.target,
		file,
		content
	};

	const decision = decisionFor(context, file.target);

	if (keyMatchesAny(file.target, context.decisions.skip)) return { ...step, action: 'skip' };

	if (context.staging.occupied(file.target)) {
		return {
			...step,
			action: 'collision',
			detail: 'something other than a file is in the way'
		};
	}

	const local = context.staging.read(file.target);

	if (local !== null && local === content) return { ...step, action: 'adopt' };

	if (local !== null) {
		if (decision === 'overwrite')
			return { ...step, action: 'write', detail: 'overwrote local file' };

		if (decision === 'keep') return { ...step, action: 'keep' };

		return { ...step, action: 'collision', detail: 'file exists with other content' };
	}

	const alternative = file.alternatives.find((other) => alternativeTaken(context.repo, other));

	if (!alternative) return { ...step, action: 'write' };

	if (decision === 'overwrite') {
		return {
			...step,
			action: 'write',
			detail: `replaces ${alternative}`,
			replaces: alternative
		};
	}

	if (decision === 'keep')
		return { ...step, action: 'skip', detail: `${alternative} configures the same tool` };

	return { ...step, action: 'collision', detail: `${alternative} configures the same tool` };
}

/**
 * @param {PlanContext} context
 * @param {LinkItem} link
 * @returns {Step}
 */
function planLink(context, link) {
	const step = { type: /** @type {const} */ ('link'), key: link.target, link };

	const skipped =
		keyMatchesAny(link.target, context.decisions.skip) ||
		keyMatchesAny(link.unit, context.decisions.skip);

	if (skipped) return { ...step, action: 'skip' };

	if (!pathTaken(context.repo, link.target)) return { ...step, action: 'write' };

	if (linkResolves(context.repo, link)) return { ...step, action: 'adopt' };

	const decision = decisionFor(context, link.target);

	if (decision === 'overwrite' && isSymlink(context.repo, link.target))
		return { ...step, action: 'write' };

	if (decision === 'keep') return { ...step, action: 'skip' };

	return { ...step, action: 'collision', detail: `exists and doesn't point at ${link.to}` };
}

/**
 * @param {PlanContext} context
 * @param {BlockItem} block
 * @returns {Step}
 */
function planBlock(context, block) {
	const content = normalizeBlock(
		readPayload(context.source, context.commit, block, context.maps)
	);

	const key = blockKey(block);
	const step = { type: /** @type {const} */ ('block'), key, block, content };

	if (keyMatchesAny(key, context.decisions.skip)) return { ...step, action: 'skip' };

	if (context.staging.occupied(block.target)) {
		return {
			...step,
			action: 'collision',
			detail: 'something other than a file is in the way'
		};
	}

	const text = context.staging.read(block.target);
	const found = text === null ? null : findBlock(text, block.style, block.module);

	if (found === 'malformed') {
		return {
			...step,
			action: 'collision',
			detail: 'house-rules markers are unpaired; fix them by hand'
		};
	}

	if (found === null) return { ...step, action: 'write' };

	if (found.content === content) return { ...step, action: 'adopt' };

	const decision = decisionFor(context, key);

	if (decision === 'overwrite')
		return { ...step, action: 'write', detail: 'overwrote local block' };

	if (decision === 'keep') return { ...step, action: 'keep' };

	return { ...step, action: 'collision', detail: 'block exists with other content' };
}

/**
 * @param {PlanContext} context
 * @param {JsonItem} json
 * @param {(target: string) => boolean} available Whether a path will exist once the run is done.
 * @returns {Step}
 */
function planJson(context, json, available) {
	const held = json.values.filter((value) => !(json.needs[value] ?? []).every(available));

	if (held.length === 0) return planValues(context, json);

	const detail = heldDetail(json, held, available, context.declined);
	const kept = json.values.filter((value) => !held.includes(value));

	if (kept.length === 0 && !keyMatchesAny(jsonKey(json), context.decisions.skip)) {
		return { type: 'json', key: jsonKey(json), json, action: 'hold', detail };
	}

	const step = planValues(context, { ...json, values: kept });

	return { ...step, detail: step.detail === undefined ? detail : `${step.detail}; ${detail}` };
}

/**
 * Explains why values wait: the install and update reports show it on the `held` entry, and an
 * update installs the values once the paths they name exist.
 *
 * @param {JsonItem} json
 * @param {readonly string[]} held The values that wait.
 * @param {(target: string) => boolean} available Whether a path will exist once the run is done.
 * @param {(target: string) => Declined | null} declined From `declinedFiles`.
 * @returns {string}
 */
export function heldDetail(json, held, available, declined) {
	const missing = [...new Set(held.flatMap((value) => json.needs[value] ?? []))].filter(
		(target) => !available(target)
	);

	const left = missing.filter((target) => declined(target) !== null);
	const adds = [...new Set(left.map((target) => declined(target)?.add))];

	const then =
		left.length > 0
			? `the repo left out ${left.join(', ')}; an update with --add ${adds.join(' --add ')} installs it`
			: 'an update adds it then';

	return `holds back ${held.join(', ')} until ${missing.join(', ')} exists; ${then}`;
}

/**
 * @param {PlanContext} context
 * @param {JsonItem} json
 * @returns {Step}
 */
function planValues(context, json) {
	const key = jsonKey(json);
	const step = { type: /** @type {const} */ ('json'), key, json };
	const change = describeChange([], json.values);

	if (keyMatchesAny(key, context.decisions.skip)) return { ...step, action: 'skip' };

	const file = parseJsonFile(context.staging.read(json.target));

	if (file.status === 'invalid') return { ...step, action: 'collision', detail: file.error };

	const alternative =
		file.status === 'missing'
			? json.alternatives.find((other) => alternativeTaken(context.repo, other))
			: undefined;

	if (alternative) {
		const decision = decisionFor(context, key);
		const detail = `${alternative} configures the same tool`;

		if (decision === 'keep') return { ...step, action: 'skip', detail };

		if (decision !== 'overwrite') return { ...step, action: 'collision', detail };

		return {
			...step,
			action: 'write',
			detail: `replaces ${alternative}`,
			replaces: alternative
		};
	}

	if (file.status === 'jsonc') {
		return {
			...step,
			action: 'manual',
			detail: `has comments; in "${json.key}", ${change}`
		};
	}

	if (file.status === 'json' && blocksContribution(file.value, json.key)) {
		return {
			...step,
			action: 'manual',
			detail: `"${json.key}" isn't an array; ${change}`
		};
	}

	return { ...step, action: 'write' };
}

/**
 * Decides, for each item, whether to write it, adopt an identical copy, keep a local one, or stop
 * on a collision. Reads the repo but changes nothing.
 * @param {PlanContext} context
 * @param {Pick<Payload, 'files' | 'links' | 'blocks' | 'json'>} items
 * @returns {Step[]}
 */
export function plan(context, items) {
	const files = items.files.map((file) => planFile(context, file));

	const installing = files.flatMap((step) =>
		['write', 'adopt', 'keep'].includes(step.action) ? [step.key] : []
	);

	/** @param {string} target */
	const available = (target) =>
		context.staging.exists(target) || installing.some((key) => keyMatches(key, target));

	return [
		...files,
		...items.links.map((link) => planLink(context, link)),
		...items.blocks.map((block) => planBlock(context, block)),
		...items.json.map((json) => planJson(context, json, available))
	];
}

/**
 * @param {Staging} staging
 * @param {BlockItem} block
 * @param {string} content
 * @returns {void}
 */
function stageBlock(staging, block, content) {
	const text = staging.read(block.target);

	if (text === null) {
		staging.write(
			block.target,
			scaffoldBlock(block.scaffold, block.style, block.module, content)
		);

		return;
	}

	const found = findBlock(text, block.style, block.module);

	const next =
		found && found !== 'malformed'
			? replaceBlock(text, found, block.style, block.module, content)
			: insertBlock(text, block.style, block.module, content);

	staging.write(block.target, next);
}

/**
 * @param {PlanContext} context
 * @param {JsonItem} json
 * @returns {void}
 */
function stageJson(context, json) {
	const { staging } = context;
	const text = staging.read(json.target) ?? json.scaffold;
	const parsed = parseJsonObject(text) ?? {};

	const shared = context.contributions.flatMap((other) =>
		other.module !== json.module && other.target === json.target && other.key === json.key
			? other.values
			: []
	);

	mergeContribution(parsed, json.key, [], json.values, shared);
	staging.write(json.target, formatJson(parsed, detectIndent(text)));
}

/**
 * @param {string} alternative A path, or `file#key` for a key in a JSON file.
 * @param {string} target
 * @returns {string} How to retire a config that `target` replaces.
 */
function retireHint(alternative, target) {
	const [file = alternative, key] = alternative.split('#');
	const action = key === undefined ? `delete ${file}` : `remove "${key}" from ${file}`;

	return `${action}: ${target} replaces it, and the tool reads only one config`;
}

/**
 * Stages every non-colliding step and returns the lock entries and report lines for them.
 * @param {PlanContext} context
 * @param {readonly Step[]} steps
 * @returns {{ installed: Installed, entries: ReportEntry[], next: string[] }} `next` lists the
 * configs to retire by hand.
 */
export function stage(context, steps) {
	/** @type {Installed} */
	const installed = { files: [], blocks: [], links: [], json: [], excluded: [], pending: [] };
	/** @type {ReportEntry[]} */
	const entries = [];
	/** @type {Set<string>} */
	const next = new Set();

	for (const step of steps) {
		const status = {
			write: 'written',
			adopt: 'adopted',
			keep: 'kept',
			skip: 'skipped',
			manual: 'manual',
			hold: 'held',
			collision: 'collision'
		}[step.action];

		/** @type {ReportEntry} */
		const entry = { status, target: step.key };

		if (step.detail) entry.detail = step.detail;

		entries.push(entry);

		if (step.action === 'collision') continue;

		if (step.action === 'skip') {
			installed.excluded.push(declinedPattern(context, step));
			continue;
		}

		recordStep(context, step, installed);

		const target = step.file?.target ?? step.json?.target;

		if (step.replaces && target) next.add(retireHint(step.replaces, target));
	}

	return { installed, entries, next: [...next] };
}

/**
 * @param {PlanContext} context
 * @param {Step} step A skipped step.
 * @returns {string} The `--skip` argument that declined the step, so upstream items added under it
 * later stay out too, or the step's key when a `--keep` declined it.
 */
function declinedPattern(context, step) {
	const keys = step.link ? [step.key, step.link.unit] : [step.key];

	const pattern = context.decisions.skip.find((candidate) =>
		keys.some((key) => keyMatches(key, candidate))
	);

	return pattern === undefined ? step.key : pattern.replace(/\/+$/, '');
}

/**
 * @param {PlanContext} context
 * @param {Step} step
 * @param {Installed} installed
 * @returns {void}
 */
function recordStep(context, step, installed) {
	const { staging } = context;
	const write = step.action === 'write';
	const content = step.content ?? '';

	if (step.file) {
		if (write) staging.write(step.file.target, content);

		installed.files.push({
			module: step.file.module,
			source: step.file.source,
			target: step.file.target,
			commit: context.commit,
			hash: hash(content)
		});
	}

	if (step.link) {
		if (write) staging.link(step.link);

		installed.links.push({
			module: step.link.module,
			target: step.link.target,
			to: step.link.to
		});
	}

	if (step.block) {
		if (write) stageBlock(staging, step.block, content);

		installed.blocks.push({
			module: step.block.module,
			source: step.block.source,
			target: step.block.target,
			commit: context.commit,
			hash: hash(content)
		});
	}

	if (step.json) {
		const { module, target, key, values } = step.json;

		if (write) stageJson(context, step.json);

		if (step.action === 'manual') {
			installed.pending.push({
				kind: 'manual',
				item: 'json',
				module,
				target,
				key,
				values,
				commit: context.commit
			});
		}

		installed.json.push({
			module,
			target,
			key,
			values: step.action === 'write' ? values : []
		});
	}
}
