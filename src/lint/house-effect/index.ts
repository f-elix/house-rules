import { eslintCompatPlugin } from '@oxlint/plugins';
import { noInstanceofInEffectErrorHandlerRule } from './rules/no-instanceof-in-effect-error-handler.ts';

/** Lint rules for Effect v4 code. */
const houseEffectPlugin = eslintCompatPlugin({
	meta: { name: 'house-effect' },
	rules: {
		'no-instanceof-in-effect-error-handler': noInstanceofInEffectErrorHandlerRule
	}
});

export default houseEffectPlugin;
