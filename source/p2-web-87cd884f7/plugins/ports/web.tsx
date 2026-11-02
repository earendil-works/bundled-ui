import { defineFacet } from "../../src/runtime/chord.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { closeLayers, openLayer, Slots, useOwner, useSheet } from "../../src/runtime/web.tsx";
import { ChevronIcon } from "../../src/web/icons.tsx";
import { PortsPanel } from "./PortsPanel.tsx";

function PortsButton() {
	return (
		<button className="row-button" type="button" onClick={() => openLayer({ kind: "sheet", name: "ports" })}>
			<span>Ports</span>
			<small className="row-value">Open dev servers through Radius</small>
			<ChevronIcon />
		</button>
	);
}
function PortsSheet() {
	const sheet = useSheet("ports");
	return useOwner() && sheet ? <PortsPanel onClose={closeLayers} /> : null;
}
export default defineFacet((host) => {
	contribute(host, "p2.web-ports", (self) => {
		self.register(Slots, { "envs-actions:ports": PortsButton, "sidebar-foot:ports": PortsSheet });
	});
});
