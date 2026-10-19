# bundled-ui

Prebuilt bundles of the shared Pi web UI (pi-private `apps/p2`) for testing Radius Cloud Brain.
Temporary: replace once Pi publishes the UI bundle itself.

Each build lives in `bundles/<pi-private commit>/`:

- `manifest.json` — `{ version, script, stylesheets, commit }`, paths relative to the manifest
- the app script and stylesheet

Files are served through jsDelivr (correct `Content-Type`, CORS), e.g.

```
https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@<repo commit>/bundles/<pi-private commit>/manifest.json
```

Pin the repo commit in Radius's `PI_UI_MANIFEST_URL`; `@main` is cached by jsDelivr for up to 12h.
Source maps are not published (they embed pi-private sources; this repo is public).

## Build a new bundle

With `pi-private` and `bundled-ui` checked out side by side:

```sh
cd pi-private/apps/p2
C=$(git rev-parse --short=9 HEAD)
PI_UI_COMMIT=$C \
PI_UI_OUT=../../../bundled-ui/bundles \
PI_UI_VERSION=pi-private-$C \
PI_UI_BASE_URL=https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@main/bundles/$C \
  node --import ./src/source.ts ../../../bundled-ui/scripts/build.mts
cd ../../../bundled-ui
rm bundles/$C/*.map
sed -i '' 's#//\# sourceMappingURL=[^ ]*##' bundles/$C/*.js
sed -i '' 's#/\*\# sourceMappingURL=[^*]*\*/##' bundles/$C/*.css
git add bundles/$C && git commit -m "bundle pi-private $C" && git push
```

The script builds the p2 web bundle with the `web-shell`, `artifacts`, `chat`, `drafts`, `models`, `sessions`,
`status`, `subagents` and `workspace` plugins, and patches two places where it assumes p2 serves it:

- the Chord socket URL is read from the page bootstrap (`data-pi-bootstrap` → `chordUrl`) instead of `/chord`;
- the version poll fetches this build's `manifest.json` (`PI_UI_BASE_URL`) instead of `/__p2_web`.
