# SvelteKit conventions

## Never import types from `$types`

SvelteKit infers the types of `data`, `form`, `params` and `load` arguments in route files, so don't import `PageData`, `PageServerLoad` or any other type from `./$types`, and don't annotate a `load` with `satisfies`.

```ts
// ❌ Bad
import type { PageServerLoad } from './$types';

export const load = (({ locals }) => ({ owner: locals.owner })) satisfies PageServerLoad;

// ✅ Good
export const load = ({ locals }) => ({ owner: locals.owner });
```

```svelte
<script lang="ts">
	// ❌ Bad
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// ✅ Good
	let { data } = $props();
</script>
```

The `svelte` module's [oxlint config]({{rel:tools/oxlint/svelte.json}}) rejects `$types` imports.
