# Vendored dependencies

## xterm.js

- **Upstream:** https://github.com/xtermjs/xterm.js
- **Version:** 6.0.0 (tag `6.0.0`)
- **Why vendored:** terminal rendering bugs surface in xterm.js itself; vendoring
  lets us patch its source directly instead of waiting on upstream releases.

`package.json` points `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search`,
`@xterm/addon-web-links`, and `@xterm/addon-webgl` at this tree via `file:`
dependencies, so `npm install` symlinks them into `node_modules/@xterm/`.

### Making a change

1. Edit the TypeScript sources under `vendor/xterm.js/src/` (core) or
   `vendor/xterm.js/addons/addon-*/src/` (addons).
2. Rebuild the published artifacts: `npm run vendor:xterm` (from the repo root).
   This runs `npm install && npm run esbuild-package` inside `vendor/xterm.js`
   and regenerates the `lib/*.mjs` bundles that the app consumes.
3. Commit both the source change and the rebuilt `lib/` output.

The built `lib/` bundles are committed (the vendored `.gitignore` was edited to
allow this) so the app builds without a vendor rebuild step. The package
`main` fields were repointed from the unbuilt CJS paths to the ESM bundles.

Upstream's own unit tests can be run inside `vendor/xterm.js` with
`npm run test-unit`. The app's vitest config only picks up `src/**` tests.

### Local modifications (keep this list current)

- `package.json` / `addons/*/package.json`: `main` → `lib/*.mjs` (ESM build).
- `.gitignore`: `lib/` un-ignored so built bundles are committed.
