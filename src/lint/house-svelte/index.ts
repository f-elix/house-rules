import { eslintCompatPlugin } from '@oxlint/plugins';
import { noEmptySnippetsRule } from './rules/no-empty-snippets.ts';
import { noUnderscoreExportsRule } from './rules/no-underscore-exports.ts';

/** Rules for the Svelte and SvelteKit conventions in `docs/conventions/svelte-components.md`. */
const houseSveltePlugin = eslintCompatPlugin({
	meta: { name: 'house-svelte' },
	rules: {
		'no-empty-snippets': noEmptySnippetsRule,
		'no-underscore-exports': noUnderscoreExportsRule
	}
});

export default houseSveltePlugin;
