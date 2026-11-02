# bundled-ui

The shared Pi web UI: its source (`ui/`, see [ui/README.md](ui/README.md)) and prebuilt bundles, loaded by Radius
Cloud Brain and by p2 brains. p2 no longer has the UI source; `ui/` is the only copy.
Temporary: replace once Pi publishes the UI bundle itself.

Each build lives in `bundles/<pi-private commit>/`, in two variants:

- `bundles/<commit>/` — the Cloud Brain plugins (`web-shell`, `artifacts`, `chat`, `drafts`, `models`, `sessions`,
  `status`, `subagents`, `workspace`), for Radius `PI_UI_MANIFEST_URL`;
- `bundles/<commit>/brain/` — every p2 plugin with a web facet, for p2 brains (`P2_UI_MANIFEST_URL`).

Each variant has a `manifest.json` (`{ version, script, stylesheets, commit, plugins }`, paths relative to the
manifest), the app script and stylesheet, and its assets (the brain's terminal wasm).

Files are served through jsDelivr (correct `Content-Type`, CORS), e.g.

```
https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@<repo commit>/bundles/<pi-private commit>/manifest.json
```

Pin the repo commit in the manifest URL; `@main` is cached by jsDelivr for up to 12h (the files inside a build are
immutable, so the URLs a script names may use `@main`). Source maps are not published (they embed pi-private sources;
this repo is public): the build script drops them.

## Build a new bundle

With `pi-private` and `bundled-ui` checked out side by side, in a pi-private checkout whose `apps/p2` has the web UI
(`87cd884f7`, or a later commit with `ui/` copied over `apps/p2`, see `ui/README.md`):

```sh
cd pi-private/apps/p2
C=$(git rev-parse --short=9 HEAD)
PI_UI_COMMIT=$C \
PI_UI_OUT=../../../bundled-ui/bundles \
PI_UI_VERSION=pi-private-$C \
PI_UI_BASE_URL=https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@main/bundles/$C \
  node --import ./src/source.ts ../../../bundled-ui/scripts/build.mts
cd ../../../bundled-ui
git add bundles/$C && git commit -m "bundle pi-private $C" && git push
```

`scripts/build.mts` builds p2's web bundle (`buildWebBundle` in `apps/p2/src/hosts/bundles.ts`) for each variant and
patches the places where it assumes p2 serves it:

- the Chord socket URL is read from the page bootstrap (`data-pi-bootstrap` → `chordUrl`), else `/chord` on the page's
  host (a p2 brain's page);
- the version poll fetches this build's `manifest.json` instead of `/__p2_web`;
- asset URLs (the terminal's wasm) point into this build instead of `/__p2_web/`.

The page that loads a bundle must set `data-web-version` on `<html>` to the manifest's `version`, or the version poll
reloads it.
