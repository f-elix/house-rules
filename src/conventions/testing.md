# Testing

Where tests live. Which cases to write is in [test-cases.md]({{rel:docs/conventions/test-cases.md}}).

## Files

- Colocate tests with the code they cover, in a `__tests__` folder next to it.
- Name test files `*.test.ts`.
- Test an entry point through what its framework calls: the route handler, the loader, the command. Keep helpers private to the entry point; exporting one only so a test can reach it couples the test to the implementation.
