import { defineFacet } from "../../src/runtime/chord.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { conversationRoute, Slots, useNavigation, useRoute } from "../../src/runtime/web.tsx";

function ParentLink() {
	const nav = useNavigation();
	const route = useRoute();
	if (!route.session || (route.conversation ?? 1) === 1) return null;
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => void nav.backOrPush(conversationRoute(route, route.session))}
		>
			Back to main conversation
		</button>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-subagents", (self) => {
		self.register(Slots, { "chat-parent": ParentLink });
	});
});
