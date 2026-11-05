# Svelte Component Conventions

## Standardized Structure for Basic Svelte Components

Here's the standardized structure for a basic Svelte component:

```svelte
<script lang="ts">
	// 1. Imports first (already sorted)
	import { onMount } from 'svelte';
	import Button from '$lib/components/Button.svelte';
	import type { ComponentType } from '$lib/types.js';

	// 2. Type definitions
	interface Props {
		title: string;
		subtitle?: string;
		isVisible?: boolean;
		onSubmit?: (data: FormData) => void;
		onClose?: () => void;
		onError?: (error: string) => void;
	}

	// 3. Props destructuring with defaults
	let { title, subtitle = '', isVisible = false, onSubmit, onClose, onError }: Props = $props();

	// 4. Local state, derived values, side effects, functions
	// The order here doesn't really matter but they should come after the first 3 points
	let stateValue = $state(/*...*/);

	let derivedValue = $derived(/*...*/);

	$effect(() => {
		// ...
	});

	const handleSubmit = async () => {
		// ...
	};
	const handleClose = () => {
		// ...
	};
</script>

<!-- Template -->
<div>
	<h2>{title}</h2>

	{#if hasError}
		<div class="error-message" role="alert">
			{errorMessage}
		</div>
	{/if}
</div>
```

## Event Handling (Modern Svelte 5)

```svelte
<script lang="ts">
	// ✅ Good: Use function props instead of createEventDispatcher
	interface Props {
		onSubmit?: (data: FormData) => void;
		onClose?: () => void;
		onError?: (error: string) => void;
	}

	let { onSubmit, onClose, onError }: Props = $props();

	// ✅ Good: Clear event handler functions
	const handleSubmit = (event: Event) => {
		event.preventDefault();
		onSubmit?.(new FormData(event.target as HTMLFormElement));
	};
</script>
```

```svelte
<script lang="ts">
	// ❌ Bad: Using deprecated createEventDispatcher
	import { createEventDispatcher } from 'svelte';

	const dispatch = createEventDispatcher();

	// ❌ Bad: Inline event handlers without proper typing
	const handleSubmit = (event) => {
		// No type safety, no error handling
		dispatch('submit', event.target.value);
	};
</script>
```

## Component File Naming

```
✅ Good: PascalCase for component files
   - Modal.svelte
   - UserProfile.svelte
   - LeadTable.svelte
   - ClientFileCard.svelte

❌ Bad: Other naming schemes
   - modal.svelte
   - user-profile.svelte
   - lead_table.svelte
```

The only exception to this are base ui components, that should named in lowercase kebabcase

```
- dropdown-menu.svelte
- button.svelte
- date-picker.svelte
```

## Context Files

For shared state logic that needs to be accessed by multiple components, use `.ts` or `.svelte.ts` (if you need to use runes) files with the context API and [`runed`'s `Context` class](https://runed.dev/docs/utilities/context). Make sure the name of the file ends with 'Context' so we know right away what it contains.

```typescript
// notesEditorContext.svelte.ts
import { Context } from 'runed';

class NotesEditorContext {
	content = $state('');
	isEditing = $state(false);

	startEditing() {
		this.isEditing = true;
	}

	save() {
		// Save logic
		this.isEditing = false;
	}
}

const context = new Context<NotesEditorContext>('notes-editor');

export function setNotesEditorContext() {
	return context.set(new NotesEditorContext());
}

export function getNotesEditorContext() {
	return context.get(NOTES_EDITOR_KEY);
}
```

Usage:

```svelte
<!-- Parent component -->
<script lang="ts">
	import { setNotesEditorContext } from './notesEditorContext.svelte';

	const editor = setNotesEditorContext();
</script>

<!-- Child component -->
<script lang="ts">
	import { getNotesEditorContext } from './notesEditorContext.svelte';

	const editor = getNotesEditorContext();
</script>
```

## Avoid Deep Nesting

```svelte
<!-- ✅ Good: Extract deeply nested markup into components -->
<script lang="ts">
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import UserList from '$lib/components/UserList.svelte';

	let { users, isLoading } = $props<{ users: User[]; isLoading: boolean }>();
</script>

<div>
	{#if isLoading}
		<LoadingSpinner />
	{:else}
		<UserList {users} />
	{/if}
</div>

<!-- ❌ Bad: Too much nesting -->
<div>
	{#if isLoading}
		<div class="spinner">Loading...</div>
	{:else if users.length > 0}
		{#each users as user}
			{#if user.isActive}
				<div class="card">
					<div class="card-header">
						<h3>{user.name}</h3>
						{#if user.isPremium}
							<span class="badge">Premium</span>
						{/if}
					</div>
					<div class="card-body">
						<!-- Complex user card markup -->
					</div>
				</div>
			{/if}
		{/each}
	{:else}
		<div>No users</div>
	{/if}
</div>
```

## Reactivity Patterns

### $derived for Computed Values

```svelte
<script lang="ts">
	// ✅ Good: Use $derived for computed values
	let users = $state<User[]>([]);
	let searchQuery = $state('');

	let filteredUsers = $derived(
		users.filter((u) => u.name.toLowerCase().includes(searchQuery.toLowerCase()))
	);

	// ❌ Bad: Manual tracking with $effect
	let users = $state<User[]>([]);
	let searchQuery = $state('');
	let filteredUsers = $state<User[]>([]);

	$effect(() => {
		filteredUsers = users.filter((u) =>
			u.name.toLowerCase().includes(searchQuery.toLowerCase())
		);
	});
</script>
```

### $effect is a last resort

Reach for `$effect` only to sync with something outside Svelte (a third-party widget, `localStorage`, a timer) after the alternatives fail. There is almost always a cleaner one:

| Need                                 | Use                                            |
| ------------------------------------ | ---------------------------------------------- |
| A value computed from state or props | `$derived`                                     |
| Work in response to a user action    | The event handler                              |
| A remote form field's starting value | `form.fields.x.set(value)` in the script       |
| The initial value of a prop, kept    | `untrack(() => prop)`: read once, never re-run |
| Setup and teardown once, on mount    | `onMount` (return the cleanup)                 |

An `$effect` in a diff needs a comment saying why none of these fit. `$effect.pre` follows the same rule.

### Reading a prop's initial value

To keep a prop's first value (a seed, a storage key), read it inside `untrack`. Svelte warns with `state_referenced_locally` on a bare read; don't silence that warning.

```svelte
<script lang="ts">
	import { untrack } from 'svelte';

	let { key }: Props = $props();

	const storageKey = untrack(() => `${key}-dismissed`);
</script>
```

### Conditional classes

Pass `class` an object or an array (Svelte 5.16+) instead of the `class:` directive.

```svelte
<div class={['card', { active: isActive, disabled }]}></div>
```

## Remote functions gotchas

- A remote function runs on its own URL. In a `form()` or `query()` handler, `getRequestEvent().params` is empty and `url` is the remote function's endpoint, not the page's. Pass what you need from the page as an argument or a form field.

## Component Organization Within Files

When you have a large component directory, organize by feature:

```
components/
├── ui/              # Generic UI components
│   ├── button/
│   ├── modal/
├── lead/            # Lead-specific components
│   ├── LeadCard.svelte
│   └── LeadTable.svelte
└── opportunity/     # Opportunity-specific components
    ├── client-file/
    └── notes/
```

## Anti-patterns to avoid

### Using a `class` or `className` prop

Generally, components should not accept classes from outside.

Each component should own their style. If a specific style should be modifiable from the outside (e.g: color, size, etc.), use a specific prop for that. For complex configurable styles, use `tailwind-variants`.

Class props:

- Make it very hard to identify where a particular style is coming from
- Are not descriptive enough
- Make it possible to break components
- Are not typesafe

The only place where they can be acceptable are for very generic and basic UI components. A form `Label` from a design system is a good example.

```svelte
<!-- ❌️ Bad: `bgClassName` could be anything and is not typesafe -->
<script>
	let { bgClassName = 'bg-gray-300' } = $props();
</script>

<button class={['flex items-center rounded-16 gap-4', bgClassName]}>

<!-- ✅ Good: Use a typesafe and specific prop for the bg color -->
<script>
	let { bgColor = 'gray' | 'blue' | 'gold' } = $props();
</script>

<button class={[
	'flex items-center rounded-16 gap-4',
	{
		'bg-gray-300': bgColor === 'gray',
		'bg-blue-500': bgColor === 'blue',
		'bg-gold-300': bgColor === 'gold'
	}
]}>
```

### Using configuration objects over component composition

When designing component APIs, you might be tempted to expose a single component that takes in a lot of complex configuration props.

We already have powerful languages to express user interfaces: HTML and Svelte. Use them.

**Why configuration objects are problematic:**

1. **They obscure structure** - The visual hierarchy and relationships between components are hidden in nested objects
2. **They limit flexibility** - Every possible use case must be anticipated and supported in the config schema
3. **They sacrifice type safety** - Complex nested config objects are harder to type properly
4. **They make refactoring difficult** - Changes to an internal component's props also mean changing the config props.
5. **They add unnecessary abstraction** - You're essentially reinventing a worse version of the markup language you already have
6. **They're harder to debug** - Finding which config option controls what behavior requires digging through implementation details

Configuration objects often start simple but grow into complex, exception-filled systems that are harder to maintain than simple component composition.

```svelte
<!-- ❌ Bad: Configuration-based API -->
<script>
	const toolbarConfig = {
		editor: editor,
		groups: [
			{
				type: 'dropdown',
				icon: 'TextT',
				items: [
					{ value: 'heading1', label: 'Heading 1', icon: 'H1' },
					{ value: 'heading2', label: 'Heading 2', icon: 'H2' },
					{ value: 'heading3', label: 'Heading 3', icon: 'H3' }
				]
			},
			{ type: 'separator' },
			{
				type: 'group',
				mode: 'multiple',
				items: [
					{ value: 'bold', icon: 'TextBold', tooltip: 'Bold' },
					{ value: 'italic', icon: 'TextItalic', tooltip: 'Italic' },
					{ value: 'underline', icon: 'TextUnderline', tooltip: 'Underline' }
				]
			},
			{ type: 'separator' },
			{
				type: 'group',
				mode: 'single',
				items: [
					{ value: 'orderedList', icon: 'ListOrdered' },
					{ value: 'bulletList', icon: 'ListBullets' },
					{ value: 'checkList', icon: 'CheckSquare' }
				]
			}
		]
	};
</script>

<TextEditorToolBar config={toolbarConfig} />

<!-- ✅ Good: Markup composition -->
<TextEditorToolBar.Root {editor}>
	<Sections />
	<Headings />
	<TextEditorToolBar.Separator />
	<TextStyles />
	<TextEditorToolBar.Separator />
	<TextAlign />
	<TextEditorToolBar.Separator />
	<TextEditorToolBar.Group type="single">
		<OrderedList />
		<BulletList />
		<CheckList />
	</TextEditorToolBar.Group>
	<TextEditorToolBar.Separator />
	<TextEditorToolBar.Group>
		<Link />
		<HorizontalRule />
	</TextEditorToolBar.Group>
</TextEditorToolBar.Root>
```

**Key Benefits of the Markup Approach:**

- **Readable**: The structure is immediately clear. You can see groups, separators, and items at a glance
- **Flexible**: Want a different toolbar layout? Just rearrange components. No config schema changes needed
- **Type-safe**: Each component has proper TypeScript props with full IDE support
- **Maintainable**: Adding a new toolbar item is just creating a new component, not updating config types and potentially adding exceptions.
- **Composable**: Can easily create variants (basic vs advanced toolbars) by mixing and matching components
- **Debuggable**: Click through to component definitions, see props inline, and understand behavior immediately

### Prop Drilling

Prop drilling is passing down the same props through a whole component tree.

If you see that you need to pass down props more than 1 or 2 levels deep, or that you have a lot of props to pass down, (ab)use the context API.

```svelte
<!-- ❌ Bad: Passing props through many levels -->
<GrandParent>
	<Parent {user} />
		<Child {user} />
			<GrandChild {user} />
		</Child>
	</Parent>
</GrandParent>

<!-- ✅ Good: Use context -->
<script>
	// In GrandParent
	setUserContext(user);
</script>

<script>
	// In GrandChild
	const user = getUserContext();
</script>
```

### Too Many Props

Components with an excessive number of props become difficult to use and maintain. As a general guideline, if a component accepts more than 5-7 props, consider refactoring.

#### Problems with Too Many Props

- **Cognitive Overload**: Users must understand numerous parameters to use the component correctly
- **Poor Encapsulation**: Often indicates the component is doing too much or not abstracting properly
- **Type Safety Issues**: Complex prop types become harder to maintain and validate
- **API Instability**: More props mean more frequent breaking changes

#### Solutions

##### 1. Break Down into Smaller Components

```svelte
<!-- ❌ Bad: One component doing too much -->
<DataTable
	data={items}
	{columns}
	sortable={true}
	sortColumn="name"
	sortDirection="asc"
	filterable={true}
	filterText=""
	paginated={true}
	pageSize={10}
	currentPage={1}
	onSort={handleSort}
	onFilter={handleFilter}
	onPageChange={handlePageChange}
	loading={false}
	error={null}
/>

<!-- ✅ Good: Compose from smaller, focused components -->
<DataTable {data} {columns}>
	<DataTableSort column="name" direction="asc" onSort={handleSort} />
	<DataTableFilter value="" onFilter={handleFilter} />
	<DataTablePagination pageSize={10} currentPage={1} onChange={handlePageChange} />
	<DataTableState {loading} {error} />
</DataTable>
```

##### 2. Use Snippets for Custom Rendering

```svelte
<!-- ❌ Bad: Boolean flags for every rendering variation -->
<Card
	showHeader
	showFooter
	showAvatar
	showBadge
	showActions
	headerAlign="left"
	footerAlign="right"
	avatarSize="medium"
	badgeColor="blue"
/>

<!-- ✅ Good: Use snippets for flexible customization -->
<Card>
	{#snippet header()}
		<div class="flex items-center gap-2">
			<Avatar size="medium" src={user.avatar} />
			<Badge color="blue">{user.role}</Badge>
		</div>
	{/snippet}

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button>Edit</Button>
			<Button variant="primary">Save</Button>
		</div>
	{/snippet}
</Card>
```

#### When Many Props Are Acceptable

Some components legitimately need many props:

- **Low-level UI primitives** (e.g., `<Button>` with size, variant, disabled, loading, icon, etc.)
- **Wrapper components** that pass props through to underlying libraries
- **Options objects** passed as a single prop (e.g., `options={{ ... }}`)

The key is ensuring each prop serves a distinct, necessary purpose and cannot be better expressed through composition or grouping.

### Massive Components

```svelte
<!-- ❌ Bad: 1000+ line component -->
<script lang="ts">
	// 500 lines of logic
</script>

<!-- 500 lines of markup -->

<!-- ✅ Good: Break into smaller components -->
<script lang="ts">
	import UserHeader from './UserHeader.svelte';
	import UserProfile from './UserProfile.svelte';
	import UserSettings from './UserSettings.svelte';
</script>

<UserHeader {user} />
<UserProfile {user} />
<UserSettings {user} />
```

If your component is getting large:

1. Extract repeated markup into components or snippets
2. Use context to share state instead of prop drilling
3. Move complex logic to utility functions or shared context
4. Consider if it should be multiple smaller components

### Inline Event Handlers with Complex Logic

```svelte
<!-- ✅ Good: Extract to function -->
<script>
	function handleSubmit(e: Event) {
		e.preventDefault();
		if (!canSubmit(user)) return;

		const data = prepareData(user);
		submitToServer(data).then(handleSuccess).catch(handleError);
	}
</script>

<button onclick={handleSubmit}> Submit </button>

<!-- ❌ Bad: Complex logic inline -->
<button
	onclick={(e) => {
		e.preventDefault();
		if (user && user.isActive && !user.isBlocked) {
			const data = prepareData(user);
			submitToServer(data).then((result) => {
				if (result.success) {
					showToast('Success!');
				}
			});
		}
	}}
>
	Submit
</button>

<button onclick={handleSubmit}>Submit</button>
```
