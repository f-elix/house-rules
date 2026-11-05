# Styling Conventions

## Tailwind CSS (Primary Approach)

We use Tailwind CSS as our primary styling approach. Avoid inline styles and custom CSS when possible.

## Basic Usage

```svelte
<!-- ✅ Good: Use Tailwind utility classes -->
<div class="flex flex-col gap-4 rounded-lg bg-white p-6 shadow-md">
	<h2 class="text-4 font-semibold text-gray-900">Title</h2>
	<p class="text-gray-600">Description</p>
	<button class="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700">
		Click me
	</button>
</div>

<!-- ❌ Bad: Inline styles for regular css -->
<div style="display: flex; flex-direction: column; gap: 16px;">
	<h2 style="font-size: 20px; font-weight: 600;">Title</h2>
</div>

<!-- ❌ Bad: Custom CSS classes -->
<div class="custom-card">
	<h2 class="custom-title">Title</h2>
</div>

<style>
	.custom-card {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 24px;
	}
</style>
```

## Inline styles

While you should avoid inline styles for regular css, you can use them to set css variables. Use Tailwind classes to use those variables.

```svelte
<div style="--scale: {width};">
	<div class="scale-x-[--scale]">Title</div>
</div>
```

## Class organization and conditions

Use Svelte's built-in class attribute values to organize your classes in a readable manner and apply conditions.

```svelte
<!-- ✅ Good: Organized class order -->
<div
	class={[
		'flex flex-col gap-4 items-center justify-between'
		'max-w-800 w-full'
		'rounded-lg border border-gray-200 p-6'
		'bg-white shadow-md'
		'transition-colors duration-200'
		'hover:bg-gray-200',
		// Short-circuit evaluation
		active && 'bg-gray-200',
		// Ternary if alternative classes should be added
		active ? 'bg-gray-200' : 'bg-gray-500'
		// Object format
		{
			'bg-gray-200': active
		}
	]}
>
	<!-- Content -->
</div>
```

## Tailwind Variants (tailwind-variants) and the `cn()` helper

For complex component variants, use `tv` from [`tailwind-variants`](https://www.tailwind-variants.org/):

```typescript
// Button.svelte
<script lang="ts">
	import { tv } from 'tailwind-variants';

	const button = tv({
		base: 'rounded-md font-semibold transition-colors focus:outline-none focus:ring-2',
		variants: {
			variant: {
				primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
				secondary: 'bg-gray-200 text-gray-900 hover:bg-gray-300 focus:ring-gray-500',
				danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
			},
			size: {
				sm: 'px-3 py-1.5 text-sm',
				md: 'px-4 py-2 text-base',
				lg: 'px-6 py-3 text-lg'
			},
			disabled: {
				true: 'cursor-not-allowed opacity-50',
				false: ''
			}
		},
		defaultVariants: {
			variant: 'primary',
			size: 'md',
			disabled: false
		}
	});

	let { variant, size, disabled = false } = $props<{
		variant?: 'primary' | 'secondary' | 'danger';
		size?: 'sm' | 'md' | 'lg';
		disabled?: boolean;
	}>();
</script>

<button class={button({ variant, size, disabled })} {disabled}>
	<slot />
</button>
```

To merge classes together, use the `cn()` helper, which uses [`tailwind-merge`](https://github.com/dcastil/tailwind-merge):

```ts
import { twMerge } from 'tailwind-merge';

twMerge('px-2 py-1 bg-red hover:bg-dark-red', 'p-3 bg-[#B91C1C]');
// → 'hover:bg-dark-red p-3 bg-[#B91C1C]'
```

## Custom CSS (When Necessary)

Sometimes Tailwind isn't enough. You can use Svelte's scoped styles in that case. Avoid global styles if possible:

```svelte
<div class="custom-scrollbar">
	<!-- Content -->
</div>

<style>
	.custom-scrollbar {
		/* ✅ Good: Use CSS for things Tailwind can't handle */
	}

	.custom-scrollbar::-webkit-scrollbar {
		width: 8px;
	}

	.custom-scrollbar::-webkit-scrollbar-track {
		background: #f1f1f1;
	}

	.custom-scrollbar::-webkit-scrollbar-thumb {
		background: #888;
		border-radius: 4px;
	}

	.custom-scrollbar::-webkit-scrollbar-thumb:hover {
		background: #555;
	}

	/* ❌️ Bad: Avoid global styles */
	:global(.my-text) {
		font-size: 20px;
	}
</style>
```

## Global Styles

Global styles should almost always be avoided. The only exception would be css resets and `html`/`body` styles.

```css
/* app.pcss */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
	/* ✅ Good: Global base styles */
	html {
		font-family: 'Inter', sans-serif;
	}

	body {
		@apply bg-gray-50 text-gray-900;
	}
}

@layer components {
	/* ❌️ Bad: These styles should be applied in Svelte components */
	.btn {
		@apply rounded-md px-4 py-2 font-semibold transition-colors;
	}

	.card {
		@apply rounded-lg bg-white p-6 shadow-md;
	}
}
```

## Icons

Render icons through the repo's one icon component, and size and color them with Tailwind classes (`size-5`, `text-muted-foreground`). Don't paste SVG markup into a component or import an icon library directly.

## Colors

Use Tailwind's color system:

```svelte
<!-- ✅ Good: Semantic color usage -->
<div class="bg-blue-600 text-white">Primary action</div>
<div class="bg-gray-100 text-gray-900">Secondary background</div>
<div class="bg-red-600 text-white">Error state</div>
<div class="bg-green-600 text-white">Success state</div>
<div class="bg-yellow-500 text-white">Warning state</div>

<!-- ❌ Bad: Arbitrary color values -->
<div class="bg-[#3B82F6]">Don't do this</div>
```

## Spacing

Use multiple of fours for all regular spacings and sizes. Some exceptions may be warranted for special cases.

```svelte
<!-- Padding -->
<div class="p-4">4px</div>
<div class="p-8">8px</div>
<div class="p-16">16px</div>
<div class="p-24">24px</div>
<div class="p-32">32px</div>

<!-- Margins -->
<div class="size-16">16px size</div>

<!-- Gap (for flex/grid) -->
<div class="flex gap-16">16px gap</div>
```

## Anti-patterns to avoid

### Tailwind arbitrary values

Tailwind provides an escape hatch from the established config, but these should only ever be used for exceptions. If a design calls for a value that is not in the configuration, communicate with the designers to clarify things. It may be a new value to add to the system, or a mistake on their part. Either way, don't blindly apply custom styles everywhere, follow the design system.

```svelte
<!-- ❌ Bad: Arbitrary values everywhere -->
<div class="mt-[13px] w-[347px] text-[17.5px]">Use standard spacing and sizing</div>
```

### `!important` classes

`!important` classes should be avoided at all cost. If you find yourself needing it to make your styles work, take a step back and re-evaluate what you're doing, you probably messed up somewhere. Use the design system. Exceptions can happen, but they should be very rare.

<!-- ❌ Bad: !important calsses -->
<div class="text-14! bg-gray-400!"></div>
```

### Layout affecting styles

Component styles that affect the surrounding layout (like margin) must be avoided.

Components should be responsible for their internal layout only. Layout decisions about spacing between components or positioning within a parent should be made by the parent component.

#### Why Layout Affecting Styles Are Problematic

1. **Breaks Reusability**: A component with built-in margins can't be reused in contexts where different spacing is needed
2. **Creates Inconsistency**: Different components with different margin values make the overall layout unpredictable
3. **Makes Composition Difficult**: Parent components can't control spacing between their children
4. **Violates Single Responsibility**: A component shouldn't decide how it relates to its surroundings
5. **Causes Overriding**: Developers end up fighting the default margins with negative margins or `!important`

#### Common Offenders

Styles that affect external layout include:

- `margin` (in any direction)
- `position: absolute` or `position: fixed` (unless the component is explicitly meant to be positioned)
- `transform: translate()` (when used to offset from the normal flow)
- `float`

```svelte
<!-- ❌ Bad: Button has built-in margin -->
<script>
	// Button.svelte
	let { children } = $props();
</script>

<button class="rounded-8 bg-blue-500 px-16 py-8 text-white mr-8">
	{@render children?.()}
</button>

<!-- Now every use of Button has unwanted spacing -->
<div class="flex">
	<Button>Save</Button>  <!-- Has 8px margin-right we don't want here -->
	<Button>Cancel</Button>
</div>

<!-- ✅ Good: Button handles internal spacing only -->
<script>
	// Button.svelte
	let { children } = $props();
</script>

<button class="rounded-8 bg-blue-500 px-16 py-8 text-white">
	{@render children?.()}
</button>

<!-- Parent controls the spacing -->
<div class="flex gap-8">
	<Button>Save</Button>
	<Button>Cancel</Button>
</div>
```

#### Best Practice: Use Gap Instead

Modern CSS layout tools like Flexbox and Grid provide `gap` properties that elegantly solve spacing without margin:

```svelte
<!-- ✅ Good: Using gap for spacing -->
<div class="flex gap-8">
	<Button>Action 1</Button>
	<Button>Action 2</Button>
	<Button>Action 3</Button>
</div>

<div class="grid grid-cols-3 gap-16">
	<Card>Item 1</Card>
	<Card>Item 2</Card>
	<Card>Item 3</Card>
</div>
```

This approach keeps components reusable while giving parents full control over spacing.

### Global styles

Global styles that affect the whole application should be used very sparingly, it at all. They are almost never needed and usually require overinding everywhere.

The only exceptions should be style for `:root`, `html` and `body`.

```css
/* ❌️ Bad: add a global paragraph style for the whole app */
p {
	margin-bottom: 2rem;
}
```

```html
<!-- Needs to be overriden constantly -->
<p class="mb-0">Test</p>
```
