// The web composer's expander for prompt templates and skills (p2-tui-port.md 10.8): `/name args` and
// `/skill:name args` are expanded on the session worker before a send, as in the TUI.
import { defineFacet } from "../../src/runtime/chord.ts";
import { ComposerExpanders } from "../../src/runtime/composer.ts";
import { contribute } from "../../src/runtime/contribute.ts";
import { PromptResources } from "./contract.ts";

export const promptComposer = defineFacet((host) =>
	contribute(host, "p2.web-prompt", (self) => {
		self.register(ComposerExpanders, {
			prompt: async (client, session, conversation, text) => {
				const ref = await client.get(PromptResources, { session, conversation }, { state: false });
				try {
					return ref.variant === "participant" ? (await ref.expand({ text })).text : undefined;
				} finally {
					ref.release();
				}
			},
		});
	}),
);
