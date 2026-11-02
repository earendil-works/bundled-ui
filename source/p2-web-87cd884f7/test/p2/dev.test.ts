import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { hostFamily, hostNamed, method, remote, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import { num, obj, str } from "@earendil-works/pi-schema";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { planPluginReload, watchPlugins } from "../../src/hosts/dev.ts";
import { contentHash, LoadedModules } from "../../src/hosts/dev-modules.ts";
import { listPlugins } from "../../src/hosts/plugins.ts";
import { createHost, type Host } from "../../src/runtime/chord.ts";
import type { DevCommand, DevStatus } from "../../src/runtime/dev-protocol.ts";
import { HOST, SERVER } from "../../src/runtime/principals.ts";
import { Browser, browserTests } from "./browser.ts";
import { holdIn, http, poll, until, webBundle } from "./helpers.ts";

/** A test plugin's probe on session workers (`name`) and its twin on the server (`name-server`): one type, one place. */
function probes(name: string) {
	const variants = {
		reader: { methods: { label: method(undefined, str()), pid: method(undefined, num()) } },
	};
	return {
		worker: remote(name, {
			version: 1,
			input: obj({ session: str() }, { open: true }),
			host: hostFamily("session:", "session"),
			variants,
		}),
		server: remote(`${name}-server`, {
			version: 1,
			input: obj({}, { open: true }),
			host: hostNamed("server"),
			variants,
		}),
	};
}
const { worker: Probe, server: ServerProbe } = probes("test.dev-probe");
const contractSource = `import { num, obj, str } from "@earendil-works/pi-schema";
import { hostFamily, hostNamed, method, remote } from "@earendil-works/chord";
const variants = { reader: { methods: { label: method(undefined, str()), pid: method(undefined, num()) } } };
export const Probe = remote("test.dev-probe", { version: 1, input: obj({ session: str() }, { open: true }),
host: hostFamily("session:", "session"), variants });
export const ServerProbe = remote("test.dev-probe-server", { version: 1, input: obj({}, { open: true }), host: hostNamed("server"), variants });`;
const facetSource = `import { defineFacet } from "../../src/runtime/chord.ts";
import { Probe, ServerProbe } from "./contract.ts";
import { label } from "./nested/label.ts";
const probe = () => ({ variant: "reader" as const, label: () => label, pid: () => process.pid });
export default defineFacet(host => host.name === "server" ? host.serve(ServerProbe, probe) : host.serve(Probe, probe));`;

function lifecycleFacet(directory: string, name: string, route: string): string {
	return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { local } from "@earendil-works/chord";
import { obj } from "@earendil-works/pi-schema";
import { defineFacet } from "../../src/runtime/chord.ts";
import { Routes } from "../../src/runtime/server.ts";
import { Probe, ServerProbe } from "./contract.ts";
import { label } from "./nested/label.ts";
const Eager = local(${JSON.stringify(`test.${name}.lifecycle`)}, { version: 1, input: obj({}, { open: true }) });
export default defineFacet(host => {
 const probe = () => ({ variant: "reader" as const, label: () => label, pid: () => process.pid });
 if (host.name === "server") host.serve(ServerProbe, probe);
 else host.serve(Probe, probe);
 host.serve(Eager, (_input, _principal, self) => {
  if (host.name === "server") self.register(Routes, { ${JSON.stringify(`GET ${route}`)}: (_request, response) => response.end(${JSON.stringify(name)}) });
  self.resource("life", { version: 1, open: () => null,
   close: () => writeFileSync(join(${JSON.stringify(directory)}, ${JSON.stringify(`${name}-disposed-`)} + process.pid), "closed") });
  return {};
 }, { lifetime: "host" });
});`;
}

const emptyFacet = 'import { defineFacet } from "@earendil-works/chord"; export default defineFacet(() => {});';
const webFacet = `import "./style.css"; ${emptyFacet}`;

function connect(port: number): Host {
	return createHost({
		self: HOST,
		name: "browser",
		kind: "client",
		upstream: {
			link: webSocketLink(new WebSocket(`ws://127.0.0.1:${port}/chord`) as unknown as WebSocketLike),
			principal: SERVER,
		},
		onError: () => {},
	});
}

test("dev watcher maps saves of loaded files to plugins by directory and coalesces them", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-watch-"));
	await mkdir(join(directory, "alpha/nested"), { recursive: true });
	await mkdir(join(directory, "beta"));
	await writeFile(join(directory, "alpha/server.ts"), 'import "./nested/value.ts"; import "../beta/contract.ts";');
	await writeFile(join(directory, "alpha/nested/value.ts"), "export const value = 1;");
	await writeFile(join(directory, "alpha/web.tsx"), 'import "./view.tsx"; import "./style.css";');
	await writeFile(join(directory, "alpha/view.tsx"), "export const view = 1;");
	await writeFile(join(directory, "alpha/style.css"), ":root { --alpha: 1; }");
	await writeFile(join(directory, "alpha/unused.ts"), "export const unused = 1;");
	await writeFile(join(directory, "beta/server.ts"), "export default {};");
	// Some platforms (macOS) still report these setup writes to a watcher started right away.
	await delay(200);
	const calls: (readonly string[])[] = [];
	// What the server, workers and the web/TUI bundles loaded; nothing loaded unused.ts.
	const loaded = new Set(
		[
			"alpha/server.ts",
			"alpha/nested/value.ts",
			"beta/server.ts",
			"alpha/web.tsx",
			"alpha/view.tsx",
			"alpha/style.css",
		].map((file) => join(directory, file)),
	);
	const watcher = watchPlugins({
		directory,
		plugins: () => ["alpha", "beta"],
		quietMs: 60,
		loadedFiles: () => loaded,
		reload: async (plugins) => {
			calls.push(plugins);
			return { plugins, value: undefined };
		},
	});
	t.after(async () => {
		await watcher.close();
		await rm(directory, { recursive: true, force: true });
	});
	await appendFile(join(directory, "alpha/unused.ts"), "\n// loaded by nothing");
	await delay(150);
	assert.equal(watcher.status().revision, 0, "a file nothing loaded marks nothing");
	// Any file the web bundle loaded (not only TypeScript) marks its plugin dirty: a reload rebuilds it.
	await appendFile(join(directory, "alpha/style.css"), "\n:root { --alpha: 2; }");
	await poll(() => watcher.status().dirty.includes("alpha"));
	assert.equal(calls.length, 0, "a web save only marks dirty");
	await watcher.reload();
	calls.length = 0;
	await appendFile(join(directory, "alpha/nested/value.ts"), "\n// first");
	await appendFile(join(directory, "alpha/server.ts"), "\n// second");
	await poll(() => watcher.status().dirty.includes("alpha"));
	await delay(200);
	assert.equal(calls.length, 0, "Saves only mark dirty");
	await watcher.reload();
	assert.deepEqual(calls, [["alpha"]], "No dependencies are derived: beta stays as it is");
	assert.deepEqual(watcher.status().dirty, []);
	// A file directly in the plugins directory belongs to no plugin.
	await writeFile(join(directory, "loose.ts"), "export const value = 1;");
	await delay(150);
	assert.deepEqual(watcher.status().dirty, []);
});

test("dev watcher marks plugin-set and facet-entry changes dirty until explicitly reloaded", async () => {
	for (const change of ["add-plugin", "remove-plugin", "add-worker", "remove-worker", "add-web", "remove-web"]) {
		const directory = await mkdtemp(join(tmpdir(), "p2-dev-structure-"));
		await mkdir(join(directory, "alpha"));
		for (const kind of ["server", "worker", "web"])
			await writeFile(join(directory, "alpha", `${kind}.ts`), "export default {};");
		if (change.startsWith("add-") && change !== "add-plugin")
			await rm(join(directory, "alpha", `${change.slice(4)}.ts`));
		// Some platforms (macOS) still report these setup writes to a watcher started right away.
		await delay(200);
		let loaded = ["alpha"];
		const calls: (readonly string[])[] = [];
		const watcher = watchPlugins({
			directory,
			plugins: () => loaded,
			quietMs: 60,
			loadedFiles: () => new Set(),
			reload: async (names) => {
				calls.push(names);
				loaded = [...listPlugins(directory).keys()];
				return { plugins: names, value: undefined };
			},
		});
		try {
			if (change === "add-plugin") {
				await mkdir(join(directory, "added"));
				await writeFile(join(directory, "added/server.ts"), "export default {};");
			} else if (change === "remove-plugin") await rm(join(directory, "alpha"), { recursive: true });
			else if (change.startsWith("add-"))
				await writeFile(join(directory, "alpha", `${change.slice(4)}.ts`), "export default {};");
			else await rm(join(directory, "alpha", `${change.slice(7)}.ts`));
			await poll(() => watcher.status().dirty.length > 0, 5000, change);
			await delay(150);
			assert.equal(calls.length, 0);
			await watcher.reload();
			assert.deepEqual(calls, [[change === "add-plugin" ? "added" : "alpha"]]);
			assert.equal(watcher.status().phase, "ready");
		} finally {
			await watcher.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("a reload plan names exactly the requested plugins: changes, additions and removals", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-plan-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const name of ["alpha", "beta", "gamma"]) {
		await mkdir(join(directory, name));
		await writeFile(join(directory, name, "server.ts"), 'import "../beta/contract.ts";');
	}
	const previous = listPlugins(directory);
	await rm(join(directory, "beta"), { recursive: true });
	await mkdir(join(directory, "delta"));
	await writeFile(join(directory, "delta/worker.ts"), "export default {};");
	const listing = listPlugins(directory);
	const plan = planPluginReload(previous, ["alpha", "beta"], listing, ["beta", "delta", "alpha"]);
	assert.deepEqual(plan.selected, ["alpha", "delta"]);
	assert.deepEqual(plan.removed, ["beta"]);
	assert.deepEqual(plan.plugins, ["alpha", "delta"]);
	assert.deepEqual([...plan.listing.keys()], ["alpha", "gamma", "delta"]);
	// Removal safety is a runtime question (live holds), checked by the server, not by imports.
	assert.deepEqual(planPluginReload(previous, ["alpha", "beta"], listing, ["beta"]).plugins, ["alpha"]);
	assert.throws(
		() => planPluginReload(previous, ["alpha"], listing, ["gamma"]),
		/Cannot reload unloaded p2 plugin: gamma/,
	);
	assert.throws(() => planPluginReload(previous, ["alpha"], listing, ["missing"]), /Unknown p2 plugin: missing/);
});

test("runtime saves only mark restart-needed, and saves during a manual reload remain dirty", async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-mark-"));
	await mkdir(join(directory, "plugins/alpha"), { recursive: true });
	for (const name of ["hosts/web", "runtime"]) await mkdir(join(directory, "src", name), { recursive: true });
	await writeFile(join(directory, "plugins/alpha/server.ts"), "export default {};");
	const runtimeFile = join(directory, "src/runtime/shared.ts");
	await writeFile(runtimeFile, "// loaded backend");
	const loadedModules = new LoadedModules();
	loadedModules.set("server", [{ file: runtimeFile, hash: contentHash("// loaded backend") }]);
	const gate = Promise.withResolvers<void>();
	let calls = 0;
	const watcher = watchPlugins({
		directory: join(directory, "plugins"),
		runtimeDirectory: directory,
		loadedModules,
		plugins: () => ["alpha"],
		quietMs: 20,
		reload: async () => {
			calls++;
			await gate.promise;
			return { plugins: ["alpha"], value: undefined };
		},
	});
	try {
		// Files no process loaded (nor any bundle recorded) do not count.
		await writeFile(join(directory, "src/hosts/web/Notice.tsx"), "// not loaded");
		await writeFile(join(directory, "src/runtime/web.tsx"), "// not loaded");
		await delay(100);
		assert.equal(watcher.status().restartNeeded, false);
		await appendFile(join(directory, "plugins/alpha/server.ts"), "\n// first");
		await poll(() => watcher.status().dirty.includes("alpha"));
		const applying = watcher.reload();
		await poll(() => calls === 1);
		await appendFile(join(directory, "plugins/alpha/server.ts"), "\n// second");
		await delay(100);
		gate.resolve();
		await applying;
		assert.deepEqual(
			watcher.status().dirty,
			["alpha"],
			"A save made during prepare is not acknowledged by that commit",
		);
		await delay(100);
		assert.equal(calls, 1);
		await watcher.reload();
		assert.deepEqual(watcher.status().dirty, []);
		await writeFile(join(directory, "src/hosts/tui-unloaded.ts"), "// not loaded by the server");
		assert.equal(watcher.status().restartNeeded, false);
		await writeFile(runtimeFile, "// edited backend");
		await poll(() => watcher.status().restartNeeded);
		assert.deepEqual(watcher.status().restartFiles, ["src/runtime/shared.ts"]);
		await writeFile(runtimeFile, "// loaded backend");
		assert.equal(watcher.status().restartNeeded, false);
		assert.deepEqual(watcher.status().restartFiles, []);
		await delay(100);
		assert.equal(calls, 2, "Runtime saves cannot invoke a plugin reload or a restart");
	} finally {
		gate.resolve();
		await watcher.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"manual button/CLI reloads are atomic during streaming; explicit restarts preserve workers and inputs",
	{ timeout: 120_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-dev-"));
		const project = join(directory, "apps/p2");
		await mkdir(join(project, "scripts"), { recursive: true });
		for (const name of ["src", "plugins", "public", "vendor"])
			await cp(new URL(`../../${name}`, import.meta.url), join(project, name), { recursive: true });
		for (const name of ["package.json", "tsconfig.json"])
			await copyFile(new URL(`../../${name}`, import.meta.url), join(project, name));
		for (const script of ["dev.mjs", "reload.mjs"])
			await copyFile(new URL(`../../scripts/${script}`, import.meta.url), join(project, "scripts", script));
		await symlink(new URL("../../node_modules", import.meta.url).pathname, join(project, "node_modules"));
		for (const name of ["packages", "node_modules", "tsconfig.json", "tsconfig.base.json"])
			await symlink(new URL(`../../../../${name}`, import.meta.url).pathname, join(directory, name));
		const probeDirectory = join(project, "plugins/dev-probe");
		await mkdir(join(probeDirectory, "nested"), { recursive: true });
		await writeFile(join(probeDirectory, "contract.ts"), contractSource);
		await writeFile(join(probeDirectory, "style.css"), ":root { --dev-probe: 1; }");
		await writeFile(join(probeDirectory, "web.tsx"), webFacet);
		const removable = join(project, "plugins/dev-removable");
		await mkdir(join(removable, "nested"), { recursive: true });
		await writeFile(
			join(removable, "contract.ts"),
			contractSource.replaceAll("test.dev-probe", "test.dev-removable"),
		);
		await writeFile(join(removable, "nested/label.ts"), 'export const label = "removable-plugin";');
		for (const kind of ["server", "worker"])
			await writeFile(join(removable, `${kind}.ts`), lifecycleFacet(directory, "removable", "/__dev_removable"));
		for (const kind of ["server", "worker"]) await writeFile(join(probeDirectory, `${kind}.ts`), facetSource);
		await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "original";');
		const chatInput = join(project, "plugins/chat/dev-input.ts");
		await writeFile(chatInput, "export const input = (text: string) => text;");
		const chatWorker = join(project, "plugins/chat/worker.ts");
		await writeFile(
			chatWorker,
			`import { input } from "./dev-input.ts";\n${(await readFile(chatWorker, "utf8")).replace("await content(text, files", "await content(input(text), files")}`,
		);
		const child = spawn(process.execPath, ["--import", "./src/source.ts", "scripts/dev.mjs"], {
			cwd: project,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PORT: "0",
				P2_FAKE: "1",
				P2_RADIUS: "0",
				P2_DATA_DIR: join(directory, "data"),
				P2_DEV_RESUME: "[]",
				P2_ALLOWED_HOSTS: "dev.p2.test",
				P2_PUBLIC_URL: "https://dev.p2.test",
			},
		});
		let log = "";
		child.stdout.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		const ports = () => [...log.matchAll(/p2: http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => Number(match[1]));
		let browser: Host | undefined;
		let page: Browser | undefined;
		try {
			await poll(() => ports().length === 1, 30_000, "initial server");
			const port = ports()[0]!;
			const devState = async () => JSON.parse((await http(ports().at(-1)!, "/__p2_dev")).body) as DevStatus;
			const button = (command: DevCommand) =>
				http(ports().at(-1)!, "/__p2_dev", {
					method: "POST",
					headers: { Origin: `http://127.0.0.1:${ports().at(-1)!}`, "Content-Type": "application/json" },
					body: JSON.stringify(command),
				});
			const cli = (args: string[] = []): Promise<{ code: number; output: string }> =>
				new Promise((resolve, reject) => {
					const command = spawn("npm", ["run", "reload", "--", ...args], {
						cwd: project,
						env: { ...process.env, P2_DATA_DIR: join(directory, "data") },
						stdio: ["ignore", "pipe", "pipe"],
					});
					let output = "";
					command.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					command.stderr.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					command.on("error", reject);
					command.on("close", (code) => resolve({ code: code ?? 1, output }));
				});
			assert.equal((await stat(join(directory, "data/dev.sock"))).mode & 0o777, 0o600);
			// New/unloaded files do not count, and a loaded runtime edit disappears on exact-content revert.
			assert.equal((await devState()).restartNeeded, false);
			await writeFile(join(project, "src/hosts/unloaded-dev-fixture.ts"), "export const unused = true;");
			await delay(150);
			assert.equal((await devState()).restartNeeded, false);
			const loadedRuntime = join(project, "src/runtime/principals.ts");
			const loadedContent = await readFile(loadedRuntime, "utf8");
			await writeFile(loadedRuntime, `${loadedContent}\n// loaded runtime edit\n`);
			await poll(async () => (await devState()).restartFiles.includes("src/runtime/principals.ts"));
			await writeFile(loadedRuntime, loadedContent);
			await poll(async () => !(await devState()).restartNeeded);
			browser = connect(port);
			const sessions = await holdIn(browser, Sessions, {}, "owner");
			const first = await sessions.create({ cwd: directory });
			const second = await sessions.create({ cwd: directory });
			const unseen = browser.hold(Probe, { session: second.id });
			assert.equal(await unseen.label(), "original");
			const secondPid = await unseen.pid();
			unseen.release();
			const chat = await holdIn(browser, Chat, { session: first.id, conversation: 1 }, "participant");
			const serverProbe = browser.hold(ServerProbe, {});
			const workerProbe = browser.hold(Probe, { session: first.id });
			assert.equal(await workerProbe.label(), "original");
			const firstPid = await workerProbe.pid();
			// The server does not import the worker entry; this baseline must come from worker IPC metadata.
			const workerEntry = join(project, "src/hosts/worker.ts");
			const workerContent = await readFile(workerEntry, "utf8");
			await appendFile(workerEntry, "\n// loaded worker entry edit\n");
			await poll(async () => (await devState()).restartFiles.includes("src/hosts/worker.ts"));
			await writeFile(workerEntry, workerContent);
			await poll(async () => !(await devState()).restartNeeded);
			const status = await holdIn(browser, SessionStatus, {}, "reader");
			await until(status.statuses, (value) => Boolean(value?.[first.id]?.running && value?.[second.id]?.running));
			await chat.send({ text: "slow reload-stream-sentinel", requestId: "reload-stream" });
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			let publications = 0;
			const stopView = chat.view.subscribe(() => publications++);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "updated";');
			await writeFile(chatInput, 'export const input = (text: string) => text + " switched-code";');
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			await delay(250);
			assert.equal(await serverProbe.label(), "original", "Saving does not apply code");
			assert.equal(await workerProbe.label(), "original");
			assert.equal((await button({ action: "reload" })).status, 200);
			assert.match((await devState()).message ?? "", /Reloaded.*dev-probe/);
			assert.deepEqual((await devState()).dirty, []);
			assert.equal(await serverProbe.label(), "updated");
			assert.equal(await workerProbe.label(), "updated");
			assert(publications > 2, "stream kept publishing through reload");
			assert.equal(await workerProbe.pid(), firstPid);
			assert(
				(await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true))?.[first.id]
					?.running,
			);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("reload-stream-sentinel"),
					),
				),
			);
			stopView();
			await chat.send({ text: "code-switch-sentinel", requestId: "code-switch" });
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" &&
							JSON.stringify(entry.model).includes("code-switch-sentinel switched-code"),
					),
				),
			);

			// A valid server candidate and a syntactically broken worker must commit neither side.
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-refusal";');
			await writeFile(join(probeDirectory, "worker.ts"), `${facetSource}\nthis is broken TypeScript !!!`);
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			const failedCommand = await cli();
			assert.equal(failedCommand.code, 1);
			assert.match(failedCommand.output, /Reload refused/);
			assert.equal((await devState()).phase, "error");
			assert((await devState()).dirty.includes("dev-probe"));
			assert(log.includes("Reload refused"));
			assert.equal(await serverProbe.label(), "updated");
			assert.equal(await workerProbe.label(), "updated");
			await writeFile(join(probeDirectory, "worker.ts"), facetSource);
			const fixedCommand = await cli(["dev-probe"]);
			assert.equal(fixedCommand.code, 0, fixedCommand.output);
			assert.match(fixedCommand.output, /Reloaded dev-probe/);
			assert.deepEqual((await devState()).dirty, []);
			assert.equal(await workerProbe.label(), "after-refusal");
			assert.equal(await serverProbe.label(), "after-refusal");
			// A broken web facet refuses the whole reload too: no backend change commits and the old bundle stays served.
			const servedBundle = await webBundle(port);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-web-refusal";');
			await writeFile(join(probeDirectory, "web.tsx"), `${webFacet}\nthis is broken TypeScript !!!`);
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			const webRefusal = await cli();
			assert.equal(webRefusal.code, 1);
			assert.match(webRefusal.output, /Reload refused/);
			assert.equal(await serverProbe.label(), "after-refusal");
			assert.equal(await workerProbe.label(), "after-refusal");
			assert.deepEqual(await webBundle(port), servedBundle);
			assert.equal((await http(port, servedBundle.script)).status, 200);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-refusal";');
			await writeFile(join(probeDirectory, "web.tsx"), webFacet);
			assert.equal((await cli(["dev-probe"])).code, 0);
			assert.equal(ports().length, 1, "plugin saves never recycle the server");

			// A remote owner (proxy + cookie).
			const invitation = JSON.parse((await http(port, "/owner-token")).body) as { token: string };
			const associated = await http(port, "/owner/claim", {
				method: "POST",
				headers: {
					Host: "dev.p2.test",
					Origin: "https://dev.p2.test",
					"X-P2-Proxy-Secret": "1",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(invitation),
			});
			assert.equal(associated.status, 200);
			const cookie = String(associated.headers["set-cookie"]).split(";")[0]!;
			const headers = { Host: "dev.p2.test", "X-P2-Proxy-Secret": "1", Cookie: cookie };
			const original = (await webBundle(port, headers)).script;
			assert.equal((await http(port, "/__p2_dev", { headers: { Host: "dev.p2.test" } })).status, 403);
			assert.equal(
				(await http(port, "/__p2_dev", { method: "POST", body: JSON.stringify({ action: "reload" }) })).status,
				403,
				"Button API requires same-origin POST",
			);
			assert.equal(
				(await http(port, "/dev.sock", { method: "POST", headers, body: JSON.stringify({ action: "reload" }) }))
					.status,
				404,
				"CLI channel is not a public route",
			);
			const missing = await cli(["missing-plugin"]);
			assert.equal(missing.code, 1);
			assert.match(missing.output, /Unknown p2 plugin/);
			assert.deepEqual((await devState()).dirty, []);

			// Browser runtime files are bundle inputs: an edit asks for a restart (or the next reload), never applies.
			const style = join(project, "src/web/style.css");
			const styleContent = await readFile(style, "utf8");
			await appendFile(style, "\n/* runtime web edit */\n");
			await poll(async () => (await devState()).restartFiles.includes("src/web/style.css"));
			await writeFile(style, styleContent);
			await poll(async () => !(await devState()).restartNeeded);
			// A plugin's web edit marks it dirty; its reload makes a new bundle current, retains old files for in-flight
			// pages, and an open page polls the manifest and reloads onto the new one.
			if (browserTests) {
				page = await Browser.start();
				await page.open(`http://127.0.0.1:${port}/`);
				await page.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
				await page.evaluate(`window.beforeReload = true`);
			}
			await appendFile(join(probeDirectory, "web.tsx"), "\nconsole.log('web edit');\n");
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			assert.equal((await webBundle(port, headers)).script, original, "Saving does not rebuild");
			assert.equal((await button({ action: "reload" })).status, 200);
			const updated = (await webBundle(port, headers)).script;
			assert.notEqual(updated, original);
			assert.equal((await http(port, original, { headers })).status, 200);
			await page?.wait(
				`window.beforeReload === undefined && document.querySelector('script[type=module]')?.getAttribute('src') === ${JSON.stringify(updated)}`,
			);

			// CSS is a separate output: its edit keeps the script name but changes the complete manifest version, which
			// must still reload an open page.
			const beforeCss = await webBundle(port, headers);
			await page?.evaluate(`window.beforeCssReload = true`);
			await writeFile(join(probeDirectory, "style.css"), ":root { --dev-probe: 2; }");
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			assert.equal((await button({ action: "reload" })).status, 200);
			const afterCss = await webBundle(port, headers);
			assert.notEqual(afterCss.version, beforeCss.version);
			assert.equal(afterCss.script, beforeCss.script);
			assert.notEqual(afterCss.style, beforeCss.style);
			await page?.wait(
				`window.beforeCssReload === undefined && document.documentElement.dataset.webVersion === ${JSON.stringify(afterCss.version)}`,
			);
			await page?.close();
			page = undefined;
			assert.equal(ports().length, 1);
			const afterSave = async (revision: number, phase = "ready") => {
				await poll(async () => {
					const state = await devState();
					return state.revision > revision && state.dirty.length > 0;
				});
				const result = await button({ action: "reload" });
				assert.equal(result.status, phase === "error" ? 409 : 200, result.body);
				assert.equal((await devState()).phase, phase);
			};
			const Removable = probes("test.dev-removable");
			const removedServer = browser.hold(Removable.server, {});
			const removedWorker = browser.hold(Removable.worker, { session: first.id });
			const removedUnseen = browser.hold(Removable.worker, { session: second.id });
			const serverPid = await removedServer.pid();
			const removedPid = await removedWorker.pid();
			assert.equal(await removedUnseen.label(), "removable-plugin");
			assert.equal((await http(port, "/__dev_removable")).body, "removable");
			await chat.send({ text: "slow plugin-removal-sentinel", requestId: "plugin-removal" });
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			let revision = (await devState()).revision;
			await rm(removable, { recursive: true });
			await afterSave(revision);
			await poll(() => [removedServer, removedWorker, removedUnseen].every((ref) => ref.status === "gone"));
			assert.equal((await http(port, "/__dev_removable")).status, 404, "registration was removed");
			for (const pid of [serverPid, removedPid, secondPid])
				await poll(
					async () =>
						(await readFile(join(directory, `removable-disposed-${pid}`), "utf8").catch(() => "")) === "closed",
				);
			assert.equal(await workerProbe.pid(), firstPid);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("plugin-removal-sentinel"),
					),
				),
			);
			const afterRemoval = await sessions.create({ cwd: directory });
			const removalChat = await holdIn(browser, Chat, { session: afterRemoval.id, conversation: 1 }, "participant");
			await removalChat.send({ text: "after-removal", requestId: "after-removal" });
			await until(removalChat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("after-removal"),
					),
				),
			);

			await chat.send({ text: "slow plugin-addition-sentinel", requestId: "plugin-addition" });
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			revision = (await devState()).revision;
			const addedDirectory = join(project, "plugins/dev-added");
			await mkdir(join(addedDirectory, "nested"), { recursive: true });
			await writeFile(
				join(addedDirectory, "contract.ts"),
				contractSource.replaceAll("test.dev-probe", "test.dev-added"),
			);
			await writeFile(join(addedDirectory, "nested/label.ts"), 'export const label = "added-plugin";');
			for (const kind of ["server", "worker"])
				await writeFile(join(addedDirectory, `${kind}.ts`), lifecycleFacet(directory, "added", "/__dev_added"));
			await afterSave(revision);
			const Added = probes("test.dev-added");
			const addedServer = browser.hold(Added.server, {});
			const addedWorker = browser.hold(Added.worker, { session: first.id });
			assert.equal(await addedServer.label(), "added-plugin");
			assert.equal(await addedWorker.label(), "added-plugin");
			assert.equal(await browser.hold(Added.worker, { session: second.id }).label(), "added-plugin");
			assert.equal((await http(port, "/__dev_added")).body, "added", "new host object activated");
			assert.equal(await workerProbe.pid(), firstPid);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("plugin-addition-sentinel"),
					),
				),
			);
			const afterAddition = await sessions.create({ cwd: directory });
			assert.equal(await browser.hold(Added.worker, { session: afterAddition.id }).label(), "added-plugin");

			// A live hold by a dependent makes removal fail before any host commits. Dropping the hold retries the batch.
			const dependent = join(project, "plugins/dev-dependent");
			revision = (await devState()).revision;
			await mkdir(dependent);
			await writeFile(
				join(dependent, "server.ts"),
				`import { local } from "@earendil-works/chord";
import { obj } from "@earendil-works/pi-schema";
import { defineFacet } from "../../src/runtime/chord.ts";
import { ServerProbe } from "../dev-added/contract.ts";
const Holder = local("test.dev-dependent.holder", { version: 1, input: obj({}, { open: true }) });
export default defineFacet(host => host.serve(Holder, (_input, _principal, self) => { self.get(ServerProbe, {}); return {}; }, { lifetime: "host" }));`,
			);
			await afterSave(revision);
			revision = (await devState()).revision;
			await rm(addedDirectory, { recursive: true });
			await afterSave(revision, "error");
			assert.match(
				(await devState()).message ?? "",
				/Cannot remove p2 plugin dev-added: plugin dev-dependent still holds test\.dev-added-server \(server\)/,
			);
			assert.equal(await addedServer.label(), "added-plugin");
			assert.equal(await addedWorker.label(), "added-plugin");
			assert.equal((await http(port, "/__dev_added")).status, 200);
			revision = (await devState()).revision;
			await writeFile(join(dependent, "server.ts"), emptyFacet);
			await afterSave(revision);
			await poll(() => addedServer.status === "gone" && addedWorker.status === "gone");
			assert.equal((await http(port, "/__dev_added")).status, 404);
			assert.equal(ports().length, 1, "add/remove never restarts the backend");
			assert(!log.includes("Unknown p2 plugin: dev-removable"));
			await chat.send({ text: "slow restart-stream-sentinel", requestId: "restart-stream" });
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await appendFile(join(project, "src/runtime/loopback-cookie.ts"), "\n// restart runtime\n");
			await poll(async () => (await devState()).restartNeeded);
			await delay(700);
			assert.equal(ports().length, 1, "Runtime saves never restart automatically");
			assert.equal(await workerProbe.pid(), firstPid);
			const restarted = await cli(["--restart"]);
			assert.equal(restarted.code, 0, restarted.output);
			assert.match(restarted.output, /Restarted server/);
			await poll(() => ports().length === 2, 30_000, "replacement server");
			await poll(async () => (await devState()).message === "Restarted server");
			assert.equal((await devState()).restartNeeded, false, JSON.stringify((await devState()).restartFiles));
			await browser.close();
			browser = connect(ports()[1]!);
			const restored = await holdIn(browser, SessionStatus, {}, "reader");
			// Check running state before making any worker hold: this must not spawn the unseen session on demand.
			await until(restored.statuses, (value) => Boolean(value?.[first.id]?.running && value?.[second.id]?.running));
			for (const [session, pid] of [
				[first, firstPid],
				[second, secondPid],
			] as const) {
				const probe = browser.hold(Probe, { session: session.id });
				assert.notEqual(await probe.pid(), pid);
				probe.release();
			}
			const resumed = await holdIn(browser, Chat, { session: first.id, conversation: 1 }, "participant");
			const completed = await until(resumed.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("restart-stream-sentinel"),
					),
				),
			);
			assert.equal(
				completed?.entries.filter((entry) => entry.kind === "p2.input").length,
				5,
				"restart never resubmits input",
			);
			assert(log.includes("preserving 4 running workers"));
			await appendFile(join(project, "src/hosts/web.ts"), "\n// backend web server restart\n");
			await poll(async () => (await devState()).restartNeeded);
			await delay(500);
			assert.equal(ports().length, 2);
			// The button starts the same supervised path; the old HTTP connection closes during shutdown.
			const fromButton = button({ action: "restart" }).catch(() => undefined);
			await poll(() => ports().length === 3, 30_000);
			await fromButton;
			await poll(async () => (await devState()).message === "Restarted server");
			child.kill("SIGUSR2");
			await poll(() => ports().length === 4, 30_000);
			await poll(async () => (await devState()).message === "Restarted server");
			// Startup refusal reaches the CLI through the supervisor's socket, which survives a failed child.
			const runtimeFile = join(project, "src/runtime/loopback-cookie.ts");
			const validRuntime = await readFile(runtimeFile, "utf8");
			await writeFile(runtimeFile, `${validRuntime}\nthis is broken runtime code !!!\n`);
			await poll(async () => (await devState()).restartNeeded);
			const failedRestart = await cli(["--restart"]);
			assert.equal(failedRestart.code, 1);
			assert.match(failedRestart.output, /Restart refused/);
			await writeFile(runtimeFile, validRuntime);
			await delay(500);
			assert.equal(ports().length, 4, "Fixing source after a failed restart does not retry automatically");
			const recovered = await cli(["--restart"]);
			assert.equal(recovered.code, 0, recovered.output);
			await poll(() => ports().length === 5, 30_000);
		} catch (error) {
			console.error(log);
			throw error;
		} finally {
			await browser?.close();
			await page?.close();
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, "close");
				child.kill("SIGTERM");
				await closed;
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a forced dev restart reaps locked workers before resuming their stores", { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-forced-restart-"));
	const project = join(directory, "apps/p2");
	const dataDir = join(directory, "data");
	await mkdir(join(project, "scripts"), { recursive: true });
	for (const name of ["src", "plugins", "public", "vendor"])
		await cp(new URL(`../../${name}`, import.meta.url), join(project, name), { recursive: true });
	for (const name of ["package.json", "tsconfig.json"])
		await copyFile(new URL(`../../${name}`, import.meta.url), join(project, name));
	await copyFile(new URL("../../scripts/dev.mjs", import.meta.url), join(project, "scripts/dev.mjs"));
	await symlink(new URL("../../node_modules", import.meta.url).pathname, join(project, "node_modules"));
	for (const name of ["packages", "node_modules", "tsconfig.json", "tsconfig.base.json"])
		await symlink(new URL(`../../../../${name}`, import.meta.url).pathname, join(directory, name));

	// The old server misses its shutdown deadline before SessionHosts.close, and its worker ignores IPC disconnect.
	// This reproduces a detached lock owner that only the supervisor can reap.
	const serverEntry = join(project, "src/hosts/server.ts");
	await writeFile(
		serverEntry,
		(await readFile(serverEntry, "utf8"))
			.replace('import { mkdirSync } from "node:fs";', 'import { existsSync, mkdirSync, rmSync } from "node:fs";')
			.replace(
				"\t\t\t\tawait hosts.close();",
				'\t\t\t\tif (existsSync(join(dataDir, "test-hang-close"))) { rmSync(join(dataDir, "test-hang-close")); await new Promise<void>(() => {}); }\n\t\t\t\tawait hosts.close();',
			),
	);
	const workerEntry = join(project, "src/hosts/worker.ts");
	await writeFile(
		workerEntry,
		(await readFile(workerEntry, "utf8")).replace('process.once("disconnect", () => void stop());', ""),
	);
	const probeDirectory = join(project, "plugins/dev-probe");
	await mkdir(join(probeDirectory, "nested"), { recursive: true });
	await writeFile(join(probeDirectory, "contract.ts"), contractSource);
	await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "forced-restart";');
	await writeFile(join(probeDirectory, "worker.ts"), facetSource);

	const environment = {
		...process.env,
		PORT: "0",
		P2_FAKE: "1",
		P2_RADIUS: "0",
		P2_DATA_DIR: dataDir,
		P2_DEV_RESUME: "[]",
	};
	const child = spawn(process.execPath, ["--import", "./src/source.ts", "scripts/dev.mjs"], {
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
		env: environment,
	});
	let log = "";
	child.stdout.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	const ports = () => [...log.matchAll(/p2: http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => Number(match[1]));
	let browser: Host | undefined;
	let oldWorkerPid: number | undefined;
	try {
		await poll(() => ports().length === 1, 30_000, "initial server");
		browser = connect(ports()[0]!);
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: directory });
		const probe = browser.hold(Probe, { session: session.id });
		const oldPid = await probe.pid();
		oldWorkerPid = oldPid;
		const chat = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "forced-restart-persisted", requestId: "forced-restart" });
		await until(chat.view, (value) =>
			Boolean(value?.entries.some((entry) => JSON.stringify(entry.model).includes("forced-restart-persisted"))),
		);

		// An unrelated server never waits for or steals a live data-directory lock.
		const contender = spawn(process.execPath, ["--import", "./src/source.ts", "src/hosts/server.ts"], {
			cwd: project,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...environment, P2_DEV: "0" },
		});
		let contenderLog = "";
		contender.stdout.on("data", (chunk: Buffer) => {
			contenderLog += chunk.toString();
		});
		contender.stderr.on("data", (chunk: Buffer) => {
			contenderLog += chunk.toString();
		});
		const [code] = (await once(contender, "close")) as [number | null];
		assert.notEqual(code, 0);
		assert.match(contenderLog, /lock p2:server:.* is held by another process/);

		await writeFile(join(dataDir, "test-hang-close"), "hang once");
		child.kill("SIGUSR2");
		await poll(() => ports().length === 2, 30_000, "replacement server");
		await browser.close();
		browser = connect(ports()[1]!);
		const replacement = browser.hold(Probe, { session: session.id });
		assert.notEqual(await replacement.pid(), oldPid);
		await poll(
			() => {
				try {
					process.kill(oldPid, 0);
					return false;
				} catch {
					return true;
				}
			},
			5000,
			"old worker process exit",
		);
		const restored = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
		const view = await until(restored.view, (value) =>
			Boolean(value?.entries.some((entry) => JSON.stringify(entry.model).includes("forced-restart-persisted"))),
		);
		assert.equal(view?.entries.filter((entry) => entry.kind === "p2.input").length, 1);
		assert.doesNotMatch(log, /cannot resume .*locked/);
	} catch (error) {
		console.error(log);
		throw error;
	} finally {
		await browser?.close();
		if (child.exitCode === null && child.signalCode === null) {
			const closed = once(child, "close");
			child.kill("SIGTERM");
			await closed;
		}
		if (oldWorkerPid !== undefined) {
			try {
				process.kill(-oldWorkerPid, "SIGKILL");
			} catch {
				// The fixed supervisor already reaped it.
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
});
