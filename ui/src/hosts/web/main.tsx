// Browser host: a chord2 client host over a WebSocket to the server, the selected plugins' web facets, a React root.
// The server bundles it with those facets (src/hosts/bundles.ts), whose generated entry calls `startWeb`.
import { createRoot } from "react-dom/client";
import "../../web/style.css";
import { type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import { Access } from "../../runtime/access.ts";
import { CLIENT_LINGER, createHost, type FacetDefinition } from "../../runtime/chord.ts";
import { HOST, principalKey, SERVER } from "../../runtime/principals.ts";
import { HostContext, Slot, setConnected, setShareEnded } from "../../runtime/web.tsx";
import { browserEnvironment, keepConnected } from "../../web/reconnect.ts";
import { startTheme } from "../../web/theme.ts";

/**
 * Pi Mobile closes an ended share's socket with 1008; chord2 links carry no such code, so a guest's page asks its
 * own server: an admitted guest gets the page, an ended share's cookie a sign-in refusal (401/403). Unreachable
 * (offline, a restart): not ended, keep reconnecting.
 */
const shareHasEnded = (): Promise<boolean> =>
	fetch("/", { method: "HEAD", cache: "no-store", credentials: "same-origin" }).then(
		(response) => response.status === 401 || response.status === 403,
		() => false,
	);

/** Starts the page with the web facets the server selected, in plugin load order. */
export function startWeb(facets: readonly (readonly [string, FacetDefinition])[]): void {
	const host = createHost({
		name: "browser",
		kind: "client",
		self: HOST,
		principalKey,
		linger: CLIENT_LINGER,
		onError: (error) => console.error(error),
	});
	/** Whether this page is a guest's (from its Access object); a guest's ended share stops the reconnects. */
	let guest = false;
	/** Set once the server speaks a newer link protocol: this page's code is outdated and is being reloaded. */
	let outdated = false;

	/**
	 * Connects (and after a drop, reconnects) upstream; remote references re-hold over the new link. A newer server
	 * reloads this outdated page. An older server gets reconnects with backoff instead of a protocol-triggered loop.
	 */
	keepConnected({
		open: (events) => {
			const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/chord`);
			socket.addEventListener("open", () => events.opened());
			socket.addEventListener("message", () => events.received());
			socket.addEventListener("close", (event) => events.closed(event.code, event.reason, event.wasClean));
			const link = webSocketLink(socket as unknown as WebSocketLike);
			host.connect(link, {
				principal: SERVER,
				onProtocolMismatch: ({ local, peer }) => {
					if (peer === undefined || peer < local) return;
					outdated = true;
					location.reload();
				},
			});
			return link;
		},
		onConnected: setConnected,
		canRetry: async () => {
			if (outdated) return false;
			if (!guest || !(await shareHasEnded())) return true;
			setShareEnded(true);
			return false;
		},
		environment: browserEnvironment("connection"),
	});
	const access = host.hold(Access, {});
	void access.ready.then(
		() => {
			guest = access.variant === "guest";
		},
		() => {},
	);

	// One web bundle is current. While visible, poll its no-store manifest; another complete manifest version (including
	// a CSS-only change) means a plugin reload or restart with changed code, so replace the whole page.
	const running = document.documentElement.dataset.webVersion;
	if (!running) throw new Error("Missing web bundle version");
	let checkingBundle = false;
	const reloadIfStale = async (): Promise<void> => {
		if (checkingBundle) return;
		checkingBundle = true;
		try {
			const response = await fetch("/__p2_web", { cache: "no-store", credentials: "same-origin" });
			if (!response.ok) return;
			const manifest: unknown = await response.json();
			if (
				typeof manifest === "object" &&
				manifest !== null &&
				"version" in manifest &&
				typeof manifest.version === "string" &&
				manifest.version !== running
			)
				location.reload();
		} catch {
			// Offline or restarting: the Chord link handles reconnection, and the next poll tries again.
		} finally {
			checkingBundle = false;
		}
	};
	setInterval(() => {
		if (document.visibilityState === "visible") void reloadIfStale();
	}, 5000);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void reloadIfStale();
	});

	// The app starts without the network once it was opened (public/sw.js); conversations are kept separately.
	if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});

	for (const [name, facet] of facets) host.install({ name, ...facet });
	startTheme();
	const element = document.getElementById("root");
	if (!element) throw new Error("Missing application root");
	createRoot(element).render(
		<HostContext.Provider value={host}>
			<Slot name="app" fallback={<div className="hero">Loading…</div>} />
		</HostContext.Provider>,
	);
}
