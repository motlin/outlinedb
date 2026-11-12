import {describe, expect, it} from "vite-plus/test";
import {mentionSearchQuery, removeMentionFromHtml} from "../src/client/mention-click.js";
import {readFileSync} from "node:fs";
import {avatarInitials, insertSuggestion, matchesTerm, mentionGroups} from "../src/client/mention-options.js";
import {
	parseMentionAttrs,
	renderMentionPills,
	resolveMentionName,
	serializeMentionPills,
} from "../src/client/mention-pills.js";
import {
	MENTION_CHIP_CLASS,
	planMentionOpen,
	planMentionRearm,
	stripMentionChip,
} from "../src/client/mention-trigger.js";

describe("mention click", () => {
	const account = {userId: 7, fullName: "Alice Smith"};

	describe("mentionSearchQuery", () => {
		it("searches Everyone for id 0 and the full name for self", () => {
			expect([mentionSearchQuery("0", account), mentionSearchQuery("7", account)]).toStrictEqual([
				'mentioned:"Everyone"',
				'mentioned:"Alice Smith"',
			]);
		});
	});

	describe("removeMentionFromHtml", () => {
		it("drops the nth mention and reports the caret where it was", () => {
			const html = 'a <mention id="7" by="7" ts="1"> </mention> b <mention id="0" by="7" ts="2"> </mention>';
			expect([removeMentionFromHtml(html, 1), removeMentionFromHtml(html, 2)]).toStrictEqual([
				{html: 'a <mention id="7" by="7" ts="1"> </mention> b ', caret: 6},
				null,
			]);
		});
	});
});

describe("mention css", () => {
	const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

	function block(selector: string): string[] {
		const start = css.lastIndexOf(`\n${selector} {`);
		const end = css.indexOf("}", start);
		return css
			.slice(start + selector.length + 3, end)
			.split(";")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}

	describe("mention popup css", () => {
		it("matches upstream's declarations", () => {
			expect([block(".menu.mention-popup"), block(".mention-avatar")]).toStrictEqual([
				["padding-bottom: 0"],
				[
					"border: var(--wf-border-width-s) solid var(--wf-border-primary)",
					"display: flex",
					"flex-shrink: 0",
					"border-radius: 50%",
					"width: 18px",
					"height: 18px",
					"font-size: 10px",
					"align-items: center",
					"justify-content: center",
				],
			]);
		});
	});
});

describe("mention options", () => {
	const account = {userId: 7, fullName: "Alice Smith"};

	describe("mentionGroups", () => {
		it("lists the current user then the canonical tags", () => {
			expect(mentionGroups({term: "", account, tags: ["@mdAlpha"]})).toStrictEqual([
				{name: "People", options: [{kind: "person", id: "7", text: "Alice Smith"}]},
				{name: "Tags", options: [{kind: "tag", text: "@mdAlpha"}]},
			]);
		});

		it("keeps the tag's stored case and drops People when the term does not match", () => {
			expect(mentionGroups({term: "MDa", account, tags: ["@mdAlpha"]})).toStrictEqual([
				{name: "Tags", options: [{kind: "tag", text: "@mdAlpha"}]},
			]);
		});

		it("keeps People for me and drops everything when nothing matches", () => {
			expect([
				mentionGroups({term: "me", account, tags: []}),
				mentionGroups({term: "zz", account, tags: []}),
				mentionGroups({term: "*", account, tags: []}).length,
			]).toStrictEqual([[{name: "People", options: [{kind: "person", id: "7", text: "Alice Smith"}]}], [], 1]);
		});

		it("caps tags at eight", () => {
			const tags = Array.from({length: 12}, (_, i) => `@t${i}`);
			expect(mentionGroups({term: "t", account: null, tags})[0]?.options.length).toBe(8);
		});
	});

	describe("matchesTerm", () => {
		it("is a case-insensitive prefix test and * matches all", () => {
			expect([matchesTerm("al", "Alice"), matchesTerm("x", "Alice"), matchesTerm("*", "Alice")]).toStrictEqual([
				true,
				false,
				true,
			]);
		});
	});

	describe("avatarInitials", () => {
		it("takes the first and last words' first letters", () => {
			expect([avatarInitials("Alice B Smith"), avatarInitials("Cher"), avatarInitials("")]).toStrictEqual([
				"AS",
				"C",
				"",
			]);
		});
	});

	describe("insertSuggestion", () => {
		it("spaces the insert on both sides", () => {
			expect([insertSuggestion("q@", 1, 2, "@mdBeta"), insertSuggestion("@ x", 0, 1, "@a")]).toStrictEqual([
				{text: "q @mdBeta ", caret: 10},
				{text: "@a x", caret: 3},
			]);
		});
	});
});

describe("mention pills", () => {
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
			expect([resolveMentionName("7", null), resolveMentionName("7", {userId: 7, fullName: null})]).toStrictEqual(
				["Unknown", "Unknown"],
			);
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
});

describe("mention trigger", () => {
	describe("planMentionOpen", () => {
		it("wraps only the @ for a spaced symbol", () => {
			expect([
				planMentionOpen("a @", 2),
				planMentionOpen("mail@", 4),
				planMentionOpen("@x", 0),
				planMentionOpen("a\t@b", 2),
				planMentionOpen("ab@cd", 2),
			]).toStrictEqual([{start: 2, end: 3}, {start: 4, end: 5}, {start: 0, end: 1}, {start: 2, end: 3}, null]);
		});
	});

	describe("planMentionRearm", () => {
		it("re-wraps a resting @tag from its @ to the caret, and nothing else", () => {
			expect([
				planMentionRearm("X @md", 5),
				planMentionRearm("@md", 3),
				planMentionRearm("mail@md", 7),
				planMentionRearm("X md", 4),
				planMentionRearm("X @md y", 7),
			]).toStrictEqual([{start: 2, end: 5}, {start: 0, end: 3}, null, null, null]);
		});
	});

	describe("stripMentionChip", () => {
		it("unwraps a live chip to its text", () => {
			expect([MENTION_CHIP_CLASS, stripMentionChip('x <span class="mention-input">@md</span>')]).toStrictEqual([
				"mention-input",
				"x @md",
			]);
		});
	});
});
