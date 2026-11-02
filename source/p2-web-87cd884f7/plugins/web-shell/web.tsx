// App layout: the sidebar and main slots, the drawer on phones, Back/Forward navigation.

import { useEffect } from "react";
import { defineFacet } from "../../src/runtime/chord.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { closeLayers, getNavigation, NavigationContext, Slots, startNavigation } from "../../src/runtime/web.tsx";
import { AppLayout } from "../../src/web/AppLayout.tsx";
import { ComposerState } from "../../src/web/composer-state.tsx";
import { NewSessionState } from "../../src/web/new-session.tsx";

function App() {
	const nav = getNavigation();
	useEffect(() => startNavigation(), []);
	useEffect(() => {
		const wide = window.matchMedia("(min-width: 900px)");
		const change = () => {
			if (wide.matches && nav.route.layers.at(-1)?.kind === "drawer") closeLayers();
		};
		change();
		wide.addEventListener("change", change);
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && nav.route.layers.at(-1)?.kind === "drawer") {
				event.preventDefault();
				closeLayers();
			}
		};
		window.addEventListener("keydown", key);
		return () => {
			wide.removeEventListener("change", change);
			window.removeEventListener("keydown", key);
		};
	}, [nav]);
	return (
		<NavigationContext.Provider value={nav}>
			<NewSessionState>
				<ComposerState>
					<AppLayout />
				</ComposerState>
			</NewSessionState>
		</NavigationContext.Provider>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-shell", (self) => {
		self.register(Slots, { app: App });
	});
});
