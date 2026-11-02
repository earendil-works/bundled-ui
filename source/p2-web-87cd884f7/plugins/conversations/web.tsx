import type { ReactNode } from "react";
import { defineFacet, inVariant } from "../../src/runtime/chord.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { navigate, Slots, useConnected, useObject, useReadable, useStatus } from "../../src/runtime/web.tsx";
import { OpenPeerConversation } from "../../src/web/Chat.tsx";
import { useComposerState } from "../../src/web/composer-state.tsx";
import { Sessions } from "../sessions/contract.ts";

function Attribution({ children }: { children?: ReactNode }) {
	const sessions = useObject(Sessions, {});
	const listed = useReadable(inVariant(sessions, "owner", "guest")?.sessions) ?? [];
	const owner = useStatus(sessions) === "live" ? inVariant(sessions, "owner") : undefined;
	// As Pi Mobile: peer labels link only while connected; errors go to the app's toast.
	const connected = useConnected();
	const { setError } = useComposerState();
	const open = (session: string): void => {
		const current = listed.find((entry) => entry.id === session);
		if (!current) {
			setError("The source conversation is unavailable");
			return;
		}
		if (current.archivedAt === null) navigate({ session });
		else
			void owner
				?.restore({ id: session })
				.then(() => navigate({ session }))
				.catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
	};
	return (
		<OpenPeerConversation.Provider value={owner && connected ? open : undefined}>
			{children}
		</OpenPeerConversation.Provider>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-conversations", (self) => {
		self.register(Slots, { "chat-attribution": Attribution });
	});
});
