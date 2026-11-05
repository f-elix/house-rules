// @ts-check
import path from 'node:path';
import {
	DecodeError,
	decodeArray,
	decodeJson,
	decodeKeys,
	decodeOptionalString,
	decodeOptionalStringArray,
	decodeOptionalStringRecord,
	decodeRecord,
	decodeString,
	decodeStringArray
} from './decode.mjs';
import { blockKey, jsonKey } from './lock.mjs';
import { isRepoPath, keyMatchesAny, mapPath, render, templatePaths } from './render.mjs';
import { listFiles, readAt } from './source.mjs';

/** @typedef {import('./source.mjs').Source} Source */
/** @typedef {import('./git.mjs').GitError} GitError */

/** The module list at the root of a house-rules checkout. */
const MANIFEST_PATH = 'modules.json';

const SKILLS_DIR = '.agents/skills';

const SKILL_LINKS_DIR = '.claude/skills';

/** @typedef {'markdown' | 'hash'} BlockStyle */

/**
 * `oxlint-config` makes updates report the file's rule changes for approval.
 * @typedef {'oxlint-config'} FileKind
 */

/**
 * @typedef {object} FileSpec
 * @property {string} source A file, or a directory installed with everything under it.
 * @property {string} target
 * @property {FileKind | undefined} kind
 * @property {string[]} alternatives Other configs for the same tool; one present is a collision. Each
 * is a path, or `file#key` for a top-level key in a JSON file, such as `package.json#prettier`.
 */

/**
 * How to create a file that modules add blocks or JSON values to. The manifest's top-level `hosts`
 * holds one per file, keyed by default target, so every module writing there agrees on it.
 * @typedef {object} HostSpec
 * @property {BlockStyle | undefined} style The block markers. Set for a file that holds blocks, and
 * only for one.
 * @property {string | undefined} scaffold Content of a new file. In a block host, `{{block}}` stands
 * for the first block.
 * @property {string[]} alternatives For a JSON host: other configs for the same tool, as in
 * {@link FileSpec}. One present while the file is missing is a collision.
 */

/**
 * @typedef {object} BlockSpec
 * @property {string} source
 * @property {string} target
 * @property {BlockStyle} style From the target's host.
 * @property {string} scaffold From the target's host.
 */

/**
 * @typedef {object} JsonSpec
 * @property {string} target
 * @property {string} key A top-level key holding an array of strings.
 * @property {string[]} values
 * @property {string} scaffold From the target's host: content of a new file, before the values are
 * added.
 * @property {string[]} alternatives From the target's host.
 */

/**
 * @typedef {object} Prerequisite
 * @property {string | undefined} path A file that must exist.
 * @property {string | undefined} field A `package.json` field that must be set.
 * @property {string} why
 */

/**
 * @typedef {object} ModuleSpec
 * @property {string} description
 * @property {string[]} requires
 * @property {FileSpec[]} files
 * @property {string[]} skills Skill directories, installed under `.agents/skills/` and linked from `.claude/skills/`.
 * @property {BlockSpec[]} blocks
 * @property {JsonSpec[]} json
 * @property {Record<string, string>} devDependencies Package name to version.
 * @property {Record<string, string>} scripts Script name to what runs it.
 * @property {Prerequisite[]} prerequisites
 * @property {Record<string, string[]>} serves Names from `devDependencies` and `scripts` that only the
 * files under the listed default targets need. A run drops such a requirement when the repo tracks
 * none of those files, for example when it keeps its own Prettier config.
 * @property {string[]} keepTogether Folders, by default target, whose files load each other by plain
 * relative paths because they can't hold templates. Maps must move each one as a whole.
 */

/** @typedef {Record<string, ModuleSpec>} Manifest */

/**
 * @typedef {object} FileItem
 * @property {string} module
 * @property {string} source
 * @property {string} target
 * @property {string} defaultTarget The target before maps apply.
 * @property {string} unit Target of the directory or skill the file ships with, or the file's own target.
 * @property {string | undefined} kind
 * @property {string[]} alternatives
 */

/**
 * @typedef {object} LinkItem
 * @property {string} module
 * @property {string} target
 * @property {string} to Relative symlink destination.
 * @property {string} unit The skill directory the link points at.
 */

/**
 * @typedef {object} BlockItem
 * @property {string} module
 * @property {string} source
 * @property {string} target
 * @property {BlockStyle} style
 * @property {string} scaffold
 */

/**
 * @typedef {object} JsonItem
 * @property {string} module
 * @property {string} target
 * @property {string} key
 * @property {string[]} values Rendered for the consumer's layout.
 * @property {Record<string, string[]>} needs For each rendered value, the installed paths its
 * templates name. A value waits until they exist, so an `extends` entry can't point at nothing.
 * @property {string} scaffold
 * @property {string[]} alternatives
 */

/**
 * @typedef {object} Requirements
 * @property {Record<string, string>} devDependencies
 * @property {Record<string, string>} scripts
 * @property {Prerequisite[]} prerequisites
 * @property {Record<string, string[]>} serves See {@link ModuleSpec}; only for the names it lists.
 */

/**
 * What a set of modules installs at one commit, with the consumer's maps applied.
 * @typedef {object} Payload
 * @property {string} commit
 * @property {string[]} modules The requested modules and every module they require.
 * @property {FileItem[]} files
 * @property {LinkItem[]} links
 * @property {BlockItem[]} blocks
 * @property {JsonItem[]} json
 * @property {string[]} together Every module's `keepTogether` folders.
 * @property {Requirements} requirements
 */

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {BlockStyle}
 */
function decodeBlockStyle(value, at) {
	if (value === 'markdown' || value === 'hash') return value;

	throw new DecodeError(`${at}: expected "markdown" or "hash"`);
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {FileKind | undefined}
 */
function decodeFileKind(value, at) {
	if (value === undefined || value === 'oxlint-config') return value;

	throw new DecodeError(`${at}: expected "oxlint-config"`);
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {HostSpec}
 */
function decodeHostSpec(value, at) {
	const raw = decodeKeys(decodeRecord(value, at), ['style', 'scaffold', 'alternatives'], at);

	const host = {
		style: raw.style === undefined ? undefined : decodeBlockStyle(raw.style, `${at}.style`),
		scaffold: decodeOptionalString(raw.scaffold, `${at}.scaffold`),
		alternatives: decodeOptionalStringArray(raw.alternatives, `${at}.alternatives`)
	};

	if (host.style !== undefined && host.alternatives.length > 0) {
		throw new DecodeError(`${at}: alternatives only apply to a JSON host, which has no style`);
	}

	return host;
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {FileSpec}
 */
function decodeFileSpec(value, at) {
	const raw = decodeKeys(
		decodeRecord(value, at),
		['source', 'target', 'kind', 'alternatives'],
		at
	);

	return {
		source: decodeString(raw.source, `${at}.source`),
		target: decodeString(raw.target, `${at}.target`),
		kind: decodeFileKind(raw.kind, `${at}.kind`),
		alternatives: decodeOptionalStringArray(raw.alternatives, `${at}.alternatives`)
	};
}

/**
 * @param {unknown} value
 * @param {string} at
 * @param {Record<string, HostSpec>} hosts
 * @returns {BlockSpec}
 */
function decodeBlockSpec(value, at, hosts) {
	const raw = decodeKeys(decodeRecord(value, at), ['source', 'target'], at);
	const target = decodeString(raw.target, `${at}.target`);
	const style = hosts[target]?.style;

	if (style === undefined) {
		throw new DecodeError(`${at}: hosts["${target}"] must set a block style`);
	}

	return {
		source: decodeString(raw.source, `${at}.source`),
		target,
		style,
		scaffold: hosts[target]?.scaffold ?? '{{block}}\n'
	};
}

/**
 * @param {unknown} value
 * @param {string} at
 * @param {Record<string, HostSpec>} hosts
 * @returns {JsonSpec}
 */
function decodeJsonSpec(value, at, hosts) {
	const raw = decodeKeys(decodeRecord(value, at), ['target', 'key', 'values'], at);
	const target = decodeString(raw.target, `${at}.target`);
	const host = hosts[target];

	if (host?.style !== undefined) {
		throw new DecodeError(
			`${at}: hosts["${target}"] has a block style, so it can't take JSON values`
		);
	}

	return {
		target,
		key: decodeString(raw.key, `${at}.key`),
		values: decodeOptionalStringArray(raw.values, `${at}.values`),
		scaffold: host?.scaffold ?? '{}\n',
		alternatives: host?.alternatives ?? []
	};
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {Prerequisite}
 */
function decodePrerequisite(value, at) {
	const raw = decodeKeys(decodeRecord(value, at), ['path', 'field', 'why'], at);

	const prerequisite = {
		path: decodeOptionalString(raw.path, `${at}.path`),
		field: decodeOptionalString(raw.field, `${at}.field`),
		why: decodeString(raw.why, `${at}.why`)
	};

	if ((prerequisite.path === undefined) === (prerequisite.field === undefined)) {
		throw new DecodeError(`${at}: set exactly one of path and field`);
	}

	return prerequisite;
}

/**
 * @template T
 * @param {unknown} value
 * @param {string} at
 * @param {(item: unknown, at: string) => T} decode
 * @returns {T[]}
 */
function decodeOptionalList(value, at, decode) {
	return decodeArray(value ?? [], at).map((item, index) => decode(item, `${at}[${index}]`));
}

/**
 * @param {unknown} value
 * @param {string} at
 * @param {Record<string, HostSpec>} hosts
 * @returns {ModuleSpec}
 */
function decodeModule(value, at, hosts) {
	const raw = decodeKeys(
		decodeRecord(value, at),
		[
			'description',
			'requires',
			'files',
			'skills',
			'blocks',
			'json',
			'devDependencies',
			'scripts',
			'prerequisites',
			'serves',
			'keepTogether'
		],
		at
	);

	const devDependencies = decodeOptionalStringRecord(
		raw.devDependencies,
		`${at}.devDependencies`
	);

	const scripts = decodeOptionalStringRecord(raw.scripts, `${at}.scripts`);

	const serves = Object.fromEntries(
		Object.entries(
			raw.serves === undefined ? {} : decodeRecord(raw.serves, `${at}.serves`)
		).map(([name, targets]) => {
			if (!(name in devDependencies) && !(name in scripts)) {
				throw new DecodeError(
					`${at}.serves.${name}: not one of the module's devDependencies or scripts`
				);
			}

			return [name, decodeStringArray(targets, `${at}.serves.${name}`)];
		})
	);

	return {
		description: decodeString(raw.description, `${at}.description`),
		requires: decodeOptionalStringArray(raw.requires, `${at}.requires`),
		files: decodeOptionalList(raw.files, `${at}.files`, decodeFileSpec),
		skills: decodeOptionalStringArray(raw.skills, `${at}.skills`),
		blocks: decodeOptionalList(raw.blocks, `${at}.blocks`, (item, itemAt) =>
			decodeBlockSpec(item, itemAt, hosts)
		),
		json: decodeOptionalList(raw.json, `${at}.json`, (item, itemAt) =>
			decodeJsonSpec(item, itemAt, hosts)
		),
		devDependencies,
		scripts,
		serves,
		prerequisites: decodeOptionalList(
			raw.prerequisites,
			`${at}.prerequisites`,
			decodePrerequisite
		),
		keepTogether: decodeOptionalStringArray(raw.keepTogether, `${at}.keepTogether`)
	};
}

/**
 * @param {string} text
 * @returns {Manifest}
 * @throws {DecodeError} When the text isn't a valid manifest.
 */
export function parseManifest(text) {
	const raw = decodeKeys(
		decodeRecord(decodeJson(text, MANIFEST_PATH), MANIFEST_PATH),
		['hosts', 'modules'],
		MANIFEST_PATH
	);

	const hosts = Object.fromEntries(
		Object.entries(decodeRecord(raw.hosts ?? {}, 'hosts')).map(([target, value]) => [
			target,
			decodeHostSpec(value, `hosts["${target}"]`)
		])
	);

	const modules = Object.entries(decodeRecord(raw.modules, `${MANIFEST_PATH}.modules`)).map(
		([name, value]) =>
			/** @type {const} */ ([name, decodeModule(value, `modules.${name}`, hosts)])
	);

	assertRequiredFirst(modules);

	return Object.fromEntries(modules);
}

/**
 * Install, update and the merges of `extends` arrays follow manifest order, so a module listed
 * after the ones it requires gets its oxlint config and blocks after theirs, however it's installed.
 * @param {ReadonlyArray<readonly [string, ModuleSpec]>} modules
 * @returns {void}
 * @throws {DecodeError} When a module requires one that's missing or listed after it.
 */
function assertRequiredFirst(modules) {
	const names = modules.map(([name]) => name);

	const requirements = modules.flatMap(([name, spec], index) =>
		spec.requires.map((required) => ({ name, index, required }))
	);

	for (const { name, index, required } of requirements) {
		const position = names.indexOf(required);

		if (position === -1) {
			throw new DecodeError(`modules.${name}.requires: there's no ${required} module`);
		}

		if (position > index) {
			throw new DecodeError(
				`modules.${name}.requires: list ${required} before ${name} in modules.json`
			);
		}
	}
}

/**
 * @typedef {object} Declines
 * @property {ReadonlySet<string>} tracked The targets the lock tracks.
 * @property {readonly string[]} skip This run's `--skip` patterns.
 * @property {readonly string[]} excluded The lock's `excluded` patterns.
 * @property {readonly string[]} add This run's `--add` patterns.
 */

/**
 * @param {Payload} payload
 * @param {string} folder A `keepTogether` folder.
 * @returns {{ paths: Set<string>, files: FileItem[] }} Where the maps put the folder's files,
 * one path unless they split it, and the files.
 */
function placeFolder(payload, folder) {
	const files = payload.files.filter(
		({ defaultTarget }) => defaultTarget === folder || defaultTarget.startsWith(`${folder}/`)
	);

	const paths = new Set(
		files.map(({ target, defaultTarget }) => {
			const rest = defaultTarget.slice(folder.length);

			return target.endsWith(rest) ? target.slice(0, target.length - rest.length) : target;
		})
	);

	return { paths, files };
}

/**
 * @typedef {object} Declined
 * @property {string} add The `--add` argument that installs the path: its whole `keepTogether`
 * folder when the repo left out all of it.
 * @property {boolean} removal The path sits in a `keepTogether` folder whose other files the repo
 * kept: a local removal, which doesn't split the folder.
 */

/**
 * Decides which payload paths the repo leaves out: a path this run skips, or one the lock excludes
 * and `--add` doesn't bring back.
 *
 * @param {Payload} payload
 * @param {Declines} declines
 * @returns {(target: string) => Declined | null} `null` for a path the run installs or keeps.
 */
export function declinedFiles(payload, { tracked, skip, excluded, add }) {
	const folders = payload.together.map((folder) => {
		const { paths, files } = placeFolder(payload, folder);

		return { path: paths.size > 1 ? folder : ([...paths][0] ?? folder), files };
	});

	return (target) => {
		if (tracked.has(target)) return null;

		const folder = folders.find(
			({ path: place }) => target === place || target.startsWith(`${place}/`)
		);

		const installed = folder?.files.some((file) => tracked.has(file.target)) ?? false;

		const skipped = keyMatchesAny(target, skip);
		const removed = keyMatchesAny(target, excluded);

		if (!skipped && (!removed || keyMatchesAny(target, add))) return null;

		return { add: folder && !installed ? folder.path : target, removal: installed && removed };
	};
}

/**
 * @param {Payload} payload
 * @param {(target: string) => Declined | null} declined From {@link declinedFiles}.
 * @returns {string[]} One message per `keepTogether` folder whose files the maps move apart, or
 * that the run would install only part of.
 */
export function splitFolders(payload, declined) {
	return payload.together.flatMap((folder) => {
		const { paths, files } = placeFolder(payload, folder);

		const left = files.filter(({ target }) => {
			const out = declined(target);

			return out !== null && !out.removal;
		}).length;

		const why = 'whose files load each other by relative paths';

		if (paths.size > 1) {
			return [
				`the maps split ${folder}, ${why}; map it, or a folder that holds it, as a whole`
			];
		}

		if (left > 0 && left < files.length) {
			return [`the run would install only part of ${folder}, ${why}; skip or add all of it`];
		}

		return [];
	});
}

/**
 * @param {Source} source
 * @param {string} commit
 * @returns {Manifest | null} `null` when the commit has no manifest.
 */
export function readManifest(source, commit) {
	const text = readAt(source, commit, MANIFEST_PATH);

	return text === null ? null : parseManifest(text);
}

/**
 * Adds every module the requested ones require, in manifest order.
 * @param {Manifest} manifest
 * @param {readonly string[]} requested
 * @returns {{ modules: string[], unknown: string[] }}
 */
export function expandModules(manifest, requested) {
	const wanted = new Set();
	const unknown = [];
	const queue = [...requested];

	while (queue.length > 0) {
		const name = queue.shift() ?? '';
		const spec = manifest[name];

		if (wanted.has(name)) continue;

		if (!spec) {
			unknown.push(name);
			continue;
		}

		wanted.add(name);
		queue.push(...spec.requires);
	}

	return { modules: Object.keys(manifest).filter((name) => wanted.has(name)), unknown };
}

/**
 * @param {Source} source
 * @param {string} commit
 * @param {string} name
 * @param {FileSpec} spec
 * @param {Record<string, string>} maps
 * @returns {FileItem[]}
 */
function expandFile(source, commit, name, spec, maps) {
	const sources = listFiles(source, commit, spec.source);

	if (sources.length === 0) {
		throw new DecodeError(`modules.${name}: ${spec.source} doesn't exist at ${commit}`);
	}

	const unit = mapPath(maps, spec.target);

	return sources.map((file) => {
		const defaultTarget = `${spec.target}${file.slice(spec.source.length)}`;

		return {
			module: name,
			source: file,
			target: mapPath(maps, defaultTarget),
			defaultTarget,
			unit,
			kind: spec.kind,
			alternatives: spec.alternatives.map((alternative) => mapPath(maps, alternative))
		};
	});
}

/**
 * Lists what `modules` install at `commit`, laid out for the consumer.
 * @param {Source} source
 * @param {string} commit
 * @param {Manifest} manifest
 * @param {readonly string[]} modules Already expanded with {@link expandModules}.
 * @param {Record<string, string>} maps
 * @returns {Payload}
 */
export function buildPayload(source, commit, manifest, modules, maps) {
	/** @type {Payload} */
	const payload = {
		commit,
		modules: [...modules],
		files: [],
		links: [],
		blocks: [],
		json: [],
		together: [],
		requirements: { devDependencies: {}, scripts: {}, prerequisites: [], serves: {} }
	};

	for (const name of modules) {
		const spec = manifest[name];

		if (!spec) continue;

		payload.together.push(...spec.keepTogether);

		for (const file of spec.files)
			payload.files.push(...expandFile(source, commit, name, file, maps));

		for (const skill of spec.skills) {
			const skillName = path.posix.basename(skill);
			const target = `${SKILLS_DIR}/${skillName}`;

			const files = expandFile(
				source,
				commit,
				name,
				{ source: skill, target, kind: undefined, alternatives: [] },
				maps
			);

			const linkTarget = mapPath(maps, `${SKILL_LINKS_DIR}/${skillName}`);
			const unit = mapPath(maps, target);

			payload.files.push(...files);
			payload.links.push({
				module: name,
				target: linkTarget,
				to: path.posix.relative(path.posix.dirname(linkTarget), unit),
				unit
			});
		}

		for (const block of spec.blocks) {
			payload.blocks.push({ module: name, ...block, target: mapPath(maps, block.target) });
		}

		for (const json of spec.json) {
			const target = mapPath(maps, json.target);

			payload.json.push({
				module: name,
				target,
				key: json.key,
				values: json.values.map((value) => render(value, maps, target)),
				needs: Object.fromEntries(
					json.values.map((value) => [
						render(value, maps, target),
						templatePaths(value).map((ref) => mapPath(maps, ref))
					])
				),
				scaffold: json.scaffold,
				alternatives: json.alternatives.map((alternative) => mapPath(maps, alternative))
			});
		}
	}

	assertDistinctTargets(payload);
	payload.requirements = collectRequirements(manifest, modules);

	return payload;
}

/**
 * @param {Payload} payload
 * @returns {void}
 * @throws {DecodeError} When an item would write outside the repo, two items would write the same
 * file, link, block or JSON value, or a block or JSON value would go in a file another item writes
 * whole.
 */
function assertDistinctTargets(payload) {
	/** @type {Map<string, string>} The item that writes each key. */
	const owners = new Map();

	/**
	 * @param {string} key
	 * @param {string} owner
	 * @param {string} [host] For a block or JSON value: the file it goes in.
	 */
	const claim = (key, owner, host) => {
		const file = host ?? key;

		if (!isRepoPath(file)) throw new DecodeError(`modules: ${owner} writes outside the repo`);

		const other = owners.get(key) ?? (host === undefined ? undefined : owners.get(file));

		if (other !== undefined)
			throw new DecodeError(`modules: ${owner} and ${other} both write ${key}`);

		owners.set(key, owner);
	};

	for (const item of payload.files) claim(item.target, `${item.module} (${item.source})`);

	for (const item of payload.links)
		claim(item.target, `${item.module} (the link to ${item.unit})`);

	for (const item of payload.blocks)
		claim(blockKey(item), `${item.module} (${item.source})`, item.target);

	for (const item of payload.json)
		claim(jsonKey(item), `${item.module} (${item.key} in ${item.target})`, item.target);
}

/**
 * @param {Manifest} manifest
 * @param {readonly string[]} modules
 * @returns {Requirements} What the modules need, later modules overriding earlier ones.
 */
export function collectRequirements(manifest, modules) {
	/** @type {Requirements} */
	const requirements = { devDependencies: {}, scripts: {}, prerequisites: [], serves: {} };

	for (const name of modules) {
		const spec = manifest[name];

		if (!spec) continue;

		Object.assign(requirements.devDependencies, spec.devDependencies);
		Object.assign(requirements.scripts, spec.scripts);
		requirements.prerequisites.push(...spec.prerequisites);

		// A later module that needs the same name without `serves` needs it unconditionally.
		for (const required of [
			...Object.keys(spec.devDependencies),
			...Object.keys(spec.scripts)
		]) {
			delete requirements.serves[required];
		}

		Object.assign(requirements.serves, spec.serves);
	}

	return requirements;
}

/**
 * @param {Source} source
 * @param {string} commit
 * @param {string} payloadPath
 * @param {Record<string, string>} maps
 * @param {string} target Where the rendered text is written; `{{rel:...}}` resolves from its folder.
 * @returns {string | null} `null` when the file or the commit doesn't exist.
 * @throws {GitError} When git can't read a file that exists.
 */
export function readRendered(source, commit, payloadPath, maps, target) {
	const text = readAt(source, commit, payloadPath);

	return text === null ? null : render(text, maps, target);
}

/**
 * Reads a file or block the manifest at `commit` lists, rendered for its target.
 * @param {Source} source
 * @param {string} commit
 * @param {FileItem | BlockItem} item
 * @param {Record<string, string>} maps
 * @returns {string}
 * @throws {DecodeError} When the payload file doesn't exist at `commit`.
 * @throws {GitError} When git can't read it.
 */
export function readPayload(source, commit, item, maps) {
	const text = readRendered(source, commit, item.source, maps, item.target);

	if (text === null) {
		throw new DecodeError(`modules.${item.module}: ${item.source} doesn't exist at ${commit}`);
	}

	return text;
}
