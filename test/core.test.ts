import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { decodeArray, decodeJson, decodeRecord, decodeString } from '../scripts/lib/decode.mjs';
import { parseManifest } from '../scripts/lib/manifest.mjs';
import { createConsumer, engine, ENV, ROOT, TempRepo } from './helpers.ts';

/** Packages the installed config needs, linked from this checkout so the test runs offline. */
const PACKAGES = ['oxlint', '@oxlint/plugins', 'prettier', 'prettier-plugin-organize-imports'];

/** Installs every module, so one consumer covers all of the payload. */
const ALL = ['--modules', 'core,effect,svelte,tailwind'];

const TEMPLATE = /\{\{(path|rel):/;

const TEMPLATE_PATH = /\{\{(?:path|rel):([^}\s]+)\}\}/g;

const LINK = /\]\((?!https?:|mailto:|#)([^)\s#]+)(#[^)]*)?\)/g;

/** An upstream holding this checkout's real `modules.json` and payload. */
function realUpstream(): TempRepo {
	const upstream = new TempRepo();

	cpSync(path.join(ROOT, 'modules.json'), path.join(upstream.dir, 'modules.json'));
	cpSync(path.join(ROOT, 'src'), path.join(upstream.dir, 'src'), { recursive: true });
	upstream.commit('payload');

	return upstream;
}

/** A consumer that ignores `node_modules` and links the tool packages into it. */
function toolConsumer(): TempRepo {
	const consumer = createConsumer({
		'.gitignore': 'node_modules\n',
		'package.json': '{ "name": "app", "private": true, "type": "module" }\n',
		'lib/bad.ts':
			'export function names(xs: number[]): string[] {\n\treturn xs.filter(Boolean).map(String);\n}\n',
		'lib/recover.ts': [
			"import { Effect } from 'effect';",
			'',
			'class MissingError extends Error {}',
			'',
			'export const recover = (effect: Effect.Effect<number, MissingError>) =>',
			'\tEffect.catch(effect, (error) => Effect.succeed(error instanceof MissingError ? 0 : 1));',
			''
		].join('\n'),
		'src/routes/+page.ts': 'export const _load = 1;\n',
		'src/routes/+page.svelte': [
			'<script lang="ts">',
			"\timport type { PageData } from './$types';",
			'',
			'\tlet { data }: { data: PageData } = $props();',
			'</script>',
			'',
			'<p>{data}</p>',
			''
		].join('\n')
	});

	for (const name of PACKAGES) {
		const link = path.join(consumer.dir, 'node_modules', name);

		mkdirSync(path.dirname(link), { recursive: true });
		symlinkSync(path.join(ROOT, 'node_modules', name), link);
	}

	return consumer;
}

/** Every file the lockfile manages, or adds a block or JSON values to. */
function managedFiles(consumer: TempRepo): string[] {
	const lock = consumer.lock();

	return [...new Set([...lock.files, ...lock.blocks, ...lock.json].map((entry) => entry.target))];
}

/** Relative Markdown links in `target` whose destination doesn't exist. */
function brokenLinks(consumer: TempRepo, target: string): string[] {
	const folder = path.dirname(path.join(consumer.dir, target));

	return [...consumer.read(target).matchAll(LINK)].flatMap(([, destination = '']) =>
		existsSync(path.join(folder, destination)) ? [] : [`${target}: ${destination}`]
	);
}

/** Every path a template in this checkout's `modules.json` and payload names. */
function templatePaths(): string[] {
	const files = readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));

	const texts = [path.join(ROOT, 'modules.json'), ...files].map((file) =>
		readFileSync(file, 'utf8')
	);

	return [
		...new Set(
			texts.flatMap((text) =>
				[...text.matchAll(TEMPLATE_PATH)].map(([, target = '']) => target)
			)
		)
	];
}

/** The default target of every file, skill, block host and JSON host the modules install. */
function defaultTargets(): string[] {
	const manifest = parseManifest(readFileSync(path.join(ROOT, 'modules.json'), 'utf8'));

	return Object.values(manifest).flatMap((spec) => [
		...spec.files.map((file) => file.target),
		...spec.skills.map((skill) => `.agents/skills/${path.posix.basename(skill)}`),
		...spec.blocks.map((block) => block.target),
		...spec.json.map((json) => json.target)
	]);
}

describe('the payload', () => {
	it('names only installed paths in its templates', () => {
		const targets = defaultTargets();

		const unknown = templatePaths().filter(
			(target) =>
				!targets.some((managed) => target === managed || target.startsWith(`${managed}/`))
		);

		assert.deepEqual(unknown, []);
	});
});

describe('the modules', () => {
	const upstream = realUpstream();

	for (const maps of [[], ['--map', 'docs=handbook', '--map', 'tools/oxlint=config/lint']]) {
		const layout = maps.length === 0 ? 'the default layout' : 'a mapped layout';

		it(`installs into ${layout} with every template and link resolved`, () => {
			const consumer = toolConsumer();

			const { report } = engine(
				consumer,
				'install',
				'--source',
				upstream.dir,
				...ALL,
				...maps
			);

			assert.equal(report.status, 'installed');
			assert.deepEqual(
				report.entries.filter((entry) => entry.status !== 'written'),
				[]
			);

			const files = managedFiles(consumer);

			assert.deepEqual(
				files.filter((target) => TEMPLATE.test(consumer.read(target))),
				[]
			);
			assert.deepEqual(
				files
					.filter((target) => target.endsWith('.md'))
					.flatMap((target) => brokenLinks(consumer, target)),
				[]
			);
			assert.equal(engine(consumer, 'check', '--offline').report.status, 'ok');
		});
	}

	it('lints with every plugin through `extends` and skips the managed plugin folders', () => {
		const consumer = toolConsumer();

		engine(consumer, 'install', '--source', upstream.dir, ...ALL);

		const result = spawnSync(
			path.join(ROOT, 'node_modules', '.bin', 'oxlint'),
			['--format', 'json'],
			{ cwd: consumer.dir, env: ENV, encoding: 'utf8', timeout: 60_000 }
		);

		const output = decodeRecord(decodeJson(result.stdout, 'oxlint'), 'oxlint');

		const diagnostics = decodeArray(output.diagnostics, 'diagnostics').map((item, index) => {
			const diagnostic = decodeRecord(item, `diagnostics[${index}]`);

			return [
				decodeString(diagnostic.filename, `diagnostics[${index}].filename`),
				decodeString(diagnostic.code, `diagnostics[${index}].code`)
			];
		});

		assert.equal(result.stderr, '');
		assert.deepEqual(diagnostics.toSorted(), [
			['lib/bad.ts', 'anti-slop(no-array-filter-map)'],
			['lib/recover.ts', 'house-effect(no-instanceof-in-effect-error-handler)'],
			['src/routes/+page.svelte', 'eslint(no-restricted-imports)'],
			['src/routes/+page.ts', 'house-svelte(no-underscore-exports)']
		]);
	});

	it("installs files that are already formatted under this repo's Prettier config", () => {
		const consumer = toolConsumer();

		cpSync(path.join(ROOT, '.prettierrc'), path.join(consumer.dir, '.prettierrc'));

		engine(consumer, 'install', '--source', upstream.dir, ...ALL);

		const files = managedFiles(consumer);

		assert.ok(files.includes('.oxlintrc.json'));

		const result = spawnSync(
			path.join(ROOT, 'node_modules', '.bin', 'prettier'),
			['--check', '--ignore-unknown', ...files],
			{ cwd: consumer.dir, env: ENV, encoding: 'utf8', timeout: 60_000 }
		);

		assert.equal(result.status, 0, result.stdout + result.stderr);
	});
});
