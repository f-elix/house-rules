import { eslintCompatPlugin } from '@oxlint/plugins';
import { noInstanceofInEffectErrorHandlerRule } from './rules/no-instanceof-in-effect-error-handler.ts';

/** Rules for the Effect conventions in `docs/conventions/effect.md` and `error-handling.md`. */
const houseEffectPlugin = eslintCompatPlugin({
	meta: { name: 'house-effect' },
	rules: {
		'no-instanceof-in-effect-error-handler': noInstanceofInEffectErrorHandlerRule
	}
});

export default houseEffectPlugin;
