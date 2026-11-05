// @ts-check
import { pendingHint, readLock, sourceChange, writeLock } from './lock.mjs';
import {
	buildPayload,
	declinedFiles,
	expandModules,
	readManifest,
	splitFolders
} from './manifest.mjs';
import { plan, stage } from './plan.mjs';
import { createReport, refuse } from './report.mjs';
import { servedRequirements, unmetRequirements } from './requirements.mjs';
import { hasCommit, resolveCommit, useFetchableUrl } from './source.mjs';
import { Staging } from './staging.mjs';

/** @typedef {import('./source.mjs').Source} Source */
/** @typedef {import('./plan.mjs').Decisions} Decisions */
/** @typedef {import('./report.mjs').Report} Report */
/** @typedef {import('./lock.mjs').Lock} Lock */

/**
 * @typedef {object} InstallOptions
 * @property {string[]} modules Defaults to `core`.
 * @property {string | undefined} ref
 * @property {Record<string, string>} maps
 * @property {Decisions} decisions
 * @property {boolean} dryRun
 */

/**
 * Installs modules into a repo that doesn't have them yet. Plans every item first and writes nothing
 * while any target collides. A repo that already has a lockfile gets the new modules at its locked
 * commit, so every entry keeps a common base.
 * @param {string} repo
 * @param {Source} source
 * @param {InstallOptions} options
 * @returns {Report}
 */
export function install(repo, source, options) {
	const report = createReport('install');
	const lock = readLock(repo);

	if (lock && lock.pending.length > 0) {
		return refuse(report, `finish the pending work first: ${pendingHint(lock.pending)}`);
	}

	if (lock && Object.keys(options.maps).length > 0) {
		return refuse(
			report,
			'--map only applies to the first install; the lockfile fixes the layout'
		);
	}

	const ref = lock?.source.ref ?? options.ref ?? 'main';
	const commit = lock?.source.commit ?? resolveCommit(source, ref);

	if (!commit || !hasCommit(source, commit))
		return refuse(report, `${commit ?? ref} isn't in ${source.url}`);

	useFetchableUrl(source, commit);

	if (lock && options.ref && options.ref !== lock.source.ref) {
		report.next.push(
			`new modules join the locked commit; run \`update --ref ${options.ref}\` to move`
		);
	}

	const manifest = readManifest(source, commit);

	if (!manifest) return refuse(report, `${commit} has no modules.json`);

	const installedModules = lock?.modules ?? [];
	const requested = options.modules.length > 0 ? options.modules : ['core'];
	const expanded = expandModules(manifest, [...installedModules, ...requested]);

	if (expanded.unknown.length > 0) {
		return refuse(report, unknownModules(source, lock, manifest, expanded.unknown));
	}

	const fresh = expanded.modules.filter((name) => !installedModules.includes(name));
	const maps = lock?.maps ?? options.maps;
	// Built from every module, so a new module can't claim a path an installed one writes.
	const payload = buildPayload(source, commit, manifest, expanded.modules, maps);

	const declined = declinedFiles(payload, {
		tracked: new Set(lock?.files.map((entry) => entry.target)),
		skip: options.decisions.skip,
		excluded: lock?.excluded ?? [],
		add: []
	});

	const split = splitFolders(payload, declined);

	if (split.length > 0) {
		for (const message of split) refuse(report, message);

		return report;
	}

	/** @param {{ module: string }} item */
	const isFresh = (item) => fresh.includes(item.module);

	report.source = { url: source.url, ref, commit };
	report.modules = fresh;
	const lockedTargets = lock?.files.map((entry) => entry.target) ?? [];

	report.requirements = unmetRequirements(
		repo,
		servedRequirements(payload, new Set(lockedTargets))
	);

	if (fresh.length === 0) {
		report.status = 'up-to-date';

		return report;
	}

	const decisions = {
		...options.decisions,
		skip: [...options.decisions.skip, ...(lock?.excluded ?? [])]
	};

	const staging = new Staging(repo);

	const context = {
		repo,
		source,
		commit,
		maps,
		decisions,
		staging,
		declined,
		contributions: payload.json
	};

	const steps = plan(context, {
		files: payload.files.filter(isFresh),
		links: payload.links.filter(isFresh),
		blocks: payload.blocks.filter(isFresh),
		json: payload.json.filter(isFresh)
	});

	const { installed, entries, next } = stage(context, steps);

	report.entries = entries;
	report.next.push(...next);

	report.requirements = unmetRequirements(
		repo,
		servedRequirements(
			payload,
			new Set([...lockedTargets, ...installed.files.map((entry) => entry.target)])
		)
	);

	if (steps.some((step) => step.action === 'collision')) {
		report.status = 'collisions';
		report.next.push(
			'nothing was written; rerun with --overwrite, --keep or --skip for each collision (a path or a folder)'
		);

		return report;
	}

	if (installed.pending.length > 0) report.next.push(pendingHint(installed.pending));

	if (report.requirements.length > 0) {
		report.next.push('update package.json for the unmet requirements');
	}

	if (lock) report.next.push(...sourceChange(lock, source.url));

	report.status = installed.pending.length > 0 ? 'pending' : 'installed';

	if (options.dryRun) return report;

	staging.flush();
	writeLock(repo, extendLock(lock, { url: source.url, ref, commit }, fresh, maps, installed));

	return report;
}

/**
 * @param {Lock | null} lock
 * @param {Lock['source']} source
 * @param {string[]} modules
 * @param {Record<string, string>} maps
 * @param {import('./plan.mjs').Installed} installed
 * @returns {Lock}
 */
function extendLock(lock, source, modules, maps, installed) {
	return {
		source,
		modules: [...(lock?.modules ?? []), ...modules],
		maps,
		files: [...(lock?.files ?? []), ...installed.files],
		blocks: [...(lock?.blocks ?? []), ...installed.blocks],
		links: [...(lock?.links ?? []), ...installed.links],
		json: [...(lock?.json ?? []), ...installed.json],
		excluded: [...(lock?.excluded ?? []), ...installed.excluded],
		pending: installed.pending
	};
}

/**
 * @param {Source} source
 * @param {Lock | null} lock
 * @param {import('./manifest.mjs').Manifest} manifest
 * @param {string[]} unknown
 * @returns {string} Why install refuses: modules upstream added after the locked commit need an
 * update first, since new modules join at the locked commit.
 */
function unknownModules(source, lock, manifest, unknown) {
	const latest = lock ? resolveCommit(source, lock.source.ref) : null;
	const upstream = latest ? readManifest(source, latest) : null;

	if (lock && upstream && unknown.every((name) => upstream[name])) {
		return `${unknown.join(', ')} came after the locked commit; run \`update\`, then install again`;
	}

	return `unknown modules: ${unknown.join(', ')} (have ${Object.keys(manifest).join(', ')})`;
}
