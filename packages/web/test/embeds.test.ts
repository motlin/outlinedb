import {describe, expect, it} from "vite-plus/test";
import {embedFor, firstLinkHref} from "../src/client/components/embeds.js";

const ON =
{
	ignoreYoutube: false,
	ignoreYtShort: false,
	ignoreTwitter: false,
	ignoreLoom: false,
};

describe("embedFor", () =>
{
	it("embeds a youtube watch link, a youtu.be link and a /shorts/ link through the youtube handler", () =>
	{
		expect([
			embedFor("https://www.youtube.com/watch?v=abc123", ON),
			embedFor("https://youtu.be/abc123", ON),
			embedFor("https://m.youtube.com/watch?feature=share&v=abc_-1", ON),
			embedFor("https://www.youtube.com/shorts/short123", ON),
		]).toStrictEqual([
			{
				kind: "youtube",
				src: "https://beta.workflowy.com/media/youtube.html?v=abc123",
				aspectRatio: "16 / 9",
			},
			{
				kind: "youtube",
				src: "https://beta.workflowy.com/media/youtube.html?v=abc123",
				aspectRatio: "16 / 9",
			},
			{
				kind: "youtube",
				src: "https://beta.workflowy.com/media/youtube.html?v=abc_-1",
				aspectRatio: "16 / 9",
			},
			{
				kind: "youtube",
				src: "https://beta.workflowy.com/media/youtube.html?v=short123",
				aspectRatio: "16 / 9",
			},
		]);
	});

	it("falls back to the shorts handler (9 / 16, /embed/ url) when youtube is ignored", () =>
	{
		expect([
			embedFor(
				"https://www.youtube.com/shorts/short123",
				{
					...ON,
					ignoreYoutube: true,
				},
			),
			embedFor(
				"https://youtube.com/shorts/short123",
				{
					...ON,
					ignoreYoutube: true,
				},
			),
			embedFor(
				"https://www.youtube.com/watch?v=abc123",
				{
					...ON,
					ignoreYoutube: true,
				},
			),
			embedFor(
				"https://www.youtube.com/shorts/short123",
				{
					...ON,
					ignoreYoutube: true,
					ignoreYtShort: true,
				},
			),
		]).toStrictEqual([
			{
				kind: "yt_short",
				src: "https://www.youtube.com/embed/short123",
				aspectRatio: "9 / 16",
			},
			{
				kind: "yt_short",
				src: "https://youtube.com/embed/short123",
				aspectRatio: "9 / 16",
			},
			null,
			null,
		]);
	});

	it("embeds twitter and x.com status links by tweet id", () =>
	{
		expect([
			embedFor("https://twitter.com/alice/status/1234567890", ON),
			embedFor("https://x.com/alice/statuses/42", ON),
			embedFor("https://x.com/alice", ON),
			embedFor(
				"https://x.com/alice/status/1234567890",
				{
					...ON,
					ignoreTwitter: true,
				},
			),
		]).toStrictEqual([
			{
				kind: "twitter",
				tweetId: "1234567890",
			},
			{
				kind: "twitter",
				tweetId: "42",
			},
			null,
			null,
		]);
	});

	it("turns a loom share link into its embed url", () =>
	{
		expect([
			embedFor("https://www.loom.com/share/abc123def", ON),
			embedFor(
				"https://www.loom.com/share/abc123def",
				{
					...ON,
					ignoreLoom: true,
				},
			),
		]).toStrictEqual([
			{
				kind: "loom",
				src: "https://www.loom.com/embed/abc123def",
				aspectRatio: "16 / 9",
			},
			null,
		]);
	});

	it("ignores ordinary links", () =>
	{
		expect(embedFor("https://example.com/page", ON)).toBeNull();
	});
});

describe("firstLinkHref", () =>
{
	it("is the first link in the name html, and only that one", () =>
	{
		expect([
			firstLinkHref('see <a href="https://youtu.be/aaa">one</a> and <a href="https://youtu.be/bbb">two</a>'),
			firstLinkHref("no links"),
			firstLinkHref(null),
			firstLinkHref('<a href="https://x.com/a/status/1">t</a>'),
		]).toStrictEqual(["https://youtu.be/aaa", null, null, "https://x.com/a/status/1"]);
	});
});
