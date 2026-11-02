# p2 web UI source backup

`p2-web-<commit>/` holds the browser-only source of pi-private `apps/p2` at that commit (the web facets, `src/web`, the
browser host and the bundle builder), kept when p2 stopped serving its own web UI. Paths are relative to `apps/p2`.

To rebuild a bundle from it, copy it back over a pi-private checkout of the same commit (or check that commit out,
which still has it) and run `scripts/build.mts` as the top-level README describes.
