# p2 web UI source backup

`p2-web-<commit>/` holds the browser-only source of pi-private `apps/p2` at that commit, kept when p2 stopped serving
its own web UI: the web facets and their browser-only modules, `src/web`, the browser host (`src/hosts/web*`), the
bundle builder (`src/hosts/bundles.ts`), `public/`, the Chromium UI tests (`test/p2/browser.ts`, `ui-*.test.ts`, ...)
and component fixtures, and the original versions of tests and docs p2 trimmed when the UI left. Paths are relative
to `apps/p2`. `src/web/history.ts` and `src/web/transcript.ts` stayed in p2 (the TUI uses them) as `src/shared/`.

To rebuild a bundle from it, copy it back over a pi-private checkout of the same commit (or check that commit out,
which still has it) and run `scripts/build.mts` as the top-level README describes.
