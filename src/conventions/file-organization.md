# File organization

## Where code goes

A **module** is a boundary around one well-defined capability (`billing`, `kv-store`, `background-work`). It lives in a folder of its own and exposes that capability to the rest of the system through a simple interface: the functions, types and services it exports. Everything else in the folder is its implementation.

- **One capability, one module.** Infrastructure gets its own module too: the KV store is `kv-store`, not a file inside the CMS cache that uses it. A service that only one module uses still belongs to its own module when it is a separate capability.
- **A new file earns its place.** Split a module into another file when the new file hides something behind its own interface. Keep code in the service file when the split would only move lines around (a `transport.ts` holding one client constructor). Every new file and script in a diff should answer "what does this hide?"
- **Callers go through the interface.** Code outside a module calls its service, never the vendor client or the store the service wraps. When a caller needs something the interface lacks, add it to the interface.
- **Entry points stay thin.** A route handler, a CLI command or a queue consumer parses its input, calls a module and shapes the response. Request concerns stay there: the `authorization` header and its secret, status codes, cookies. The logic, and its tests, live in the module that owns it. Modules stay free of HTTP.

## Import paths

When the repo configures path aliases (subpath imports under `imports` in `package.json`, or `paths` in `tsconfig.json`), import other modules through them instead of climbing out with `../../`.

```typescript
// ✅ Good: an alias names the module
import { formatDate } from '#utils/dates.js';
// ❌ Bad: a relative path that depends on where the importing file sits
import { formatDate } from '../../../utils/dates.js';
```
