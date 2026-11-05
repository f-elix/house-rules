// @ts-check
import {
	createLink,
	isOccupied,
	linkResolves,
	pathTaken,
	readText,
	removeFile,
	removeLink,
	writeText
} from './workspace.mjs';

/**
 * Collects a command's writes in memory, so several changes to one file compose and `--dry-run` can
 * stop before anything touches the disk.
 */
export class Staging {
	/** @type {Map<string, string | null>} */
	#texts = new Map();
	/** @type {{ target: string, to: string }[]} */
	#links = [];
	/** @type {string[]} */
	#unlinks = [];
	#repo;

	/**
	 * @param {string} repo
	 */
	constructor(repo) {
		this.#repo = repo;
	}

	/**
	 * @param {string} target
	 * @returns {string | null} The staged text, else the file on disk, else `null`.
	 */
	read(target) {
		const staged = this.#texts.get(target);

		return staged === undefined ? readText(this.#repo, target) : staged;
	}

	/**
	 * @param {string} target
	 * @returns {boolean} Whether a file or folder will be at `target`, or something else is there now.
	 */
	exists(target) {
		const staged = this.#texts.get(target);

		if (staged !== undefined) return staged !== null;

		const under = [...this.#texts].some(
			([file, text]) => text !== null && file.startsWith(`${target}/`)
		);

		return under || pathTaken(this.#repo, target);
	}

	/**
	 * @param {string} target
	 * @returns {boolean} Whether something other than a file is in the way, and nothing staged
	 * replaces it.
	 */
	occupied(target) {
		return !this.#texts.has(target) && isOccupied(this.#repo, target);
	}

	/**
	 * @param {string} target
	 * @param {string} text
	 * @returns {void}
	 */
	write(target, text) {
		this.#texts.set(target, text);
	}

	/**
	 * @param {string} target
	 * @returns {void}
	 */
	remove(target) {
		this.#texts.set(target, null);
	}

	/**
	 * @param {{ target: string, to: string }} link
	 * @returns {void}
	 */
	link(link) {
		this.#links.push(link);
	}

	/**
	 * @param {string} target A symlink to remove.
	 * @returns {void}
	 */
	unlink(target) {
		this.#unlinks.push(target);
	}

	/**
	 * Removes links, writes files, then creates the links that don't already resolve through a
	 * linked parent.
	 * @returns {void}
	 */
	flush() {
		for (const target of this.#unlinks) removeLink(this.#repo, target);

		for (const [target, text] of this.#texts) {
			if (text === null) removeFile(this.#repo, target);
			else writeText(this.#repo, target, text);
		}

		for (const link of this.#links) {
			if (!linkResolves(this.#repo, link)) createLink(this.#repo, link);
		}
	}
}
