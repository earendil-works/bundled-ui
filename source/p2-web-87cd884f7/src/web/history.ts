// A viewed conversation's transcript on a client (web and TUI): Durable's `ConversationTranscript` over the window the
// conversation's `Chat.view` holds. Every value of the view is merged in, so entries that leave the window stay; older
// entries and the entries of a gap page in through `Chat.entries`. One store per host and conversation, kept a while
// after nobody views it, so switching back finds its pages loaded.
import type { Readable } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	ConversationTranscript,
	type ConversationView,
	type EntryId,
	type TranscriptItem,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import type { Static } from "@earendil-works/pi-schema";
import type { EntriesPage, EntriesQuerySchema } from "../../plugins/chat/contract.ts";

/** One page of `Chat.entries`. */
export type EntriesSource = (query: Static<typeof EntriesQuerySchema>) => Promise<EntriesPage>;

/** A gap of the transcript: entries between `after` and `upTo` are not loaded. */
export type Gap = Extract<TranscriptItem, { kind: "gap" }>;

/** What a client has of a conversation, and which loads run. */
export type Pages = {
	/** The view with the client's whole transcript as `items`. */
	readonly view: TranscriptView;
	/** The page before the oldest entry is loading. */
	readonly loadingEarlier: boolean;
	/** Gaps being filled, by `gapKey`. */
	readonly filling: ReadonlySet<string>;
};

/** A gap's stable key, also its transcript row's. */
export const gapKey = (gap: Gap): string => `gap-${gap.after}`;

/** What the store follows: the conversation's view and its entry pages (the current `Chat` reference's). */
export type TranscriptSource = {
	readonly view: Readable<ConversationView | null | undefined>;
	readonly entries: EntriesSource;
};

/** Entries per `Chat.entries` page the transcript asks for (pages are also cut at about a megabyte). */
const PAGE_SIZE = 100;

/**
 * A conversation's transcript, following its view readable while someone subscribes. A value that does not come as
 * operations (the first, a reconnect's) is checked first: a transcript holding entries newer than the view's newest is
 * gone from the server (restored from an older backup) and starts over, as does a transcript kept on the device
 * (`seed`) that the first view does not continue. Otherwise the transcript grows: a view past what it has adds a gap.
 */
export class TranscriptStore {
	#source: TranscriptSource;
	#transcript: ConversationTranscript;
	readonly #listeners = new Set<() => void>();
	#stop: (() => void) | undefined;
	/** The transcript came from the device: the next view must continue it. */
	#seeded = false;
	value: Pages | undefined;

	constructor(source: TranscriptSource) {
		this.#source = source;
		this.#transcript = this.#fresh();
	}

	/** Whether someone follows the view. */
	get following(): boolean {
		return this.#stop !== undefined;
	}

	/** Follows `source` from now on (a new reference to the same conversation). */
	follow(source: TranscriptSource): void {
		const changed = source.view !== this.#source.view;
		this.#source = source;
		if (!changed || this.#stop === undefined) return;
		this.#stop();
		this.#stop = undefined;
		this.#start();
	}

	/** Follows the view while subscribed; `listener` hears every change of `value`. */
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		if (!this.#stop) this.#start();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size > 0) return;
			this.#stop?.();
			this.#stop = undefined;
		};
	};

	/** Starts from a transcript kept on the device before anything arrived: shown meanwhile (see the class). */
	seed(kept: ConversationView): void {
		if (this.value !== undefined) return;
		this.#seeded = true;
		this.#set({ view: this.#transcript.merge(kept), loadingEarlier: false, filling: new Set() });
	}

	/** Loads the page before the oldest entry; nothing while one loads or when the transcript starts there. */
	async loadEarlier(): Promise<void> {
		const pages = this.value;
		if (!pages || pages.loadingEarlier || pages.view.items[0]?.kind !== "earlier") return;
		const transcript = this.#transcript;
		this.#set({ ...pages, loadingEarlier: true });
		try {
			const view = await transcript.loadEarlier(BACKGROUND_CONTEXT);
			if (transcript === this.#transcript && this.value) this.#set({ ...this.value, view, loadingEarlier: false });
		} catch (error) {
			if (transcript === this.#transcript && this.value) this.#set({ ...this.value, loadingEarlier: false });
			throw error;
		}
	}

	/** Loads the next page of `gap`; nothing while it loads. */
	async fillGap(gap: Gap): Promise<void> {
		const pages = this.value;
		const key = gapKey(gap);
		if (!pages || pages.filling.has(key)) return;
		const transcript = this.#transcript;
		this.#set({ ...pages, filling: new Set([...pages.filling, key]) });
		const done = (): Set<string> => new Set([...(this.value?.filling ?? [])].filter((each) => each !== key));
		try {
			const view = await transcript.fillGap(gap, BACKGROUND_CONTEXT);
			if (transcript === this.#transcript && this.value) this.#set({ ...this.value, view, filling: done() });
		} catch (error) {
			if (transcript === this.#transcript && this.value) this.#set({ ...this.value, filling: done() });
			throw error;
		}
	}

	/**
	 * Loads pages until entry `entryId` is held (a search hit or a quoted message): earlier pages, or the gap it lies in.
	 * False when it is not in this conversation's transcript, or nothing is loaded.
	 */
	async loadThrough(entryId: number): Promise<boolean> {
		for (;;) {
			const items = this.value?.view.items;
			if (!items) return false;
			if (items.some((item) => item.kind === "entry" && item.entry.id === entryId)) return true;
			const gap = items.find(
				(item): item is Gap => item.kind === "gap" && item.after < entryId && entryId < item.upTo,
			);
			const oldest = items.find((item) => item.kind === "entry");
			if (gap) await this.fillGap(gap);
			else if (items[0]?.kind === "earlier" && (oldest === undefined || entryId < oldest.entry.id))
				await this.loadEarlier();
			else return false;
			// Another caller's load of the same page runs: wait for it.
			while (this.value?.loadingEarlier || (this.value?.filling.size ?? 0) > 0) await this.#changed();
		}
	}

	#changed(): Promise<void> {
		return new Promise((resolve) => {
			const stop = this.subscribe(() => {
				queueMicrotask(stop);
				resolve();
			});
		});
	}

	#fresh(): ConversationTranscript {
		return new ConversationTranscript(
			async (query, limit) => {
				const page = await this.#source.entries({ ...query, limit });
				return { items: page.items, ...(page.more ? { next: {} } : {}) };
			},
			{ pageSize: PAGE_SIZE },
		);
	}

	#start(): void {
		let last: ConversationView | null | undefined;
		this.#stop = this.#source.view.events((event) => {
			const view = event.value;
			if (!view || view === last) {
				last = view;
				return;
			}
			last = view;
			if (event.type !== "ops" && !this.#continues(view)) {
				this.#transcript = this.#fresh();
				this.value = undefined;
			}
			this.#seeded = false;
			const merged = this.#transcript.merge(view);
			if (merged !== this.value?.view)
				this.#set({ loadingEarlier: false, filling: new Set(), ...this.value, view: merged });
		});
	}

	/** Whether `view`, not received as operations, may be merged into what is held (see the class). */
	#continues(view: ConversationView): boolean {
		const held = this.#transcript.newest;
		if (held === undefined) return true;
		const newest = view.entries.at(-1)?.id ?? view.before;
		if (newest === undefined || held > newest) return false;
		return !this.#seeded || view.before === undefined || view.before <= held;
	}

	#set(value: Pages): void {
		this.value = value;
		for (const listener of [...this.#listeners]) listener();
	}
}

/** Transcript stores of a host (a page, a TUI) by conversation (`session#conversation`), the most recently used last. */
const hosts = new WeakMap<object, Map<string, TranscriptStore>>();
/** How many conversations keep their pages while nobody views them. */
const RETAINED = 4;

/** The one transcript store of conversation `key` on `host`, following `source` (its current reference's). */
export function transcriptOf(host: object, key: string, source: TranscriptSource): TranscriptStore {
	let stores = hosts.get(host);
	if (!stores) {
		stores = new Map();
		hosts.set(host, stores);
	}
	let store = stores.get(key);
	if (store) {
		stores.delete(key);
		store.follow(source);
	} else store = new TranscriptStore(source);
	stores.set(key, store);
	for (const [other, candidate] of stores) {
		if (stores.size <= RETAINED) break;
		if (!candidate.following && candidate !== store) stores.delete(other);
	}
	return store;
}

/**
 * The newest entries of `view` without a gap among them, as a view the next start seeds a transcript with
 * (`TranscriptStore.seed`), at most `maxBytes` of them (at least one). `before` is the entry just before them, absent
 * when they start the conversation.
 */
export function keptWindow(view: TranscriptView, maxBytes: number): ConversationView {
	const { items } = view;
	let start = items.length;
	let bytes = 0;
	while (start > 0) {
		const item = items[start - 1]!;
		if (item.kind !== "entry") break;
		const size = JSON.stringify(item.entry).length;
		if (start < items.length && bytes + size > maxBytes) break;
		bytes += size;
		start--;
	}
	const entries = items.slice(start).flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
	const first = entries[0];
	return {
		conversation: view.conversation,
		docs: view.docs,
		entries,
		// Any ID below the first kept one bounds what is known; entry IDs are numbers with a type brand.
		...(start === 0 || !first ? {} : { before: (first.id - 1) as EntryId }),
	};
}

/** A transcript store's pages as a readable (for subscribers that take one, such as the TUI's `follow`). */
export function pagesReadable(store: TranscriptStore): Readable<Pages | undefined> {
	return {
		get value() {
			return store.value;
		},
		subscribe: (listener) => {
			const stop = store.subscribe(() => listener(store.value));
			listener(store.value);
			return stop;
		},
		events: (listener) => {
			const stop = store.subscribe(() => listener({ type: "reset", value: store.value }));
			listener({ type: "snap", value: store.value });
			return stop;
		},
	};
}
