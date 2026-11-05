import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeLock } from '../scripts/lib/lock.mjs';
import {
	createConsumer,
	createUpstream,
	editManifest,
	engine,
	entryFor,
	git,
	lines,
	sha
} from './helpers.ts';

describe('install', () => {
	const upstream = createUpstream();
	const head = git(upstream.dir, 'rev-parse', 'HEAD');

	it('writes every item, renders templates and records the lockfile', () => {
		const consumer = createConsumer();
		const { status, report } = engine(consumer, 'install', '--source', upstream.dir);

		assert.equal(status, 0);
		assert.equal(report.status, 'installed');
		assert.equal(consumer.read('docs/rules/a.md'), lines());
		assert.equal(
			consumer.read('docs/rules/b.md'),
			'See ../../AGENTS.md and `tools/lint.json`.\n'
		);
		assert.equal(
			consumer.read('.agents/skills/demo/SKILL.md'),
			'---\nname: demo\n---\n\nRead ../../../docs/rules/a.md.\n'
		);
		assert.ok(consumer.isSymlink('.claude/skills/demo'));
		assert.equal(
			consumer.read('.claude/skills/demo/SKILL.md'),
			consumer.read('.agents/skills/demo/SKILL.md')
		);
		assert.equal(
			consumer.read('AGENTS.md'),
			'# AGENTS.md\n\n<!-- house-rules:core:start -->\n\n## Rules\n\nRead `docs/rules/a.md`.\n\n<!-- house-rules:core:end -->\n'
		);
		assert.equal(
			consumer.read('.prettierignore'),
			'# house-rules:core:start\ntools\n# house-rules:core:end\n'
		);
		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')), {
			extends: ['./tools/lint.json']
		});

		const lock = consumer.lock();

		assert.deepEqual(lock.source, { url: upstream.dir, ref: 'main', commit: head });
		assert.deepEqual(lock.modules, ['core']);
		assert.deepEqual(
			lock.files.map((entry) => entry.target),
			[
				'.agents/skills/demo/SKILL.md',
				'.prettierrc',
				'docs/rules/a.md',
				'docs/rules/b.md',
				'tools/lint.json'
			]
		);

		for (const entry of lock.files) {
			assert.equal(entry.commit, head);
			assert.equal(entry.hash, sha(consumer.read(entry.target)), entry.target);
		}

		assert.deepEqual(lock.links, [
			{ module: 'core', target: '.claude/skills/demo', to: '../../.agents/skills/demo' }
		]);
		assert.deepEqual(
			lock.blocks.map((entry) => [entry.target, entry.hash]),
			[
				['.prettierignore', sha('tools\n')],
				['AGENTS.md', sha('## Rules\n\nRead `docs/rules/a.md`.\n')]
			]
		);
		assert.deepEqual(lock.pending, []);
		assert.deepEqual(
			report.requirements.map((requirement) => [requirement.type, requirement.name]),
			[
				['devDependency', 'oxlint'],
				['script', 'lint']
			]
		);
	});

	it('writes nothing while any target collides, then honours --keep, --overwrite and --skip', () => {
		const consumer = createConsumer({
			'docs/rules/a.md': 'local a\n',
			'docs/rules/b.md': 'local b\n',
			'prettier.config.js': 'export default {};\n'
		});

		const first = engine(consumer, 'install', '--source', upstream.dir);

		assert.equal(first.status, 1);
		assert.equal(first.report.status, 'collisions');
		assert.equal(entryFor(first.report, 'docs/rules/a.md').status, 'collision');
		assert.equal(
			entryFor(first.report, '.prettierrc').detail,
			'prettier.config.js configures the same tool'
		);
		assert.equal(consumer.exists('house-rules.lock.json'), false);
		assert.equal(consumer.exists('AGENTS.md'), false);

		const second = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--keep',
			'docs/rules/a.md',
			'--overwrite',
			'docs/rules/b.md',
			'--skip',
			'.prettierrc'
		);

		assert.equal(second.report.status, 'installed');
		assert.equal(consumer.read('docs/rules/a.md'), 'local a\n');
		assert.equal(
			consumer.read('docs/rules/b.md'),
			'See ../../AGENTS.md and `tools/lint.json`.\n'
		);
		assert.equal(consumer.exists('.prettierrc'), false);

		const lock = consumer.lock();
		const kept = lock.files.find((entry) => entry.target === 'docs/rules/a.md');

		assert.equal(
			kept?.hash,
			sha(lines()),
			'a kept file records the upstream hash, so it counts as a local change'
		);
		assert.deepEqual(lock.excluded, ['.prettierrc']);
	});

	it('leaves out the requirements that serve only a file the repo skips', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, {
				devDependencies: { oxlint: '1.81.0', 'prettier-plugin-x': '1.0.0' },
				serves: { 'prettier-plugin-x': ['.prettierrc'] }
			});
		});
		upstream.commit();

		const names = (report: { requirements: { name: string }[] }) =>
			report.requirements.map((requirement) => requirement.name);

		const full = engine(createConsumer(), 'install', '--source', upstream.dir, '--dry-run');

		assert.deepEqual(names(full.report), ['oxlint', 'prettier-plugin-x', 'lint']);

		const consumer = createConsumer();

		const skipped = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--skip',
			'.prettierrc'
		);

		assert.deepEqual(names(skipped.report), ['oxlint', 'lint']);
		consumer.commit();
		assert.deepEqual(names(engine(consumer, 'update', '--source', upstream.dir).report), [
			'oxlint',
			'lint'
		]);
	});

	it('counts another config for the same tool as a collision, as a file or a package.json key', () => {
		const consumer = createConsumer({
			'package.json': '{ "prettier": {} }\n',
			'oxlint.config.ts': 'export default {};\n'
		});

		const first = engine(consumer, 'install', '--source', upstream.dir);

		assert.deepEqual(
			first.report.entries.filter((entry) => entry.status === 'collision'),
			[
				{
					status: 'collision',
					target: '.prettierrc',
					detail: 'package.json#prettier configures the same tool'
				},
				{
					status: 'collision',
					target: '.oxlintrc.json#extends#core',
					detail: 'oxlint.config.ts configures the same tool'
				}
			]
		);

		const second = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--keep',
			'.prettierrc',
			'--keep',
			'.oxlintrc.json'
		);

		assert.equal(second.report.status, 'installed');
		assert.equal(consumer.exists('.prettierrc'), false);
		assert.equal(consumer.exists('.oxlintrc.json'), false);
		assert.deepEqual(consumer.lock().excluded, ['.oxlintrc.json#extends#core', '.prettierrc']);
	});

	it('names the other config to retire when --overwrite replaces it', () => {
		const consumer = createConsumer({
			'package.json': '{ "prettier": {} }\n',
			'oxlint.config.ts': 'export default {};\n'
		});

		const { report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--overwrite',
			'.prettierrc',
			'--overwrite',
			'.oxlintrc.json'
		);

		assert.equal(report.status, 'installed');
		assert.equal(consumer.read('.prettierrc'), '{ "useTabs": true }\n');
		assert.ok(consumer.exists('.oxlintrc.json'));
		assert.deepEqual(
			report.next.filter((line) => line.includes('replaces it')),
			[
				'remove "prettier" from package.json: .prettierrc replaces it, and the tool reads only one config',
				'delete oxlint.config.ts: .oxlintrc.json replaces it, and the tool reads only one config'
			]
		);
	});

	it('adds its block to an existing AGENTS.md and keeps the rest', () => {
		const consumer = createConsumer({ 'AGENTS.md': '# Project\n\nLocal rules.\n' });

		engine(consumer, 'install', '--source', upstream.dir);

		assert.equal(
			consumer.read('AGENTS.md'),
			'# Project\n\nLocal rules.\n\n<!-- house-rules:core:start -->\n\n## Rules\n\nRead `docs/rules/a.md`.\n\n<!-- house-rules:core:end -->\n'
		);
	});

	it("adopts identical files and puts its values before the repo's own in a JSON array", () => {
		const consumer = createConsumer({
			'docs/rules/a.md': lines(),
			'.oxlintrc.json': '{\n  "extends": ["./base.json"]\n}\n'
		});

		const { report } = engine(consumer, 'install', '--source', upstream.dir);

		assert.equal(entryFor(report, 'docs/rules/a.md').status, 'adopted');
		assert.equal(
			consumer.read('.oxlintrc.json'),
			'{\n  "extends": ["./tools/lint.json", "./base.json"]\n}\n'
		);
	});

	it('leaves a contribution to a JSON file with comments as manual work until `resolve`', () => {
		const consumer = createConsumer({ '.oxlintrc.json': '{\n\t// local\n\t"rules": {}\n}\n' });
		const key = '.oxlintrc.json#extends#core';
		const { status, report } = engine(consumer, 'install', '--source', upstream.dir);

		assert.equal(status, 2);
		assert.equal(report.status, 'pending');
		assert.equal(
			entryFor(report, key).detail,
			'has comments; in "extends", add "./tools/lint.json"'
		);
		assert.equal(consumer.read('.oxlintrc.json'), '{\n\t// local\n\t"rules": {}\n}\n');
		assert.deepEqual(consumer.lock().pending, [
			{
				kind: 'manual',
				item: 'json',
				module: 'core',
				target: '.oxlintrc.json',
				key: 'extends',
				values: ['./tools/lint.json'],
				commit: head
			}
		]);

		const checked = engine(consumer, 'check', '--offline');

		assert.equal(checked.status, 1);
		assert.deepEqual(
			checked.report.entries.filter((entry) => entry.status === 'pending'),
			[
				{
					status: 'pending',
					target: key,
					detail: 'manual change: add "./tools/lint.json"; make it, then run `resolve`'
				}
			]
		);

		const unedited = engine(consumer, 'resolve', '.oxlintrc.json', '--dry-run').report;

		assert.deepEqual(
			entryFor(unedited, key).detail,
			'without ./tools/lint.json; later updates treat that as a local removal'
		);
		assert.match(unedited.next.join('\n'), /^confirm with the user that /m);

		consumer.write({
			'.oxlintrc.json':
				'{\n\t// local\n\t"extends": ["./tools/lint.json"],\n\t"rules": {}\n}\n'
		});

		const resolved = engine(consumer, 'resolve', '.oxlintrc.json').report;

		assert.equal(resolved.status, 'resolved');
		assert.deepEqual(entryFor(resolved, key), { status: 'resolved', target: key });
		assert.deepEqual(consumer.lock().pending, []);
		assert.deepEqual(consumer.lock().json[0]?.values, ['./tools/lint.json']);
		assert.equal(engine(consumer, 'check', '--offline').report.status, 'ok');
	});

	it('relocates folders and files with --map and renders paths for the new layout', () => {
		const consumer = createConsumer();

		const { report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--map',
			'docs/rules=handbook',
			'--map',
			'docs/rules/a.md=intro.md'
		);

		assert.equal(report.status, 'installed');
		assert.equal(consumer.read('handbook/b.md'), 'See ../AGENTS.md and `tools/lint.json`.\n');
		assert.equal(consumer.read('intro.md'), lines(), 'the longest matching map wins');
		assert.match(consumer.read('AGENTS.md'), /Read `intro\.md`\./);
		assert.equal(
			consumer.read('.agents/skills/demo/SKILL.md'),
			'---\nname: demo\n---\n\nRead ../../../intro.md.\n'
		);
		assert.deepEqual(consumer.lock().maps, {
			'docs/rules': 'handbook',
			'docs/rules/a.md': 'intro.md'
		});
	});

	it('holds back a JSON value whose config the repo skips', () => {
		const consumer = createConsumer();

		const { report } = engine(
			consumer,
			'install',
			'--source',
			createUpstream().dir,
			'--skip',
			'tools/lint.json'
		);

		assert.equal(report.status, 'installed');
		assert.deepEqual(entryFor(report, '.oxlintrc.json#extends#core'), {
			status: 'held',
			target: '.oxlintrc.json#extends#core',
			detail: 'holds back ./tools/lint.json until tools/lint.json exists; the repo left out tools/lint.json; an update with --add tools/lint.json installs it'
		});
		assert.equal(consumer.exists('.oxlintrc.json'), false);
		assert.deepEqual(consumer.lock().json, [
			{ module: 'core', target: '.oxlintrc.json', key: 'extends', values: [] }
		]);
	});

	it('names the whole folder to add when a held value needs a file in a folder kept together', () => {
		const upstream = createUpstream();

		editManifest(upstream, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['tools'] });
		});
		upstream.commit();

		const consumer = createConsumer();
		const { report } = engine(consumer, 'install', '--source', upstream.dir, '--skip', 'tools');

		assert.equal(
			entryFor(report, '.oxlintrc.json#extends#core').detail,
			'holds back ./tools/lint.json until tools/lint.json exists; the repo left out tools/lint.json; an update with --add tools installs it'
		);
	});

	it('refuses maps or skips that split a folder whose files load each other by relative paths', () => {
		const together = createUpstream();

		editManifest(together, (manifest) => {
			Object.assign(manifest.modules.core, { keepTogether: ['docs/rules'] });
		});
		together.commit();

		const split = createConsumer();

		const refused = engine(
			split,
			'install',
			'--source',
			together.dir,
			'--map',
			'docs/rules/a.md=intro.md'
		);

		assert.equal(refused.status, 1);
		assert.deepEqual(refused.report.next, [
			'the maps split docs/rules, whose files load each other by relative paths; map it, or a folder that holds it, as a whole'
		]);
		assert.equal(split.exists('house-rules.lock.json'), false);

		const partial = engine(
			createConsumer(),
			'install',
			'--source',
			together.dir,
			'--skip',
			'docs/rules/a.md'
		);

		assert.deepEqual(partial.report.next, [
			'the run would install only part of docs/rules, whose files load each other by relative paths; skip or add all of it'
		]);

		const whole = engine(
			createConsumer(),
			'install',
			'--source',
			together.dir,
			'--map',
			'docs=handbook'
		);

		assert.equal(whole.report.status, 'installed');
	});

	it('writes nothing on --dry-run', () => {
		const consumer = createConsumer();

		const { status, report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--dry-run'
		);

		assert.equal(status, 0);
		assert.equal(report.status, 'installed');
		assert.equal(report.dryRun, true);
		assert.equal(entryFor(report, 'docs/rules/a.md').status, 'written');
		assert.equal(git(consumer.dir, 'status', '--porcelain'), '');
	});

	it('adds a module at the locked commit, with the modules it requires', () => {
		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir);

		const { report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--modules',
			'extra'
		);

		assert.equal(report.status, 'installed');
		assert.deepEqual(report.modules, ['extra']);
		assert.equal(consumer.read('docs/extra.md'), 'extra\n');
		assert.deepEqual(consumer.lock().modules, ['core', 'extra']);
	});

	it("puts a new module's JSON values after the installed modules' values", () => {
		const extended = createUpstream();

		editManifest(extended, (manifest) => {
			Object.assign(manifest.modules.extra, {
				json: [{ target: '.oxlintrc.json', key: 'extends', values: ['./extra.json'] }]
			});
		});
		extended.commit();

		const consumer = createConsumer({
			'.oxlintrc.json': '{\n\t"extends": ["./mine.json"]\n}\n'
		});

		engine(consumer, 'install', '--source', extended.dir);
		engine(consumer, 'install', '--source', extended.dir, '--modules', 'extra');

		assert.deepEqual(JSON.parse(consumer.read('.oxlintrc.json')), {
			extends: ['./tools/lint.json', './extra.json', './mine.json']
		});
	});

	it('leaves out paths the repo declined when it adds a module', () => {
		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir, '--skip', 'docs');
		consumer.commit();

		const { report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--modules',
			'extra'
		);

		assert.equal(report.status, 'installed');
		assert.equal(entryFor(report, 'docs/extra.md').status, 'skipped');
		assert.equal(consumer.exists('docs/extra.md'), false);
		assert.deepEqual(consumer.lock().excluded, ['docs']);
	});

	it('refuses to add a module while work is pending', () => {
		const consumer = createConsumer();

		engine(consumer, 'install', '--source', upstream.dir);

		const lock = consumer.lock();

		lock.pending = [
			{
				kind: 'conflict',
				item: 'file',
				module: 'core',
				source: 'payload/docs/a.md',
				target: 'docs/rules/a.md',
				commit: head,
				hash: sha(lines())
			}
		];
		writeLock(consumer.dir, lock);

		const { status, report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--modules',
			'extra'
		);

		assert.equal(status, 1);
		assert.match(report.next.join('\n'), /^finish the pending work first: /);
		assert.equal(consumer.exists('docs/extra.md'), false);
	});

	it('refuses unknown modules', () => {
		const consumer = createConsumer();

		const { status, report } = engine(
			consumer,
			'install',
			'--source',
			upstream.dir,
			'--modules',
			'nope'
		);

		assert.equal(status, 1);
		assert.equal(report.status, 'refused');
		assert.match(report.next.join('\n'), /unknown modules: nope/);
	});

	it('asks for an update before adding a module that came after the locked commit', () => {
		const later = createUpstream();
		const consumer = createConsumer();

		engine(consumer, 'install', '--source', later.dir);
		later.write({ 'payload/later.md': 'later\n' });
		editManifest(later, (manifest) => {
			Object.assign(manifest.modules, {
				later: {
					description: 'Test later',
					files: [{ source: 'payload/later.md', target: 'docs/later.md' }]
				}
			});
		});
		later.commit();

		const { status, report } = engine(
			consumer,
			'install',
			'--source',
			later.dir,
			'--modules',
			'later'
		);

		assert.equal(status, 1);
		assert.deepEqual(report.next, [
			'later came after the locked commit; run `update`, then install again'
		]);
	});

	it("refuses a modules.json with a key it doesn't know", () => {
		const misspelled = createUpstream();

		editManifest(misspelled, (manifest) => {
			Object.assign(manifest.modules.core, { fils: [] });
		});
		misspelled.commit();

		const { status, report } = engine(createConsumer(), 'install', '--source', misspelled.dir);

		assert.equal(status, 1);
		assert.equal(report.status, 'error');
		assert.match(report.next.join('\n'), /unknown keys fils/);
	});

	it('refuses a prerequisite that names neither a path nor a field', () => {
		const vague = createUpstream();

		editManifest(vague, (manifest) => {
			Object.assign(manifest.modules.core, { prerequisites: [{ why: 'something' }] });
		});
		vague.commit();

		const { status, report } = engine(createConsumer(), 'install', '--source', vague.dir);

		assert.equal(status, 1);
		assert.match(
			report.next.join('\n'),
			/modules\.core\.prerequisites\[0\]: set exactly one of path and field/
		);
	});

	it('refuses a module that writes a file an installed module writes', () => {
		const clashing = createUpstream();

		editManifest(clashing, (manifest) => {
			manifest.modules.extra.files = [
				{ source: 'payload/extra.md', target: 'docs/rules/a.md' }
			];
		});
		clashing.commit();

		const consumer = createConsumer();

		engine(consumer, 'install', '--source', clashing.dir);
		consumer.commit();

		const { status, report } = engine(
			consumer,
			'install',
			'--source',
			clashing.dir,
			'--modules',
			'extra'
		);

		assert.equal(status, 1);
		assert.deepEqual(report.next, [
			'modules: extra (payload/extra.md) and core (payload/docs/a.md) both write docs/rules/a.md'
		]);
		assert.equal(consumer.read('docs/rules/a.md'), lines());
		assert.deepEqual(consumer.lock().modules, ['core']);
	});

	it('refuses a modules.json with a target outside the repo, a missing host or a misordered requirement', () => {
		const escaping = createUpstream();

		editManifest(escaping, (manifest) => {
			manifest.modules.extra.files = [{ source: 'payload/extra.md', target: '../extra.md' }];
		});
		escaping.commit();

		const outside = engine(
			createConsumer(),
			'install',
			'--source',
			escaping.dir,
			'--modules',
			'extra'
		);

		assert.equal(outside.status, 1);
		assert.deepEqual(outside.report.next, [
			'modules: extra (payload/extra.md) writes outside the repo'
		]);

		const unhosted = createUpstream();

		editManifest(unhosted, (manifest) => {
			Object.assign(manifest.modules.extra, {
				blocks: [{ source: 'payload/extra.md', target: 'docs/extra-index.md' }],
				json: [{ target: 'AGENTS.md', key: 'extends', values: ['./extra.json'] }]
			});
		});
		unhosted.commit();

		const misplaced = engine(
			createConsumer(),
			'install',
			'--source',
			unhosted.dir,
			'--modules',
			'extra'
		);

		assert.equal(misplaced.status, 1);
		assert.deepEqual(misplaced.report.next, [
			'modules.extra.blocks[0]: hosts["docs/extra-index.md"] must set a block style'
		]);

		editManifest(unhosted, (manifest) => {
			Object.assign(manifest.modules.extra, { blocks: [] });
		});
		unhosted.commit();

		const styled = engine(
			createConsumer(),
			'install',
			'--source',
			unhosted.dir,
			'--modules',
			'extra'
		);

		assert.equal(styled.status, 1);
		assert.deepEqual(styled.report.next, [
			'modules.extra.json[0]: hosts["AGENTS.md"] has a block style, so it can\'t take JSON values'
		]);

		const misordered = createUpstream();

		editManifest(misordered, (manifest) => {
			const { core, extra } = manifest.modules;

			manifest.modules = { extra, core };
		});
		misordered.commit();

		const late = engine(createConsumer(), 'install', '--source', misordered.dir);

		assert.equal(late.status, 1);
		assert.deepEqual(late.report.next, [
			'modules.extra.requires: list core before extra in modules.json'
		]);

		editManifest(misordered, (manifest) => {
			const { core, extra } = manifest.modules;

			manifest.modules = { core, extra };
			Object.assign(extra, { requires: ['core', 'gone'] });
		});
		misordered.commit();

		const unknown = engine(createConsumer(), 'install', '--source', misordered.dir);

		assert.deepEqual(unknown.report.next, ["modules.extra.requires: there's no gone module"]);
	});
});
