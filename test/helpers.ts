import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import {
	decodeArray,
	decodeBoolean,
	decodeJson,
	decodeOptionalString,
	decodeRecord,
	decodeString,
	decodeStringArray
} from '../scripts/lib/decode.mjs';
import { LOCK_FILE, parseLock, type Lock } from '../scripts/lib/lock.mjs';
import type { ReportEntry } from '../scripts/lib/report.mjs';

/** The house-rules checkout under test. */
export const ROOT = path.resolve(import.meta.dirname, '..');

const ENGINE = path.join(ROOT, 'scripts', 'house-rules.mjs');

/** Isolates every git call from the user's config, so signing or hooks can't interfere. */
export const ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com'
};

const temps: string[] = [];

after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Creates a directory that is removed when the test file finishes. Resolves symlinks such as macOS's `/var`, as the engine does. */
export function tempDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'house-rules-test-')));

	temps.push(dir);

	return dir;
}

/** Runs git in `cwd` and returns its trimmed stdout, failing the test on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
	const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });

	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);

	return result.stdout.trim();
}

/** A git repository in a temporary directory, written to through repo-relative paths. */
export class TempRepo {
	readonly dir: string;

	constructor() {
		this.dir = tempDir();
		git(this.dir, 'init', '--quiet', '-b', 'main');
	}

	/** Writes each file at its repo-relative path, creating folders as needed. */
	write(files: Record<string, string>): this {
		for (const [target, text] of Object.entries(files)) {
			const file = path.join(this.dir, target);

			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, text);
		}

		return this;
	}

	/** Deletes files or folders at repo-relative paths. */
	remove(...targets: string[]): this {
		for (const target of targets) rmSync(path.join(this.dir, target), { recursive: true });

		return this;
	}

	read(target: string): string {
		return readFileSync(path.join(this.dir, target), 'utf8');
	}

	exists(target: string): boolean {
		return existsSync(path.join(this.dir, target));
	}

	isSymlink(target: string): boolean {
		return lstatSync(path.join(this.dir, target)).isSymbolicLink();
	}

	/** Commits everything and returns the new commit's SHA. */
	commit(message = 'change'): string {
		git(this.dir, 'add', '--all');
		git(this.dir, 'commit', '--quiet', '--allow-empty', '-m', message);

		return git(this.dir, 'rev-parse', 'HEAD');
	}

	/** Reads and decodes the repo's lockfile. */
	lock(): Lock {
		return parseLock(this.read(LOCK_FILE));
	}
}

/** A lint policy or requirement change in a report. */
type Change = { type: string; name: string; from: string | null; to: string | null };

/** A requirement the repo doesn't meet yet. */
type Requirement = { type: string; name: string; wanted: string; found: string | null };

/** The parts of a `--json` report the tests read. */
export type Report = {
	status: string;
	dryRun: boolean;
	source?: { url: string; ref: string; commit: string; from?: string };
	modules?: string[];
	entries: ReportEntry[];
	lintChanges: Change[];
	requirementChanges: Change[];
	requirements: Requirement[];
	next: string[];
};

/** Decodes the `--json` report the engine prints. */
export function parseReport(text: string): Report {
	const raw = decodeRecord(decodeJson(text, 'report'), 'report');

	const changes = (key: 'lintChanges' | 'requirementChanges'): Change[] =>
		decodeArray(raw[key], key).map((item, index) => {
			const at = `${key}[${index}]`;
			const change = decodeRecord(item, at);

			return {
				type: decodeString(change.type, `${at}.type`),
				name: decodeString(change.name, `${at}.name`),
				from: change.from === null ? null : decodeString(change.from, `${at}.from`),
				to: change.to === null ? null : decodeString(change.to, `${at}.to`)
			};
		});

	const report: Report = {
		status: decodeString(raw.status, 'status'),
		dryRun: decodeBoolean(raw.dryRun, 'dryRun'),
		entries: decodeArray(raw.entries, 'entries').map((item, index) => {
			const at = `entries[${index}]`;
			const entry = decodeRecord(item, at);
			const detail = decodeOptionalString(entry.detail, `${at}.detail`);
			const unit = decodeOptionalString(entry.unit, `${at}.unit`);

			const decoded: ReportEntry = {
				status: decodeString(entry.status, `${at}.status`),
				target: decodeString(entry.target, `${at}.target`)
			};

			if (detail !== undefined) decoded.detail = detail;

			if (unit !== undefined) decoded.unit = unit;

			return decoded;
		}),
		lintChanges: changes('lintChanges'),
		requirementChanges: changes('requirementChanges'),
		requirements: decodeArray(raw.requirements, 'requirements').map((item, index) => {
			const at = `requirements[${index}]`;
			const requirement = decodeRecord(item, at);

			return {
				type: decodeString(requirement.type, `${at}.type`),
				name: decodeString(requirement.name, `${at}.name`),
				wanted: decodeString(requirement.wanted, `${at}.wanted`),
				found:
					requirement.found === null
						? null
						: decodeString(requirement.found, `${at}.found`)
			};
		}),
		next: decodeStringArray(raw.next, 'next')
	};

	if (raw.source !== undefined) {
		const source = decodeRecord(raw.source, 'source');

		report.source = {
			url: decodeString(source.url, 'source.url'),
			ref: decodeString(source.ref, 'source.ref'),
			commit: decodeString(source.commit, 'source.commit')
		};

		if (source.from !== undefined)
			report.source.from = decodeString(source.from, 'source.from');
	}

	if (raw.modules !== undefined) report.modules = decodeStringArray(raw.modules, 'modules');

	return report;
}

/** The result of one engine run. */
export type Run = {
	status: number;
	report: Report;
};

/** Runs the engine on `repo` with `--json` and parses its report. */
export function engine(repo: TempRepo, ...args: string[]): Run {
	const result = spawnSync(process.execPath, [ENGINE, ...args, '--repo', repo.dir, '--json'], {
		env: ENV,
		encoding: 'utf8'
	});

	if (result.stderr) throw new Error(result.stderr);

	return { status: result.status ?? -1, report: parseReport(result.stdout) };
}

/** Finds the report entry for `target`, failing when there is none. */
export function entryFor(report: Report, target: string): ReportEntry {
	const entry = report.entries.find((candidate) => candidate.target === target);

	if (!entry) throw new Error(`no entry for ${target} in ${JSON.stringify(report.entries)}`);

	return entry;
}

/** The engine's content hash. */
export function sha(text: string): string {
	return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Ten numbered lines, so tests can change lines far enough apart to merge cleanly. */
export function lines(...changes: [number, string][]): string {
	const result = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

	for (const [line, text] of changes) result[line - 1] = text;

	return `${result.join('\n')}\n`;
}

const MODULES = {
	hosts: {
		'AGENTS.md': { style: 'markdown', scaffold: '# AGENTS.md\n\n{{block}}\n' },
		'.prettierignore': { style: 'hash' },
		'.oxlintrc.json': { alternatives: ['oxlint.config.ts'] }
	},
	modules: {
		core: {
			description: 'Test core',
			files: [
				{ source: 'payload/lint.json', target: 'tools/lint.json', kind: 'oxlint-config' },
				{ source: 'payload/docs', target: 'docs/rules' },
				{
					source: 'payload/.prettierrc',
					target: '.prettierrc',
					alternatives: ['prettier.config.js', 'package.json#prettier']
				}
			],
			skills: ['payload/skills/demo'],
			blocks: [
				{ source: 'payload/agents.md', target: 'AGENTS.md' },
				{ source: 'payload/ignore', target: '.prettierignore' }
			],
			json: [
				{ target: '.oxlintrc.json', key: 'extends', values: ['{{rel:tools/lint.json}}'] }
			],
			devDependencies: { oxlint: '1.81.0' },
			scripts: { lint: 'oxlint' }
		},
		extra: {
			description: 'Test extra',
			requires: ['core'],
			files: [{ source: 'payload/extra.md', target: 'docs/extra.md' }]
		}
	}
};

type Manifest = typeof MODULES;

/** A test upstream. It keeps the modules.json it last wrote, so tests edit that instead of parsing the file. */
export class Upstream extends TempRepo {
	readonly manifest: Manifest = structuredClone(MODULES);
}

/** Rewrites the upstream's modules.json through `edit`, without committing. */
export function editManifest(upstream: Upstream, edit: (manifest: Manifest) => void): void {
	edit(upstream.manifest);
	upstream.write({ 'modules.json': `${JSON.stringify(upstream.manifest, null, '\t')}\n` });
}

/** An upstream repo with a small `core` module and an `extra` module that requires it. */
export function createUpstream(): Upstream {
	const upstream = new Upstream();

	upstream.write({
		'modules.json': `${JSON.stringify(upstream.manifest, null, '\t')}\n`,
		'payload/lint.json': '{\n\t"rules": {\n\t\t"no-eval": "error"\n\t}\n}\n',
		'payload/docs/a.md': lines(),
		'payload/docs/b.md': 'See {{rel:AGENTS.md}} and `{{path:tools/lint.json}}`.\n',
		'payload/.prettierrc': '{ "useTabs": true }\n',
		'payload/skills/demo/SKILL.md': '---\nname: demo\n---\n\nRead {{rel:docs/rules/a.md}}.\n',
		'payload/agents.md': '## Rules\n\nRead `{{path:docs/rules/a.md}}`.\n',
		'payload/ignore': '{{path:tools}}\n',
		'payload/extra.md': 'extra\n'
	});
	upstream.commit('initial');

	return upstream;
}

/** A consumer repo with one commit, so the engine's dirty check has a baseline. */
export function createConsumer(
	files: Record<string, string> = { 'README.md': '# App\n' }
): TempRepo {
	const consumer = new TempRepo();

	consumer.write(files);
	consumer.commit('initial');

	return consumer;
}

/** Installs `core` from `upstream` into a new consumer and commits the result. */
export function installed(upstream: TempRepo): TempRepo {
	const consumer = createConsumer();
	const { report } = engine(consumer, 'install', '--source', upstream.dir);

	if (report.status !== 'installed') throw new Error(JSON.stringify(report));

	consumer.commit('install house-rules');

	return consumer;
}
