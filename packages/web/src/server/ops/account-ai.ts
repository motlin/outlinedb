import {z} from "zod";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok} from "./define.js";

/** Upstream's `ai.context_limit` fallback: a subtree with more items is "Too Much to Process". */
const DEFAULT_CONTEXT_LIMIT = 500;

const PromptButtonSchema = z.strictObject({
	id: z.string().nullable(),
	name: z.string().nullable(),
	icon: z.string().nullable(),
});

/**
 * The account's AI chat settings, from settings `ai.*` and root metadata `ai.mailboxId`
 * (upstream's "AI Messages" container under Home). `defaultAgentId` is the payload's
 * `ai.default_agent_id`; upstream reads `ai.default_assistant`, which the live payload omits.
 */
export const AccountAiResponseSchema = z.strictObject({
	assistants: z.array(
		z.strictObject({
			id: z.string(),
			name: z.string().nullable(),
			model: z.string().nullable(),
			systemUserId: z.number().nullable(),
		}),
	),
	defaultAgentId: z.string().nullable(),
	promptButtons: z.strictObject({draft: z.array(PromptButtonSchema), reply: z.array(PromptButtonSchema)}),
	contextLimit: z.number(),
	mailboxId: z.string().nullable(),
});

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function promptButtons(value: unknown): z.output<typeof PromptButtonSchema>[] {
	return list(value).map((button) => {
		const fields = record(button);
		return {id: text(fields.id), name: text(fields.name), icon: text(fields.icon)};
	});
}

export const accountAi = defineOp({
	input: z.object({}),
	output: AccountAiResponseSchema,
	async run(ctx) {
		const adapter = ctx.internalAdapter?.();
		if (!adapter) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}
		const [settings, mailboxId] = await Promise.all([
			adapter.getSetting("ai"),
			adapter.getRootMeta(["ai", "mailboxId"]),
		]);
		const ai = record(settings);
		const buttons = record(ai.prompt_buttons);
		return ok({
			assistants: list(ai.assistants).flatMap((assistant) => {
				const fields = record(assistant);
				const id = text(fields.id);
				return id === null
					? []
					: [
							{
								id,
								name: text(fields.name),
								model: text(fields.model),
								systemUserId: integer(fields.system_user_id),
							},
						];
			}),
			defaultAgentId: text(ai.default_agent_id),
			promptButtons: {draft: promptButtons(buttons.draft), reply: promptButtons(buttons.reply)},
			contextLimit: integer(ai.context_limit) ?? DEFAULT_CONTEXT_LIMIT,
			mailboxId: text(mailboxId),
		});
	},
});
