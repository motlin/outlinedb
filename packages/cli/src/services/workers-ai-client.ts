import {z} from "zod";
import type {ChoiceQuestion, ClefRequest, ClefResult, NoulQuestion} from "./clef-requests.js";

const ClefAnswerSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("choice"),
		choice: z.string(),
		probabilities: z.record(z.string(), z.number()),
		confidence: z.number(),
	}),
	z.object({type: z.literal("noul"), noul: z.number()}),
]);

const EnvelopeSchema = z.object({
	success: z.boolean().optional(),
	errors: z.array(z.object({message: z.string().optional()})).optional(),
	result: z
		.object({
			model: z.string(),
			answers: z.record(z.string(), ClefAnswerSchema),
			usage: z.object({input_tokens: z.number(), output_tokens: z.number()}),
		})
		.nullish(),
});

/** Runs Clef requests against the Workers AI REST API. */
export class WorkersAiClefClient {
	constructor(
		private readonly accountId: string,
		private readonly token: string,
		private readonly fetchFn: typeof fetch = fetch,
	) {}

	async run(request: ClefRequest<ChoiceQuestion | NoulQuestion>): Promise<ClefResult> {
		const response = await this.fetchFn(
			`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/@cf/cloudflare/${request.model}`,
			{
				method: "POST",
				headers: {Authorization: `Bearer ${this.token}`, "Content-Type": "application/json"},
				body: JSON.stringify(request),
			},
		);
		const envelope = EnvelopeSchema.parse(await response.json());
		if (!response.ok || envelope.success !== true || envelope.result == null) {
			const errors = envelope.errors?.map(({message}) => message).join("; ") ?? "";
			throw new Error(`Workers AI ${request.model} request failed (${response.status}): ${errors}`);
		}
		return envelope.result;
	}
}
