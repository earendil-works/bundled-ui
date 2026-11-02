# Pi web UI source

The source of the shared Pi web UI, taken from pi-private `apps/p2` at `87cd884f7`, when p2 stopped building its own
web UI. This is now the only copy. Paths mirror `apps/p2`:

- the plugins' web facets (`plugins/*/web.tsx`) and their browser-only modules;
- `src/web/`, the browser host (`src/hosts/web/`, `src/hosts/web.ts`) and the bundle builder (`src/hosts/bundles.ts`);
- `public/` (installable app manifest, icons, service worker);
- the Chromium UI tests (`test/p2/browser.ts`, `ui-*.test.ts`, ...) and component fixtures (`test/fixtures/`);
- the original versions of tests and docs p2 trimmed when the UI left.

`src/web/history.ts` and `src/web/transcript.ts` are not here: the TUI uses them, so they stayed in p2 as
`src/shared/history.ts` and `src/shared/transcript.ts`.

The UI imports p2's contracts and runtime modules (`plugins/*/contract.ts`, `src/runtime/`, `src/shared/`), so it
builds only inside a pi-private checkout. To build a bundle, copy this directory over `apps/p2` of a pi-private
checkout (fixing `src/web/history.ts`/`transcript.ts` imports to `src/shared/` on commits after `87cd884f7`), then run
`scripts/build.mts` as the top-level README describes.
