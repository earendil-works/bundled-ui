import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Builds p2's web bundle from a pi-private checkout for hosts other than p2 itself: the Radius Cloud Brain page, and
// p2 brains whose page loads it from here. Run it from the checkout's `apps/p2` (see README); the UI source is p2's
// own (`plugins/*/web.tsx`, `src/web/`, `src/hosts/web/`), this repository holds only the built files.
//
// Patches the places where the bundle assumes p2 serves its files:
// - the Chord socket: the page bootstrap's `chordUrl` (`data-pi-bootstrap`), else `/chord` on the page's host;
// - the version poll: this build's manifest.json instead of /__p2_web;
// - asset URLs (the terminal's wasm): this build's directory instead of /__p2_web/.
// Source maps are dropped: they embed pi-private sources, and this repository is public.
//
// Env:
//   PI_UI_COMMIT   directory name for this build (default: the checkout's HEAD, short=9; the checkout's apps/p2 must
//                  then be clean, so a published build is exactly that commit)
//   PI_UI_OUT      parent directory of the build (default: this repository's bundles/)
//   PI_UI_BASE_URL public URL of the build directory, i.e. where its manifest.json is served from
//                  (default http://127.0.0.1:4173/<commit>; for the GitHub repo, a jsDelivr URL)
//   PI_UI_VERSION  the manifest version (default local-radius-<time>)
//
// Each build has two variants, each with its own manifest:
//   <commit>/        cloud: the plugins Radius Cloud Brain serves
//   <commit>/brain/  brain: every p2 plugin with a web facet, for p2 brains (local or through Radius)
const app = process.cwd();
// The checkout is chosen at run time (any commit, any location), so the builder cannot be a static import.
const { buildWebBundle } = (await import(pathToFileURL(join(app, "src/hosts/bundles.ts")).href)) as {
	buildWebBundle: (plugins: readonly string[]) => Promise<{
		files: ReadonlyMap<string, { body: Uint8Array }>;
		script: string;
		style: string | undefined;
	}>;
};

const git = (...args: string[]): string => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();
const commit = process.env.PI_UI_COMMIT ?? headCommit();
const root = process.env.PI_UI_OUT ?? new URL("../bundles/", import.meta.url).pathname;
const base = (process.env.PI_UI_BASE_URL ?? `http://127.0.0.1:4173/${commit}`).replace(/\/$/, "");
const version = process.env.PI_UI_VERSION ?? `local-radius-${Date.now()}`;

function headCommit(): string {
	if (git("status", "--porcelain", "--", ".") !== "")
		throw new Error(`${app} has uncommitted changes: commit them, or name the build with PI_UI_COMMIT`);
	return git("rev-parse", "--short=9", "HEAD");
}

const CLOUD = [
	"web-shell", // registers the "app" slot; without it the page stays on "Loading…"
	"artifacts",
	"chat",
	"drafts",
	"models",
	"sessions",
	"status",
	"subagents",
	"workspace",
];
const BRAIN = [
	"artifacts",
	"chat",
	"chat-mode",
	"conversations",
	"devices",
	"drafts",
	"envs",
	"login",
	"logs",
	"models",
	"ports",
	"prompt",
	"sessions",
	"sharing",
	"status",
	"subagents",
	"terminals",
	"voice",
	"web-shell",
	"workspace",
];

const patch = (source: string, from: string, to: string, all = false): string => {
	if (!source.includes(from)) throw new Error(`patch target not found: ${from}`);
	return all ? source.split(from).join(to) : source.replace(from, to);
};
const chordUrl =
	'(()=>{const fallback=`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`;' +
	'try{const raw=document.getElementById("root")?.getAttribute("data-pi-bootstrap");' +
	"return (raw?JSON.parse(raw):undefined)?.chordUrl??fallback}catch{return fallback}})()";

async function variant(name: string, plugins: readonly string[], directory: string): Promise<void> {
	const output = join(root, commit, directory);
	const url = `${base}${directory ? `/${directory}` : ""}`;
	const manifestUrl = `${url}/manifest.json`;
	// Plugins without a web facet (or not in this checkout) are skipped by the build.
	const bundle = await buildWebBundle(plugins);
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	const prefix = `radius-${version}-`;
	let script: string | undefined;
	let style: string | undefined;
	for (const [file, content] of bundle.files) {
		if (file.endsWith(".map")) continue;
		let body: Uint8Array | string = content.body;
		let outName = file;
		if (file === bundle.script) {
			let text = new TextDecoder().decode(content.body);
			text = patch(
				text,
				'new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`)',
				`new WebSocket(${chordUrl})`,
			);
			text = patch(
				text,
				'fetch("/__p2_web",{cache:"no-store",credentials:"same-origin"})',
				`fetch(${JSON.stringify(manifestUrl)},{cache:"no-store"})`,
			);
			if (text.includes("/__p2_web/")) text = patch(text, "/__p2_web/", `${url}/`, true);
			text = text.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "\n");
			if (text.includes("__p2_web")) throw new Error(`${name}: the script still names /__p2_web`);
			body = text;
			outName = `${prefix}${file}`;
			script = outName;
		} else if (file === bundle.style) {
			body = new TextDecoder().decode(content.body).replace(/\n?\/\*# sourceMappingURL=[^*]*\*\/\s*$/, "\n");
			style = file;
		}
		await writeFile(join(output, outName), body);
	}
	if (!script) throw new Error(`${name}: bundle has no script`);
	await writeFile(
		join(output, "manifest.json"),
		`${JSON.stringify({ version: `${version}${directory ? `-${directory}` : ""}`, script, stylesheets: style ? [style] : [], commit, plugins }, null, 2)}\n`,
	);
	console.log(JSON.stringify({ variant: name, output, manifest: manifestUrl, script, style }, null, 2));
}

await variant("cloud", CLOUD, "");
await variant("brain", BRAIN, "brain");
