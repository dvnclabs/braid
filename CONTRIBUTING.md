# Contributing

braid is early, so comments on the [design](docs/design.md) are as useful as code.

- **Questions and proposals:** open an issue and name the section it concerns.
- **Code:** run `npm run check` before opening a pull request. It typechecks, runs the tests, and rebuilds `dist/braid.mjs`, which is committed because the plugin runs it straight from the repository.
- **The example:** edit `examples/pr-review/generate.py`, regenerate the file, and validate it as its README shows.
- **Corrections to [prior art](docs/design.md#prior-art):** welcome at any time, with a link to the source.
