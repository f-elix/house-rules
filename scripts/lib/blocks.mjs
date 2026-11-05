// @ts-check

/** @typedef {import('./manifest.mjs').BlockStyle} BlockStyle */

/**
 * @typedef {object} FoundBlock
 * @property {string} content Normalized with {@link normalizeBlock}.
 * @property {number} start Line index of the start marker.
 * @property {number} end Line index of the end marker.
 */

/**
 * @param {BlockStyle} style
 * @param {string} module
 * @returns {{ start: string, end: string }}
 */
export function markers(style, module) {
	if (style === 'markdown') {
		return {
			start: `<!-- house-rules:${module}:start -->`,
			end: `<!-- house-rules:${module}:end -->`
		};
	}

	return { start: `# house-rules:${module}:start`, end: `# house-rules:${module}:end` };
}

/**
 * Drops leading and trailing blank lines, and ends non-empty content with one newline, so a block
 * compares equal however the host file's formatter spaced it.
 * @param {string} content
 * @returns {string}
 */
export function normalizeBlock(content) {
	const trimmed = content.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');

	return trimmed === '' ? '' : `${trimmed}\n`;
}

/**
 * @param {string} text
 * @param {BlockStyle} style
 * @param {string} module
 * @returns {FoundBlock | 'malformed' | null} `null` when the markers are absent, `malformed` when one
 * is missing, repeated or out of order.
 */
export function findBlock(text, style, module) {
	const { start, end } = markers(style, module);
	const lines = text.split('\n');
	const starts = lines.flatMap((line, index) => (line.trim() === start ? [index] : []));
	const ends = lines.flatMap((line, index) => (line.trim() === end ? [index] : []));

	if (starts.length === 0 && ends.length === 0) return null;

	const [first] = starts;
	const [last] = ends;

	if (starts.length !== 1 || ends.length !== 1 || first === undefined || last === undefined) {
		return 'malformed';
	}

	if (last < first) return 'malformed';

	return {
		content: normalizeBlock(lines.slice(first + 1, last).join('\n')),
		start: first,
		end: last
	};
}

/**
 * Finds a block in either marker style, for commands that run without the manifest.
 * @param {string} text
 * @param {string} module
 * @returns {FoundBlock | 'malformed' | null}
 */
export function findAnyBlock(text, module) {
	return findBlock(text, 'markdown', module) ?? findBlock(text, 'hash', module);
}

/**
 * @param {BlockStyle} style
 * @param {string} module
 * @param {string} content Normalized block content.
 * @returns {string} The block with its markers, without a trailing newline.
 */
function formatBlock(style, module, content) {
	const { start, end } = markers(style, module);

	if (style === 'hash') return `${start}\n${content}${end}`;

	return content === '' ? `${start}\n\n${end}` : `${start}\n\n${content}\n${end}`;
}

/**
 * Replaces the block `found` points at with `content`, between fresh markers.
 * @param {string} text
 * @param {FoundBlock} found
 * @param {BlockStyle} style
 * @param {string} module
 * @param {string} content
 * @returns {string}
 */
export function replaceBlock(text, found, style, module, content) {
	const lines = text.split('\n');

	return [
		...lines.slice(0, found.start),
		formatBlock(style, module, content),
		...lines.slice(found.end + 1)
	].join('\n');
}

/**
 * Adds a block after the file's last house-rules block, or at the end when it has none.
 * @param {string} text
 * @param {BlockStyle} style
 * @param {string} module
 * @param {string} content
 * @returns {string}
 */
export function insertBlock(text, style, module, content) {
	const block = formatBlock(style, module, content);
	const separator = style === 'markdown' ? '\n' : '';
	const lines = text.split('\n');

	const anyEnd =
		style === 'markdown' ? /^<!-- house-rules:[\w-]+:end -->$/ : /^# house-rules:[\w-]+:end$/;

	const lastEnd = lines.findLastIndex((line) => anyEnd.test(line.trim()));

	if (lastEnd !== -1) {
		return [
			...lines.slice(0, lastEnd + 1),
			`${separator}${block}`,
			...lines.slice(lastEnd + 1)
		].join('\n');
	}

	const body = text.replace(/\s+$/, '');

	return body === '' ? `${block}\n` : `${body}\n${separator}${block}\n`;
}

/**
 * @param {string} scaffold Contains `{{block}}`.
 * @param {BlockStyle} style
 * @param {string} module
 * @param {string} content
 * @returns {string}
 */
export function scaffoldBlock(scaffold, style, module, content) {
	return scaffold.replace('{{block}}', () => formatBlock(style, module, content));
}
