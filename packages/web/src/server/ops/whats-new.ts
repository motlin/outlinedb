/**
 * Our own What's New read state, kept in our database (`whats_new_reads`) rather than upstream's root metadata
 * `changelog.read`, which belongs to upstream's entries. Needs no internal API.
 */

import {z} from "zod";
import {markWhatsNewRead, readWhatsNewReads} from "@workflowy/shared/cache";
import {defineOp, ok} from "./define.js";

/** Every entry id of ours that was read, sorted. */
export const WhatsNewReadSchema = z.strictObject({read: z.array(z.string())});

/** Which of our What's New entries were read. */
export const whatsNewGet = defineOp({
	input: z.object({}),
	output: WhatsNewReadSchema,
	run(ctx) {
		return ok({read: readWhatsNewReads(ctx.db)});
	},
});

/** Marks entries read (already-read ones are kept as they are) and answers every read entry. */
export const whatsNewMarkRead = defineOp({
	input: z.strictObject({entries: z.array(z.string().regex(/^[a-z0-9_]+$/u))}),
	output: WhatsNewReadSchema,
	run(ctx, {entries}) {
		markWhatsNewRead(ctx.db, entries);
		return ok({read: readWhatsNewReads(ctx.db)});
	},
});
