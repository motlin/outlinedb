import {setTimeout as delay} from "node:timers/promises";
import {z} from "zod";
import type {ChoiceQuestion, ClefClient, ClefRequest, ClefResult, NoulQuestion} from "./clef-requests.js";

const ClefAnswerSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("choice"),
		choice: z.string(),
		probabilities: z.record(z.string(), z.number()),
		confidence: z.number(),
	}),
	z.object({type: z.literal("noul"), noul: z.number()}),
]);

const ClefResultSchema = z.object({
	model: z.string(),
	answers: z.record(z.string(), ClefAnswerSchema),
	usage: z.object({input_tokens: z.number(), output_tokens: z.number()}),
});

const SuccessEnvelopeSchema = z.object({success: z.literal(true), result: z.unknown()});

/** Only the error fields; a failed call's `result` is `null` or `{}`, so it is not validated here. */
const ErrorEnvelopeSchema = z.object({
	errors: z.array(z.object({message: z.string().optional()})).optional(),
});

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;

/** Runs Clef requests against the Workers AI REST API, retrying 429 and 5xx with exponential backoff. */
export class WorkersAiClefClient implements ClefClient {
	constructor(
		private readonly accountId: string,
		private readonly token: string,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly sleep: (ms: number) => Promise<unknown> = delay,
	) {}

	async run(request: ClefRequest<ChoiceQuestion | NoulQuestion>): Promise<ClefResult> {
		for (let attempt = 1; ; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- retries are sequential by design
			const response = await this.post(request);
			// oxlint-disable-next-line no-await-in-loop -- retries are sequential by design
			const text = await response.text();
			const body = parseJson(text);
			const success = SuccessEnvelopeSchema.safeParse(body);
			if (response.ok && success.success) {
				return validateResult(request, success.data.result);
			}
			const retryable = response.status === 429 || response.status >= 500;
			if (!retryable || attempt >= MAX_ATTEMPTS) {
				throw new Error(
					`Workers AI ${request.model} request failed (${response.status}): ${errorMessage(body, text)}`,
				);
			}
			// oxlint-disable-next-line no-await-in-loop -- backoff between sequential attempts
			await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
		}
	}

	private async post(request: ClefRequest<ChoiceQuestion | NoulQuestion>): Promise<Response> {
		return this.fetchFn(
			`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/@cf/cloudflare/${request.model}`,
			{
				method: "POST",
				headers: {Authorization: `Bearer ${this.token}`, "Content-Type": "application/json"},
				body: JSON.stringify(request),
			},
		);
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function errorMessage(body: unknown, text: string): string {
	const parsed = ErrorEnvelopeSchema.safeParse(body);
	const messages = parsed.success
		? (parsed.data.errors ?? []).flatMap(({message}) => (message === undefined ? [] : [message]))
		: [];
	return messages.length > 0 ? messages.join("; ") : text.slice(0, 200);
}

/** Checks the result's shape and that every question got an answer of its own type. */
function validateResult(request: ClefRequest<ChoiceQuestion | NoulQuestion>, result: unknown): ClefResult {
	const mismatch = (detail: string) =>
		new Error(`Workers AI ${request.model} response did not match the Clef schema: ${detail}`);
	const parsed = ClefResultSchema.safeParse(result);
	if (!parsed.success) {
		throw mismatch(z.prettifyError(parsed.error));
	}
	const problems = Object.entries(request.questions).flatMap(([id, question]) => {
		const answer = parsed.data.answers[id];
		if (answer === undefined) {
			return [`${id}: missing answer`];
		}
		return answer.type === question.type ? [] : [`${id}: expected a ${question.type} answer, got ${answer.type}`];
	});
	if (problems.length > 0) {
		throw mismatch(problems.join("; "));
	}
	return parsed.data;
}
