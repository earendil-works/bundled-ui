import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Run from pi-private/apps/p2 (see README): resolved relative to this file, so keep the repos side by side.
import { buildWebBundle } from "../../pi-private/apps/p2/src/hosts/bundles.ts";

// Temporary Radius preview of the shared Pi web UI: builds pi-private's p2 web bundle and patches the two
// places where it assumes it is served by p2 itself (the /chord socket and the /__p2_web version poll).
//
// Env:
//   PI_UI_COMMIT   directory name for this build (default a1caf99fd; use the pi-private commit for published builds)
//   PI_UI_OUT      parent directory of the build (default: next to this script)
//   PI_UI_BASE_URL public URL of the build directory, i.e. where manifest.json is served from
//                  (default http://127.0.0.1:4173/<commit>; for the GitHub repo, a jsDelivr URL)
const root = process.env.PI_UI_OUT ?? new URL("./", import.meta.url).pathname;
const commit = process.env.PI_UI_COMMIT ?? "a1caf99fd";
const base = (process.env.PI_UI_BASE_URL ?? `http://127.0.0.1:4173/${commit}`).replace(/\/$/, "");
const version = process.env.PI_UI_VERSION ?? `local-radius-${Date.now()}`;
const output = join(root, commit);
const manifestUrl = `${base}/manifest.json`;

const bundle = await buildWebBundle([
  "web-shell", // registers the "app" slot; without it the page stays on "Loading…"
  "artifacts",
  "chat",
  "drafts",
  "models",
  "sessions",
  "status",
  "subagents",
  "workspace",
]);

const patch = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) throw new Error(`patch target not found: ${from}`);
  return source.replace(from, to);
};
const chordUrl =
  '(()=>{const fallback=`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`;' +
  'try{const raw=document.getElementById("root")?.getAttribute("data-pi-bootstrap");' +
  "return (raw?JSON.parse(raw):undefined)?.chordUrl??fallback}catch{return fallback}})()";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const prefix = `radius-${version}-`;
let script: string | undefined;
let style: string | undefined;
for (const [name, file] of bundle.files) {
  let body: Uint8Array | string = file.body;
  let outName = name;
  if (name === bundle.script) {
    let text = new TextDecoder().decode(file.body);
    text = patch(text, 'new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`)', `new WebSocket(${chordUrl})`);
    text = patch(text, 'fetch("/__p2_web",{cache:"no-store",credentials:"same-origin"})', `fetch(${JSON.stringify(manifestUrl)},{cache:"no-store"})`);
    body = text;
    outName = `${prefix}${name}`;
    script = outName;
  }
  if (name === bundle.style) style = name;
  await writeFile(join(output, outName), body);
}
if (!script) throw new Error("bundle has no script");
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify({ version, script, stylesheets: style ? [style] : [], commit }, null, 2),
);
console.log(JSON.stringify({ output, manifest: manifestUrl, version, script, style }, null, 2));
