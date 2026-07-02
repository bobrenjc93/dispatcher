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

### Backported upstream fixes (post-6.0.0)

Renderer fixes for resize/atlas corruption, cherry-picked from upstream
master (hashes are upstream xterm.js commits):

- `4619a755` Force a sync render after resize occurs — closes the gap
  between the canvas being cleared on resize and the debounced repaint.
- `d6df8d79` Update viewport dims when dpr changes — adds the missing
  `gl.viewport()` call when the device-pixel observer resizes the backing
  store (fixes never-repainted black rectangles).
- `4ddd982e` Fix blur due to canvas dim mismatch in glyph renderer.
- `dc726a2a` + `3bcb5754` + `c24eb60b` + `b4bd92d6` + `0c8271db` texture
  atlas page-merge fixes (wrong-glyph corruption when multiple terminals
  share the atlas cache, stack overflow, stable sort, re-upload after merge).
- `f43273b3` Include texture size and cell dimensions in atlas cache
  equality — prevents reusing an atlas built for different cell metrics.
- `64718444` Avoid glyph atlas mipmaps.
- `f33f5022` DomRenderer: resilience when buffer lines are missing
  (adapted: 6.0.0 has no `_setRowBlinkState`; those calls were dropped).
- `2fe3fd13` WebGL: skip missing buffer lines in `_updateModel`
  (hand-adapted to the 6.0.0 code shape) — a resize landing between a
  refresh request and the frame could throw on `lines.get(row)!`,
  aborting the frame and leaving stale glyphs on rows below the gap.
