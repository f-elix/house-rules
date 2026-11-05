// @ts-check
/* oxlint-disable anti-slop/no-runtime-typeof -- this module is the JSON decoding boundary for modules.json and the lockfile */

/** Thrown when a file the engine reads isn't JSON, or doesn't match the structure it expects. */
export class DecodeError extends Error {}

/**
 * Parses JSON, or throws a {@link DecodeError} naming the file.
 * @param {string} text
 * @param {string} path The file, for the error message.
 * @returns {unknown}
 */
export function decodeJson(text, path) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new DecodeError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Decodes an integer, or throws a {@link DecodeError} naming `path`.
 * @param {unknown} value
 * @param {string} path
 * @returns {number}
 */
export function decodeInteger(value, path) {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new DecodeError(`${path}: expected an integer`);
	}

	return value;
}

/**
 * Rejects keys outside `allowed`, so a misspelled key fails instead of being ignored.
 * @param {Record<string, unknown>} raw
 * @param {readonly string[]} allowed
 * @param {string} path
 * @returns {Record<string, unknown>} `raw`.
 */
export function decodeKeys(raw, allowed, path) {
	const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));

	if (unknown.length > 0) throw new DecodeError(`${path}: unknown keys ${unknown.join(', ')}`);

	return raw;
}

/**
 * Decodes a string, or throws a {@link DecodeError} naming `path`.
 * @param {unknown} value
 * @param {string} path Where the value sits, for the error message.
 * @returns {string}
 */
export function decodeString(value, path) {
	if (typeof value !== 'string') throw new DecodeError(`${path}: expected a string`);

	return value;
}

/**
 * Decodes a boolean, or throws a {@link DecodeError} naming `path`.
 * @param {unknown} value
 * @param {string} path
 * @returns {boolean}
 */
export function decodeBoolean(value, path) {
	if (typeof value !== 'boolean') throw new DecodeError(`${path}: expected a boolean`);

	return value;
}

/**
 * Decodes a string that may be absent.
 * @param {unknown} value
 * @param {string} path
 * @returns {string | undefined}
 */
export function decodeOptionalString(value, path) {
	return value === undefined ? undefined : decodeString(value, path);
}

/**
 * Decodes an array, leaving its items to the caller.
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown[]}
 */
export function decodeArray(value, path) {
	if (!Array.isArray(value)) throw new DecodeError(`${path}: expected an array`);

	return value;
}

/**
 * Decodes an array of strings.
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
export function decodeStringArray(value, path) {
	return decodeArray(value, path).map((item, index) => decodeString(item, `${path}[${index}]`));
}

/**
 * Decodes an optional string list. An absent value decodes to an empty list.
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
export function decodeOptionalStringArray(value, path) {
	return value === undefined ? [] : decodeStringArray(value, path);
}

/**
 * Decodes a plain object (not null or an array) into a shallow copy.
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function decodeRecord(value, path) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new DecodeError(`${path}: expected an object`);
	}

	return Object.fromEntries(Object.entries(value));
}

/**
 * Decodes an optional object of string values. An absent value decodes to an empty object.
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, string>}
 */
export function decodeOptionalStringRecord(value, path) {
	const record = value === undefined ? {} : decodeRecord(value, path);

	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [key, decodeString(item, `${path}.${key}`)])
	);
}

/**
 * Narrows a JSON value read from a consumer's config file, where any shape is legal.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isString(value) {
	return typeof value === 'string';
}

/**
 * Narrows a JSON value read from a consumer's config file to a plain object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
