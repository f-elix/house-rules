import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	createConsumer,
	createUpstream,
	ENV,
	git,
	lines,
	parseReport,
	type Report,
	ROOT,
	tempDir,
	TempRepo
} from './helpers.ts';

const BOOTSTRAP = path.join(ROOT, 'skills', 'house-rules', 'scripts', 'run.mjs');

type Bootstrapped = {
	status: number;
	/** `null` when the engine never ran. */
	report: Report | null;
	stderr: string;
};

/** Runs the bootstrap from inside `repo`, the way the skill does. */
function bootstrap(repo: TempRepo, ...args: string[]): Bootstrapped {
	const result = spawnSync(process.execPath, [BOOTSTRAP, ...args, '--json'], {
		cwd: repo.dir,
		env: ENV,
		encoding: 'utf8'
	});

	return {
		status: result.status ?? -1,
		report: result.stdout ? parseReport(result.stdout) : null,
		stderr: result.stderr
	};
}

describe('the bootstrap', () => {
	const upstream = createUpstream();

	cpSync(path.join(ROOT, 'scripts'), path.join(upstream.dir, 'scripts'), { recursive: true });
	upstream.commit('engine');

	it('clones a local checkout at the ref and runs its engine', () => {
		const consumer = createConsumer();

		upstream.write({ 'payload/docs/a.md': 'uncommitted\n' });

		// A repeated flag counts once, the last time, the way the engine reads it.
		const { status, report, stderr } = bootstrap(
			consumer,
			'install',
			'--source',
			`file://${path.join(tempDir(), 'missing')}`,
			'--source',
			upstream.dir
		);

		git(upstream.dir, 'checkout', '--', 'payload/docs/a.md');
		assert.equal(status, 0);
		assert.equal(stderr, '');
		assert.equal(report?.status, 'installed');
		assert.equal(consumer.lock().source.url, upstream.dir);
		assert.match(report?.next.join('\n') ?? '', /records the local path .* as the source/);
		assert.equal(consumer.read('docs/rules/a.md'), lines(), 'uncommitted changes stay out');
	});

	it('clones a URL, records it, and reuses it from the lockfile', () => {
		const consumer = createConsumer();
		const url = `file://${upstream.dir}`;
		const installed = bootstrap(consumer, 'install', '--source', url);

		assert.equal(installed.report?.status, 'installed');
		assert.equal(consumer.lock().source.url, url);
		consumer.commit('install');
		upstream.write({ 'payload/docs/a.md': lines([2, 'two']) }).commit();

		const checked = bootstrap(consumer, 'check');

		assert.equal(checked.status, 0);
		assert.equal(checked.report?.status, 'warnings');

		const updated = bootstrap(consumer, 'update');

		assert.equal(updated.report?.status, 'updated');
		assert.equal(consumer.read('docs/rules/a.md'), lines([2, 'two']));
	});

	it("fails without running anything when it can't fetch the source", () => {
		const consumer = createConsumer();
		const missing = `file://${path.join(tempDir(), 'missing')}`;

		const { status, report, stderr } = bootstrap(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--source',
			missing
		);

		assert.equal(status, 1);
		assert.equal(report, null);
		assert.match(
			stderr,
			/^house-rules: couldn't fetch main from file:\/\/.*\/missing\n.*fatal: /s
		);
		assert.equal(consumer.exists('house-rules.lock.json'), false);
	});

	it("fails without running anything when it can't read the lockfile's source", () => {
		const consumer = createConsumer({ 'house-rules.lock.json': '{ "version": 1 }\n' });
		const { status, report, stderr } = bootstrap(consumer, 'check', '--offline');

		assert.equal(status, 1);
		assert.equal(report, null);
		assert.equal(
			stderr,
			'house-rules: house-rules.lock.json has no source.url and source.ref\n'
		);
	});
});

describe('an engine run from its own checkout', () => {
	const upstream = createUpstream();

	cpSync(path.join(ROOT, 'scripts'), path.join(upstream.dir, 'scripts'), { recursive: true });
	upstream.commit('engine');

	const url = `file://${upstream.dir}`;
	const checkout = path.join(tempDir(), 'checkout');

	git(path.dirname(checkout), 'clone', '--quiet', url, checkout);

	/** Runs the checkout's engine with no `--source`, as a developer would. */
	function runCheckout(consumer: TempRepo): Report {
		const engine = path.join(checkout, 'scripts', 'house-rules.mjs');

		const result = spawnSync(
			process.execPath,
			[engine, 'install', '--repo', consumer.dir, '--json'],
			{ env: ENV, encoding: 'utf8' }
		);

		return parseReport(result.stdout);
	}

	it('records the origin URL for a commit the origin has', () => {
		const consumer = createConsumer();

		assert.equal(runCheckout(consumer).status, 'installed');
		assert.equal(consumer.lock().source.url, url);
	});

	it("records the checkout's path for a commit the origin doesn't have", () => {
		const consumer = createConsumer();

		writeFileSync(path.join(checkout, 'payload', 'docs', 'a.md'), 'unpushed\n');
		git(checkout, 'commit', '--quiet', '--all', '-m', 'unpushed');

		const report = runCheckout(consumer);

		assert.equal(report.status, 'installed');
		assert.equal(consumer.lock().source.url, checkout);
		assert.match(report.next.join('\n'), /records the local path .* as the source/);
	});
});
