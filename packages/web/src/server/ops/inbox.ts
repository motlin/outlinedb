/**
 * `GET /api/v1/inbox/share?title=&text=&url=` -> 302 to the Inbox: the web manifest's
 * Share to Workflowy target (a Web Share Target). The shared fields, blanks and a url the
 * text already holds left out, become one item at the top of the Inbox, which the adapter
 * finds (or, standalone, creates). 400 when nothing was shared, 409 when workflowy.com has no
 * Inbox, 503 without the internal API.
 */

import {InboxMissing} from "@outlinedb/shared/internal";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok} from "./define.js";
import {NoContentSchema} from "./schemas.js";

const NOTHING_SHARED = "Share a title, text or url";

/** `&` first, then `>` and `<`, like upstream's `HL`: item names are HTML. */
function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll(">", "&gt;").replaceAll("<", "&lt;");
}

/** The shared fields as one item name, or undefined when all are blank. */
function sharedItemName(shared: {title?: string; text?: string; url?: string}): string | undefined {
	const title = shared.title?.trim() ?? "";
	const text = shared.text?.trim() ?? "";
	const url = shared.url?.trim() ?? "";
	const parts = [title, text, text.includes(url) ? "" : url].filter((part) => part !== "");
	return parts.length === 0 ? undefined : escapeHtml(parts.join(" "));
}

export const inboxShare = defineOp({
	input: z.object({title: z.string().optional(), text: z.string().optional(), url: z.string().optional()}),
	/** The value is always null: the Inbox URL travels in `meta.redirect`. */
	output: NoContentSchema,
	async run(ctx: ServerContext, input) {
		const name = sharedItemName(input);
		if (name === undefined) {
			return fail(400, {error: NOTHING_SHARED});
		}
		// Tree writes refresh the cache through the public API, so they need its key too.
		const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
		if (!adapter) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}
		try {
			const {inboxId} = await adapter.addToInbox({name});
			return ok(null, {redirect: `/#/${inboxId.slice(-12)}`});
		} catch (error) {
			if (error instanceof InboxMissing) {
				return fail(409, {error: error.message});
			}
			throw error;
		}
	},
});
