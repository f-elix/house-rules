import { defineRule } from '@oxlint/plugins';
import { readFileSync } from 'node:fs';
import { parse, type AST } from 'svelte/compiler';

/**
 * An empty snippet, such as `{#snippet pending()}{/snippet}`, renders nothing, and the reader has to
 * guess why. There's usually a primitive that says it: a remote query's `.current` and `.error`
 * instead of an empty `pending` and `failed`, or no snippet at all when the default is what you
 * want.
 *
 * oxlint gives JS plugins only the `<script>` of a `.svelte` file, so this rule reads the file
 * itself and reports from the instance script, or from the module script when there's no
 * instance script. A component with no `<script>` isn't linted.
 */
export const noEmptySnippetsRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: { description: 'Disallow snippets that hold only whitespace or comments.' },
		messages: {
			empty: "`{#snippet {{name}}()}` on line {{line}} is empty, which hides why nothing renders. To hide a remote query's value while it loads or fails, read its `.current` and `.error` instead of awaiting it in a `<svelte:boundary>`. To keep the default behaviour, leave the snippet out."
		}
	},
	createOnce(context) {
		return {
			Program() {
				if (!context.filename.endsWith('.svelte')) {
					return;
				}

				const source = readFileSync(context.filename, 'utf8');
				const root = parseComponent(source);
				const script = root?.instance ?? root?.module;

				// Each `<script>` is linted on its own; report only from one of them.
				if (
					!root ||
					!script ||
					!source.slice(script.start, script.end).includes(context.sourceCode.text.trim())
				) {
					return;
				}

				for (const snippet of emptySnippets(root.fragment)) {
					context.report({
						loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
						messageId: 'empty',
						data: {
							name: snippetName(snippet),
							line: String(lineOf(source, snippet.start))
						}
					});
				}
			}
		};
	}
});

/** `undefined` when the file doesn't parse; `svelte-check` reports that. */
const parseComponent = (source: string): AST.Root | undefined => {
	try {
		return parse(source, { modern: true });
	} catch {
		return undefined;
	}
};

const emptySnippets = (fragment: AST.Fragment): AST.SnippetBlock[] =>
	allSnippets(fragment).filter((snippet) =>
		snippet.body.nodes.every(
			(node) => node.type === 'Comment' || (node.type === 'Text' && node.data.trim() === '')
		)
	);

/** Every snippet in the fragment, nested ones included. */
const allSnippets = (fragment: AST.Fragment | null | undefined): AST.SnippetBlock[] =>
	(fragment?.nodes ?? []).flatMap((node) => {
		const nested = childFragments(node).flatMap(allSnippets);

		return node.type === 'SnippetBlock' ? [node, ...nested] : nested;
	});

const childFragments = (
	node: AST.Fragment['nodes'][number]
): Array<AST.Fragment | null | undefined> => {
	switch (node.type) {
		case 'IfBlock':
			return [node.consequent, node.alternate];
		case 'EachBlock':
			return [node.body, node.fallback];
		case 'AwaitBlock':
			return [node.pending, node.then, node.catch];
		case 'KeyBlock':
			return [node.fragment];
		case 'SnippetBlock':
			return [node.body];
		default:
			return 'fragment' in node ? [node.fragment] : [];
	}
};

const snippetName = (snippet: AST.SnippetBlock): string =>
	snippet.expression.type === 'Identifier' ? snippet.expression.name : 'snippet';

const lineOf = (source: string, offset: number): number =>
	source.slice(0, offset).split('\n').length;
