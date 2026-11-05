import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { format, resolveConfig } from 'prettier';
import { formatJson } from '../scripts/lib/jsonc.mjs';
import { ROOT } from './helpers.ts';

/** A file at the root of this repo, so Prettier resolves its `.prettierrc`. */
const FILE = path.join(ROOT, 'config.json');

const CASES = [
	{ extends: ['./tools/oxlint/core.json'] },
	{ rules: { a: ['error', []] } },
	{ rules: { a: ['error', ['a']] } },
	{ rules: { a: ['error', {}] } },
	{ rules: { a: ['error', { allow: ['x', 'y'] }] } },
	{ a: [{}], b: [[]], c: [[], []], d: [{}, {}] },
	{ a: [['a'], ['b']], b: [['a', 'b'], ['c']], c: [['a', 'b'], {}] },
	{
		a: [
			['a', 'b'],
			['c', 'd']
		],
		b: [
			[1, 2],
			[3, 4]
		],
		c: [
			[
				['a', 'b'],
				['c', 'd']
			]
		]
	},
	{ a: [{ x: 1 }], b: [{ x: 1 }, { y: 2 }] },
	{ a: [null, true, false, 1.5, 'x'], b: ['error', [], {}, ['q']] },
	{ a: ['x'.repeat(40), ['y'.repeat(40), 'z'.repeat(30)]] },
	{ a: [['y'.repeat(40), 'z'.repeat(30)], 'x'.repeat(40)] },
	{ ignorePatterns: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(6)] },
	{ ignorePatterns: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(7)] },
	{ overrides: [{ files: ['*.ts'], rules: { a: 'off' } }] }
];

describe('the JSON printer', () => {
	for (const value of CASES) {
		it(`prints ${JSON.stringify(value)} the way Prettier does`, async () => {
			const printed = formatJson(value, '\t');
			const config = await resolveConfig(FILE);

			assert.equal(await format(printed, { ...config, filepath: FILE }), printed);
		});
	}
});
