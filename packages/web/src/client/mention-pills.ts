// Stored `<mention id by ts> </mention>` markup as upstream's atomic monolith pill, and back.

/** `assistantNames`: settings `ai.assistants` names by system user id, which upstream merges into its participant names. */
export type MentionAccount = {
	/** A workflowy.com account's numeric id, or a standalone profile's id. */
	userId: number | string;
	fullName: string | null;
	joinedAt?: string;
	assistantNames?: Record<string, string>;
} | null;

const BOM = "﻿";
export const MENTION_PATTERN = /<mention\b([^>]*)>[\s\S]*?<\/mention>/giu;

export interface MentionAttrs {
	id: string;
	by: string | null;
	ts: string | null;
}

function attr(attrText: string, name: string): string | null {
	const match = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(attrText);
	return match === null ? null : (match[1] ?? match[2] ?? "");
}

export function parseMentionAttrs(attrText: string): MentionAttrs {
	return {id: attr(attrText, "id") ?? "", by: attr(attrText, "by"), ts: attr(attrText, "ts")};
}

export function resolveMentionName(id: string, account: MentionAccount): string {
	switch (id) {
		case "0": {
			return "everyone";
		}
		case "-2": {
			return "Workflowy";
		}
		case "-10": {
			return "AI";
		}
		default: {
			if (account === null) {
				return "Unknown";
			}
			return id === String(account.userId)
				? (account.fullName ?? "Unknown")
				: (account.assistantNames?.[id] ?? "Unknown");
		}
	}
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function attrString({id, by, ts}: MentionAttrs): string {
	return [`id="${id}"`, ...(by === null ? [] : [`by="${by}"`]), ...(ts === null ? [] : [`ts="${ts}"`])].join(" ");
}

/** Display-mode HTML: each stored `<mention>` becomes upstream's non-editable monolith pill with the resolved name. */
export function renderMentionPills(html: string, account: MentionAccount): string {
	return html.replaceAll(MENTION_PATTERN, (_match, text: string) => {
		const attrs = parseMentionAttrs(text);
		const self = account !== null && attrs.id === String(account.userId);
		const classes = `mention view-mode monolith-pill explosive${self ? " mention-of-current-user" : ""}`;
		const label = escapeHtml(resolveMentionName(attrs.id, account));
		return `<mention data-monolith="true" contenteditable="false" class="${classes}" ${attrString(attrs)}>${BOM}<span class="content-wrapper"><span class="at-sign"></span>${label}</span>${BOM}</mention>`;
	});
}

/**
 * Stored HTML from editor HTML: each `<mention>` (rendered or raw, any inner text) becomes
 * canonical markup with a single-space inner text, a mention without an id is dropped, and the
 * pills' U+FEFF caret guards are removed.
 */
export function serializeMentionPills(html: string): string {
	return html
		.replaceAll(MENTION_PATTERN, (_match, text: string) => {
			const attrs = parseMentionAttrs(text);
			return attrs.id === "" ? "" : `<mention ${attrString(attrs)}> </mention>`;
		})
		.replaceAll(BOM, "");
}
