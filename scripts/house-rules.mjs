#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './lib/check.mjs';
import { DecodeError } from './lib/decode.mjs';
import { GitError, gitOrNull } from './lib/git.mjs';
import { install } from './lib/install.mjs';
import { isRepoPath } from './lib/render.mjs';
import { createReport, formatReport } from './lib/report.mjs';
import { closeSource, openSource } from './lib/source.mjs';
import { resolve, untrack } from './lib/track.mjs';
import { update } from './lib/update.mjs';

/** @typedef {import('./lib/report.mjs').Report} Report */
/** @typedef {import('./lib/source.mjs').Source} Source */

const USAGE = `Usage: house-rules.mjs <command> [options]

Commands:
  install [--modules a,b] [--map from=to] [--overwrite|--keep|--skip <path>]
  update [--ref <ref>] [--add <path>] [--skip <path>] [--overwrite|--keep <path>]
         [--follow-renames] [--allow-dirty]
  check [--strict] [--offline]
  resolve <target>...
  untrack <target>...

Options:
  --repo <dir>      repo to work on (default: the current directory)
  --json            print the machine-readable report
  --dry-run         report what would change and write nothing; check never writes
  --source <spec>   install, update, check: house-rules checkout or git URL (default: this
                    script's checkout)
  --ref <ref>       install, update: branch, tag or commit (default: the locked ref, else
                    main). Other commands accept it because the bootstrap passes it on after
                    using it to pick the engine it fetches.

Exit status: 0 done, 1 refused or failed, 2 conflicts or manual changes pending. A dry run
reports the status and exit status the real run would have.
`;

const OPTIONS = /** @type {const} */ ({
	repo: { type: 'string' },
	source: { type: 'string' },
	ref: { type: 'string' },
	json: { type: 'boolean', default: false },
	'dry-run': { type: 'boolean', default: false },
	modules: { type: 'string', multiple: true },
	map: { type: 'string', multiple: true },
	overwrite: { type: 'string', multiple: true },
	keep: { type: 'string', multiple: true },
	skip: { type: 'string', multiple: true },
	add: { type: 'string', multiple: true },
	'follow-renames': { type: 'boolean', default: false },
	'allow-dirty': { type: 'boolean', default: false },
	strict: { type: 'boolean', default: false },
	offline: { type: 'boolean', default: false },
	help: { type: 'boolean', default: false }
});

// `ref` everywhere: the bootstrap passes it on after using it to pick the engine.
const COMMON = ['repo', 'ref', 'json', 'help'];

/** @type {Record<string, string[]>} */
const ALLOWED = {
	install: [...COMMON, 'source', 'dry-run', 'modules', 'map', 'overwrite', 'keep', 'skip'],
	update: [
		...COMMON,
		'source',
		'dry-run',
		'add',
		'skip',
		'overwrite',
		'keep',
		'follow-renames',
		'allow-dirty'
	],
	check: [...COMMON, 'source', 'strict', 'offline'],
	resolve: [...COMMON, 'dry-run'],
	untrack: [...COMMON, 'dry-run']
};

/** Report statuses that exit with 1. */
const FAILED = new Set(['refused', 'collisions', 'failed', 'error']);

class UsageError extends Error {}

/**
 * @param {string[]} pairs `from=to` arguments.
 * @returns {Record<string, string>}
 */
function parseMaps(pairs) {
	/** @type {Record<string, string>} */
	const maps = {};

	for (const pair of pairs) {
		const parts = pair.split('=');
		const [from, to] = parts;

		if (parts.length !== 2 || !from || !to) {
			throw new UsageError(`--map expects one from=to pair, got ${pair}`);
		}

		if (!isRepoPath(from) || !isRepoPath(to)) {
			throw new UsageError(`--map ${pair}: both paths must stay inside the repo`);
		}

		maps[from.replace(/\/+$/, '')] = to.replace(/\/+$/, '');
	}

	return maps;
}

/**
 * @param {string} dir
 * @returns {string} The work tree root containing `dir`, or `dir` itself outside git.
 */
function repoRoot(dir) {
	return gitOrNull(dir, ['rev-parse', '--show-toplevel'])?.trim() || dir;
}

/**
 * @param {string | undefined} spec
 * @returns {Source | Error}
 */
function tryOpenSource(spec) {
	try {
		return openSource(spec);
	} catch (error) {
		if (error instanceof GitError) return error;

		throw error;
	}
}

/** @typedef {ReturnType<typeof parse>['values']} Values */

/**
 * @param {string} repo
 * @param {Values} values
 * @returns {Report}
 */
function runCheck(repo, values) {
	const source = values.offline ? null : tryOpenSource(values.source);

	try {
		return check(repo, source, { strict: values.strict });
	} finally {
		if (source && !(source instanceof Error)) closeSource(source);
	}
}

/**
 * @param {'install' | 'update'} command
 * @param {string} repo
 * @param {Source} source
 * @param {Values} values
 * @returns {Report}
 */
function runWithSource(command, repo, source, values) {
	const dryRun = values['dry-run'];

	const decisions = {
		overwrite: values.overwrite ?? [],
		keep: values.keep ?? [],
		skip: values.skip ?? []
	};

	if (command === 'install') {
		return install(repo, source, {
			modules: (values.modules ?? []).flatMap((value) => value.split(',').filter(Boolean)),
			ref: values.ref,
			maps: parseMaps(values.map ?? []),
			decisions,
			dryRun
		});
	}

	return update(repo, source, {
		ref: values.ref,
		add: values.add ?? [],
		decisions,
		followRenames: values['follow-renames'],
		allowDirty: values['allow-dirty'],
		dryRun
	});
}

/**
 * @param {string} command One of the {@link ALLOWED} commands.
 * @param {Values} values
 * @param {string[]} targets
 * @returns {Report}
 */
function run(command, values, targets) {
	const repo = repoRoot(path.resolve(values.repo ?? process.cwd()));
	const dryRun = values['dry-run'];

	if (command === 'resolve' || command === 'untrack') {
		if (targets.length === 0) throw new UsageError(`${command} needs at least one target`);

		return command === 'resolve'
			? resolve(repo, targets, { dryRun })
			: untrack(repo, targets, { dryRun });
	}

	if (targets.length > 0)
		throw new UsageError(`${command} takes no arguments: ${targets.join(' ')}`);

	if (command === 'check') return runCheck(repo, values);

	const source = openSource(values.source);

	try {
		const report = runWithSource(
			command === 'install' ? 'install' : 'update',
			repo,
			source,
			values
		);

		if (path.isAbsolute(source.url) && !FAILED.has(report.status)) {
			report.next.push(
				`the lockfile records the local path ${source.url} as the source, which CI and other machines can't fetch; use a git URL in a shared repo`
			);
		}

		return report;
	} finally {
		closeSource(source);
	}
}

/**
 * @param {string[]} args
 */
function parse(args) {
	return parseArgs({
		args,
		options: OPTIONS,
		allowPositionals: true,
		strict: true,
		tokens: true
	});
}

/**
 * @param {Report} report
 * @returns {number}
 */
function exitCode(report) {
	if (report.status === 'pending') return 2;

	return FAILED.has(report.status) ? 1 : 0;
}

/**
 * @param {string[]} args
 * @returns {number} The exit status.
 */
function main(args) {
	/** @type {ReturnType<typeof parse>} */
	let parsed;

	try {
		parsed = parse(args);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`
		);

		return 1;
	}

	const { values, positionals } = parsed;
	const [command = '', ...targets] = positionals;
	const allowed = ALLOWED[command];

	if (values.help || !allowed) {
		process.stdout.write(USAGE);

		return values.help ? 0 : 1;
	}

	const extra = parsed.tokens.flatMap((token) =>
		token.kind === 'option' && !allowed.includes(token.name) ? [token.name] : []
	);

	if (extra.length > 0) {
		process.stderr.write(`${command} doesn't take --${extra.join(', --')}\n\n${USAGE}`);

		return 1;
	}

	/** @type {Report} */
	let report;

	try {
		report = run(command, values, targets);
	} catch (error) {
		const expected =
			error instanceof UsageError ||
			error instanceof DecodeError ||
			error instanceof GitError ||
			error instanceof SyntaxError;

		if (!expected) throw error;

		report = createReport(command);
		report.status = 'error';
		report.next.push(error.message.trim());
	}

	report.dryRun = values['dry-run'];

	process.stdout.write(
		values.json ? `${JSON.stringify(report, null, '\t')}\n` : formatReport(report)
	);

	return exitCode(report);
}

process.exitCode = main(process.argv.slice(2));
