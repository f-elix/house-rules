import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	createConsumer,
	createUpstream,
	engine,
	ENV,
	installed,
	ROOT,
	tempDir
} from './helpers.ts';

type Output = {
	status: number;
	stdout: string;
	stderr: string;
};

/** Runs the engine without `--json`, keeping stdout and stderr apart. */
function raw(...args: string[]): Output {
	const result = spawnSync(
		process.execPath,
		[path.join(ROOT, 'scripts', 'house-rules.mjs'), ...args],
		{
			env: ENV,
			encoding: 'utf8'
		}
	);

	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('the command line', () => {
	const upstream = createUpstream();
	const consumer = installed(upstream);

	it('prints a short text report by default', () => {
		const { status, stdout } = raw('check', '--offline', '--repo', consumer.dir);

		assert.equal(status, 0);
		assert.match(stdout, /^house-rules check: ok at [0-9a-f]{7} \(main, /);
	});

	it("rejects options the command doesn't take", () => {
		const { status, stderr } = raw('update', '--modules', 'core', '--repo', consumer.dir);

		assert.equal(status, 1);
		assert.match(stderr, /^update doesn't take --modules/);
	});

	it('reports usage mistakes as errors', () => {
		const { status, report } = engine(consumer, 'resolve');

		assert.equal(status, 1);
		assert.equal(report.status, 'error');
		assert.deepEqual(report.next, ['resolve needs at least one target']);
	});

	it('keeps --map inside the repo', () => {
		const { status, report } = engine(
			createConsumer(),
			'install',
			'--source',
			upstream.dir,
			'--map',
			'docs=../docs'
		);

		assert.equal(status, 1);
		assert.deepEqual(report.next, ['--map docs=../docs: both paths must stay inside the repo']);
	});

	it('refuses a --map with more than one =', () => {
		const { status, report } = engine(
			createConsumer(),
			'install',
			'--source',
			upstream.dir,
			'--map',
			'docs=notes=old'
		);

		assert.equal(status, 1);
		assert.deepEqual(report.next, ['--map expects one from=to pair, got docs=notes=old']);
	});

	it("removes its temporary clone when it can't clone the source", () => {
		const temp = tempDir();
		const missing = `file://${path.join(tempDir(), 'missing')}`;

		const result = spawnSync(
			process.execPath,
			[
				path.join(ROOT, 'scripts', 'house-rules.mjs'),
				'install',
				'--source',
				missing,
				'--json'
			],
			{ cwd: createConsumer().dir, env: { ...ENV, TMPDIR: temp }, encoding: 'utf8' }
		);

		assert.equal(result.status, 1);
		assert.deepEqual(readdirSync(temp), []);
	});

	it("reports a lockfile it can't read", () => {
		const lock = consumer.read('house-rules.lock.json');

		consumer.write({ 'house-rules.lock.json': lock.replace('"version": 1', '"version": 2') });

		const { status, report } = engine(consumer, 'check', '--offline');

		consumer.write({ 'house-rules.lock.json': lock });
		assert.equal(status, 1);
		assert.deepEqual(report.next, [
			'house-rules.lock.json: version 2 needs a newer house-rules engine (this one reads up to 1); rerun with a newer --ref'
		]);
	});

	it('names the lockfile when one of its fields is wrong', () => {
		const lock = consumer.read('house-rules.lock.json');

		consumer.write({
			'house-rules.lock.json': lock.replace('"module": "core"', '"module": 1')
		});

		const { status, report } = engine(consumer, 'check', '--offline');

		consumer.write({ 'house-rules.lock.json': lock });
		assert.equal(status, 1);
		assert.match(
			report.next.join('\n'),
			/^house-rules\.lock\.json: \w+\[0\]\.module: expected a string$/
		);
	});
});
