// When the person talking interrupts the agent: only once the speech service heard real words. The barge-in
// detector (barge-in.ts) and the service's VAD may both take noise (windshield wipers, a door) for speech, so neither
// stops anything on its own:
//
// - A barge-in trigger while the agent's speech plays only opens a candidate: the microphone (from a second before)
//   streams to the room while the agent goes on speaking. No `speech_start` from the room within CANDIDATE_START_MS:
//   the candidate is dropped (`dropStream`) and the microphone goes back to being buffered.
// - Words decide: the first interim (or final) transcript with a real word (not empty, not a filler such as "um", not
//   the agent's own words picked up from the speaker) interrupts at once: the agent's speech is cut and its run is
//   stopped, as the Stop button would (in chat mode only when the words are for the agent, or a stop command; there
//   people talking with each other cut the agent's speech, never its work). This holds while the agent only works
//   too: the speaker no longer waits for the end of the utterance.
// - A final without such words is dropped: never sent as a message, and nothing was interrupted.
//
// A service without interim transcripts interrupts at the final (after the utterance), by the same rule.
import { isStopCommand } from "./speech-text.ts";
import { voiceMessage } from "./transcripts.ts";

/** What the engine knows when words arrive. */
export type InterruptionState = {
	/** The agent works (its run is live). */
	busy: boolean;
	/** The agent's speech is asked for or plays. */
	speaking: boolean;
	chatMode: boolean;
	agentName: string | undefined;
	/** What the agent said lately (its latest answers' text), to tell an echo from the speaker's words. */
	said: () => readonly string[];
};

export type InterruptionDeps = {
	state: () => InterruptionState;
	/** Cuts the agent's speech (for the room) and never reads the rest of the answers known so far. */
	cutSpeech: () => void;
	/** Stops the run (`PendingTranscripts.stopping`: sends wait for it, withdrawn messages go with the next one). */
	stopRun: () => void;
	/** Ends the candidate's stream: back to buffering, the room's VAD reset. */
	dropStream: () => void;
	log: (message: string) => void;
	now?: () => number;
};

/** How long a barge-in candidate may stream before the room reports speech; past it, it was noise. */
export const CANDIDATE_START_MS = 1500;

/** Words that are no message: hesitation and backchannel sounds, as Parakeet writes them for noise or breath. */
const FILLERS = new Set([
	"uh",
	"uhm",
	"um",
	"umm",
	"hm",
	"hmm",
	"mm",
	"mmm",
	"mhm",
	"mm-hmm",
	"uh-huh",
	"ah",
	"oh",
	"eh",
	"er",
	"erm",
	"huh",
	"ha",
]);

const wordsOf = (text: string): string[] =>
	(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter((word) => !FILLERS.has(word));

/** Whether a transcript holds a real word: one that is no filler, and longer than a letter unless it is a number. */
export function meaningful(text: string): boolean {
	return wordsOf(text).some((word) => word.length > 1 || /\p{N}/u.test(word));
}

/**
 * Whether `text` is the agent's speech heard back through the speaker: three words or more, every one of them among
 * the words the agent said. Shorter replies ("yes", "no, stop") are the speaker's, even when the agent used them.
 */
export function isEcho(text: string, said: readonly string[]): boolean {
	const words = wordsOf(text);
	if (words.length < 3) return false;
	const known = new Set(said.flatMap(wordsOf));
	return words.every((word) => known.has(word));
}

export class Interruption {
	readonly #deps: InterruptionDeps;
	/** A barge-in trigger not yet confirmed: when it fired, and whether the room has reported speech since. */
	#candidate: { at: number; heard: boolean } | undefined;
	/** What this utterance did already: each happens once per utterance. */
	#cut = false;
	#stopped = false;

	constructor(deps: InterruptionDeps) {
		this.#deps = deps;
	}

	/** A candidate streams and waits for words: the microphone keeps streaming while the agent speaks. */
	get pending(): boolean {
		return this.#candidate !== undefined;
	}

	/** The barge-in detector fired: its stream starts, nothing is interrupted yet. */
	trigger(): void {
		if (this.#candidate) return;
		this.#candidate = { at: this.#now(), heard: false };
		this.#deps.log("barge-in candidate: streaming, waiting for words");
	}

	/** The room heard speech start. */
	speechStart(): void {
		if (this.#candidate) this.#candidate.heard = true;
	}

	/** Called with each microphone frame: a candidate the room never heard as speech is dropped. */
	tick(): void {
		const candidate = this.#candidate;
		if (!candidate || candidate.heard || this.#now() - candidate.at < CANDIDATE_START_MS) return;
		this.#drop("no speech heard");
	}

	/** An interim transcript of the utterance in progress. */
	interim(text: string): void {
		this.#consider(text);
	}

	/**
	 * The utterance's final transcript: whether it is a message to send (words, and not the agent's own heard back),
	 * and whether this utterance stopped the run. It interrupts first if its interim transcripts did not.
	 */
	final(text: string): { send: boolean; stopped: boolean } {
		const candidate = this.#candidate;
		const send = meaningful(text) && (this.#cut || this.#stopped || !this.#echo(text));
		if (send) this.#consider(text);
		else if (candidate) this.#drop(text.trim() ? "no words, or the agent's own" : "nothing recognized");
		else if (text.trim()) this.#deps.log(`final dropped: no words (${text.trim().length} chars)`);
		const stopped = this.#stopped;
		this.reset();
		return { send, stopped };
	}

	/** Forgets the utterance in progress (the room's connection ended, the microphone was muted). */
	reset(): void {
		this.#candidate = undefined;
		this.#cut = false;
		this.#stopped = false;
	}

	#consider(text: string): void {
		if (!meaningful(text) || (!this.#cut && !this.#stopped && this.#echo(text))) return;
		const state = this.#deps.state();
		const addressed = voiceMessage(text, state.chatMode, state.agentName).interrupts || isStopCommand(text);
		const cut = state.speaking && !this.#cut;
		const stop = state.busy && addressed && !this.#stopped;
		this.#candidate = undefined;
		if (!cut && !stop) return;
		this.#cut ||= cut;
		this.#stopped ||= stop;
		this.#deps.log(
			`interrupted by speech: ${[cut && "speech cut", stop && "run stopped"].filter(Boolean).join(", ")}`,
		);
		if (cut) this.#deps.cutSpeech();
		if (stop) this.#deps.stopRun();
	}

	/** Words heard while the agent speaks (or a candidate streams) that are all the agent's own. */
	#echo(text: string): boolean {
		const state = this.#deps.state();
		return (state.speaking || this.#candidate !== undefined) && isEcho(text, state.said());
	}

	#drop(reason: string): void {
		this.#candidate = undefined;
		this.#deps.log(`barge-in candidate dropped (${reason}); the agent goes on`);
		this.#deps.dropStream();
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}
}
