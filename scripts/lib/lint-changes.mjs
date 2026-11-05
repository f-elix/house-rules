// @ts-check
import { isRecord } from './decode.mjs';
import { parseJsoncObject } from './jsonc.mjs';

/**
 * A policy change in an oxlint config: the user approves it before it stays.
 * @typedef {object} LintChange
 * @property {string} target
 * @property {'rule' | 'category' | 'setting'} type A `setting` is any other top-level key, such as
 * `plugins`, `jsPlugins`, `overrides`, `settings` or `env`.
 * @property {string} name The rule, category or key.
 * @property {string | null} from Severity for a rule or category, else the value as JSON.
 * @property {string | null} to
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOrEmpty(value) {
	return isRecord(value) ? value : {};
}

/**
 * Describes a rule setting: its severity, plus its options when it has any.
 * @param {unknown} setting
 * @returns {string | null}
 */
function describeRule(setting) {
	if (setting === undefined) return null;

	if (!Array.isArray(setting)) return JSON.stringify(setting).replaceAll('"', '');

	const [severity, ...options] = setting;
	const label = JSON.stringify(severity).replaceAll('"', '');

	return options.length > 0 ? `${label} ${JSON.stringify(options)}` : label;
}

/**
 * @param {string} target
 * @param {'rule' | 'category'} type
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {LintChange[]}
 */
function diffSettings(target, type, before, after) {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);

	return [...names].flatMap((name) => {
		const from = describeRule(before[name]);
		const to = describeRule(after[name]);

		return from === to ? [] : [{ target, type, name, from, to }];
	});
}

/**
 * Lists the changes between two versions of an oxlint config: each rule and category, and every
 * other top-level key except `$schema`.
 * @param {string} target
 * @param {string} baseText
 * @param {string} incomingText
 * @returns {LintChange[]}
 */
export function diffOxlintConfig(target, baseText, incomingText) {
	const base = parseJsoncObject(baseText) ?? {};
	const incoming = parseJsoncObject(incomingText) ?? {};

	/** @type {LintChange[]} */
	const changes = [
		...diffSettings(target, 'rule', recordOrEmpty(base.rules), recordOrEmpty(incoming.rules)),
		...diffSettings(
			target,
			'category',
			recordOrEmpty(base.categories),
			recordOrEmpty(incoming.categories)
		)
	];

	const settings = new Set([...Object.keys(base), ...Object.keys(incoming)]);

	for (const key of ['$schema', 'rules', 'categories']) settings.delete(key);

	for (const key of settings) {
		const from = base[key] === undefined ? null : JSON.stringify(base[key]);
		const to = incoming[key] === undefined ? null : JSON.stringify(incoming[key]);

		if (from !== to) changes.push({ target, type: 'setting', name: key, from, to });
	}

	return changes;
}
