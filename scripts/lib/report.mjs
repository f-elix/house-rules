// @ts-check

/** @typedef {import('./lint-changes.mjs').LintChange} LintChange */
/** @typedef {import('./requirements.mjs').Requirement} Requirement */
/** @typedef {import('./requirements.mjs').RequirementChange} RequirementChange */

/**
 * One line of a command's result. `target` is a repo-relative path, followed by `#module` for a
 * managed block or `#key#module` for the values a module adds to a JSON file.
 * @typedef {object} ReportEntry
 * @property {string} status
 * @property {string} target
 * @property {string} [detail]
 * @property {string} [unit] For new items: the `--add` / `--skip` argument that covers the item.
 */

/**
 * The machine-readable result `--json` prints.
 * @typedef {object} Report
 * @property {string} command
 * @property {string} status On a dry run, the status the real run would have.
 * @property {boolean} dryRun Whether the command ran with `--dry-run` and wrote nothing.
 * @property {{ url: string, ref: string, commit: string, from?: string }} [source]
 * @property {string[]} [modules]
 * @property {ReportEntry[]} entries
 * @property {LintChange[]} lintChanges
 * @property {RequirementChange[]} requirementChanges
 * @property {Requirement[]} requirements Requirements the repo doesn't meet yet.
 * @property {string[]} next What the user or agent does next.
 */

/**
 * An empty report for `command`, before anything ran.
 * @param {string} command
 * @returns {Report}
 */
export function createReport(command) {
	return {
		command,
		status: 'ok',
		dryRun: false,
		entries: [],
		lintChanges: [],
		requirementChanges: [],
		requirements: [],
		next: []
	};
}

/**
 * Marks the report refused and adds `message` to its next steps.
 * @param {Report} report Mutated.
 * @param {string} message
 * @returns {Report} `report`.
 */
export function refuse(report, message) {
	report.status = 'refused';
	report.next.push(message);

	return report;
}

/** Statuses `--json` reports but the text output leaves out, to keep it short. */
const QUIET = new Set(['unchanged', 'ok']);

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
function show(value) {
	return value ?? '(none)';
}

/**
 * The report as text for a terminal. Unchanged and ok entries are left out; `--json` keeps them.
 * @param {Report} report
 * @returns {string}
 */
export function formatReport(report) {
	const lines = [];
	const source = report.source;

	const range =
		source?.from && source.from !== source.commit ? `${source.from.slice(0, 7)} -> ` : '';

	const command = report.dryRun ? `${report.command} (dry run)` : report.command;

	lines.push(
		source
			? `house-rules ${command}: ${report.status} at ${range}${source.commit.slice(0, 7)} (${source.ref}, ${source.url})`
			: `house-rules ${command}: ${report.status}`
	);

	if (report.modules) lines.push(`  modules: ${report.modules.join(', ')}`);

	for (const entry of report.entries) {
		if (QUIET.has(entry.status)) continue;

		const detail = entry.detail ? `  ${entry.detail}` : '';

		lines.push(`  ${entry.status.padEnd(12)} ${entry.target}${detail}`);
	}

	for (const change of report.lintChanges) {
		lines.push(
			`  lint         ${change.target}: ${change.type} ${change.name}: ${show(change.from)} -> ${show(change.to)}`
		);
	}

	for (const change of report.requirementChanges) {
		lines.push(
			`  requirement  ${change.type} ${change.name}: ${show(change.from)} -> ${show(change.to)}`
		);
	}

	for (const requirement of report.requirements) {
		const found = requirement.found === null ? '' : ` (found ${requirement.found})`;

		lines.push(
			`  needs        ${requirement.type} ${requirement.name}: ${requirement.wanted}${found}`
		);
	}

	for (const step of report.next) lines.push(`next: ${step}`);

	return `${lines.join('\n')}\n`;
}
