# Comments

Every symbol a `.ts` or `.js` module exports gets a JSDoc comment: the interface comment that lets a caller use it without reading the body. Write it before the body. If it's hard to write in a sentence or two, the interface is probably doing too much: rethink it before you build it.

Exports whose contract something else defines need none: the entry points a framework calls by name (route handlers, loaders, config default exports), message catalogs, and generated files.
