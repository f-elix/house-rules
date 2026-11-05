import assert from 'node:assert/strict';
import { readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { writeLock } from '../scripts/lib/lock.mjs';
import {
	createConsumer,
	createUpstream,
	editManifest,
	engine,
	entryFor,
	git,
	installed,
	lines,
	sha,
	type TempRepo
} from './helpers.ts';

const A = 'docs/rules/a.md';

describe('update', () => {
	it('takes upstream changes to files the repo left alone', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const from = consumer.lock().source.commit;
		const to = upstream.write({ 'payload/docs/a.md': lines([2, 'two']) }).commit();
		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'updated');
		assert.deepEqual(report.source, { url: upstream.dir, ref: 'main', commit: to, from });
		assert.equal(entryFor(report, A).status, 'updated');
		assert.equal(consumer.read(A), lines([2, 'two']));

		const lock = consumer.lock();
		const entry = lock.files.find((candidate) => candidate.target === A);

		assert.equal(lock.source.commit, to);
		assert.deepEqual([entry?.commit, entry?.hash], [to, sha(lines([2, 'two']))]);
	});

	it('names a change of source in the report', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const url = `file://${upstream.dir}`;
		const { report } = engine(consumer, 'update', '--source', url);

		assert.equal(report.status, 'up-to-date');
		assert.ok(
			report.next.includes(
				`the lockfile's source changes from ${upstream.dir} to ${url}; rerun with --source ${upstream.dir} to keep it`
			)
		);
		assert.equal(consumer.lock().source.url, url);
	});

	it('keeps local changes when upstream left the file alone', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ [A]: lines([1, 'local']) }).commit();
		upstream.write({ 'payload/.prettierrc': '{ "useTabs": false }\n' }).commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(report, A).status, 'kept');
		assert.equal(entryFor(report, '.prettierrc').status, 'updated');
		assert.equal(consumer.read(A), lines([1, 'local']));
	});

	it('merges local and upstream changes to different lines', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ [A]: lines([1, 'local']) }).commit();
		upstream.write({ 'payload/docs/a.md': lines([9, 'upstream']) }).commit();

		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(entryFor(report, A).status, 'merged');
		assert.equal(consumer.read(A), lines([1, 'local'], [9, 'upstream']));
		assert.equal(
			consumer.lock().files.find((entry) => entry.target === A)?.hash,
			sha(lines([9, 'upstream'])),
			'the base moves to the new upstream content'
		);
	});

	it('leaves conflicts pending until `resolve`, without claiming the new commit', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const from = consumer.lock().source.commit;

		consumer.write({ [A]: lines([5, 'local']) }).commit();

		const to = upstream.write({ 'payload/docs/a.md': lines([5, 'upstream']) }).commit();
		const updated = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(updated.status, 2);
		assert.equal(updated.report.status, 'pending');
		assert.equal(entryFor(updated.report, A).status, 'conflict');
		assert.match(
			consumer.read(A),
			/<<<<<<< local\nlocal\n\|\|\|\|\|\|\| base\nline 5\n=======\nupstream\n>>>>>>> incoming\n/
		);

		const lock = consumer.lock();
		const entry = lock.files.find((candidate) => candidate.target === A);

		assert.equal(lock.source.commit, from);
		assert.deepEqual([entry?.commit, entry?.hash], [from, sha(lines())]);
		assert.deepEqual(lock.pending, [
			{
				kind: 'conflict',
				item: 'file',
				module: 'core',
				source: 'payload/docs/a.md',
				target: A,
				commit: to,
				hash: sha(lines([5, 'upstream']))
			}
		]);

		const checked = engine(consumer, 'check', '--source', upstream.dir);

		assert.equal(checked.status, 1);
		assert.deepEqual(
			checked.report.entries
				.filter((candidate) => candidate.target === A)
				.map((candidate) => candidate.status),
			['markers', 'pending']
		);
		const blocked = engine(consumer, 'update', '--source', upstream.dir, '--allow-dirty');

		assert.equal(blocked.report.status, 'refused');
		assert.match(blocked.report.next.join('\n'), /^finish the pending work first: /);

		const early = engine(consumer, 'resolve', A);

		assert.equal(early.status, 2);
		assert.equal(entryFor(early.report, A).detail, 'still has conflict markers');

		consumer.write({ [A]: lines([5, 'both']) });

		const pendingLock = consumer.read('house-rules.lock.json');
		const preview = engine(consumer, 'resolve', A, '--dry-run');

		assert.equal(preview.status, 0);
		assert.deepEqual([preview.report.status, preview.report.dryRun], ['resolved', true]);
		assert.equal(consumer.read('house-rules.lock.json'), pendingLock);

		const resolved = engine(consumer, 'resolve', A);
		const after = consumer.lock();

		assert.equal(resolved.status, 0);
		assert.equal(resolved.report.status, 'resolved');
		assert.equal(after.source.commit, to);
		assert.deepEqual(after.pending, []);
		assert.equal(
			after.files.find((candidate) => candidate.target === A)?.hash,
			sha(lines([5, 'upstream']))
		);
		assert.equal(engine(consumer, 'check', '--source', upstream.dir).report.status, 'ok');
	});

	it('leaves a block conflict pending, and `untrack` settles it', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer
			.write({ 'AGENTS.md': consumer.read('AGENTS.md').replace('Read', 'Always read') })
			.commit();

		const to = upstream
			.write({ 'payload/agents.md': '## Rules\n\nSkim `{{path:docs/rules/a.md}}`.\n' })
			.commit();

		const updated = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(updated.status, 2);
		assert.equal(entryFor(updated.report, 'AGENTS.md#core').status, 'conflict');
		assert.match(consumer.read('AGENTS.md'), /<<<<<<< local\nAlways read/);
		assert.equal(consumer.lock().pending[0]?.item, 'block');
		assert.equal(engine(consumer, 'resolve', 'AGENTS.md').report.status, 'pending');
		assert.equal(engine(consumer, 'untrack', 'AGENTS.md#core').report.status, 'untracked');

		const lock = consumer.lock();

		assert.equal(lock.source.commit, to);
		assert.deepEqual(lock.pending, []);
		assert.deepEqual(
			lock.blocks.map((entry) => entry.target),
			['.prettierignore']
		);
		assert.deepEqual(lock.excluded, ['AGENTS.md#core']);
	});

	it('merges against an empty base when the locked base is unknown', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const lock = consumer.lock();

		for (const entry of lock.files) if (entry.target === A) entry.hash = sha('tampered');

		writeLock(consumer.dir, lock);
		consumer.commit();
		upstream.write({ 'payload/docs/a.md': lines([3, 'upstream']) }).commit();

		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 2);
		assert.equal(entryFor(report, A).status, 'no-base');
		assert.match(consumer.read(A), /\|\|\|\|\|\|\| base\n=======\n/);
		assert.equal(consumer.lock().pending[0]?.kind, 'no-base');
	});

	it('updates a block and leaves the rest of its host file alone', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer
			.write({ 'AGENTS.md': `${consumer.read('AGENTS.md')}\n## Local\n\nOur rules.\n` })
			.commit();
		upstream
			.write({ 'payload/agents.md': '## Rules\n\nRead `{{path:docs/rules/b.md}}`.\n' })
			.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(report, 'AGENTS.md#core').status, 'updated');
		assert.equal(
			consumer.read('AGENTS.md'),
			'# AGENTS.md\n\n<!-- house-rules:core:start -->\n\n## Rules\n\nRead `docs/rules/b.md`.\n\n<!-- house-rules:core:end -->\n\n## Local\n\nOur rules.\n'
		);
	});

	it('applies upstream JSON changes as a set change and keeps local removals', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ '.oxlintrc.json': '{\n\t"extends": ["./local.json"]\n}\n' }).commit();
		editManifest(upstream, (manifest) => {
			manifest.modules.core.json[0]?.values.push('./more.json');
		});
		upstream.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(report, '.oxlintrc.json#extends#core').status, 'updated');
		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')), {
			extends: ['./more.json', './local.json']
		});
	});

	it('names malformed block markers instead of offering untrack', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const text = consumer.read('AGENTS.md');

		consumer.write({ 'AGENTS.md': `${text}<!-- house-rules:core:end -->\n` }).commit();
		upstream.write({ 'payload/agents.md': '## Rules\n\nRead the rules.\n' }).commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.deepEqual(entryFor(report, 'AGENTS.md#core'), {
			status: 'missing',
			target: 'AGENTS.md#core',
			detail: 'one marker missing, repeated or out of order: fix them, then rerun `update`'
		});
		assert.equal(consumer.read('AGENTS.md'), `${text}<!-- house-rules:core:end -->\n`);
	});

	const manualCases: [string, string, string][] = [
		[
			'comments',
			'{\n\t// local\n\t"extends": ["./tools/lint.json"]\n}\n',
			'has comments; add "./more.json" by hand, then run `resolve`'
		],
		[
			'invalid JSON',
			'{\n\t"extends": ["./tools/lint.json"]\n',
			'isn\'t valid JSON; fix it, add "./more.json" by hand, then run `resolve`'
		],
		[
			'a key that is not an array',
			'{\n\t"extends": "./tools/lint.json"\n}\n',
			'"extends" isn\'t a JSON array; add "./more.json" by hand, then run `resolve`'
		]
	];

	for (const [problem, text, detail] of manualCases) {
		it(`leaves a JSON change as manual work when the file has ${problem}`, () => {
			const upstream = createUpstream();
			const consumer = installed(upstream);

			consumer.write({ '.oxlintrc.json': text }).commit();
			editManifest(upstream, (manifest) => {
				manifest.modules.core.json[0]?.values.push('./more.json');
			});
			upstream.commit();

			const { report } = engine(consumer, 'update', '--source', upstream.dir);

			assert.deepEqual(entryFor(report, '.oxlintrc.json#extends#core'), {
				status: 'manual',
				target: '.oxlintrc.json#extends#core',
				detail
			});
			assert.equal(consumer.read('.oxlintrc.json'), text);
			assert.equal(consumer.lock().pending.length, 1);
		});
	}

	it("puts a JSON value upstream adds after the modules' values and before the repo's own", () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer
			.write({
				'.oxlintrc.json': '{\n\t"extends": ["./tools/lint.json", "./local.json"]\n}\n'
			})
			.commit();
		editManifest(upstream, (manifest) => {
			manifest.modules.core.json[0]?.values.push('./more.json');
		});
		upstream.commit();

		engine(consumer, 'update', '--source', upstream.dir);

		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')), {
			extends: ['./tools/lint.json', './more.json', './local.json']
		});
	});

	it('puts a JSON value upstream replaced where the old one was', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer
			.write({
				'.oxlintrc.json': '{\n\t"extends": ["./tools/lint.json", "./local.json"]\n}\n'
			})
			.commit();
		editManifest(upstream, (manifest) => {
			for (const json of manifest.modules.core.json) json.values = ['./core.json'];
		});
		upstream.commit();

		engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(
			consumer.read('.oxlintrc.json'),
			'{\n\t"extends": ["./core.json", "./local.json"]\n}\n'
		);
	});

	it('keeps a JSON value another module still contributes', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.extra, {
				json: [
					{
						target: '.oxlintrc.json',
						key: 'extends',
						values: ['{{rel:tools/lint.json}}', './extra.json']
					}
				]
			});
		});
		upstream.commit();

		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir, '--modules', 'extra');
		consumer.commit();
		editManifest(upstream, (manifest) => {
			for (const json of manifest.modules.core.json) json.values = ['./core.json'];
		});
		upstream.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(
			entryFor(report, '.oxlintrc.json#extends#core').detail,
			'add "./core.json"; remove "./tools/lint.json"'
		);
		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')), {
			extends: ['./tools/lint.json', './extra.json', './core.json']
		});
		assert.deepEqual(
			consumer.lock().json.map((entry) => [entry.module, entry.values]),
			[
				['core', ['./core.json']],
				['extra', ['./tools/lint.json', './extra.json']]
			]
		);
	});

	it('reports lint policy changes and requirement changes', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({
			'payload/lint.json':
				'{\n\t"plugins": ["unicorn"],\n\t"rules": {\n\t\t"no-eval": "warn",\n\t\t"no-debugger": "error"\n\t}\n}\n'
		});
		editManifest(upstream, (manifest) => {
			manifest.modules.core.devDependencies.oxlint = '1.82.0';
		});
		upstream.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.deepEqual(
			report.lintChanges.map((change) => [change.type, change.name, change.from, change.to]),
			[
				['rule', 'no-eval', 'error', 'warn'],
				['rule', 'no-debugger', null, 'error'],
				['setting', 'plugins', null, '["unicorn"]']
			]
		);
		assert.deepEqual(report.requirementChanges, [
			{ type: 'devDependency', name: 'oxlint', from: '1.81.0', to: '1.82.0' }
		]);
	});

	it('offers new upstream items and installs or declines them on request', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({ 'payload/new.md': 'new\n', 'payload/other.md': 'other\n' });
		editManifest(upstream, (manifest) => {
			manifest.modules.core.files.push(
				{ source: 'payload/new.md', target: 'docs/new.md' },
				{ source: 'payload/other.md', target: 'docs/other.md' }
			);
		});
		upstream.commit();

		const offered = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(offered.report, 'docs/new.md').status, 'new');
		assert.equal(entryFor(offered.report, 'docs/other.md').status, 'new');
		assert.equal(consumer.exists('docs/new.md'), false);
		consumer.commit();

		const { report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'docs/new.md',
			'--skip',
			'docs/other.md'
		);

		assert.equal(entryFor(report, 'docs/new.md').status, 'written');
		assert.equal(entryFor(report, 'docs/other.md').status, 'skipped');
		assert.equal(consumer.read('docs/new.md'), 'new\n');
		assert.deepEqual(consumer.lock().excluded, ['docs/other.md']);
		consumer.commit();

		const again = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(again.report.status, 'up-to-date');
		assert.equal(
			again.report.entries.some((entry) => entry.status === 'new'),
			false
		);
	});

	it('holds back a JSON value until the config it names is installed, and lists its rules', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const extendsKey = '.oxlintrc.json#extends#core';
		const before = consumer.read('.oxlintrc.json');

		upstream.write({
			'payload/strict.json': '{\n\t"rules": {\n\t\t"no-console": "error"\n\t}\n}\n'
		});
		editManifest(upstream, (manifest) => {
			manifest.modules.core.files.push({
				source: 'payload/strict.json',
				target: 'tools/strict.json',
				kind: 'oxlint-config'
			});
			manifest.modules.core.json[0]?.values.push('{{rel:tools/strict.json}}');
		});
		upstream.commit();

		const offered = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(offered.report, 'tools/strict.json').status, 'new');
		assert.deepEqual(entryFor(offered.report, extendsKey), {
			status: 'held',
			target: extendsKey,
			detail: 'holds back ./tools/strict.json until tools/strict.json exists; an update adds it then'
		});
		assert.equal(consumer.read('.oxlintrc.json'), before);
		assert.deepEqual(consumer.lock().json[0]?.values, ['./tools/lint.json']);
		consumer.commit();

		const { report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'tools/strict.json'
		);

		assert.equal(entryFor(report, 'tools/strict.json').status, 'written');
		assert.equal(entryFor(report, extendsKey).status, 'updated');
		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')).extends, [
			'./tools/lint.json',
			'./tools/strict.json'
		]);
		assert.deepEqual(
			report.lintChanges.map((change) => [change.type, change.name, change.from, change.to]),
			[['rule', 'no-console', null, 'error']]
		);
	});

	it('writes a new file where a file upstream moved used to be', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.write({ 'payload/b.md': 'a new b\n' });
		editManifest(upstream, (manifest) => {
			manifest.modules.core.files.push({ source: 'payload/b.md', target: 'docs/rules/b.md' });
		});
		upstream.commit();

		const { report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--follow-renames',
			'--add',
			'docs/rules/b.md'
		);

		assert.equal(report.status, 'updated');
		assert.equal(consumer.read('docs/rules/b.md'), 'a new b\n');
		assert.equal(
			consumer.read('docs/rules/c.md'),
			'See ../../AGENTS.md and `tools/lint.json`.\n'
		);
	});

	it('writes a file upstream adds to an installed folder or skill with the update', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream
			.write({
				'payload/docs/c.md': 'c\n',
				'payload/skills/demo/references/more.md': 'more\n'
			})
			.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(report.status, 'updated');
		assert.equal(entryFor(report, 'docs/rules/c.md').status, 'written');
		assert.equal(entryFor(report, '.agents/skills/demo/references/more.md').status, 'written');
		assert.equal(consumer.read('docs/rules/c.md'), 'c\n');
		assert.ok(consumer.lock().files.some((entry) => entry.target === 'docs/rules/c.md'));
	});

	const declineRules: [string, (upstream: TempRepo) => TempRepo][] = [
		[
			'untracked',
			(upstream) => {
				const consumer = installed(upstream);

				engine(consumer, 'untrack', 'docs/rules');
				consumer.commit();

				return consumer;
			}
		],
		[
			'skipped at install',
			(upstream) => {
				const consumer = createConsumer();

				engine(consumer, 'install', '--source', upstream.dir, '--skip', 'docs/rules/');
				consumer.commit();

				return consumer;
			}
		]
	];

	for (const [how, decline] of declineRules) {
		it(`names new upstream files under a folder the repo ${how} once, and leaves them out`, () => {
			const upstream = createUpstream();
			const consumer = decline(upstream);

			assert.deepEqual(consumer.lock().excluded, ['docs/rules']);
			upstream.write({ 'payload/docs/c.md': 'c\n' }).commit();

			const { report } = engine(consumer, 'update', '--source', upstream.dir);

			assert.equal(report.status, 'updated');
			assert.deepEqual(entryFor(report, 'docs/rules/c.md'), {
				status: 'excluded',
				target: 'docs/rules/c.md',
				detail: 'new upstream under declined docs/rules; --add docs/rules/c.md to install'
			});
			assert.equal(consumer.exists('docs/rules/c.md'), false);
			consumer.commit();

			const again = engine(consumer, 'update', '--source', upstream.dir).report;

			assert.ok(again.entries.every((entry) => entry.target !== 'docs/rules/c.md'));
		});
	}

	it('records a module upstream made required only once the repo takes an item from it', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({ 'payload/later.md': 'later\n' });
		editManifest(upstream, (manifest) => {
			const { core, extra } = manifest.modules;

			const later = {
				description: 'Test later',
				files: [{ source: 'payload/later.md', target: 'docs/later.md' }]
			};

			Object.assign(core, { requires: ['later'] });
			manifest.modules = Object.assign({ later }, { core, extra });
		});
		upstream.commit();

		const offered = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(offered.report, 'docs/later.md').status, 'new');
		assert.deepEqual(consumer.lock().modules, ['core']);
		consumer.commit();
		engine(consumer, 'update', '--source', upstream.dir, '--add', 'docs/later.md');
		assert.deepEqual(consumer.lock().modules, ['core', 'later']);
	});

	it("stops without writing when git can't read an upstream file", () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({ 'payload/docs/a.md': lines([2, 'two']) }).commit();

		const blob = git(upstream.dir, 'rev-parse', 'HEAD:payload/docs/a.md');
		const lock = consumer.read('house-rules.lock.json');

		rmSync(path.join(upstream.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 1);
		assert.equal(report.status, 'error');
		assert.match(report.next.join('\n'), /cat-file blob \w+:payload\/docs\/a\.md failed/);
		assert.equal(consumer.read(A), lines());
		assert.equal(consumer.read('house-rules.lock.json'), lock);
	});

	it('names the options for a new upstream file whose path the repo already uses', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ 'docs/rules/c.md': 'mine\n' }).commit();
		upstream.write({ 'payload/docs/c.md': 'c\n' }).commit();

		const collided = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'docs/rules/c.md'
		);

		assert.equal(collided.status, 0);
		assert.equal(
			entryFor(collided.report, 'docs/rules/c.md').detail,
			'file exists with other content: rerun with --add docs/rules/c.md and --overwrite or --keep docs/rules/c.md, or with --skip docs/rules/c.md'
		);
		assert.equal(consumer.read('docs/rules/c.md'), 'mine\n');
		consumer.commit();

		const kept = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'docs/rules/c.md',
			'--keep',
			'docs/rules/c.md'
		);

		assert.equal(entryFor(kept.report, 'docs/rules/c.md').status, 'kept');
		assert.equal(consumer.read('docs/rules/c.md'), 'mine\n');
		assert.equal(
			consumer.lock().files.find((entry) => entry.target === 'docs/rules/c.md')?.hash,
			sha('c\n')
		);
	});

	it('follows a file upstream moved in one commit and rewrote in a later one', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.commit('move');
		upstream.write({ 'payload/docs/c.md': 'Rewritten from scratch.\n' }).commit('rewrite');

		const { report } = engine(consumer, 'update', '--source', upstream.dir, '--dry-run');

		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'renamed');
		assert.equal(
			report.entries.some((entry) => entry.target === 'docs/rules/c.md'),
			false
		);
	});

	it('ends a rename chain where upstream deletes the file', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/a.md', 'payload/docs/c.md');
		upstream.commit('move a');
		upstream.remove('payload/docs/c.md').commit('delete it');
		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.commit('move b');

		const { report } = engine(consumer, 'update', '--source', upstream.dir, '--dry-run');

		assert.equal(entryFor(report, A).status, 'deleted');
		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'renamed');
		assert.match(
			entryFor(report, 'docs/rules/b.md').detail ?? '',
			/moved it to docs\/rules\/c\.md/
		);
		assert.equal(consumer.read(A), lines());
	});

	it("skips the advice that needs a locked modules.json this engine can't read", () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { futureKey: true });
		});

		const newer = upstream.commit('newer manifest');
		const lock = consumer.lock();

		lock.source.commit = newer;
		writeLock(consumer.dir, lock);
		consumer.commit();
		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { futureKey: undefined });
		});
		upstream.commit('older manifest');

		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'updated');
		assert.match(
			report.next.join('\n'),
			/^skipped the requirement changes and new items under declined paths: this engine can't read modules.json at [0-9a-f]{7} \(modules.core: unknown keys futureKey\)$/m
		);
	});

	it("refuses to update a repo where it can't check managed files for uncommitted changes", () => {
		const upstream = createUpstream();
		const consumer = createConsumer({ 'handbook/README.md': '# Handbook\n' });

		symlinkSync('handbook', path.join(consumer.dir, 'docs'));
		engine(consumer, 'install', '--source', upstream.dir);
		consumer.commit();
		consumer.write({ [A]: lines([1, 'local']) });
		upstream.write({ 'payload/docs/a.md': lines([9, 'upstream']) }).commit();

		const throughLink = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(throughLink.status, 1);
		assert.deepEqual(throughLink.report.next, [
			'commit or discard the changes to managed files first, or pass --allow-dirty: docs/rules/a.md'
		]);

		rmSync(path.join(consumer.dir, '.git'), { recursive: true });

		const outside = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(outside.status, 1);
		assert.match(outside.report.next.join('\n'), /isn't a git work tree\); pass --allow-dirty/);
		assert.equal(consumer.read(A), lines([1, 'local']));
	});

	it('installs an item the repo declined only when --add names it', () => {
		const upstream = createUpstream();
		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir, '--skip', 'docs/rules/b.md');
		consumer.commit();
		assert.equal(
			engine(consumer, 'update', '--source', upstream.dir).report.status,
			'up-to-date'
		);

		const { report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'docs/rules/b.md'
		);

		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'written');
		assert.equal(
			consumer.read('docs/rules/b.md'),
			'See ../../AGENTS.md and `tools/lint.json`.\n'
		);
		assert.deepEqual(consumer.lock().excluded, []);
	});

	it('reports files upstream deleted and stops tracking them on `untrack`', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.remove('payload/docs/b.md').commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'deleted');
		assert.ok(
			consumer.exists('docs/rules/b.md'),
			'the local copy stays until the user decides'
		);

		const trackedLock = consumer.read('house-rules.lock.json');
		const preview = engine(consumer, 'untrack', 'docs/rules/b.md', '--dry-run');

		assert.deepEqual([preview.report.status, preview.report.dryRun], ['untracked', true]);
		assert.equal(consumer.read('house-rules.lock.json'), trackedLock);

		const untracked = engine(consumer, 'untrack', 'docs/rules/b.md');

		assert.equal(untracked.report.status, 'untracked');
		assert.equal(
			consumer.lock().files.some((entry) => entry.target === 'docs/rules/b.md'),
			false
		);
		assert.deepEqual(consumer.lock().excluded, ['docs/rules/b.md']);
		assert.equal(engine(consumer, 'untrack', 'docs/nothing.md').report.status, 'refused');
	});

	it('untracks a skill folder whose link is all the lock still tracks', () => {
		const consumer = installed(createUpstream());

		engine(consumer, 'untrack', '.agents/skills/demo/SKILL.md');

		const { status, report } = engine(consumer, 'untrack', '.agents/skills/demo');

		assert.equal(status, 0);
		assert.equal(entryFor(report, '.claude/skills/demo').status, 'untracked');
		assert.deepEqual(consumer.lock().links, []);
		assert.ok(consumer.lock().excluded.includes('.agents/skills/demo'));
	});

	it('refuses an update with an undecided rename, and moves the file with --follow-renames', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.commit();

		const refused = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(refused.status, 1);
		assert.equal(refused.report.status, 'refused');
		assert.deepEqual(
			refused.report.entries.map((entry) => [entry.target, entry.status]),
			[['docs/rules/b.md', 'renamed']]
		);
		assert.match(refused.report.next.join('\n'), /^nothing was written: upstream moved/m);
		assert.equal(git(consumer.dir, 'status', '--porcelain'), '');

		const stayed = engine(consumer, 'update', '--source', upstream.dir, '--dry-run');

		assert.equal(stayed.status, 1);
		assert.equal(stayed.report.status, 'refused');
		assert.equal(stayed.report.dryRun, true);
		assert.match(stayed.report.next.join('\n'), /^the update will refuse: upstream moved/m);
		assert.equal(
			entryFor(stayed.report, 'docs/rules/b.md').detail,
			'upstream moved it to docs/rules/c.md: rerun with --follow-renames, or with --keep docs/rules/b.md to leave it here'
		);
		assert.equal(
			stayed.report.entries.some((entry) => entry.status === 'new'),
			false
		);

		const { report } = engine(consumer, 'update', '--source', upstream.dir, '--follow-renames');

		assert.equal(entryFor(report, 'docs/rules/c.md').status, 'unchanged');
		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'moved');
		assert.equal(consumer.exists('docs/rules/b.md'), false);
		assert.equal(
			consumer.read('docs/rules/c.md'),
			'See ../../AGENTS.md and `tools/lint.json`.\n'
		);
		assert.deepEqual(
			consumer.lock().files.find((entry) => entry.target === 'docs/rules/c.md')?.source,
			'payload/docs/c.md'
		);
	});

	it('refuses while managed files have uncommitted changes, unless --allow-dirty', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ [A]: lines([1, 'local']) });
		upstream.write({ 'payload/docs/a.md': lines([9, 'upstream']) }).commit();

		const refused = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(refused.status, 1);
		assert.match(refused.report.next.join('\n'), /docs\/rules\/a\.md/);
		assert.equal(consumer.read(A), lines([1, 'local']));

		const { report } = engine(consumer, 'update', '--source', upstream.dir, '--allow-dirty');

		assert.equal(entryFor(report, A).status, 'merged');
	});

	it('keeps a renamed file in place with --keep, and maps the new path to it', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream
			.write({ 'payload/agents.md': '## Rules\n\nRead `{{path:docs/rules/c.md}}`.\n' })
			.commit();

		const { report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--keep',
			'docs/rules/b.md'
		);

		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'mapped');
		assert.equal(consumer.exists('docs/rules/c.md'), false);
		assert.match(consumer.read('AGENTS.md'), /Read `docs\/rules\/b\.md`\./);
		assert.deepEqual(consumer.lock().maps, { 'docs/rules/c.md': 'docs/rules/b.md' });
		consumer.commit();
		assert.equal(
			engine(consumer, 'update', '--source', upstream.dir).report.status,
			'up-to-date'
		);
	});

	it('refuses --keep on a renamed file in a folder whose files load each other', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['docs/rules'] });
		});
		upstream.commit();

		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.commit();

		const refused = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--keep',
			'docs/rules/b.md',
			'--dry-run'
		);

		assert.equal(refused.status, 1);
		assert.match(refused.report.next.join('\n'), /^the maps split docs\/rules,/m);
		assert.deepEqual(consumer.lock().maps, {});
	});

	it('refuses an --add that installs only part of a skipped folder whose files load each other', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['docs/rules'] });
		});
		upstream.commit();

		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir, '--skip', 'docs/rules');
		consumer.commit();

		const partial = engine(consumer, 'update', '--source', upstream.dir, '--add', A);

		assert.equal(partial.status, 1);
		assert.match(
			partial.report.next.join('\n'),
			/^the run would install only part of docs\/rules,/m
		);
		assert.equal(consumer.exists(A), false);

		const whole = engine(consumer, 'update', '--source', upstream.dir, '--add', 'docs/rules');

		assert.equal(whole.report.status, 'updated');
		assert.equal(consumer.exists('docs/rules/b.md'), true);
	});

	it('keeps updating a folder whose files load each other after one of them is untracked, even when a skip names it', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['docs/rules'] });
		});
		upstream.commit();

		const consumer = installed(upstream);

		engine(consumer, 'untrack', 'docs/rules/b.md');
		consumer.commit();
		upstream.write({ 'payload/docs/a.md': 'upstream a\n' }).commit();

		const { status, report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--skip',
			'docs/rules/b.md'
		);

		assert.equal(status, 0);
		assert.equal(entryFor(report, A).status, 'updated');
		assert.equal(consumer.read(A), 'upstream a\n');
		assert.deepEqual(consumer.lock().excluded, ['docs/rules/b.md']);
	});

	it('names the file to add when a held value needs a file untracked from a folder kept together', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['docs/rules'] });
		});
		upstream.commit();

		const consumer = installed(upstream);

		engine(consumer, 'untrack', 'docs/rules/b.md');
		consumer.remove('docs/rules/b.md').commit();

		editManifest(upstream, (manifest) => {
			manifest.modules.core.json?.[0]?.values.push('{{rel:docs/rules/b.md}}');
		});
		upstream.commit();

		const held = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(
			entryFor(held.report, '.oxlintrc.json#extends#core').detail,
			'holds back ./docs/rules/b.md until docs/rules/b.md exists; the repo left out docs/rules/b.md; an update with --add docs/rules/b.md installs it'
		);
		consumer.commit();

		const added = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--add',
			'docs/rules/b.md'
		);

		assert.equal(consumer.exists('docs/rules/b.md'), true);
		assert.match(consumer.read('.oxlintrc.json'), /\.\/docs\/rules\/b\.md/);
		assert.deepEqual(
			added.report.next.filter((line) => line.includes('matched no new item')),
			[]
		);
		assert.deepEqual(consumer.lock().excluded, []);
	});

	it('refuses to follow a rename onto a path the repo uses', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ 'docs/rules/c.md': 'local c\n' }).commit();
		git(upstream.dir, 'mv', 'payload/docs/b.md', 'payload/docs/c.md');
		upstream.commit();

		const { status, report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--follow-renames'
		);

		assert.equal(status, 1);
		assert.equal(entryFor(report, 'docs/rules/b.md').status, 'collision');
		assert.match(report.next.join('\n'), /^nothing was written: upstream moved/m);
		assert.equal(git(consumer.dir, 'status', '--porcelain'), '');
	});

	it('moves a skill folder and its link with --follow-renames', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		git(upstream.dir, 'mv', 'payload/skills/demo', 'payload/skills/guide');
		editManifest(upstream, (manifest) => {
			manifest.modules.core.skills = ['payload/skills/guide'];
		});
		upstream.commit();

		const { report } = engine(consumer, 'update', '--source', upstream.dir, '--follow-renames');

		assert.equal(entryFor(report, '.claude/skills/demo').status, 'removed');
		assert.equal(entryFor(report, '.claude/skills/guide').status, 'written');
		assert.deepEqual(readdirSync(path.join(consumer.dir, '.agents/skills')), ['guide']);
		assert.deepEqual(readdirSync(path.join(consumer.dir, '.claude/skills')), ['guide']);
		assert.equal(
			consumer.read('.claude/skills/guide/SKILL.md'),
			'---\nname: demo\n---\n\nRead ../../../docs/rules/a.md.\n'
		);
		assert.deepEqual(consumer.lock().links, [
			{ module: 'core', target: '.claude/skills/guide', to: '../../.agents/skills/guide' }
		]);
		consumer.commit();
		assert.equal(engine(consumer, 'check', '--source', upstream.dir).report.status, 'ok');
	});

	it('names both paths of a staged rename in the dirty check', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.remove('.prettierrc').commit();
		git(consumer.dir, 'mv', A, '.prettierrc');

		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 1);
		assert.deepEqual(report.next, [
			'commit or discard the changes to managed files first, or pass --allow-dirty: .prettierrc, docs/rules/a.md'
		]);
	});

	it('changes nothing when upstream has nothing new', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);
		const { status, report } = engine(consumer, 'update', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'up-to-date');
		assert.equal(git(consumer.dir, 'status', '--porcelain'), '');
	});

	it('writes nothing on --dry-run', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		upstream.write({ 'payload/docs/a.md': lines([2, 'two']) }).commit();

		const { status, report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--dry-run'
		);

		assert.equal(status, 0);
		assert.equal(report.status, 'updated');
		assert.equal(report.dryRun, true);
		assert.equal(entryFor(report, A).status, 'updated');
		assert.equal(git(consumer.dir, 'status', '--porcelain'), '');
	});

	it('reports on --dry-run that uncommitted changes to managed files will stop the update', () => {
		const upstream = createUpstream();
		const consumer = installed(upstream);

		consumer.write({ [A]: lines([1, 'local']) });
		upstream.write({ 'payload/docs/a.md': lines([9, 'upstream']) }).commit();

		const { status, report } = engine(
			consumer,
			'update',
			'--source',
			upstream.dir,
			'--dry-run'
		);

		assert.equal(status, 1);
		assert.deepEqual([report.status, report.dryRun], ['refused', true]);
		assert.equal(entryFor(report, A).status, 'merged');
		assert.match(
			report.next.join('\n'),
			/^the update will refuse: commit or discard the changes to managed files first, or pass --allow-dirty: docs\/rules\/a\.md$/m
		);
		assert.equal(consumer.read(A), lines([1, 'local']));
	});
});
