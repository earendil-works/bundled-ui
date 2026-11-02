// Native catalog operations beneath the copied mobile Session sheet.
import {
	closeLayers,
	conversationRoute,
	openLayer,
	useNavigation,
	useObject,
	useReadable,
	useRoute,
	useSheet,
} from "../../src/runtime/web.tsx";
import { useComposerState } from "../../src/web/composer-state.tsx";
import { MoreIcon } from "../../src/web/icons.tsx";
import { SessionSheet } from "../../src/web/SessionSheet.tsx";
import { directoryPickerLayer } from "../envs/DirectoryPicker.tsx";
import { Sessions } from "./contract.ts";
export function SessionOptions() {
	const nav = useNavigation(),
		route = useRoute();
	const service = useObject(Sessions, {}, { variant: "owner" }),
		rows = useReadable(service?.sessions);
	const session = rows?.find((row) => row.id === route.session),
		sessionSheet = useSheet("session");
	const { setError } = useComposerState();
	const perform = (operation: Promise<unknown> | undefined) =>
		void operation?.catch((error) => setError(error instanceof Error ? error.message : String(error)));
	if (!service || !session || route.conversation !== 1) return null;
	return (
		<>
			<button
				type="button"
				className="icon-button"
				aria-label="Session options"
				onClick={() => openLayer({ kind: "sheet", name: "session" })}
			>
				<MoreIcon />
			</button>
			{sessionSheet && (
				<SessionSheet
					session={session}
					onClose={closeLayers}
					onRename={(title) => perform(service?.rename({ id: session.id, title }))}
					onPin={() => perform(service?.pin({ id: session.id, pinned: !session.pinned }))}
					onShare={() => openLayer({ kind: "sheet", name: "share" })}
					onCwd={() => openLayer(directoryPickerLayer(session.env ?? null, session.cwd))}
					onArchive={() => {
						closeLayers();
						void nav.replace(conversationRoute(route, undefined));
						perform(service?.archive({ id: session.id }));
					}}
				/>
			)}
		</>
	);
}
