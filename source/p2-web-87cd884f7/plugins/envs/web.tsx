import { defineFacet } from "../../src/runtime/chord.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { closeLayers, openLayer, Slots, useOwner, useSheet } from "../../src/runtime/web.tsx";
import { EnvsPanel } from "./EnvsPanel.tsx";

function EnvsButton() {
	const sheet = useSheet("envs");
	if (!useOwner()) return null;
	return (
		<>
			<button
				className="foot-button"
				type="button"
				onClick={() => openLayer({ kind: "sheet", name: "envs" }, { fromDrawer: true })}
				title="Remote environments"
			>
				Envs
			</button>
			{sheet && <EnvsPanel env={sheet.locator} onClose={closeLayers} />}
		</>
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-envs", (self) => {
		self.register(Slots, { "sidebar-foot:envs": EnvsButton });
	});
});
