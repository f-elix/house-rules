// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { isRecord, isString } from './decode.mjs';

/**
 * A JSON config file as read from the consumer. `jsonc` files have comments the engine can't keep,
 * so their contributions become manual actions.
 * @typedef {{ status: 'missing' }
 *   | { status: 'json', value: Record<string, unknown>, indent: string }
 *   | { status: 'jsonc', value: Record<string, unknown> }
 *   | { status: 'invalid', error: string }} JsonFile
 */

/**
 * Removes `//` and `/* *\/` comments outside strings.
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
	return text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) =>
		string ? match : ''
	);
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null} `null` when the text isn't a JSON object.
 */
export function parseJsonObject(text) {
	try {
		const value = JSON.parse(text);

		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * @param {string} text JSON, or JSONC with comments and trailing commas.
 * @returns {Record<string, unknown> | null} `null` when the text isn't a JSON object.
 */
export function parseJsoncObject(text) {
	return parseJsonObject(stripJsonComments(text).replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * @param {string} text
 * @returns {string} The indentation of the first indented key, or a tab.
 */
export function detectIndent(text) {
	return /^([ \t]+)"/m.exec(text)?.[1] ?? '\t';
}

/**
 * Says whether the engine can rewrite a consumer JSON file.
 * @param {string | null} text The file's content, or `null` when it's missing.
 * @returns {JsonFile}
 */
export function parseJsonFile(text) {
	if (text === null) return { status: 'missing' };

	const value = parseJsonObject(text);

	if (value) return { status: 'json', value, indent: detectIndent(text) };

	const commented = parseJsoncObject(text);

	if (commented) return { status: 'jsonc', value: commented };

	return { status: 'invalid', error: 'not a JSON object' };
}

/**
 * @param {string} file
 * @returns {JsonFile}
 */
export function readJsonFile(file) {
	return parseJsonFile(existsSync(file) ? readFileSync(file, 'utf8') : null);
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {string[]} The string entries of the array at `key`.
 */
export function stringsAt(value, key) {
	const array = value[key];

	return Array.isArray(array) ? array.filter(isString) : [];
}

/**
 * Applies an upstream change to a contributed array as a set: adds what upstream added and removes
 * what upstream removed, so values the consumer added or removed stay as they are. Added values
 * take the place of the first removed one, so a replaced `extends` entry keeps its precedence.
 * Otherwise they go right after the last value a module contributes, or first when there is none.
 * The repo's own values stay after them, and oxlint gives a later `extends` entry precedence.
 * @param {Record<string, unknown>} value Mutated. Its `key` must be absent or an array.
 * @param {string} key
 * @param {readonly string[]} base Values at the commit the consumer last took.
 * @param {readonly string[]} incoming
 * @param {readonly string[]} shared Values other modules still contribute to `key`; never removed.
 * @returns {{ added: string[], removed: string[] }} What changed in `value`.
 */
export function mergeContribution(value, key, base, incoming, shared) {
	const current = Array.isArray(value[key]) ? value[key] : [];
	const dropped = base.filter((item) => !incoming.includes(item) && !shared.includes(item));
	/** @param {unknown} item */
	const isDropped = (item) => isString(item) && dropped.includes(item);
	/** @param {unknown} item */
	const isManaged = (item) => isString(item) && (base.includes(item) || shared.includes(item));
	const removed = current.filter(isDropped);
	const kept = current.filter((item) => !isDropped(item));
	const added = incoming.filter((item) => !base.includes(item) && !kept.includes(item));

	const slot =
		removed.length > 0 ? current.findIndex(isDropped) : kept.findLastIndex(isManaged) + 1;

	if (added.length > 0 || removed.length > 0) {
		value[key] = [...kept.slice(0, slot), ...added, ...kept.slice(slot)];
	}

	return { added, removed: removed.filter(isString) };
}

/**
 * @param {readonly string[]} base
 * @param {readonly string[]} incoming
 * @returns {string} The edit that turns `base` into `incoming`, such as `add "a"; remove "b"`.
 */
export function describeChange(base, incoming) {
	const added = incoming.filter((item) => !base.includes(item));
	const removed = base.filter((item) => !incoming.includes(item));

	return [
		...(added.length > 0
			? [`add ${added.map((item) => JSON.stringify(item)).join(', ')}`]
			: []),
		...(removed.length > 0
			? [`remove ${removed.map((item) => JSON.stringify(item)).join(', ')}`]
			: [])
	].join('; ');
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {boolean} Whether `key` holds something other than an array, which the engine won't touch.
 */
export function blocksContribution(value, key) {
	return value[key] !== undefined && !Array.isArray(value[key]);
}

/** The line width and tab width of this repo's `.prettierrc`, the style the payload is formatted in. */
const PRINT_WIDTH = 100;

const TAB_WIDTH = 4;

/**
 * @param {unknown} value
 * @returns {string | null} `value` on one line, or `null` when Prettier would break it: a non-empty
 * object, which this printer always expands, or two or more arrays that each hold more than one item.
 */
function printFlat(value) {
	if (Array.isArray(value)) {
		if (value.length > 1 && value.every((item) => Array.isArray(item) && item.length > 1))
			return null;

		const items = value.map(printFlat);

		return items.every(isString) ? `[${items.join(', ')}]` : null;
	}

	if (isRecord(value)) return Object.keys(value).length === 0 ? '{}' : null;

	return JSON.stringify(value);
}

/**
 * Prints a JSON object the way Prettier does under this repo's `.prettierrc`: one key per line,
 * and an array on one line when it fits and Prettier wouldn't break it.
 * @param {Record<string, unknown>} value
 * @param {string} indent
 * @returns {string}
 */
export function formatJson(value, indent) {
	return `${printJson(value, indent, 0, 0, 0)}\n`;
}

/**
 * @param {unknown} value
 * @param {string} indent
 * @param {number} depth
 * @param {number} column Where `value` starts on its line, with tabs counted as {@link TAB_WIDTH}.
 * @param {number} after Characters after `value` on its line: 1 for a comma, otherwise 0.
 * @returns {string}
 */
function printJson(value, indent, depth, column, after) {
	const inner = indent.repeat(depth + 1);
	const innerColumn = inner.replaceAll('\t', ' '.repeat(TAB_WIDTH)).length;
	const close = `\n${indent.repeat(depth)}`;

	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';

		const flat = printFlat(value);

		if (flat !== null && column + flat.length + after <= PRINT_WIDTH) return flat;

		const items = value.map((item, index) => {
			const comma = index < value.length - 1 ? ',' : '';

			return `${inner}${printJson(item, indent, depth + 1, innerColumn, comma.length)}${comma}`;
		});

		return `[\n${items.join('\n')}${close}]`;
	}

	if (isRecord(value)) {
		const entries = Object.entries(value);

		if (entries.length === 0) return '{}';

		const lines = entries.map(([key, item], index) => {
			const name = `${JSON.stringify(key)}: `;
			const comma = index < entries.length - 1 ? ',' : '';

			const printed = printJson(
				item,
				indent,
				depth + 1,
				innerColumn + name.length,
				comma.length
			);

			return `${inner}${name}${printed}${comma}`;
		});

		return `{\n${lines.join('\n')}${close}}`;
	}

	return JSON.stringify(value);
}
