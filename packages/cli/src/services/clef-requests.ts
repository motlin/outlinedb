import type {LabelKind, PoolLabel} from "./label-pool.js";

/** Clef model name for the request body `model` field. */
export type ClefModel = "clef" | "clef-flash";

/** The entry Clef reads; the same state goes to both passes. */
export interface ClefState {
	readonly date: string;
	readonly parent: string;
	readonly entry: string;
}

export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string | null>>;
}

export interface NoulQuestion {
	readonly type: "noul";
	readonly instructions: string;
}

export interface ClefRequest<Q> {
	readonly model: ClefModel;
	readonly state: ClefState;
	readonly questions: Readonly<Record<string, Q>>;
}

export interface ChoiceAnswer {
	readonly type: "choice";
	readonly choice: string;
	readonly probabilities: Readonly<Record<string, number>>;
	readonly confidence: number;
}

export interface NoulAnswer {
	readonly type: "noul";
	/** Probability of yes, 0 to 1. */
	readonly noul: number;
}

export type ClefAnswer = ChoiceAnswer | NoulAnswer;

/** The unwrapped Workers AI `result` of a Clef run. */
export interface ClefResult {
	readonly model: string;
	readonly answers: Record<string, ClefAnswer>;
	readonly usage: {readonly input_tokens: number; readonly output_tokens: number};
}

/** Sends one Clef request and returns its unwrapped result. */
export interface ClefClient {
	run(request: ClefRequest<ChoiceQuestion | NoulQuestion>): Promise<ClefResult>;
}

export interface ShortlistEntry {
	readonly label: PoolLabel;
	/** Pass 1 choice probability, stored as `clef-flash-shortlist`. */
	readonly score: number;
}

/** Clef allows 255 options per `choice`; one is reserved for {@link NONE_OPTION}. */
const SHARD_SIZE = 254;
const NONE_OPTION = "none";
const MAX_QUESTIONS = 64;
/** Stays well under Clef-flash's 24,576-token window. */
const MAX_REQUEST_TOKENS = 20_000;
/** Pass 1 options kept per shard, by label kind; people get more because homonyms spread their probability. */
const SHORTLIST_TOP_PER_SHARD: Readonly<Record<LabelKind, number>> = {person: 16, tag: 8};
const SHORTLIST_MIN_PROBABILITY = 0.05;

const CLEF_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const CHARS_PER_TOKEN = 3.5;

const SHARD_TEXT: Readonly<Record<LabelKind, {prefix: string; instructions: string; none: string}>> = {
	person: {
		prefix: "people",
		instructions: "Which one of these people does this journal entry most likely involve?",
		none: "None of these people",
	},
	tag: {
		prefix: "tags",
		instructions: "Which one of these tags best describes this journal entry?",
		none: "None of these tags",
	},
};

/** Rough token count for a request body: serialized characters / 3.5. */
export function estimateTokens(body: unknown): number {
	return Math.ceil(JSON.stringify(body).length / CHARS_PER_TOKEN);
}

/**
 * Pass 1: the pool as `choice` shards (people and tags apart, at most 254 labels plus `none` each),
 * packed into as few requests as fit under {@link MAX_REQUEST_TOKENS} and {@link MAX_QUESTIONS}. Pure.
 */
export function buildShortlistRequests(
	state: ClefState,
	pool: readonly PoolLabel[],
	model: ClefModel = "clef-flash",
): ClefRequest<ChoiceQuestion>[] {
	const shards: [string, ChoiceQuestion][] = [];
	for (const kind of ["person", "tag"] as const) {
		const labels = pool.filter((label) => label.kind === kind);
		const text = SHARD_TEXT[kind];
		for (let start = 0; start < labels.length; start += SHARD_SIZE) {
			const criteria: Record<string, string | null> = {};
			for (const label of labels.slice(start, start + SHARD_SIZE)) {
				criteria[validId(label.optionId)] = label.description === "" ? null : label.description;
			}
			criteria[NONE_OPTION] = text.none;
			shards.push([
				`${text.prefix}.${start / SHARD_SIZE + 1}`,
				{type: "choice", instructions: text.instructions, criteria},
			]);
		}
	}

	const requests: ClefRequest<ChoiceQuestion>[] = [];
	let questions: Record<string, ChoiceQuestion> = {};
	for (const [id, question] of shards) {
		const candidate = {...questions, [id]: question};
		const full = Object.keys(questions).length >= MAX_QUESTIONS;
		if (
			Object.keys(questions).length > 0 &&
			(full || estimateTokens({model, state, questions: candidate}) > MAX_REQUEST_TOKENS)
		) {
			requests.push({model, state, questions});
			questions = {[id]: question};
		} else {
			questions = candidate;
		}
	}
	if (Object.keys(questions).length > 0) {
		requests.push({model, state, questions});
	}
	return requests;
}

/**
 * Picks the shortlist from pass 1 answers: per shard the top K options for the label kind
 * (default {@link SHORTLIST_TOP_PER_SHARD}) plus any at or above 0.05, minus `none` and unknown ids,
 * deduplicated, best first. Pure.
 */
export function selectShortlist(
	pool: readonly PoolLabel[],
	answers: Readonly<Record<string, ChoiceAnswer>>,
	topPerShard: Readonly<Record<LabelKind, number>> = SHORTLIST_TOP_PER_SHARD,
): ShortlistEntry[] {
	const byId = new Map(pool.map((label) => [label.optionId, label]));
	const selected = new Map<string, ShortlistEntry>();
	for (const answer of Object.values(answers)) {
		const ranked = Object.entries(answer.probabilities)
			.flatMap(([id, score]) => {
				const label = byId.get(id);
				return label === undefined ? [] : [{label, score}];
			})
			.toSorted((a, b) => b.score - a.score);
		for (const [index, entry] of ranked.entries()) {
			const previous = selected.get(entry.label.optionId);
			if (
				(index < topPerShard[entry.label.kind] || entry.score >= SHORTLIST_MIN_PROBABILITY) &&
				(previous === undefined || previous.score < entry.score)
			) {
				selected.set(entry.label.optionId, entry);
			}
		}
	}
	return [...selected.values()].toSorted((a, b) => b.score - a.score);
}

/** Pass 2: one `noul` per shortlisted label, the best {@link MAX_QUESTIONS} by shortlist score. Pure. */
export function buildVerifyRequest(
	state: ClefState,
	shortlist: readonly ShortlistEntry[],
	model: ClefModel = "clef-flash",
): ClefRequest<NoulQuestion> {
	const questions: Record<string, NoulQuestion> = {};
	const best = shortlist.toSorted((a, b) => b.score - a.score).slice(0, MAX_QUESTIONS);
	for (const {label} of best) {
		questions[validId(label.optionId)] = {type: "noul", instructions: verifyInstructions(label)};
	}
	return {model, state, questions};
}

function verifyInstructions(label: PoolLabel): string {
	const described = label.description === "" ? label.label : `${label.label} (${label.description})`;
	return label.kind === "person"
		? `Does this journal entry involve ${described}?`
		: `Does this journal entry describe doing ${described}?`;
}

function validId(id: string): string {
	if (!CLEF_ID.test(id)) {
		throw new Error(`Invalid Clef id: ${id}`);
	}
	return id;
}
