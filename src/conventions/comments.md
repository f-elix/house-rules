# Comments

Every symbol a `.ts` or `.js` module exports gets a JSDoc comment: the interface comment that lets a caller use it without reading the body. Write it before the body. If it's hard to write in a sentence or two, the interface is probably doing too much: rethink it before you build it.

Exports whose contract something else defines need none: the entry points a framework calls by name (route handlers, loaders, config default exports), message catalogs, and generated files.

## Sentence structure

Every comment, JSDoc or inline, should read in one pass, front to back:

- Give every sentence a subject and a main verb. No fragments.
- Start a relative clause with "that" or "which", or use a participle: "the fields that `EventRow` decodes" or "the fields decoded by `EventRow`", never "the fields `EventRow` decodes". Without the "that", the noun's role stays unknown until the verb at the end.
- Name who acts: "the query sorts the rows", not "the rows sort".
- Don't stack nouns where the first could be read as modifying the next, as in "the order events show".

```ts
// ❌ Both lists, as one, in the fields `EventRow` decodes. The type names sort in the order
//    events of the same second show: 'created', 'deleted', 'updated'.
// ✅ Merges both lists into the fields that `EventRow` decodes. The type names are chosen so that
//    events in the same second sort alphabetically into display order: 'created', 'deleted',
//    'updated'.
```
