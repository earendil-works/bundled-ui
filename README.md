# bundled-ui

Prebuilt bundles of p2's web UI, loaded by Radius Cloud Brain. The source is p2 in pi-private (`apps/p2`: the
plugins' `web.tsx` facets, `src/web/`, `src/hosts/web/`); p2 builds and serves its own page from it. This repository
holds only the built files and the script that builds them.
Temporary: replace once Pi publishes the UI bundle itself.

This repository is public. The bundles hold compiled code only: the build drops source maps, which embed pi-private
sources. Never commit pi-private source here.

Each build lives in `bundles/<pi-private commit>/`, in two variants:

- `bundles/<commit>/` — the Cloud Brain plugins (`web-shell`, `artifacts`, `chat`, `drafts`, `models`, `sessions`,
  `status`, `subagents`, `workspace`), for Radius `PI_UI_MANIFEST_URL`;
- `bundles/<commit>/brain/` — every p2 plugin with a web facet: a p2 brain's full UI, for pages that load it from
  here. p2 serves its own build again; from pi-private `1cf20071f` until the UI moved back, it loaded this variant
  through `P2_UI_MANIFEST_URL`.

Each variant has a `manifest.json` (`{ version, script, stylesheets, commit, plugins }`, paths relative to the
manifest), the app script and stylesheet, and its assets (the brain's terminal wasm). Radius pins published builds:
never change or delete one, add a new directory instead.

Files are served through jsDelivr (correct `Content-Type`, CORS), e.g.

```
https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@<repo commit>/bundles/<pi-private commit>/manifest.json
```

Pin the repo commit in the manifest URL; `@main` is cached by jsDelivr for up to 12h (the files inside a build are
immutable, so the URLs a script names may use `@main`).

## Build a new bundle

Check out the pi-private commit to build, side by side with this repository (a worktree works; it needs
`npm ci --ignore-scripts` and Node 24), then run the script from its `apps/p2`:

```sh
git -C pi-private fetch origin
git -C pi-private worktree add --detach ../pi-private-build <commit>
(cd pi-private-build && npm ci --ignore-scripts)
cd pi-private-build/apps/p2
C=$(git rev-parse --short=9 HEAD)
PI_UI_VERSION=pi-private-$C \
PI_UI_BASE_URL=https://cdn.jsdelivr.net/gh/earendil-works/bundled-ui@main/bundles/$C \
  node --import ./src/source.ts ../../../bundled-ui/scripts/build.mts
cd ../../../bundled-ui
git add bundles/$C && git commit -m "Pi web UI bundles for pi-private $C (cloud and brain)" && git push
```

The script builds from the checkout it runs in, names the build after its `HEAD` (`PI_UI_COMMIT` overrides it; an
unnamed build refuses a checkout with uncommitted changes in `apps/p2`) and writes to this repository's `bundles/`
(`PI_UI_OUT` overrides it). It builds p2's web bundle (`buildWebBundle` in `apps/p2/src/hosts/bundles.ts`) for each
variant and patches the places where it assumes p2 serves it:

- the Chord socket URL is read from the page bootstrap (`data-pi-bootstrap` → `chordUrl`), else `/chord` on the page's
  host (a p2 brain's page);
- the version poll fetches this build's `manifest.json` instead of `/__p2_web`;
- asset URLs (the terminal's wasm) point into this build instead of `/__p2_web/`.

A patch whose target is missing stops the build: p2 changed the code it patches (`src/hosts/web/main.tsx`,
`WEB_BUNDLE_PATH`), and the script must follow.

The page that loads a bundle must set `data-web-version` on `<html>` to the manifest's `version`, or the version poll
reloads it.
