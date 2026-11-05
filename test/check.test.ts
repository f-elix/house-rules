import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createUpstream, engine, entryFor, git, installed, lines, tempDir } from './helpers.ts';

describe('check', () => {
	it('passes on a fresh install', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const { status, report } = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'ok');
		assert.ok(report.entries.every((entry) => entry.status === 'ok'));
	});

	it('reports local modifications as information', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({
			'docs/rules/a.md': lines([1, 'local']),
			'AGENTS.md': consumer.read('AGENTS.md').replace('Read', 'Always read'),
			'.oxlintrc.json': '{ "extends": [] }\n'
		});

		const { status, report } = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'ok');
		assert.equal(entryFor(report, 'docs/rules/a.md').status, 'modified');
		assert.equal(entryFor(report, 'AGENTS.md#core').status, 'modified');
		assert.equal(
			entryFor(report, '.oxlintrc.json#extends#core').detail,
			'without ./tools/lint.json'
		);
	});

	it('fails on missing files, removed markers, conflict markers and broken links', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.remove('docs/rules/b.md', '.agents/skills/demo');
		consumer.write({
			'docs/rules/a.md': '<<<<<<< local\na\n=======\nb\n>>>>>>> incoming\n',
			'.prettierignore': 'tools\n'
		});

		const { status, report } = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(status, 1);
		assert.equal(report.status, 'failed');
		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'missing');
		assert.equal(entryFor(report, 'docs/rules/a.md').status, 'markers');
		assert.equal(entryFor(report, '.claude/skills/demo').status, 'broken-link');
		assert.equal(entryFor(report, '.prettierignore#core').detail, 'markers are missing');
	});

	it('fails on a base section left from a three-way conflict', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ 'docs/rules/a.md': `${lines()}||||||| base\nold\n=======\n` });

		const { status, report } = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(status, 1);
		assert.equal(entryFor(report, 'docs/rules/a.md').status, 'markers');
	});

	it('warns when the locked commit is behind its ref, and fails with --strict', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({ 'payload/docs/a.md': lines([2, 'two']) }).commit();
		upstream.write({ 'payload/docs/a.md': lines([3, 'three']) }).commit();

		const warned = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(warned.status, 0);
		assert.equal(warned.report.status, 'warnings');
		assert.equal(
			entryFor(warned.report, 'house-rules.lock.json').detail,
			'2 commits behind main; run `update`'
		);

		const strict = engine(consumer, 'check', '--source', upstream.dir, '--strict');

		assert.equal(strict.status, 1);
		assert.equal(strict.report.status, 'failed');
		assert.equal(
			engine(consumer, 'check', '--source', upstream.dir, '--offline').report.status,
			'ok'
		);
	});

	it('warns when the locked commit left its ref, or the ref is gone', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'commit', '--quiet', '--amend', '-m', 'rewritten');

		const diverged = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(diverged.report.status, 'warnings');
		assert.equal(entryFor(diverged.report, 'house-rules.lock.json').status, 'diverged');

		git(upstream.dir, 'branch', '--quiet', '-m', 'main', 'trunk');

		const gone = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(gone.report.status, 'warnings');
		assert.deepEqual(entryFor(gone.report, 'house-rules.lock.json'), {
			status: 'unknown-ref',
			target: 'house-rules.lock.json',
			detail: `main isn't in ${upstream.dir}`
		});
	});

	it('warns when the source is unreachable', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const gone = path.join(tempDir(), 'gone');

		const { status, report } = engine(consumer, 'check', '--source', `file://${gone}`);

		assert.equal(status, 0);
		assert.equal(entryFor(report, 'house-rules.lock.json').status, 'unreachable');
		rmSync(gone, { recursive: true, force: true });
	});

	it('refuses without a lockfile', () => {
		const upstream = createUpstream();
		const { status, report } = engine(upstream, 'check', '--offline');

		assert.equal(status, 1);
		assert.equal(report.status, 'refused');
	});
});
