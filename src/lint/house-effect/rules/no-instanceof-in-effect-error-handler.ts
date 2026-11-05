import { defineRule, type ESTree, type Options } from '@oxlint/plugins';

/**
 * Tagged errors are translated by tag, not by class (`docs/conventions/error-handling.details.md`).
 * The `allow` option lists error classes that share a tag, which only `instanceof` tells apart.
 */
export const noInstanceofInEffectErrorHandlerRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow telling tagged errors apart with instanceof inside Effect error handlers.'
		},
		messages: {
			instanceof:
				'Translate `{{name}}` by its tag with Effect.catchTag or Effect.catchTags instead of instanceof.'
		},
		schema: [
			{
				type: 'object',
				properties: { allow: { type: 'array', items: { type: 'string' } } },
				additionalProperties: false
			}
		]
	},
	createOnce(context) {
		let allowed = new Set(BUILT_IN);

		return {
			before() {
				allowed = allowedNames(context.options);
			},
			BinaryExpression(node) {
				if (node.operator !== 'instanceof' || node.right.type !== 'Identifier') return;

				const name = node.right.name;

				if (!name.endsWith('Error') || allowed.has(name)) return;

				if (isInsideEffectErrorHandler(node)) {
					context.report({ node, messageId: 'instanceof', data: { name } });
				}
			}
		};
	}
});

/** Effect combinators whose callbacks receive a typed failure. */
const ERROR_HANDLER = /^(catch\w*|mapError|tapError\w*|orElse\w*|mapBoth)$/;

/** Built-in errors have no tag, so `instanceof` is the only way to tell them apart. */
const BUILT_IN = [
	'Error',
	'AggregateError',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError'
];

/** The built-in errors plus the rule's `allow` option, which `meta.schema` checks is a string array. */
const allowedNames = (options: Readonly<Options>) => {
	const allow: unknown = Object(options[0]).allow;

	return new Set([...BUILT_IN, ...(Array.isArray(allow) ? allow.map(String) : [])]);
};

const isEffectErrorHandlerCall = (node: ESTree.Node | null | undefined) =>
	node?.type === 'CallExpression' &&
	node.callee.type === 'MemberExpression' &&
	!node.callee.computed &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Effect' &&
	node.callee.property.type === 'Identifier' &&
	ERROR_HANDLER.test(node.callee.property.name);

/** Whether the closest enclosing function is a callback passed to an Effect error handler. */
const isInsideEffectErrorHandler = (node: ESTree.Node) => {
	let current = node.parent;

	while (current) {
		if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
			const call = current.parent;

			return (
				isEffectErrorHandlerCall(call) &&
				call.type === 'CallExpression' &&
				call.arguments.includes(current)
			);
		}

		current = current.parent;
	}

	return false;
};
