# Add and change a plugin in p2

This tutorial builds one feature from start to finish: **chat mode**. The owner shares a session with Alice and Bob.
All three watch the agent work. They want to talk to each other ("should we let it delete that file?") in the same
transcript, without every remark becoming an instruction for the agent. With chat mode on, a message is a chat
message: everyone sees it, and the model never does. When someone wants the agent's opinion, they mention it with
`@pi`, and the agent receives the chat nobody has passed on to it yet, along with the question.

You should know TypeScript and React. You do not need to know p2. p2 is built on a small runtime called Chord
(`@earendil-works/chord`). [Build a shared todo list with Chord](../../../packages/chord/docs/tutorial.md) explains
its ideas in detail. This tutorial links to it instead of repeating it, and explains each Chord word briefly when it
first appears.

The finished plugin is in `plugins/chat-mode`. Its tests are `test/p2/chat-mode*.test.ts`. The earlier versions you
write in sections 1 to 3 live in `test/p2/chat-mode-reload.test.ts`, which loads them into one host in the
tutorial's order. Every code block below is quoted from the plugin, its tests, or the two chat-plugin files it
extends, and a test (`chat-mode.test.ts`) fails when a quote no longer matches.

## 1. A plugin and its first version

### What a plugin is

p2 runs as several processes. The **server** holds what all sessions share: the session list, share links, logins.
Each running session gets a **worker** process that runs the agent. Workers stop when nobody has used the session
for a while. Each browser tab is a third kind of process. Chord calls each of these a **host**.

A **plugin** is a directory under `plugins/` that adds code to some of these hosts. Its files have fixed names:

| File | Runs on | Used for |
| --- | --- | --- |
| `contract.ts` | everywhere it is imported | the shapes and method signatures that hosts agree on |
| `server.ts` | the server | data shared by everyone, HTTP routes |
| `worker.ts` | each session worker | anything that needs the agent or the session's files |
| `web.tsx` | the browser | React components |

A file that adds code to a host is a **facet**. It default-exports `defineFacet((host) => { ... })`; the callback
registers the plugin's objects on that host. A plugin needs at least one facet; `contract.ts` and helpers such as
chat-mode's `digest.ts` are ordinary modules.

There is no manifest that lists plugins or their dependencies, and p2 never reads plugin source to work them out. A
plugin is a directory under `plugins/` with facet files; p2 lists the directory and loads the selected plugins'
facets in alphabetical order. When `plugins/chat-mode/worker.ts` holds a Chat object, it needs the chat plugin at
runtime: Chord resolves the contract by name when chat-mode's object activates, and every facet of a load is installed
before any object activates, so the order does not matter. If chat is not loaded, that activation fails loudly:
`plugin chat-mode needs p2.chat; no loaded plugin serves p2.chat`. Imports are just imports, of contracts, of
`src/runtime` or of `@earendil-works/chord`; a list kept by hand would drift from the code, a contract name cannot.

### Where chat mode lives

A conversation's transcript is stored by **Durable**, the agent runtime inside each worker. Durable stores a
conversation as a list of **entries**. Each entry has a **kind** (a string such as `p2.input`), application **data**
(any JSON), and possibly a **model** message: the user message, answer or tool result the model sees. Only entries
with a model message are sent to the model. You add to a conversation by handing it a **submission**:

- an `input`: a user message that starts or steers a run. It is placed as an entry of the kind you name, with your
  data, and the message as its model message. p2 places every person's input as a `p2.input` entry whose data says
  who wrote what (`src/runtime/input.ts`). Code that needs the author reads the data.
- a `write`: an entry appended without asking the model anything. A write with only a kind and data is placed at
  once, even while the agent is in the middle of a run.

That gives chat mode its shape. A chat message is a write of a `chat.message` entry with the same kind of data and no
model message, so the model cannot see it, whether the agent is idle or working. A mention is an input of its own
kind, `chat.mention`: its data is what the person wrote, its model message is what the agent should read. Both happen
next to the agent, so chat-mode is a worker plugin: it has a `worker.ts` and no `server.ts`.

### Extending the chat plugin

Sending belongs to the chat plugin. Its `Chat` object, which each browser holds, has a `send` method that turns text
into an input. Chat mode must decide, for every message, whether it becomes a chat entry instead. Rather than edit
`send` for this one feature, the chat plugin offers an extension point: a **registry**, which is a table that
plugins add entries to. `SendRouters` holds functions that may take a message:

```ts
/**
 * Worker extension point of `Chat.send`: each router may take a message (returning its submission) or leave it
 * (`undefined`). Untaken messages become ordinary inputs. Example: chat-mode writes chat entries.
 */
export const SendRouters = defineRegistry<
	(input: RoutedSend, ctx: Ctx) => Promise<{ submissionId: number } | undefined>
>("p2.chat-send-routers", { conflict: "error" });
```

`Chat.send` asks each router before doing what it always did:

```ts
for (const route of host.registry(SendRouters).table(ctx).values()) {
	const routed = await route(
		{ ...input, conversation, author: author(), attachments: attachments ?? [] },
		ctx,
	);
	if (routed) return routed;
}
```

The chat plugin's worker-local `Conversation` object gained a `write` method for display-only entries, and its
`submit` takes an input's own entry kind and data, and an image cap (section 5). The browser side shows every entry
whose data is a person's message, of any kind; a registry, `TranscriptEntries`, lets a plugin add to its kinds'
messages, and the composer renders a slot list (below). Replies in
section 3 add two more hooks of the same kind. None of these changes to the chat plugin mentions chat mode. When the
plugin you build needs a hook that does not exist, add a small, general one to the plugin that owns the behavior, and
use it from yours.

### The contract

In Chord, code reaches a feature through an **object**: state plus methods, identified by a type and an input. A
**contract** names the object's type and describes its members. Both sides import the contract, so TypeScript checks
callers, and Chord checks values that cross between processes.

The first version has a switch for the whole session, kept in memory, and lets only the owner see it. That is two
objects. `ChatModeStore` holds the switch. It is **local**: only code in this worker can reach it, never a browser.
`ChatMode` is what a browser holds. It is **remote**: its state and methods travel between processes as JSON, and it
is grouped into **variants**, one per kind of caller. For now there is one, `owner`.

```ts
const ChatModeStore = local("p2.chat-mode-store", {
	version: 1,
	input: obj({}, { open: true }),
	members: {
		enabled: bool(),
		set: method(obj({ enabled: bool() }, { open: true })),
	},
});
```

```ts
const ChatMode = remote("p2.chat-mode", {
	version: 1,
	input: obj({ session: str(), conversation: num() }, { open: true }),
	host: sessionHost,
	variants: {
		owner: {
			state: { enabled: bool() },
			methods: { set: method(obj({ enabled: bool() }, { open: true })) },
		},
	},
});
```

The schemas are JSON Schema, built with `@earendil-works/pi-schema`'s builders (`obj`, `str`, `num`, `bool`, ...):
`obj(...)` is both a runtime description and, through `Static<...>`, a TypeScript type. p2 writes object schemas as
`obj(properties, { open: true })`, which also accepts other properties, as the TypeBox objects p2's contracts were
first declared with did (a contract's fingerprint is computed from its schemas' JSON).
`method(args, result)` declares a method by the schemas of its argument and its result; `set` has no result, so
it returns nothing. `ChatMode`'s input names a conversation, although the first version has one switch for all of them; browsers
always look at one conversation, and section 3 makes use of it. A remote contract also says where its objects live:
`host: sessionHost` (from `src/runtime/chord.ts`) puts each `ChatMode` object on the worker of the session its input
names, `session:<session>`, and `serverHost` puts an object on the server. Nobody who asks for an object names a host;
Chord routes the request by the contract, and a host refuses an object its contract places elsewhere. Local types
like the store have no `host`: they never leave the host that serves them.

The contract file also decides what a mention is, so that every host agrees. The agent is called Pi unless the owner
renamed it for the conversation (section 4 keeps the name with the switch), so a mention is built from a name:

```ts
export const mentionPattern = (name = DEFAULT_AGENT_NAME): RegExp =>
	new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeName(name)}(?![\\p{L}\\p{N}_-])`, "iu");
export const MENTION = mentionPattern();
export const mentionsAgent = (text: string, name = DEFAULT_AGENT_NAME): boolean => mentionPattern(name).test(text);
```

### The worker facet

`host.serve(Contract, factory, options)` registers a **factory**: a synchronous function that Chord calls when
someone first asks for an object, with the object's input, the caller's **principal** (who is asking), and `self`,
which declares the object's state and dependencies. The store keeps its switch in a **cell**, an observable value
that `self.state(name, schema, initial)` declares: everyone subscribed to `enabled` receives each change. The name
`"enabled"` finds the cell again when the code is reloaded.

```ts
host.serve(
	ChatModeStore,
	(_input, _principal, self) => {
		const enabled = self.state("enabled", bool(), false);
		self.register(SendRouters, {
			"chat-mode": async ({ conversation, author, text, requestId, attachments }, ctx) => {
				if (!enabled.value || mentionsAgent(text)) return undefined;
				const uploads = await ctx.get(Attachments, {});
				const files = await uploads.resolve({ ids: [...attachments], conversation }, ctx);
				const data = { author, text, attachments: files.map(({ id, name }) => ({ id, name })) };
				const chat = await ctx.get(Conversation, { conversation });
				return chat.write({ kind: CHAT_ENTRY, data, requestId, author }, ctx);
			},
		});
		return {
			enabled,
			set: ({ enabled: on }, ctx) => {
				enabled.replace(ctx, on);
			},
		};
	},
	{ lifetime: "host" },
);
```

The `ctx` argument is the call's context (cancellation, caller, code version); pass it on to every call you make.
Why the switch is a cell and not a variable is the subject of
[Chord tutorial section 3](../../../packages/chord/docs/tutorial.md#3-give-the-list-live-state): a cell keeps its
value when the code is replaced, which section 3 below relies on.

The store also registers the router. Registrations belong to objects of **lifetime `"host"`**, which the host creates
when the plugin loads and keeps until it closes, so the router exists before anyone opens the chat; that is why the
store is served with `lifetime: "host"`. Other objects have the default lifetime, `"referenced"`: they exist while
someone references them.

With chat mode off, or with a mention, the router returns `undefined` and the message goes on as an ordinary input.
Otherwise it writes a chat entry. Its data is a person's message, the same shape as a `p2.input` entry's: the author,
the text, and the attachments as upload IDs with their file names. So the transcript, in the browser and in p2's
terminal client, can show who wrote it without knowing chat mode. `Attachments` is the files plugin's object that checks that each ID is an upload of this session;
the names are what the transcript shows. `requestId` comes from the browser and makes a retried send harmless:
Durable admits one submission per author and request ID.

The browser's `ChatMode` hands out the store's state and forwards `set`, for the owner only:

```ts
host.serve(ChatMode, (_input, principal, self) => {
	if (!isOwner(principal)) throw forbidden("Only the owner, for now");
	const store = self.get(ChatModeStore, {});
	return { variant: "owner", enabled: store.enabled, set: (change, ctx) => store.set(change, ctx) };
});
```

`forbidden` refuses a caller. `isOwner` comes from `src/runtime/principals.ts`, which section 2 looks at.

### The web facet

The browser side has two jobs: a switch in the composer, and chat entries in the transcript. p2's layout has
**slots**: named places that plugins fill with React components through the `Slots` registry. A name holds one
component. A **slot list** renders every component registered under a prefix, so several plugins can share a place.
The composer's bar renders `<SlotList prefix="composer" />`, beside the Steer chip, so chat-mode registers
`composer:chat-mode`. The existing slots:

| Slot | Where | Filled by |
| --- | --- | --- |
| `app`, `sidebar`, `main` | the page, the session list, the main column | web-shell, sessions, chat |
| `artifact-actions`, `terminal-actions`, `workspace-actions`, `session-options`, `session-actions` | the chat's top bar | artifacts, terminals, workspace, sessions, sharing |
| `composer:<name>` | the composer's bar, any number | chat-mode |
| `chat-content`, `chat-attribution`, `chat-parent`, `chat-bottom` | inside and below the transcript | artifacts, subagents, terminals |
| `sidebar-foot:<name>` | the session list's footer (fixed names) | providers, envs, devices, ports, logs |
| `workspace-panel`, `workspace-terminal` | the docked workspace | workspace, terminals |
| `envs-actions:<name>` | the environments panel, any number | ports |

The transcript needs no help to show a chat message. It shows every entry whose data is a person's message, of
any kind, with the author's name, "guest" for guests and the file names; one without a model message gets "· chat"
after the name and an outlined bubble (in `plugins/chat-mode/style.css`), which sets it apart from what the agent was
asked. The web facet registers the chip:

```tsx
self.register(Slots, { "composer:chat-mode": ChatModeChip });
```

and, through `TranscriptEntries`, what chat mode adds to its own entries: a reply's quoted line (section 3) and a
mention's note "with 3 chat messages" (section 5).

The chip holds the conversation's `ChatMode` and looks like the composer's other chips:

```tsx
<button
	type="button"
	className={`chip toggle chat-mode ${enabled ? "on" : ""}`}
	aria-pressed={enabled}
	title={title}
	onClick={() => void mode.set({ enabled: !enabled }).catch((error: unknown) => console.error(error))}
>
	{label}
</button>
```

`useObject` (in the full component) gets a reference while the component is mounted and releases it afterwards;
`useReadable` subscribes to a state member and re-renders on each change. `web.tsx` in the repository is the
finished file; it already shows guests a marker instead of the switch, and turns on the replies of section 3.

The server automatically bundles each selected plugin's web facet with `src/hosts/web/main.tsx`, so no registration
is needed. Its browser-reachable dependencies ship in the owner and guest bundle; keep worker-only code out of that
import graph. That is why the Durable document of section 4 lives in `worker.ts`, not in `contract.ts`.

### Load it into the running server

Run p2 in dev mode (the exact command with the owner's environment is in [p2-notes.md](p2-notes.md#dev-mode)):

```sh
cd apps/p2
P2_FAKE=1 P2_DATA_DIR=/tmp/p2-try PORT=8797 npm run dev
```

Saving a facet or one of its loaded imports does not change the running code by itself. The dev watcher marks the
plugin as changed ("dirty"), and the owner's page shows that a reload is pending. You apply it when you are ready, either with the
Reload button on that notice or from a shell:

```sh
P2_DATA_DIR=/tmp/p2-try npm run reload            # every dirty plugin
P2_DATA_DIR=/tmp/p2-try npm run reload chat-mode  # just this one
```

The command prints what it reloaded, and the server log says the same, for example:

```text
p2 dev: Reloaded chat-mode
```

A reload takes exactly the named (or dirty) plugins; the others keep running, and Chord's contract versions decide
whether new code may talk to old code (section 3). A plugin directory that did not exist before is picked up by the
same reload; you do not need to restart. Removing a plugin that another loaded plugin still holds an object of is
refused, naming the holder.

**Hot reload** means the new code takes over inside the running processes: the server and every running worker
switch in one step, and objects keep their state. Section 3 shows when that is safe. A successful reload also
publishes the rebuilt web bundle; visible pages poll every five seconds and reload when they detect it, and hidden
pages check when foregrounded.

What you see: a "Chat" chip in the composer. Tap it, write "is anyone here?" and send. The message appears in the
transcript with "Owner · chat" above it, and the agent does not start. A guest cannot see the switch yet: the
worker refuses their `ChatMode` with `forbidden`. The reload test checks the same without a browser:

```ts
// Section 1: the owner switches chat mode on; a message becomes a chat entry; a guest is refused.
await owner.set({ enabled: true });
await until(owner.enabled, (value) => value === true);
await chat.send({ text: "is anyone here?", requestId: "1" });
await until(chat.view, (view) => chatCount(view) === 1);
await assert.rejects(fixture.client(ALICE).get(first.ChatMode, where), (error) =>
	isChordError(error, "forbidden"),
);
```

## 2. Who may do what

### Principals

Every call in p2 carries a **principal**, a small object that says who is calling. It is never taken from the
request's content. The server **stamps** it when a connection arrives: a request from localhost is the owner; a
request through a tunnel carries a cookie, and an authenticator (registered by the sharing or devices plugin) turns
that cookie into a principal. Everything that the connection sends afterwards acts as that principal, including
calls the server relays to a session's worker. The kinds are defined in `src/runtime/principals.ts`, as the type
`P2Principal`; plugins import `defineFacet` and `Ctx` from `src/runtime/chord.ts`, Chord's API typed with it, so a
factory's `principal` narrows on `kind`:

- `{ kind: "owner", access }`: the person running p2, on this machine (`"local"`), through Radius (`"relay"`), or with
  an associated device's owner cookie (`"device"`, with the device's ID).
- `{ kind: "guest", id, name, session, mode, revision }`: someone who joined one session through a share link.
  `mode` is `"view"` (read-only link) or `"full"` (read/write link). The name is whatever the guest typed when
  joining; p2 only makes it unique within the session.
- `{ kind: "worker", session, generation }`: a session worker calling the server.
- `{ kind: "server" }` and `{ kind: "host" }`: the server's own code calling a worker, and any host's own code.

The same file has the checks every plugin uses. `canView(principal, session)`: the owner, or a guest of that session.
`canSend(principal, session)`: the owner, or a read/write guest of that session. `authorOf(principal, ownerName)`:
the `{ kind, id, name }` to record as an author (the owner is `{ kind: "owner", id: "owner", name }`, with the name
settings.json's `ownerName` gives when the entry is written, "Owner" by default).

### The rules

Chat mode has three:

- The owner switches it. It changes what everyone's messages do, and the agent's work is the owner's.
- The owner and read/write guests chat and mention the agent. Read-only guests read.
- Everyone who can see the session can see whether chat mode is on.

The second rule costs chat-mode nothing. Chat messages go through `Chat.send`, and the chat plugin already gives
read-only guests a `Chat` without `send`. The router only ever runs inside `send`, so it never sees a read-only
guest. It never asks who is calling either: `Chat` computes the author from the principal and passes it to every
router. A client that adds `author` to its arguments changes nothing; the integration test tries:

```ts
// A client cannot choose its author: the extra field is ignored, the principal decides.
await aliceChat.send({
	text: "@Pi, what do you think?",
	requestId: "m1",
	author: { kind: "owner", id: "owner", name: "Owner" },
} as never);
```

and the agent's input is still Alice's. This is the rule to keep in every plugin: identity comes from the
principal, never from arguments, because arguments are whatever the client chose to send.

### Two variants

The first and third rules are about `ChatMode`. A remote contract can offer different **variants** to different
callers, and the factory decides which one a caller gets. Add a `reader` variant without `set`:

```ts
variants: {
	reader: { state: { enabled: bool() } },
	owner: {
		state: { enabled: bool() },
		methods: { set: method(obj({ enabled: bool() }, { open: true })) },
	},
},
```

and let the factory choose:

```ts
host.serve(ChatMode, ({ session: requested }, principal, self) => {
	if (requested !== session || !canView(principal, session)) throw forbidden();
	const store = self.get(ChatModeStore, {});
	if (!isOwner(principal)) return { variant: "reader", enabled: store.enabled };
	return { variant: "owner", enabled: store.enabled, set: (change, ctx) => store.set(change, ctx) };
});
```

`session` is the worker's own session, taken from the host's name (`session:<id>`). The check refuses a guest of
another session, and a request that names a session this worker does not run.

The browser learns the variant from `mode.variant`. TypeScript shows every variant's methods on a reference, so nothing
stops the page from calling `set` as a reader; the worker refuses that call with `not_in_variant`. The chip uses
`mode.variant` to decide between a switch and a plain marker.

### Grants change while objects live

A guest's access can end while their page is open: the owner removes them, resets the share link, or archives the
session. The sharing plugin then bumps the grant's `revision` and **invalidates** every object the old principal
holds, here and in workers: their references go `gone`, and their socket closes. New calls to a worker pass the
server's route to it, which asks `SessionAccess` (a registry in `src/runtime/server.ts` that the sharing plugin
fills) whether the guest's grant is current. So chat-mode does not check grants itself. Where a plugin writes on the
server for guests, without a worker in between, it must ask `SessionAccess` at the moment of writing.

### What reload does with this change

Save, reload chat-mode, and nothing visible happens to the owner: chat mode is still on. The view's factory
changed, but the store did not, and the store object with its cell survived the reload. An **object** is one instance of an object type (one per
input and principal); a reload replaces the code of every object and keeps its cells. In
the reload test, `gated` lists objects that had to stop and convert their data; it is empty here, and Alice sees
the switch that was on before:

```ts
// Section 2: new view code only. The store object and its switch stay; nothing waits at a gate.
const readers = withReaders();
assert.deepEqual((await reload(readers.facet)).gated, []);
const alice = await fixture.client({ ...ALICE, revision: 2 }).get(readers.ChatMode, where);
assert.equal(alice.variant, "reader");
assert.equal(await until(alice.enabled, (value) => value !== undefined), true);
```

The finished plugin's unit test checks every rule over **memory links**, an in-process connection that behaves like
a WebSocket, with the principal stamped by the receiving host:

```ts
assert.equal(owner.variant, "owner");
assert.equal(alice.variant, "reader");
assert.equal(bob.variant, "reader");
// A reader has no `set` and a viewer no `send`: TypeScript refuses them; called anyway, so does the provider.
// @ts-expect-error `set` is the owner's.
await expectChord(alice.set({ enabled: true }), "not_in_variant");
const viewer = await fixture.client(BOB).get(Chat, where);
// @ts-expect-error `send` is a participant's.
await expectChord(viewer.send({ text: "hi", requestId: "b" }), "not_in_variant");
```

## 3. Changing it live

Hot reload replaces code while objects keep their cells. That is only safe when the old data still means what the
new code expects. Chord checks what it can and refuses the rest. This section makes one change it accepts as is,
and one it refuses until you say how to convert the data.

### A compatible change: replies

Chat gets busy. Ann asks "should we split the tokenizer and the parser work?", two other things are said, and Bob
writes "yes, the tokenizer part". Nobody knows what he agrees with. Discord-style replies fix that: Bob points his
message at Ann's, and his message shows a small quoted line, "Ann should we split the tokenizer…", that leads back
to hers. There are no threads; a reply is an ordinary message that knows which message it answers. Pi's answers can
be replied to as well.

**What a client may say.** The browser names the message it answers and nothing else: an entry ID. The chat
plugin's `send` gained an optional field for it, which ordinary inputs ignore:

```ts
replyTo: opt(int({ minimum: 1 })),
```

Whom the reply quotes, and what, must not come from the client, for the same reason the author does not: a client
could make Bob's message quote words Ann never wrote. So the worker looks the entry up and derives both from it.

**What the worker checks.** `replyTarget` asks Durable for exactly that entry, in this conversation:

```ts
export async function replyTarget(durable: DurableHarness, id: ConversationId, entryId: number, ctx: Ctx) {
	const conversation = await durable.conversation(id, durableContext(ctx));
	const only = { minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId };
	const page = await conversation?.entries(only, 1, undefined, durableContext(ctx));
	const entry = page?.items[0];
	const quote: ReplyTo | undefined = entry?.id === entryId ? quoteOf(entry) : undefined;
	if (!quote) throw invalid("args", "That message cannot be replied to");
	return quote;
}
```

Durable lists a conversation's own entries, so an ID from a subagent's conversation, or one that does not exist, is
not found, and the send is refused with `invalid`. `quoteOf` (in `digest.ts`) decides what may be replied to and
what is quoted, always from the entry's data: a chat message's or an input's author and text (for a mention, what
the person wrote, not what the model read), or Pi's answer, with the author `Pi`. Anything else, such as a tool
result, is refused. The excerpt is the start of the text, whitespace collapsed, at most 60 characters:

```ts
export function excerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat;
}
```

**What is stored.** The router resolves the target before writing, and the chat entry carries the result:

```ts
const answering =
	replyTo === undefined ? undefined : await replyTarget(harness.harness!, id, replyTo, ctx);
const uploads = await ctx.get(Attachments, {});
const files = await uploads.resolve({ ids: [...attachments], conversation }, ctx);
const data = {
	author,
	text,
	attachments: files.map(({ id, name }) => ({ id, name })),
	...(answering ? { replyTo: answering } : {}),
};
```

The quote is copied into the reply, not looked up again when the reply is shown. A conversation's history can be
compacted or reset, and the browser holds only part of it, but the reply always knows what it answered. The entry's
schema in `contract.ts` gains one optional field:

```ts
replyTo: opt(ReplyToSchema),
```

**What the browser shows.** Replies need two places the chat plugin owns: the transcript, which offers "Reply" on
messages, and the composer, which shows "Replying to Ann ×" and sends `replyTo`. So the chat plugin got two more
general hooks. Its transcript offers a reply action wherever a `ReplyTo` React context provides one, and its
composer state has `canReply`, which a plugin turns on. Chat-mode's chip turns it on while chat mode is on:

```tsx
// Replies belong to chat mode: the transcript offers them while it is on, and the composer offers the mention.
const { setCanReply, setReplyTo, setMentionName } = useComposerState();
const replies = live && enabled;
useEffect(() => {
	setCanReply(replies);
	if (!replies) setReplyTo(undefined);
	return () => setCanReply(false);
}, [replies, setCanReply, setReplyTo]);
```

With a mouse, a reply button appears beside a person's message on hover, and beside Copy under Pi's answers. On a
phone (a coarse pointer), a long press on the message starts the reply instead, because there is no hover. The
transcript draws the stored quote above the reply's text; tapping it scrolls to the original and highlights it
briefly, if that message is loaded. The chip's web facet passes the quote on through the transcript registry from
section 1, as `replyTo: { entryId, name, excerpt }`.

**Why this is compatible.** Nothing stored by Chord changed: the store's cell keeps its schema, and no contract
changed in a way that breaks a caller. `Chat.send` only gained an optional argument, and `ChatMode` did not change
at all. Durable entries written before replies simply have no `replyTo`, which the new schema allows. Chord compares
all of this during the reload's **prepare** step (the new code is built next to the old, and nothing is switched
yet). When nothing stored changes meaning, the reload commits at once: calls already running finish on the old code,
new calls use the new code, and no object waits. The reload test replies to the message from section 1:

```ts
// Section 3, compatible: replies. Optional data on new entries, no stored state changes. Still no gate.
const replies = withReplies();
assert.deepEqual((await reload(replies.facet)).gated, []);
const [question] = chatEntries(chat.view.value);
const guest = await fixture.client({ ...ALICE, revision: 3 }).get(Chat, where);
assert.equal(guest.variant, "participant");
await guest.send({ text: "yes, here", requestId: "r1", replyTo: question!.id });
const [, reply] = chatEntries(await until(chat.view, (view) => chatCount(view) === 2));
assert.deepEqual((reply?.data as ChatMessage).replyTo, {
	entryId: question!.id,
	author: { kind: "owner", id: "owner", name: "Owner" },
	excerpt: "is anyone here?",
});
```

The finished chip also shows how much a mention would hand the agent ("Chat · 3"): a `waiting` member, counted from
the conversation's entries (see "The document is the truth, the cell shows it" below). Adding it is the same kind of
change, additive and stateless.

### An incompatible change: one switch per conversation

A session has more than one conversation. When the agent starts a subagent, the subagent gets a conversation of
its own, and people can open it and talk to the subagent directly. With one switch per session, turning chat mode on
in the main conversation also turned it on there, and messages meant for the subagent became chat. The switch
belongs to a conversation.

The store's cell changes from one boolean to a boolean per conversation (`record(schema)`, from
`src/runtime/schema.ts`, is an object with any keys whose values match `schema`):

```ts
const EnabledSchema = record(bool());
const ChatModeStore = local("p2.chat-mode-store", {
	version: 2,
	input: obj({}, { open: true }),
	members: {
		enabled: EnabledSchema,
		set: method(obj({ conversation: num(), enabled: bool() }, { open: true })),
	},
});
```

The router checks `store.enabled.value?.[conversation]`, and `ChatMode` derives its `enabled` from its own
conversation's entry:

```ts
const enabled = self.derive([store.enabled], (switches) => switches?.[conversation] === true);
```

Save and reload, and Chord refuses. It refuses three times, in fact, once for each thing you have not changed yet.
Each protects something different.

**The contract version** protects callers. The store's `enabled` member is now a record, and code built against the
old contract would read it as a boolean. Changing a member's type is a breaking change, so the store's contract
needs a new version (`version: 2` above). Without it, `npm run reload` prints:

```text
Reload refused: contract_mismatch: reload aborted: contract_mismatch: p2.chat-mode-store@1 changed incompatibly without a version bump (.enabled state)
```

The browser's `ChatMode` contract keeps version 1: its `enabled` is still a boolean, per conversation.

**The cell's version** protects stored data. The cell holds a value written by the old code, a plain `true` or
`false`, and its schema changed. Chord will not let new code read the old value as if it were new. The message ends
in:

```text
invalid/state: p2.chat-mode-store{}host: schema of state enabled changed without a version bump
```

**The migration** says how to convert. Bumping the cell's version alone is not enough, because `true` does not fit
the new schema:

```text
invalid/state: p2.chat-mode-store{}host: migrated state enabled: / must be object
```

The version and the migration belong to the cell, as options of `self.state`. A migration is a function from the old
value to the new one. It can only use what was stored, and the old switch does not say which conversation it was
meant for. The main conversation (ID 1) is where people switched it, so it keeps the setting and every other
conversation starts off:

```ts
// Version 1 was one switch for the session. Keep it for the main conversation only.
const enabled = self.state(
	"enabled",
	EnabledSchema,
	{},
	{
		version: cell.version ?? 2,
		...(cell.migrate === false
			? {}
			: { migrate: (old): Record<string, boolean> => (old === true ? { 1: true } : {}) }),
	},
);
```

(`cell` belongs to the test: it leaves out the bump or the migration to show the refusals above.)

A second argument, `from`, says which version the old value has. An object can be more than one version behind, so
once there are several versions, a migration must handle each one it still supports.

### What a refused reload looks like

A refused reload changes nothing. Prepare failed, so the old code keeps running with the old data, and every open
page keeps working. `npm run reload` prints `Reload refused:` with the message and exits with status 1; the server
log has the same line after `p2 dev:`; the owner's page shows it in the dev notice. Fix the code, save, and reload
again. The test checks all three refusals, then that nothing changed:

```ts
for (const [facet, message] of refusals) {
	await assert.rejects(reload(facet), (error) => isChordError(error) && message.test(error.message));
}
assert.equal(await until(owner.enabled, (value) => value !== undefined), true, "refusals change nothing");
```

### What an accepted migration does

With all three changes, the reload goes through, but not instantly. The store object has to convert its data, so
it passes a **gate**: Chord waits for calls already inside that object to finish, runs the migration on a copy,
checks the copy against the new schema, and switches code and data together. Subscribers get the converted value
as one reset. Calls that started under the old code and reach the object afterwards fail with `upgrade_conflict`
instead of running old code on new data, and should be retried in a fresh call (`retrying()` in
`src/runtime/retry.ts` does that). Only objects whose stored data changes are gated, here the store:

```ts
// With both bumps and the migration, the store object passes the gate; the main conversation keeps its switch.
const migrated = await reload(split.facet);
assert.equal(migrated.gated.length, 1);
assert.match(migrated.gated[0]!, /p2\.chat-mode-store/);
assert.equal(await until(owner.enabled, (value) => value === true), true);
```

The store has lifetime `"host"`, and its contract version changed. The host's own reference to such an object follows the new
contract when the reload commits, so that needs nothing more. Other consumers that survive the reload must be
reloaded with it, as `ChatMode` is here, or the provider needs an `accepts` adapter for their old version.

The full rules (adapters for old callers of a renamed method, deadlines, resources replaced at the gate) are in
[Chord tutorial section 9](../../../packages/chord/docs/tutorial.md#9-change-running-code-without-losing-the-list).

## 4. Keeping it: Durable documents and entries

The switch lives in a cell. A reload keeps it, but a worker does not live forever: it stops when nobody has used the
session for five minutes, and a server restart stops all of them. When a worker starts again, its objects start
again, and chat mode is off. The chat messages themselves are fine. They were Durable entries from the first
version on, stored in the session's database with everything else in the conversation.

The switch should be stored in the same place, for the same reason: it belongs to the conversation. Durable has a
place for that.

### A Durable document

A Durable **document** is a typed JSON object stored with a conversation and changed in the same transactions as its
entries. Its definition says where it lives and what happens to it:

```ts
export const ChatModeDoc = defineDoc<{ enabled: boolean; name: string }>({
	kind: "chat-mode.settings",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ enabled: false, name: DEFAULT_AGENT_NAME }),
	checkpointWhen: () => true,
	// Version 1 had the switch only.
	migrate: (value) => ({ enabled: value.enabled === true, name: DEFAULT_AGENT_NAME }),
});
```

`scope: "conversation"` gives every conversation its own document, which is section 3's per-conversation switch
without a map. `history: "latest"` keeps only the current value. `fork: "initial"` means a copy of the conversation
starts with chat mode off. Every definition requires `checkpointWhen`; `() => true` stores this tiny settings
object as a complete base on every write instead of replaying deltas. The document also keeps the agent's name, which
the owner may change from Pi; it came later, so the document's `version` rose to 2 and `migrate` gives an older
document the default name. The definition is in `worker.ts`, not `contract.ts`, because `defineDoc` is Durable code
and the browser never loads it.

The finished plugin replaces the store with `ChatModeSetting`, one object per conversation. Switching (and renaming)
writes the document in a **commit**, Durable's transaction:

```ts
const commit = async (ctx: Ctx, change: (doc: { enabled: boolean; name: string }) => void) => {
	const durable = await harness.harness!.conversation(id, durableContext(ctx));
	if (!durable) throw invalid("args", `Unknown conversation ${conversation}`);
	await durable.commit(async (tx) => change(await tx.doc(ChatModeDoc, id)), durableContext(ctx));
};
```

`harness` is the session's Durable runtime, which every worker plugin can hold through the `Harness` object of
`src/runtime/worker.ts`. `durableContext(ctx)` turns Chord's call context into Durable's, so cancelling the call
cancels the commit.

### The document is the truth, the cell shows it

Browsers still subscribe to a cell. Durable's conversation view, which the chat plugin mirrors, includes only
Durable's built-in documents, so a plugin's own document needs its own mirror. `ChatModeSetting` opens a
**resource** (something Chord opens before the object becomes usable and closes when it goes away): a
`CommitSignal` from `src/runtime/commits.ts`, which wakes a waiter after every commit that touches this document. It
also wakes for new entries and queue changes: the `waiting` count follows them.

```ts
const commits = self.resource("commits", {
	version: 1,
	deps: [harness],
	open: async ({ signal }) => {
		const durable = harness.harness!;
		if (!(await durable.conversation(id, durableContext(signal))))
			throw new Error(`Unknown conversation ${conversation}`);
		// The waiting count also follows the entries and the queue.
		return new CommitSignal(durable, (publication) =>
			publication.changes.some(
				(change) =>
					(change.type === "entry" && change.value.conversationId === id) ||
					(change.type === "document" &&
						(change.record.kind === ChatModeDoc.definition.kind ||
							change.record.kind === InboxDoc.definition.kind) &&
						change.conversationId === id),
			),
		);
	},
	close: (signal) => signal.close(),
});
```

The cell's first value is read from the document. A cell declared with `{ init }` instead of an initial value gets it
from `init`, which Chord runs after the object's resources are open and before the object is usable, so no browser
and no call ever sees a `false` that the document does not say:

```ts
const enabled = self.state("enabled", bool(), { init: async (ctx) => (await read(ctx)).enabled });
const name = self.state("name", AgentNameSchema, { init: async (ctx) => (await read(ctx)).name });
```

`init` only reads; the document stays the only place the setting is saved. After that, a **task**, background work
that belongs to the object, reads the document and waits for the next change, in a loop:

```ts
// The document is the truth; the cells show it. Subscribed before reading, so no commit is missed. The view
// holds only a window of the entries, so the router's backwards scan counts what waits, while chat mode is on.
self.task(async (ctx) => {
	while (!ctx.signal.aborted) {
		const seen = commits.value.version;
		const doc = await read(ctx);
		if (doc.enabled !== enabled.value) enabled.replace(ctx, doc.enabled);
		if (doc.name !== name.value) name.replace(ctx, doc.name);
		const durable = harness.harness!;
		const count = doc.enabled
			? unmentioned(
					await recentEntries(durable, id, ctx),
					await durable.snapshot(InboxDoc, id, durableContext(ctx)),
				).length
			: 0;
		if (count !== waiting.value) waiting.replace(ctx, count);
		await commits.value.next(seen, ctx.signal).catch(() => {});
	}
});
```

The count is the same scan the router makes for a mention (below): Chat's view holds only the newest entries of the
conversation, a window, so counting there would miss chat messages older than it.

The order matters. The signal is subscribed before the first read, and the loop notes the signal's version before
each read. A commit that lands between the read and the wait has already changed the version, so `next` returns at
once instead of missing it. For the same reason the first pass reads again although `init` just read: a commit
between `init` and the start of the task would otherwise wait for the next one.

The router does not use the cell. It reads the document itself, at the moment a message arrives:

```ts
const settings = await durable.snapshot(ChatModeDoc, id, durableContext(ctx));
if (!settings?.enabled) return undefined;
```

The cell is updated a moment after a commit; the document is current. A message sent right after switching must
follow the new setting, so the decision reads the source.

### Reloading from memory to Durable

Reload from section 3 to this version and chat mode is off: the switch lived in the old store's cell, and nothing
copied it into the new document. For a switch, that is acceptable; the owner switches it on again. For data people
would miss, the new code would have to copy what the old objects hold the first time it runs. The chat messages
lost nothing, because they were never in memory:

```ts
// Section 4: the finished plugin keeps the switch in a Durable document, with the agent's name: a new state member,
// so its contract is version 2 and a page built against version 1 reloads. The in-memory switch is not carried
// over.
await reload(chatModeWorker);
const finished = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
assert.equal(await until(finished.enabled, (value) => value === false), false);
assert.equal(finished.name.value, "Pi");
await finished.set({ enabled: true });
await until(finished.enabled, (value) => value === true);
await chat.send({ text: "back in chat mode", requestId: "3" });
assert.equal(chatCount(await until(chat.view, (view) => chatCount(view) === 4)), 4, "entries were never lost");
```

### Three kinds of version

Section 3 had a cell's version, which converts the cells of objects that are alive during a reload. Durable
documents have their own: change the document's shape, bump `version`, and give the definition a
`migrate(value, fromVersion)`. Durable applies it when it reads a stored document of an older version, which happens
after a restart, for a conversation nobody had open, or months later. Code that finds a newer document than it knows
refuses to read it, rather than misreading it.

Entries are the third kind, and they have no migration at all. An entry is history: once written, it stays as it
was, in every copy of the conversation. If chat-mode's entries ever change shape, every reader must keep handling
every shape that was ever written. That is why the transcript and the mention read an entry's data through
`chatMessage`, which checks it against the schema (compiled once with pi-schema's `compile`) and skips what it does
not recognize:

```ts
const isChatMessage = compile(ChatMessageSchema).check;
```

```ts
/** Entries are history: read their data defensively, never assume this code wrote it. */
export const chatMessage = (data: unknown): ChatMessage | undefined => (isChatMessage(data) ? data : undefined);
```

p2 itself has such history. Before Durable inputs could carry their own kind and data, every input was a `pi.user`
entry, and its author lived only in a text block at the start of the model message. Sessions from that time still
have those entries. Exactly one function reads them, `legacyMessage` in `src/runtime/input.ts`, marked as
legacy. Every other reader takes a person's message from entry data and hands only `pi.user` entries to it.

### What you see

Switch chat mode on, stop the server (Ctrl-C), start it again, and open the session: the chip is still on, and the
chat messages are where they were. The unit test does this with two bare hosts on one session file:

```ts
const second = await chatModeHost({ directory: first.directory });
t.after(() => second.close());
const again = await second.client(OWNER).get(ChatMode, where);
// The cell's first value comes from the document (its `init`), before anyone can read it.
assert.equal(await until(again.enabled, (value) => value === true), true);
```

## 5. Calling other plugins: the mention

So far a mention was an ordinary input: the agent got "@pi where should we eat?" and nothing of the conversation
before it. Now it should receive what people said that it has not seen yet, with who said it, then the question. The
router builds that text and hands it to the chat plugin, and on the way it uses two other plugins' objects.

### What the agent receives

Which chat should a mention pass on? Not "everything since the agent's last answer": with a busy agent, a mention can
wait in the queue while people keep talking, and the next mention would then repeat some messages and miss others.
Instead, each mention records which chat entries it passed on, in its own entry's data, and the next mention takes
the chat entries no mention has passed on yet.

The scan starts at the newest entry and walks back. Mentions add their recorded IDs to a set of covered entries;
mentions still waiting in the queue count too. Chat entries not in that set are collected:

```ts
export function unmentioned(entries: readonly EntryRecord[], inbox?: InboxState): ChatEntry[] {
	const covered = new Set<number>();
	for (const item of inbox?.items ?? []) {
		const queued = item.mode !== "write" && item.entry?.kind === MENTION_ENTRY ? mention(item.entry.data) : undefined;
		for (const id of queued?.included ?? []) covered.add(id);
	}
	const boundary = boundaryOf(entries) ?? Number.NEGATIVE_INFINITY;
	const found: ChatEntry[] = [];
	for (const entry of entries) {
		if (entry.id < boundary) break;
		const earlier = entry.kind === MENTION_ENTRY ? mention(entry.data) : undefined;
		for (const id of earlier?.included ?? []) covered.add(id);
		const message = entry.kind === CHAT_ENTRY ? chatMessage(entry.data) : undefined;
		if (message && !covered.has(entry.id)) found.push({ id: entry.id, message });
	}
	return found.reverse();
}
```

The scan does not have to read the whole conversation. The latest mention that passed anything on took every chat
message not passed on at the time, so it can stop at the lowest entry that mention included. Chat placed while that
mention waited in the queue lies above it and is found. The unit test builds exactly that case: mention 5 was
composed with chat 2 and 3, and chat 4 arrived while it waited:

```ts
assert.deepEqual(
	unmentioned(entries).map((entry) => entry.id),
	[4, 6],
);
```

`digest` turns the result into the text the model reads. Each message gets its author's name, with "guest" for
guests, so the agent knows the name was chosen by its writer, and the quote of the message it replies to, so a short
"yes" still makes sense; attachments are named. Then comes who is asking, and the question:

```ts
/** How a digest names a message's author: `Ann (guest, replying to Bob: "should we split…")`. */
function speaker(author: Author, replyTo?: ReplyTo): string {
	const notes = [
		...(author.kind === "guest" ? ["guest"] : []),
		...(replyTo ? [`replying to ${replyTo.author.name}: "${replyTo.excerpt}"`] : []),
	];
	return notes.length ? `${author.name} (${notes.join(", ")})` : author.name;
}
```

```ts
return [...header, `${speaker(author, answering)} mentioned you:`, text].join("\n");
```

A mention can be a reply too; then the asking line says what it answers. For a question about splitting work, the
agent reads:

```text
<chat>
Since you were last mentioned, people in this session talked to each other. They did not address you:
Ann (guest): should we split the tokenizer and the parser work? [attached: plan.md]
Owner: lunch first?
Bob (guest, replying to Ann: "should we split the tokenizer and the parser work?"): yes, the tokenizer part
</chat>

Ann (guest) mentioned you:
@pi how big is the tokenizer part?
```

The chat text now exists twice in the conversation: once as display-only entries, once in this input's model
message. That is deliberate. The entries are what people read; the model message is what the model reads.

### The chat plugin: one function composes the mention

The mention goes in through the chat plugin's worker-local `Conversation.submit`, the same call `Chat.send` makes
for any message. Everything about what a mention is, for people and for the model, is decided in one function,
`composeMention`, which returns what `submit` takes:

```ts
export function composeMention(input: {
	readonly author: Author;
	readonly text: string;
	readonly chat: readonly ChatEntry[];
	readonly replyTo?: ReplyTo;
	readonly attachments: readonly { readonly id: string; readonly name: string }[];
	readonly files: readonly Attachment[];
	readonly requestId: string;
	readonly whenBusy?: "steer" | "followUp";
}): Submit {
	const data: Mention = {
		author: input.author,
		text: input.text,
		attachments: input.attachments.map(({ id, name }) => ({ id, name })),
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		included: input.chat.slice(-MAX_DIGEST_MESSAGES).map((entry) => entry.id),
	};
	return {
		text: digest(input.chat, input.author, input.text, input.replyTo),
		requestId: input.requestId,
		...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
		author: input.author,
		files: [...input.files],
		maxImages: MAX_DIGEST_IMAGES,
		entry: { kind: MENTION_ENTRY, data },
	};
}
```

`entry` is the mention's own entry: kind `chat.mention`, and data that is a person's message (author, what they
wrote, their attachments, the reply) plus `included`, the chat entries passed on. People see the mention from that
data: the transcript shows "@pi which place?" with a note "with 3 chat messages", not the digest, and a reply to the
mention quotes the question. `text` and `files` are for the model. `author` appears in both: in the data, and as the
speaker block the chat plugin puts at the start of the model message, because the system prompt tells the model to
attribute input by it. Nothing reads that block back; code that needs the author reads the data.

The router only gathers the pieces and hands the result over:

```ts
const earlier = unmentioned(await recentEntries(durable, id, ctx), inbox);
const files = await resolve(digestFiles(earlier, attachments), conversation, ctx);
const own = files.filter((file) => attachments.includes(file.id));
```

Using `submit` keeps every rule of a normal input. Attachments are listed by path so the agent can open them with its tools, and images are inlined
when the model accepts images. `whenBusy` is the composer's Steer setting: while the agent works, a mention steers
the current run or queues a follow-up, exactly like any other message.

One thing is new. A busy chat can carry many images, and every inlined image costs tokens in every later request.
`submit` gained an optional `maxImages`; chat-mode passes 4, so only the four newest images are inlined and the
rest are listed. `digestFiles` similarly keeps the 20 newest chat attachments, and `digest` quotes at most the last
100 chat messages, counting the ones it leaves out. All three limits are in `digest.ts`.

### The files plugin: attachments on the right machine

A session can run on a remote environment, another machine the agent works on over SSH. Uploads are stored on the
p2 machine, so an attachment must be copied to the remote machine before the agent can read it. The files plugin
already does this for every input, in its worker-local `Attachments.resolve`, and chat-mode reuses it for the chat's
attachments:

```ts
/** Validates upload IDs of this session (copying them to a remote environment, like any input's). */
const resolve = async (ids: readonly string[], conversation: number, ctx: Ctx) => {
	const attachments = await ctx.get(Attachments, {});
	const files = [];
	for (let start = 0; start < ids.length; start += MAX_ATTACHMENTS)
		files.push(
			...(await attachments.resolve({ ids: ids.slice(start, start + MAX_ATTACHMENTS), conversation }, ctx)),
		);
	return files;
};
```

`await ctx.get` gets a reference, ready, for the duration of this call only. The loop exists because `resolve` takes at most
`MAX_ATTACHMENTS` IDs per call, a limit of the files plugin's contract that chat-mode imports instead of repeating.
Reusing the object instead of reading upload directories keeps one rule in one place: only uploads of this session
resolve, they are copied to the machine where the conversation works (a subagent may work on another machine than
the session), and a remote copy that fails refuses the input instead of handing the agent a path that does not exist.

Both calls are plain Chord calls on objects another plugin serves. chat-mode imports their contracts and calls them;
chat and files must be loaded for that to work, which a fixture says by naming them.

### Mid-run

What happens to a chat message while the agent works? A write with only a kind and data is placed at once, busy or
idle; only a pending reset holds it back. People see it immediately, and since the entry has no model message, the
run's next request is exactly what it would have been. A mention is different: it is an input, so while the agent
works it waits in the conversation's **inbox**, the queue of pending submissions, and is placed when the run ends or
steers it, as the composer's Steer setting says. That wait is why mentions record what they passed on.

The integration test starts a run whose tool sleeps, chats during the tool, checks the chat entry is there while the
run is still going, and then reads every request the fake provider received (the fake provider writes them to the
file in `P2_FAKE_REQUESTS`):

```ts
const all = JSON.stringify(requests());
assert(!all.includes("hello people") && !all.includes("while the tool runs"), all);
// The run went on as if nobody had chatted: the tool result, then the usual echo.
assert.deepEqual(
	requests().map((request) => request.at(-1)?.role),
	["user", "toolResult"],
);
```

### What you see

With chat mode on, Alice uploads three screenshots and writes "screenshots"; the owner adds notes and two more
images; Alice writes "@Pi, what do you think?". The transcript shows her question with "with 4 chat messages", and
the agent answers. The integration test checks the request the model received, including the owner's "hello people"
from before the run, which no mention had passed on yet:

```ts
assert.match(text, /^Alice \(guest\): screenshots \[attached: a\.png, b\.png, c\.png\]$/m);
assert.match(text, /^Owner: my notes \[attached: notes\.txt, d\.png, e\.png\]$/m);
assert.match(text, /Alice \(guest\) mentioned you:\n@Pi, what do you think\?/);
assert.match(text, /^Owner: hello people$/m, "chat never passed on goes with the first mention");
for (const name of ["a.png", "b.png", "c.png", "notes.txt", "d.png", "e.png"]) assert(text.includes(`(${name},`));
const inlined = (asked.content as { type: string }[]).filter((part) => part.type === "image");
assert.equal(inlined.length, MAX_DIGEST_IMAGES, "only the newest images are inlined");
```

and what people see, from the mention's data:

```ts
const placed = view?.entries.find((entry) => entry.kind === "chat.mention");
const data = placed?.data as { author: unknown; text: string; included: number[] };
assert.deepEqual(data.author, { kind: "guest", id: alice.id, name: "Alice" });
assert.equal(data.text, "@Pi, what do you think?");
assert.equal(data.included.length, 4);
```

## 6. Testing

Each test above answers one question, and each question has the cheapest place to ask it. From cheapest to most
expensive: one host without processes, the same host with remote clients, a real server with some plugins, and a real
browser. Run any of them from `apps/p2`:

```sh
node --import ./src/source.ts --test test/p2/chat-mode.test.ts
```

All of them use temporary directories, port 0 and the fake provider. None needs network access or credentials.

### A bare host

`testHost` (in `test/p2/helpers.ts`) creates one Chord host and installs the facets you pass, with no worker
process, no HTTP and no provider. Whatever the facets need from outside, you supply as a **stub**: a contract plus a
behavior, or a factory when the stub needs real cells. Chat mode is mostly Durable, so its helper,
`test/p2/chat-mode-host.ts`, opens a real Durable harness on a temporary SQLite file with the fake provider, and
stubs only what a worker process would provide:

```ts
const fixture = await testHost({
	name: "session:s1",
	facets: [chatWorker, options.facet ?? chatModeWorker],
	stubs: [
		// Nothing here runs tools, so the execution environment is never used.
		[Harness, { harness: durable, environments: {}, relocate: async () => {} }],
		[Attachments, { resolve: async ({ ids }: { ids: string[] }) => ids.map(fakeUpload) }],
		// No settings.json: the owner's entries carry the default name.
		[WorkerModels, (_input, _principal, self) => ({ settings: self.state("settings", unknown(), {}) })],
		// Chat counts its viewers and calls for the idle timer; a bare host has none.
		[
			WorkerProcess,
			{
				init: {},
				liveness: { add: () => {}, call: (fn: () => Promise<unknown>) => fn() },
				location: new SessionLocation({ cwd: "/", env: null }),
			},
		],
	],
});
```

The host is named `session:s1`, like a worker, so the facets find their session in the name. The chat plugin's own
worker facet is loaded too: chat-mode extends it, and testing the router without `Chat.send` would test less than
what runs. On this host, the unit test sends chat messages and mentions through `Chat` and reads the entries Durable
stored: their kinds and data, and the digest in a mention's model message. It starts a slow run to check that a
chat message is placed at once while a mention waits, and goes with the next mention. It restarts the host on the
same file to check the switch survives (section 4). It also tries every way a reply can go wrong: a forged quote
(refused by the contract, since `replyTo` is an entry ID), an unknown ID, and an entry of another conversation, which
it creates with `fixture.durable.createConversation`. Each is refused with `invalid`; a valid reply's quote, also to
a mention or to Pi's answer, is the one derived from the entry's data. Pure functions get plain tests, such as the
digest's reply line:

```ts
assert.match(text, /^Bob \(guest, replying to Ann: "should we split…"\): yes, the tokenizer part$/m);
```

The reload test uses the same helper with each earlier version as `facet`, and `fixture.host.reload` to move from one
to the next. `test/p2/inputs.test.ts` checks the readers outside chat mode: the transcript, queued inputs and tool
attribution take authors from entry data, even when a model message's speaker block names someone else.

`until(readable, predicate)` waits for a value and stays subscribed meanwhile. That matters for remote state: an
unsubscribed remote member starts again from `undefined`, so a test that reads `.value` between waits can see a
stale or empty value.

### Remote variants

`fixture.client(principal)` creates a second host connected over a memory link. The bare host stamps that principal
on everything the client sends, just as the server stamps a browser's. Asking the client for an object goes over the
link (its contract places it on the bare host: `where` names session `s1`, and the host is `session:s1`), so the test
sees what a browser would see: the variant, the state, and
refusals (section 2). Use stable error codes in assertions (`expectChord(promise, "not_in_variant")`), not message
wording. Records are keyed by principal, including the grant revision, so a test that changes a guest's grant uses
a new `revision`, as production does.

### A real server with a plugin subset

Uploads, the share-link join and a real worker process need a server. `startFixture` starts one on port 0. Without a
`plugins` option it loads every plugin, which is what most tests want. This test checks exactly what the model
receives, so it names every plugin it loads; nothing is added for imports:

```ts
fixture = await startFixture({
	// Exactly these: the model requests below are checked against this tool and prompt set.
	plugins: [
		"chat",
		"chat-mode",
		"conversations",
		"drafts",
		"envs",
		"files",
		"models",
		"search",
		"sessions",
		"sharing",
		"status",
		"subagents",
	],
	allowedHosts: ["share.test"],
	workerEnv: { P2_FAKE_REQUESTS: requestLog },
});
```

Terminals, workspace, artifacts, code mode and the other plugins stay out. Leave out one that is needed, say
`sessions`, and startup fails with the consumer and the missing contract (`plugin envs needs p2.catalog; no loaded
plugin serves p2.catalog on server`), not with a silent gap.

`allowedHosts: ["share.test"]` lets the test act as a remote visitor: requests with `Host: share.test` are not the
owner, so joining a share link yields a guest cookie, and `fixture.client(headers)` opens a WebSocket with it.
`workerEnv` passes `P2_FAKE_REQUESTS` to the session's worker, where the fake provider appends every request's
messages to that file. That is how the test asserts what the model received, which is the property chat mode exists
for:

```ts
/** Every request the fake provider received so far: one list of messages per request. */
const requests = (): Logged[][] =>
	existsSync(requestLog)
		? readFileSync(requestLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Logged[])
		: [];
```

### A browser

The browser test starts a full server with the web UI and drives headless Chromium over the DevTools protocol
(`test/p2/browser.ts`). It is the only test that sees layout: the chip in the composer, the outlined chat message
with "Owner · chat", the chip's count, the switch surviving a page reload, the agent's answer to a mention, and
replies: the hover button, the "Replying to Owner" bar, the quoted line and the jump to the original, and a long
press on a phone. The long press is real touch input:

```ts
await browser.metrics(390, 844);
await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
await browser.click(".composer button.chat-mode");
await browser.wait(`document.querySelector('.composer button.chat-mode')?.getAttribute('aria-pressed')==='true'`);
```

```ts
await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [answer] });
await new Promise((resolve) => setTimeout(resolve, 1000)); // the long press needs 500 ms; leave room under load
await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await browser.wait(`document.querySelector('.composer .replying')?.textContent==='Replying to Pi'`);
```

`browser.click` waits until the element is visible, enabled, not animating, and actually on top at its center, then
clicks with real mouse events. Headless Chromium reports no hover and no fine pointer, which is one reason the reply
button is hidden only for a coarse pointer, not for "no hover": desktop browsers behave like the test, phones do
not show the button. The browser is found through `CHROMIUM_BIN`; without one, the test is skipped. On a
server without a system Chromium, [p2-notes.md](p2-notes.md#running) shows a Docker wrapper.

Before you are done, run `npm run check`, your new tests, and then the full suite with `npm test`.

## 7. Checklist: mistakes plugin authors make

- **Taking identity from arguments.** Arguments are whatever the client sends; only the principal is stamped by the
  server.
- **Taking quoted content from the client.** A reply names an entry; the worker reads author and text from that
  entry, in the same conversation, or a client could put words in someone's mouth.
- **Parsing text written for the model back.** Give an input its own entry kind and data, and read that; text for
  the model is for the model, and a convention parsed back breaks when it changes.
- **Spreading what an input is over several places.** Compose it in one function (`composeMention`): its data for
  people and its model message for the agent change together.
- **Checking the variant and nothing else.** A variant decides which methods exist; a method still checks its
  arguments, and a server-side write for guests still asks `SessionAccess`.
- **Editing another plugin for one feature.** Add a small, general extension point (a registry or a slot list) to
  the plugin that owns the behavior; the next feature will need it too.
- **Putting data in a cell because a reload keeps it.** Workers stop when idle and servers restart; what must
  survive belongs in Durable (or a database), with the cell as its mirror.
- **Deciding from the mirror.** The cell lags the document by a moment; a decision that must follow the latest
  change reads the source.
- **Changing a cell's schema without a version bump and a migration.** Objects alive during the reload hold
  old values, and Chord refuses to read them as new ones.
- **Changing a member's type without a contract-version bump.** Callers built against the old contract would read
  it wrongly.
- **Assuming you wrote every entry you read.** Entries are history and are never migrated; validate their data and
  handle every shape ever written.
- **Sending display-only data with a `model` message.** Anything with a `model` message is sent to the model in
  every later request.
- **Deciding "what is new" by time or position.** A queued input is placed later than it was composed; record what it
  took (here, `included`) and decide by that. Then cap what you pass on.
- **Copying another plugin's rules instead of calling its object.** `Attachments.resolve` already knows which
  uploads belong to the session and how to reach a remote machine.
- **Sending without a `requestId`.** A retried or double-tapped request then runs twice.
- **Importing worker-only code from `web.tsx`.** Browser-reachable dependencies ship to owners and guests;
  Node-specific code can fail the build or the page.
- **Testing through a full server and browser first.** Most rules are checked faster and more precisely on a bare
  host; keep the browser test for what only a browser shows.
