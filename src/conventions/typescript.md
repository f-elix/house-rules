# TypeScript conventions

## Types over interfaces

Prefer types over interfaces.

## Avoid `any`

```typescript
// ❌ Bad: Using any
function processData(data: any): any {
	return data.map((user: any) => ({ ...user, processed: true }));
}

// ✅ Good: Be specific
function processData(data: User[]): ProcessedUser[] {
	return data.map((user) => ({ ...user, processed: true }));
}

// ✅ Good: If you truly don't know the type, decode the raw input where it enters
async function handleWebhook(request: Request) {
	const event = parseWebhookEvent(await request.json()); // the schema library's decoder, throws when invalid

	console.info(event.type);
}

// ⚠️ Acceptable: With an oxlint-disable comment and its reason
// oxlint-disable-next-line typescript/no-explicit-any -- compares arbitrary values structurally
export function deepEqual(obj1: any, obj2: any): boolean {
	// Implementation
}
```

## Utility types

Use TypeScript's built-in utilities:

```typescript
// Partial - makes all properties optional
type PartialUser = Partial<User>;

// Required - makes all properties required
type RequiredUser = Required<PartialUser>;

// Pick - select specific properties
type UserEmailOnly = Pick<User, 'email'>;
type UserNameAndEmail = Pick<User, 'name' | 'email'>;

// Omit - exclude specific properties
type UserWithoutEmail = Omit<User, 'email'>;

// Record - create an object type with specific keys and value type
type UserRoles = Record<string, 'admin' | 'editor' | 'viewer'>;

// ReturnType - extract return type of a function
type UserResult = ReturnType<typeof fetchUser>;

// Parameters - extract parameters of a function
type FetchUserParams = Parameters<typeof fetchUser>;

// Awaited - unwrap Promise types
type ResolvedUser = Awaited<Promise<User>>;
```

## Return types

Prefer inference over explicit return types.

```typescript
// The return type is inferred as `number`, no need to specify it
export function average(values: number[]) {
	const total = values.reduce((sum, value) => sum + value, 0);

	return values.length === 0 ? 0 : total / values.length;
}

// The return type is inferred as `string`, no need to specify it
function initials(firstName: string, lastName: string) {
	return firstName[0] + lastName[0];
}

// You might specify an explicit return type for complex returns
export function processOrder(order: Order): {
	isValid: boolean;
	errors: string[];
	processedOrder?: ProcessedOrder;
} {
	// Implementation
}

// ⚠️ Better: Extract to named type for reusability
export type OrderProcessResult = {
	isValid: boolean;
	errors: string[];
	processedOrder?: ProcessedOrder;
};

export function processOrder(order: Order): OrderProcessResult {
	// Implementation
}
```

## Enums vs union types

Avoid enums, use const objects and union types.

```typescript
// ✅ Preferred: Use const objects with union types (tree-shakeable)
export const OrderStatus = {
	PENDING: 'pending',
	PAID: 'paid',
	SHIPPED: 'shipped',
	DELIVERED: 'delivered'
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

// Usage:
const status: OrderStatus = OrderStatus.PENDING;

// ✅ Also good: Simple union types for few values
export type UserRole = 'admin' | 'editor' | 'viewer';
```

## Function signatures

```typescript
// ✅ Good: Clear parameter types
function formatUserName(
	firstName: string,
	lastName: string,
	options?: { uppercase?: boolean; middleName?: string }
) {
	// Implementation
}

// ✅ Good: Use object for many parameters
type FormatUserNameOptions = {
	firstName: string;
	lastName: string;
	middleName?: string;
	uppercase?: boolean;
	includeTitle?: boolean;
};

function formatUserName(options: FormatUserNameOptions): string {
	// Implementation
}

// ❌ Bad: Too many parameters
function formatUserName(
	firstName: string,
	lastName: string,
	middleName?: string,
	uppercase?: boolean,
	includeTitle?: boolean
) {
	// Hard to remember parameter order
}

// ❌️ Bad: Avoid boolean parameters
function formatUserName(user: User, uppercase?: boolean, includeTitle?: boolean) {
	//
}

// We can't know what the boolean parameters do just by looking at the function call
formatUserName(user, false, true);
```

## Parse at the boundary

Data from outside the program (a request body, a file, an API response, `JSON.parse`) arrives as `unknown`. Decode it once, where it enters, with the repo's schema library, and pass the typed value inward. Hand-written `typeof` checks narrow a representation without establishing its contract; the `anti-slop/no-runtime-typeof` lint rule rejects them.

```typescript
// ✅ Good: a schema decodes and validates in one step
export const User = schema.object({
	id: schema.string(),
	name: schema.string(),
	email: schema.string(),
	age: schema.optional(schema.number())
});

export type User = schema.Infer<typeof User>;

// Usage:
const user = User.parse(await response.json());
// user is now typed as User and validated

// ❌ Bad: a hand-written guard that checks the representation
export function isUser(value: unknown): value is User {
	return typeof value === 'object' && value !== null && 'id' in value && 'email' in value;
}
```

`schema` stands for whichever library the repo uses: Zod, Valibot, Effect Schema or another.

## Type assertions

```typescript
// ❌ Bad: Type assertion without validation
const response = await fetch('/api/user');
const user = (await response.json()) as User; // Unsafe!

// ✅ Good: Validate instead of asserting
const response = await fetch('/api/user');
const user = User.parse(await response.json()); // Throws if invalid

// ⚠️ Acceptable: When you know more than TypeScript, say why in a SAFETY comment
// SAFETY: the template renders exactly one `.my-element` div
const element = document.querySelector('.my-element') as HTMLDivElement;
// But better to check:
const element = document.querySelector<HTMLDivElement>('.my-element');
if (!element) {
	return;
}
// Safe to use as HTMLDivElement

// ❌️ Bad: Avoid non-null assertion
const user = users.find((u) => u.id === targetId)!;
// ✅ Good: handle null case
const user = users.find((u) => u.id === targetId);
if (!user) throw new Error('User not found');
```
