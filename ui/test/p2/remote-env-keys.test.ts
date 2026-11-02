import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Ref } from "@earendil-works/chord";
import { Devices } from "../../plugins/devices/contract.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import { PROXY_MARKER_HEADER } from "../../plugins/proxy-marker/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { expectChord, holdIn, http, startFixture, until, webBundle } from "./helpers.ts";

const hasKeygen = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
const TUNNEL = { Host: "keys.test", Origin: "https://keys.test" };
for (const via of ["token", "relay", "proxy"] as const)
	test(
		`remote ${via} owner may upload and generate SSH keys; guests cannot`,
		{ skip: hasKeygen ? false : "no ssh-keygen" },
		async (t) => {
			const fixture = await startFixture({
				allowedHosts: ["keys.test"],
				web: true,
			});
			t.after(() => fixture.close());
			const source = join(fixture.dataDir, "fixture-key");
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", source], { stdio: "ignore" });
			const key = await readFile(source, "utf8");
			const local = fixture.browser();
			let envs: Ref<typeof Envs>;
			if (via === "token" || via === "proxy") {
				const { token } = await local.hold(Devices, {}).token();
				const signedIn = await http(fixture.server.port, "/owner/claim", {
					headers: { ...TUNNEL, "Content-Type": "application/json" },
					method: "POST",
					body: JSON.stringify({ token }),
				});
				assert.equal(signedIn.status, 200);
				const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
				envs = fixture
					.client({ ...TUNNEL, Cookie: cookie, ...(via === "proxy" ? { [PROXY_MARKER_HEADER]: "1" } : {}) })
					.host.hold(Envs, {});
			} else {
				envs = fixture.server.host.hold(Envs, {}, { principal: { kind: "owner", access: "relay" } });
				t.after(() => envs.release());
			}
			await envs.save({ name: "box", config: { type: "ssh", host: "fixture.test" } });
			const stored = await envs.uploadKey({ name: "box", key });
			assert.match(stored.publicKey, /^ssh-ed25519 /);
			assert.equal(stored.identityFile, join(fixture.dataDir, "ssh", "keys", "box"));
			assert.equal(await readFile(stored.identityFile, "utf8"), key);
			assert.equal((await stat(stored.identityFile)).mode & 0o777, 0o600);
			const published = await until(
				envs.envs,
				(entries) => entries?.[0]?.config.identityFile === stored.identityFile,
			);
			assert(!JSON.stringify(published).includes("PRIVATE KEY"));
			await assert.rejects(envs.uploadKey({ name: "box", key: "invalid" }), /private key/i);
			await assert.rejects(envs.uploadKey({ name: "box", key: "PRIVATE KEY".repeat(2000) }));
			await assert.rejects(envs.uploadKey({ name: "../escape", key }), /name/i);
			const protectedKey = join(fixture.dataDir, "protected-key");
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "fixture-passphrase", "-f", protectedKey], {
				stdio: "ignore",
			});
			await assert.rejects(
				envs.uploadKey({ name: "box", key: await readFile(protectedKey, "utf8") }),
				/passphrase|valid/i,
			);
			assert.equal(await readFile(stored.identityFile, "utf8"), key);
			assert(!(await readdir(join(fixture.dataDir, "ssh", "keys"))).some((name) => name.startsWith(".upload-")));
			// Key generation and the public key are available to every owner too, as in Pi Mobile.
			const generated = await envs.generateKey({ name: "generated" });
			assert.match(generated.publicKey, /^ssh-ed25519 /);
			assert.equal(await envs.publicKey({ name: "generated" }), generated.publicKey);
			const session = await (await holdIn(local, Sessions, {}, "owner")).create({ cwd: fixture.workspace });
			const sharing = local.hold(Sharing, { session: session.id });
			await sharing.link({ mode: "full" });
			const links = await until(sharing.links, (value) => Boolean(value?.length));
			const joined = await http(fixture.server.port, "/join", {
				method: "POST",
				headers: { ...TUNNEL, "Content-Type": "application/json" },
				body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
			});
			assert.equal(joined.status, 200);
			const guest = fixture
				.client({ ...TUNNEL, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! })
				.host.hold(Envs, {});
			await expectChord(guest.ready, "forbidden");
			await expectChord(guest.uploadKey({ name: "guest", key }), "forbidden");
			await expectChord(guest.generateKey({ name: "guest" }), "forbidden");
			await expectChord(guest.publicKey({ name: "generated" }), "forbidden");
			const ui = await http(fixture.server.port, (await webBundle(fixture.server.port)).script);
			assert.equal(ui.status, 200);
			assert(ui.body.includes("Upload private key"));
			assert(!ui.body.includes("Generate/upload keys only on the device"));
		},
	);
