// @ts-check
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isRecord, isString } from './decode.mjs';
import { readJsonFile } from './jsonc.mjs';
import { keyMatches } from './render.mjs';

/** @typedef {import('./manifest.mjs').Requirements} Requirements */
/** @typedef {import('./manifest.mjs').Payload} Payload */

/**
 * Something the modules need that the engine reports instead of changing: a devDependency, a
 * `package.json` script, a file or a field.
 * @typedef {object} Requirement
 * @property {'devDependency' | 'script' | 'prerequisite'} type
 * @property {string} name
 * @property {string} wanted
 * @property {string | null} found
 */

/**
 * @param {Record<string, unknown>} pkg
 * @param {string} field
 * @returns {Record<string, string>}
 */
function stringMap(pkg, field) {
	const value = pkg[field];

	/** @type {Record<string, string>} */
	const strings = {};

	if (!isRecord(value)) return strings;

	for (const [name, version] of Object.entries(value)) {
		if (isString(version)) strings[name] = version;
	}

	return strings;
}

/**
 * Drops the devDependencies and scripts that serve only files the repo doesn't track, such as a
 * Prettier plugin when the repo keeps its own Prettier config.
 * @param {Payload} payload
 * @param {ReadonlySet<string>} tracked The targets the lock tracks once the run is done.
 * @returns {Requirements}
 */
export function servedRequirements(payload, tracked) {
	const { serves } = payload.requirements;

	/** @param {string} served A default target, or a folder of them. */
	const present = (served) =>
		payload.files.some(
			(file) => keyMatches(file.defaultTarget, served) && tracked.has(file.target)
		);

	/** @param {Record<string, string>} record */
	const keep = (record) =>
		Object.fromEntries(
			Object.entries(record).filter(([name]) => serves[name]?.some(present) ?? true)
		);

	return {
		...payload.requirements,
		devDependencies: keep(payload.requirements.devDependencies),
		scripts: keep(payload.requirements.scripts)
	};
}

/**
 * Lists the requirements the consumer doesn't meet. A devDependency pinned to an exact version also
 * counts as unmet when the consumer has another version.
 * @param {string} repo
 * @param {Requirements} requirements
 * @returns {Requirement[]}
 */
export function unmetRequirements(repo, requirements) {
	const file = readJsonFile(path.join(repo, 'package.json'));
	const pkg = file.status === 'json' || file.status === 'jsonc' ? file.value : {};
	const installed = { ...stringMap(pkg, 'dependencies'), ...stringMap(pkg, 'devDependencies') };
	const scripts = stringMap(pkg, 'scripts');
	/** @type {Requirement[]} */
	const unmet = [];

	for (const [name, wanted] of Object.entries(requirements.devDependencies)) {
		const found = installed[name] ?? null;
		const exact = /^\d+\.\d+\.\d+$/.test(wanted);

		if (found === null || (exact && found !== wanted)) {
			unmet.push({ type: 'devDependency', name, wanted, found });
		}
	}

	for (const [name, wanted] of Object.entries(requirements.scripts)) {
		if (scripts[name] === undefined) unmet.push({ type: 'script', name, wanted, found: null });
	}

	for (const prerequisite of requirements.prerequisites) {
		const name = prerequisite.path ?? `package.json#${prerequisite.field ?? ''}`;

		const met = prerequisite.path
			? existsSync(path.join(repo, prerequisite.path))
			: pkg[prerequisite.field ?? ''] !== undefined;

		if (!met) unmet.push({ type: 'prerequisite', name, wanted: prerequisite.why, found: null });
	}

	return unmet;
}

/**
 * @typedef {object} RequirementChange
 * @property {'devDependency' | 'script'} type
 * @property {string} name
 * @property {string | null} from
 * @property {string | null} to
 */

/**
 * @param {'devDependency' | 'script'} type
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 * @returns {RequirementChange[]}
 */
function diffMap(type, before, after) {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);

	return [...names].flatMap((name) => {
		const from = before[name] ?? null;
		const to = after[name] ?? null;

		return from === to ? [] : [{ type, name, from, to }];
	});
}

/**
 * The devDependency and script changes between two versions of the requirements.
 * @param {Requirements} before
 * @param {Requirements} after
 * @returns {RequirementChange[]}
 */
export function diffRequirements(before, after) {
	return [
		...diffMap('devDependency', before.devDependencies, after.devDependencies),
		...diffMap('script', before.scripts, after.scripts)
	];
}
