import {describe, expect, it} from "vite-plus/test";
import {
	parseMentionAttrs,
	renderMentionPills,
	resolveMentionName,
	serializeMentionPills,
} from "../src/client/mention-pills.js";

const BOM = "﻿";
const ACCOUNT = {userId: 7, fullName: "Alice Smith"};

function pill(classes: string, attrs: string, label: string): string {
	return `<mention data-monolith="true" contenteditable="false" class="${classes}" ${attrs}>${BOM}<span class="content-wrapper"><span class="at-sign"></span>${label}</span>${BOM}</mention>`;
}

describe("parseMentionAttrs", () => {
	it("reads id, by and ts, and null for the absent ones", () => {
		expect([
			parseMentionAttrs(' id="0" by="7" ts="5"'),
			parseMentionAttrs(" ID='42'"),
			parseMentionAttrs(""),
		]).toStrictEqual([
			{id: "0", by: "7", ts: "5"},
			{id: "42", by: null, ts: null},
			{id: "", by: null, ts: null},
		]);
	});
});

describe("resolveMentionName", () => {
	it("names the system ids, the account's own id, and everything else Unknown", () => {
		expect(["0", "-2", "-10", "7", "42"].map((id) => resolveMentionName(id, ACCOUNT))).toStrictEqual([
			"everyone",
			"Workflowy",
			"AI",
			"Alice Smith",
			"Unknown",
		]);
		expect([resolveMentionName("7", null), resolveMentionName("7", {userId: 7, fullName: null})]).toStrictEqual([
			"Unknown",
			"Unknown",
		]);
	});

	it("names an AI assistant's system user id from settings ai.assistants, like upstream's participant names", () => {
		const account = {...ACCOUNT, assistantNames: {"-5": "Assistant A", "-6": "Assistant B"}};
		expect(["-5", "-6", "-7", "-10"].map((id) => resolveMentionName(id, account))).toStrictEqual([
			"Assistant A",
			"Assistant B",
			"Unknown",
			"AI",
		]);
	});
});

describe("renderMentionPills", () => {
	it("renders upstream's monolith pill with the resolved name, ignoring stored inner text", () => {
		expect(renderMentionPills('a <mention id="0" by="1" ts="1"> Q</mention> b', null)).toBe(
			`a ${pill("mention view-mode monolith-pill explosive", 'id="0" by="1" ts="1"', "everyone")} b`,
		);
	});

	it("marks the current user's mention and shows their full name", () => {
		expect(renderMentionPills('<mention id="7" by="7" ts="1"> </mention>', ACCOUNT)).toBe(
			pill(
				"mention view-mode monolith-pill explosive mention-of-current-user",
				'id="7" by="7" ts="1"',
				"Alice Smith",
			),
		);
	});

	it("labels the system ids and keeps by/ts on an unknown id", () => {
		expect(
			renderMentionPills(
				'<mention id="-2" by="1" ts="1"> </mention><mention id="-10" by="1" ts="1"> </mention><mention id="42" by="1" ts="1"> </mention>',
				ACCOUNT,
			),
		).toBe(
			[
				pill("mention view-mode monolith-pill explosive", 'id="-2" by="1" ts="1"', "Workflowy"),
				pill("mention view-mode monolith-pill explosive", 'id="-10" by="1" ts="1"', "AI"),
				pill("mention view-mode monolith-pill explosive", 'id="42" by="1" ts="1"', "Unknown"),
			].join(""),
		);
	});

	it("omits by and ts when the stored markup has none", () => {
		expect(renderMentionPills('<mention id="0"> </mention>', null)).toBe(
			pill("mention view-mode monolith-pill explosive", 'id="0"', "everyone"),
		);
	});

	it("escapes the full name", () => {
		expect(renderMentionPills('<mention id="7" by="7" ts="1"> </mention>', {userId: 7, fullName: "<b>"})).toBe(
			pill(
				"mention view-mode monolith-pill explosive mention-of-current-user",
				'id="7" by="7" ts="1"',
				"&lt;b&gt;",
			),
		);
	});

	it("leaves text without mentions unchanged", () => {
		expect(renderMentionPills("plain <b>x</b>", ACCOUNT)).toBe("plain <b>x</b>");
	});
});

describe("serializeMentionPills", () => {
	it("repairs corrupted inner text to the canonical single space", () => {
		expect(serializeMentionPills('x <mention id="7" by="7" ts="5"> Q</mention> y')).toBe(
			'x <mention id="7" by="7" ts="5"> </mention> y',
		);
	});

	it("round-trips a canonical mention through render", () => {
		const stored = 'a <b>p <mention id="42" by="1" ts="9"> </mention> q</b> <mention id="0"> </mention> z';
		expect(serializeMentionPills(renderMentionPills(stored, ACCOUNT))).toBe(stored);
	});

	it("drops a mention with no id and removes U+FEFF", () => {
		expect(serializeMentionPills(`a <mention> </mention>${BOM}b`)).toBe("a b");
	});
});
