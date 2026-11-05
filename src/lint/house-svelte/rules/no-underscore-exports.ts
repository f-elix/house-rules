import { defineRule, type ESTree } from '@oxlint/plugins';

/**
 * SvelteKit accepts `_`-prefixed exports from route files, which makes them an easy back door for
 * tests. Test the route's real export instead. `svelte.json` enables it for `src/routes/` only.
 */
export const noUnderscoreExportsRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: { description: 'Disallow `_`-prefixed exports.' },
		messages: {
			underscore:
				"Don't export `{{name}}` for tests. Test the route's own exports (GET, POST, load, actions) with a request event built for the test."
		}
	},
	createOnce(context) {
		return {
			ExportNamedDeclaration(node) {
				for (const id of exportedNames(node)) {
					if (id.type === 'Identifier' && id.name.startsWith('_')) {
						context.report({
							node: id,
							messageId: 'underscore',
							data: { name: id.name }
						});
					}
				}
			}
		};
	}
});

const exportedNames = (node: ESTree.ExportNamedDeclaration): ESTree.Node[] => {
	const declaration = node.declaration;

	if (declaration?.type === 'VariableDeclaration') {
		return declaration.declarations.map((declarator) => declarator.id);
	}

	if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
		return declaration.id ? [declaration.id] : [];
	}

	return node.specifiers.map((specifier) => specifier.exported);
};
