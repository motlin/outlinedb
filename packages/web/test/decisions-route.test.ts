import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {Hono} from "hono";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {fileDecisionStore} from "../src/server/decision-files.js";
import type {DecisionStore} from "../src/server/decisions.js";
import {createDecisionsApp, createDecisionsRouter} from "../src/server/routes/decisions.js";

const NOW = new Date("2026-10-27T15:00:00.000Z");

const DOCUMENT = {
	slug: "meetings",
	title: "Meeting follow-ups",
	intro: "Pick one per item",
	groups: [
		{
			heading: "1:1 Alice - Mon Oct 26",
			link: "https://example.com/meeting",
			items: [
				{
					id: "a-1",
					title: "Send the deck",
					body: ["Alice asked for the deck", "<b>not html</b>"],
					links: [{label: "Meeting", href: "https://example.com/meeting"}],
					options: [
						{value: "inbox", label: "Add to inbox", description: "File it"},
						{value: "skip", label: "Skip"},
					],
					default: null,
				},
			],
		},
	],
};

/** An in-memory store holding file text by name, the way the filesystem store would. */
function memoryStore(files: Record<string, string>): DecisionStore {
	return {
		readDocument: async (slug) => Promise.resolve(files[`${slug}.json`] ?? null),
		readAnswers: async (slug) => Promise.resolve(files[`${slug}.answers.json`] ?? null),
		writeAnswers: async (slug, text) => {
			files[`${slug}.answers.json`] = text;
			return Promise.resolve();
		},
		openMedia: async () => Promise.resolve(null),
	};
}

function setup(files: Record<string, string>, options: {withStore: boolean} = {withStore: true}) {
	const ctx = {decisions: options.withStore ? memoryStore(files) : undefined} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/api/v1/decisions", createDecisionsRouter({now: () => NOW}));
	return async (method: string, path: string, body?: unknown) => {
		const res = await app.fetch(
			new Request(`http://x/api/v1/decisions${path}`, {
				method,
				headers: {"content-type": "application/json"},
				...(body === undefined ? {} : {body: JSON.stringify(body)}),
			}),
		);
		return {status: res.status, body: await res.json()};
	};
}

function staged(): Record<string, string> {
	return {"meetings.json": JSON.stringify(DOCUMENT)};
}

describe("GET /api/v1/decisions/:slug", () => {
	it("returns the staged document with no answers yet", async () => {
		const request = setup(staged());
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 200,
			body: {
				...DOCUMENT,
				groups: [{...DOCUMENT.groups[0], items: [{...DOCUMENT.groups[0].items[0], answer: null}]}],
				submittedAt: null,
			},
		});
	});

	it("merges saved answers and the submission time into the document", async () => {
		const files: Record<string, string> = {
			...staged(),
			"meetings.answers.json": JSON.stringify({
				"a-1": {choice: "skip", note: "done already", answeredAt: "2026-10-27T14:00:00.000Z"},
				submittedAt: "2026-10-27T14:30:00.000Z",
			}),
		};
		const request = setup(files);
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 200,
			body: {
				...DOCUMENT,
				groups: [
					{
						...DOCUMENT.groups[0],
						items: [
							{
								...DOCUMENT.groups[0].items[0],
								answer: {choice: "skip", note: "done already", answeredAt: "2026-10-27T14:00:00.000Z"},
							},
						],
					},
				],
				submittedAt: "2026-10-27T14:30:00.000Z",
			},
		});
	});

	it("answers 404 when nothing is staged under the slug", async () => {
		const request = setup({});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 404,
			body: {error: "No decision page staged as meetings"},
		});
	});

	it("rejects a slug outside [a-z0-9-] before touching the store", async () => {
		const request = setup(staged());
		await expect(request("GET", "/..%2Fsecrets")).resolves.toStrictEqual({
			status: 400,
			body: {error: "Decision slug must match [a-z0-9-]+"},
		});
	});

	it("reports a staged file that is not JSON as a 500 naming the file", async () => {
		const request = setup({"meetings.json": "{oops"});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {
				error: "meetings.json is not valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
			},
		});
	});

	it("reports a staged file with the wrong shape as a 500 naming the bad field", async () => {
		const request = setup({"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [{}]}]})});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {
				error: [
					"meetings.json does not match the decision page shape: ✖ Invalid input: expected string, received undefined",
					"  → at groups[0].items[0].id",
					"✖ Invalid input: expected string, received undefined",
					"  → at groups[0].items[0].title",
					"✖ Invalid input: expected array, received undefined",
					"  → at groups[0].items[0].options",
				].join("\n"),
			},
		});
	});

	it("rejects a staged slug that disagrees with the file name", async () => {
		const request = setup({"meetings.json": JSON.stringify({...DOCUMENT, slug: "other"})});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {error: 'meetings.json declares slug "other"'},
		});
	});

	it("rejects a staged file whose item ids repeat", async () => {
		const item = DOCUMENT.groups[0].items[0];
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item, item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {error: 'meetings.json repeats item id "a-1"'},
		});
	});

	it("rejects a default that is not one of the item's options", async () => {
		const item = {...DOCUMENT.groups[0].items[0], default: "later"};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {error: 'meetings.json item "a-1" defaults to "later", which is not one of its options'},
		});
	});

	it("passes an item's images through to the page", async () => {
		const images = [{src: "status-2026-11-03/shot.jpg", alt: "The shelf"}];
		const item = {...DOCUMENT.groups[0].items[0], images};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 200,
			body: {...DOCUMENT, groups: [{heading: "x", items: [{...item, answer: null}]}], submittedAt: null},
		});
	});

	it("passes an item's before/after diff through to the page", async () => {
		const diff = {before: "Ran 5k with Gary", after: "Ran 5k with Frank"};
		const item = {...DOCUMENT.groups[0].items[0], diff};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 200,
			body: {...DOCUMENT, groups: [{heading: "x", items: [{...item, answer: null}]}], submittedAt: null},
		});
	});

	it("passes an item's videos, with and without a poster, through to the page", async () => {
		const videos = [{src: "status-2026-11-03/clip.mp4", poster: "status-2026-11-03/clip.jpg"}, {src: "b.webm"}];
		const item = {...DOCUMENT.groups[0].items[0], videos};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 200,
			body: {...DOCUMENT, groups: [{heading: "x", items: [{...item, answer: null}]}], submittedAt: null},
		});
	});

	it("rejects a staged video whose src is not a relative video path, or whose poster is not an image path", async () => {
		const item = {
			...DOCUMENT.groups[0].items[0],
			videos: [
				{src: "../secret.mp4"},
				{src: "/etc/x.mov"},
				{src: "still.jpg"},
				{src: "ok.m4v", poster: "../poster.jpg"},
				{src: "ok.mp4", poster: "poster.mp4"},
			],
		};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		const videoError = "✖ Video src must be a relative .mp4, .mov, .m4v or .webm path under .llm/photos";
		const posterError = "✖ Video poster must be a relative .jpg, .jpeg, .png, .webp or .gif path under .llm/photos";
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {
				error: [
					`meetings.json does not match the decision page shape: ${videoError}`,
					"  → at groups[0].items[0].videos[0].src",
					videoError,
					"  → at groups[0].items[0].videos[1].src",
					videoError,
					"  → at groups[0].items[0].videos[2].src",
					posterError,
					"  → at groups[0].items[0].videos[3].poster",
					posterError,
					"  → at groups[0].items[0].videos[4].poster",
				].join("\n"),
			},
		});
	});

	it("rejects a staged image whose src is not a relative image path under the photos directory", async () => {
		const item = {
			...DOCUMENT.groups[0].items[0],
			images: [
				{src: "../secret.jpg", alt: "a"},
				{src: "/etc/x.png", alt: "b"},
				{src: "notes.txt", alt: "c"},
			],
		};
		const request = setup({
			"meetings.json": JSON.stringify({...DOCUMENT, groups: [{heading: "x", items: [item]}]}),
		});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 500,
			body: {
				error: [
					"meetings.json does not match the decision page shape: ✖ Image src must be a relative .jpg, .jpeg, .png, .webp or .gif path under .llm/photos",
					"  → at groups[0].items[0].images[0].src",
					"✖ Image src must be a relative .jpg, .jpeg, .png, .webp or .gif path under .llm/photos",
					"  → at groups[0].items[0].images[1].src",
					"✖ Image src must be a relative .jpg, .jpeg, .png, .webp or .gif path under .llm/photos",
					"  → at groups[0].items[0].images[2].src",
				].join("\n"),
			},
		});
	});

	it("answers 503 when the host has no decision store", async () => {
		const request = setup({}, {withStore: false});
		await expect(request("GET", "/meetings")).resolves.toStrictEqual({
			status: 503,
			body: {error: "Decision pages are not available on this host"},
		});
	});
});

describe("PUT /api/v1/decisions/:slug/:itemId", () => {
	it("saves the choice and note with the time it was answered", async () => {
		const files: Record<string, string> = staged();
		const request = setup(files);
		await expect(request("PUT", "/meetings/a-1", {choice: "inbox", note: "by Friday"})).resolves.toStrictEqual({
			status: 200,
			body: {answer: {choice: "inbox", note: "by Friday", answeredAt: NOW.toISOString()}},
		});
		expect(JSON.parse(files["meetings.answers.json"])).toStrictEqual({
			"a-1": {choice: "inbox", note: "by Friday", answeredAt: NOW.toISOString()},
		});
	});

	it("keeps other answers and the submission time when one item changes", async () => {
		const files: Record<string, string> = {
			...staged(),
			"meetings.answers.json": JSON.stringify({
				"b-2": {choice: "x", note: "", answeredAt: "2026-10-27T14:00:00.000Z"},
				submittedAt: "2026-10-27T14:30:00.000Z",
			}),
		};
		const request = setup(files);
		await request("PUT", "/meetings/a-1", {choice: null, note: "ask Bob first"});
		expect(JSON.parse(files["meetings.answers.json"])).toStrictEqual({
			"b-2": {choice: "x", note: "", answeredAt: "2026-10-27T14:00:00.000Z"},
			submittedAt: "2026-10-27T14:30:00.000Z",
			"a-1": {choice: null, note: "ask Bob first", answeredAt: NOW.toISOString()},
		});
	});

	it("rejects a choice that is not one of the item's option values", async () => {
		const files: Record<string, string> = staged();
		const request = setup(files);
		await expect(request("PUT", "/meetings/a-1", {choice: "later", note: ""})).resolves.toStrictEqual({
			status: 400,
			body: {error: 'Choice "later" is not an option for item "a-1"'},
		});
		expect(files["meetings.answers.json"]).toBeUndefined();
	});

	it("rejects a body missing the note instead of guessing one", async () => {
		const request = setup(staged());
		await expect(request("PUT", "/meetings/a-1", {choice: "inbox"})).resolves.toStrictEqual({
			status: 400,
			body: {error: "Body must be {choice: string | null, note: string}"},
		});
	});

	it("answers 404 for an item the page does not have", async () => {
		const request = setup(staged());
		await expect(request("PUT", "/meetings/zz-9", {choice: null, note: ""})).resolves.toStrictEqual({
			status: 404,
			body: {error: 'No item "zz-9" on decision page meetings'},
		});
	});

	it("serializes concurrent saves so neither answer is lost", async () => {
		const files: Record<string, string> = {
			"meetings.json": JSON.stringify({
				...DOCUMENT,
				groups: [
					{
						heading: "x",
						items: [DOCUMENT.groups[0].items[0], {...DOCUMENT.groups[0].items[0], id: "a-2"}],
					},
				],
			}),
		};
		const request = setup(files);
		await Promise.all([
			request("PUT", "/meetings/a-1", {choice: "inbox", note: ""}),
			request("PUT", "/meetings/a-2", {choice: "skip", note: ""}),
		]);
		expect(JSON.parse(files["meetings.answers.json"])).toStrictEqual({
			"a-1": {choice: "inbox", note: "", answeredAt: NOW.toISOString()},
			"a-2": {choice: "skip", note: "", answeredAt: NOW.toISOString()},
		});
	});
});

describe("POST /api/v1/decisions/:slug/submit", () => {
	it("stamps submittedAt beside the saved answers", async () => {
		const files: Record<string, string> = {
			...staged(),
			"meetings.answers.json": JSON.stringify({
				"a-1": {choice: "skip", note: "", answeredAt: "2026-10-27T14:00:00.000Z"},
			}),
		};
		const request = setup(files);
		await expect(request("POST", "/meetings/submit")).resolves.toStrictEqual({
			status: 200,
			body: {submittedAt: NOW.toISOString()},
		});
		expect(JSON.parse(files["meetings.answers.json"])).toStrictEqual({
			"a-1": {choice: "skip", note: "", answeredAt: "2026-10-27T14:00:00.000Z"},
			submittedAt: NOW.toISOString(),
		});
	});

	it("answers 404 when nothing is staged under the slug", async () => {
		const request = setup({});
		await expect(request("POST", "/meetings/submit")).resolves.toStrictEqual({
			status: 404,
			body: {error: "No decision page staged as meetings"},
		});
	});
});

describe("GET /api/v1/decisions/images/*", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "decision-images-"));
		mkdirSync(join(root, "photos", "status 2026-11-03"), {recursive: true});
		writeFileSync(join(root, "photos", "status 2026-11-03", "shot.JPG"), "jpeg bytes");
		writeFileSync(join(root, "photos", "chart.png"), "png bytes");
		writeFileSync(join(root, "photos", "notes.txt"), "text");
		writeFileSync(join(root, "secret.jpg"), "secret");
	});

	afterEach(() => {
		rmSync(root, {recursive: true, force: true});
	});

	async function fetchImage(path: string) {
		const ctx = {
			decisions: fileDecisionStore(join(root, "decisions"), join(root, "photos")),
		} as unknown as ServerContext;
		const response = await createDecisionsApp(ctx).fetch(new Request(`http://x/api/v1/decisions/images/${path}`));
		return {
			status: response.status,
			contentType: response.headers.get("content-type"),
			body: await response.text(),
		};
	}

	it("serves an image from the photos directory with its content type", async () => {
		await expect(
			Promise.all([fetchImage("status%202026-11-03/shot.JPG"), fetchImage("chart.png")]),
		).resolves.toStrictEqual([
			{status: 200, contentType: "image/jpeg", body: "jpeg bytes"},
			{status: 200, contentType: "image/png", body: "png bytes"},
		]);
	});

	it("answers 404 for traversal, absolute paths, non-images and missing files", async () => {
		const notFound = {status: 404, contentType: "application/json", body: '{"error":"No such image"}'};
		await expect(
			Promise.all([
				fetchImage("..%2Fsecret.jpg"),
				fetchImage("chart.png%2F..%2F..%2Fsecret.jpg"),
				fetchImage(encodeURIComponent(join(root, "secret.jpg"))),
				fetchImage("notes.txt"),
				fetchImage("missing.gif"),
			]),
		).resolves.toStrictEqual([notFound, notFound, notFound, notFound, notFound]);
	});

	it("answers 404 for a video, which only the media endpoint serves", async () => {
		writeFileSync(join(root, "photos", "clip.mp4"), "video");
		await expect(fetchImage("clip.mp4")).resolves.toStrictEqual({
			status: 404,
			contentType: "application/json",
			body: '{"error":"No such image"}',
		});
	});

	it("answers 404 when the host has no decision store", async () => {
		const ctx = {decisions: undefined} as unknown as ServerContext;
		const response = await createDecisionsApp(ctx).fetch(new Request("http://x/api/v1/decisions/images/chart.png"));
		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 404,
			body: {error: "No such image"},
		});
	});
});

describe("GET /api/v1/decisions/media/*", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "decision-media-"));
		mkdirSync(join(root, "photos", "status 2026-11-03"), {recursive: true});
		writeFileSync(join(root, "photos", "status 2026-11-03", "clip.MP4"), "0123456789");
		writeFileSync(join(root, "photos", "a.mov"), "mov");
		writeFileSync(join(root, "photos", "a.m4v"), "m4v");
		writeFileSync(join(root, "photos", "a.webm"), "webm");
		writeFileSync(join(root, "photos", "chart.png"), "png bytes");
		writeFileSync(join(root, "photos", "empty.mp4"), "");
		writeFileSync(join(root, "photos", "notes.txt"), "text");
		writeFileSync(join(root, "secret.mp4"), "secret");
	});

	afterEach(() => {
		rmSync(root, {recursive: true, force: true});
	});

	async function fetchMedia(path: string, headers: Record<string, string> = {}, method = "GET") {
		const ctx = {
			decisions: fileDecisionStore(join(root, "decisions"), join(root, "photos")),
		} as unknown as ServerContext;
		const response = await createDecisionsApp(ctx).fetch(
			new Request(`http://x/api/v1/decisions/media/${path}`, {method, headers}),
		);
		return {
			status: response.status,
			headers: Object.fromEntries(
				["content-type", "content-length", "accept-ranges", "content-range"].map((name) => [
					name,
					response.headers.get(name),
				]),
			),
			body: await response.text(),
		};
	}

	function full(contentType: string, body: string) {
		return {
			status: 200,
			headers: {
				"content-type": contentType,
				"content-length": String(body.length),
				"accept-ranges": "bytes",
				"content-range": null,
			},
			body,
		};
	}

	function partial(range: string, body: string) {
		return {
			status: 206,
			headers: {
				"content-type": "video/mp4",
				"content-length": String(body.length),
				"accept-ranges": "bytes",
				"content-range": `bytes ${range}/10`,
			},
			body,
		};
	}

	it("serves each video type and images whole, advertising byte ranges", async () => {
		await expect(
			Promise.all([
				fetchMedia("status%202026-11-03/clip.MP4"),
				fetchMedia("a.mov"),
				fetchMedia("a.m4v"),
				fetchMedia("a.webm"),
				fetchMedia("chart.png"),
				fetchMedia("empty.mp4"),
			]),
		).resolves.toStrictEqual([
			full("video/mp4", "0123456789"),
			full("video/quicktime", "mov"),
			full("video/x-m4v", "m4v"),
			full("video/webm", "webm"),
			full("image/png", "png bytes"),
			full("video/mp4", ""),
		]);
	});

	it("answers 206 with the requested slice for bounded, open-ended, suffix and overlong ranges", async () => {
		const clip = "status%202026-11-03/clip.MP4";
		await expect(
			Promise.all([
				fetchMedia(clip, {range: "bytes=2-5"}),
				fetchMedia(clip, {range: "bytes=7-"}),
				fetchMedia(clip, {range: "bytes=-3"}),
				fetchMedia(clip, {range: "bytes=8-100"}),
				fetchMedia(clip, {range: "bytes=-50"}),
				fetchMedia(clip, {range: "bytes=0-"}),
			]),
		).resolves.toStrictEqual([
			partial("2-5", "2345"),
			partial("7-9", "789"),
			partial("7-9", "789"),
			partial("8-9", "89"),
			partial("0-9", "0123456789"),
			partial("0-9", "0123456789"),
		]);
	});

	it("answers 416 with the file size for unsatisfiable or malformed ranges", async () => {
		const clip = "status%202026-11-03/clip.MP4";
		const refused = {
			status: 416,
			headers: {
				"content-type": null,
				"content-length": null,
				"accept-ranges": "bytes",
				"content-range": "bytes */10",
			},
			body: "",
		};
		await expect(
			Promise.all([
				fetchMedia(clip, {range: "bytes=10-"}),
				fetchMedia(clip, {range: "bytes=5-2"}),
				fetchMedia(clip, {range: "bytes=-0"}),
				fetchMedia(clip, {range: "bytes=abc"}),
				fetchMedia(clip, {range: "items=0-1"}),
				fetchMedia(clip, {range: "bytes=0-1,4-5"}),
			]),
		).resolves.toStrictEqual([refused, refused, refused, refused, refused, refused]);
	});

	it("answers HEAD with the headers and no body", async () => {
		await expect(fetchMedia("a.mov", {}, "HEAD")).resolves.toStrictEqual({
			...full("video/quicktime", "mov"),
			body: "",
		});
	});

	it("answers 404 for traversal, absolute paths, symlink escapes, other types and missing files", async () => {
		symlinkSync(join(root, "secret.mp4"), join(root, "photos", "escape.mp4"));
		const notFound = {
			status: 404,
			headers: {
				"content-type": "application/json",
				"content-length": null,
				"accept-ranges": null,
				"content-range": null,
			},
			body: '{"error":"No such media file"}',
		};
		await expect(
			Promise.all([
				fetchMedia("..%2Fsecret.mp4"),
				fetchMedia("a.mov%2F..%2F..%2Fsecret.mp4"),
				fetchMedia(encodeURIComponent(join(root, "secret.mp4"))),
				fetchMedia("escape.mp4", {range: "bytes=0-1"}),
				fetchMedia("notes.txt"),
				fetchMedia("missing.webm"),
			]),
		).resolves.toStrictEqual([notFound, notFound, notFound, notFound, notFound, notFound]);
	});

	it("answers 404 when the host has no decision store", async () => {
		const ctx = {decisions: undefined} as unknown as ServerContext;
		const response = await createDecisionsApp(ctx).fetch(new Request("http://x/api/v1/decisions/media/a.mp4"));
		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 404,
			body: {error: "No such media file"},
		});
	});
});

describe("createDecisionsApp", () => {
	it("serves the decision pages under /api/v1/decisions with the context set", async () => {
		const ctx = {decisions: memoryStore({})} as unknown as ServerContext;
		const response = await createDecisionsApp(ctx).fetch(new Request("http://x/api/v1/decisions/missing"));
		expect(response.status).toBe(404);
	});
});
