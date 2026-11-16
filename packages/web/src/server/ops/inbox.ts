/**
 * `GET /api/v1/inbox/share?title=&text=&url=` -> 302 to the Inbox: the web manifest's
 * Share to Workflowy target (a Web Share Target). The shared fields, blanks and a url the
 * text already holds left out, become one item at the top of the Inbox, written locally (a
 * mirror's write also queues outbox rows for the drain). 400 when nothing was shared, 409 when
 * the outline has no Inbox, 503 for a mirror without the internal API.
 */

import {findInbox} from "@outlinedb/shared/cache";
import {InboxMissing} from "@outlinedb/shared/internal";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import {defineOp, fail, ok} from "./define.js";
import {getNodeWriter} from "./nodes-shared.js";
import {NoContentSchema} from "./schemas.js";

const NOTHING_SHARED = "Share a title, text or url";

/** `&` first, then `>` and `<`, like upstream's `HL`: item names are HTML. */
function escapeHtml(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll(">", "&gt;").replaceAll("<", "&lt;");
}

/** The shared fields as one item name, or undefined when all are blank. */
function sharedItemName(shared: {title?: string; text?: string; url?: string}): string | undefined
{
	const title = shared.title?.trim() ?? "";
	const text = shared.text?.trim() ?? "";
	const url = shared.url?.trim() ?? "";
	const parts = [title, text, text.includes(url) ? "" : url].filter((part) => part !== "");
	return parts.length === 0 ? undefined : escapeHtml(parts.join(" "));
}

export const inboxShare = defineOp(
	{
		input: z.object(
			{
				title: z.string().optional(),
				text: z.string().optional(),
				url: z.string().optional(),
			},
		),
		/** The value is always null: the Inbox URL travels in `meta.redirect`. */
		output: NoContentSchema,
		run(ctx: ServerContext, input)
		{
			const name = sharedItemName(input);
			if (name === undefined)
			{
				return fail(
					400,
					{
						error: NOTHING_SHARED,
					},
				);
			}
			const writer = getNodeWriter(ctx);
			if (writer === undefined)
			{
				return fail(
					503,
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				);
			}
			const inbox = findInbox(ctx.db);
			if (inbox === undefined)
			{
				return fail(
					409,
					{
						error: new InboxMissing().message,
					},
				);
			}
			writer.local.createAt(
				{
					parentId: inbox.id,
					index: 0,
					name,
				},
			);
			return ok(
				null,
				{
					redirect: `/#/${inbox.id.slice(-12)}`,
				},
			);
		},
	},
);
