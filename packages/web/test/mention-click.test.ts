import {describe, expect, it} from "vite-plus/test";
import {mentionSearchQuery, removeMentionFromHtml} from "../src/client/mention-click.js";

const account =
{
	userId: 7,
	fullName: "Alice Smith",
};

describe("mentionSearchQuery", () =>
{
	it("searches Everyone for id 0 and the full name for self", () =>
	{
		expect([mentionSearchQuery("0", account), mentionSearchQuery("7", account)]).toStrictEqual([
			'mentioned:"Everyone"',
			'mentioned:"Alice Smith"',
		]);
	});
});

describe("removeMentionFromHtml", () =>
{
	it("drops the nth mention and reports the caret where it was", () =>
	{
		const html = 'a <mention id="7" by="7" ts="1"> </mention> b <mention id="0" by="7" ts="2"> </mention>';
		expect([removeMentionFromHtml(html, 1), removeMentionFromHtml(html, 2)]).toStrictEqual([
			{
				html: 'a <mention id="7" by="7" ts="1"> </mention> b ',
				caret: 6,
			},
			null,
		]);
	});
});
