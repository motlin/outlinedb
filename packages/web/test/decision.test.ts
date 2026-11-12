import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {decisionPhotosDirectory, decisionsDirectory, fileDecisionStore} from "../src/server/decision-files.js";
import {bodyTokens} from "../src/client/decision-tokens.js";

describe("decision files", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "decisions-"));
	});

	afterEach(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	describe("fileDecisionStore", () => {
		it("reads null for a slug with no staged file or answers", async () => {
			const store = fileDecisionStore(directory);
			expect([await store.readDocument("meetings"), await store.readAnswers("meetings")]).toStrictEqual([
				null,
				null,
			]);
		});

		it("reads the staged document and answers files by slug", async () => {
			writeFileSync(join(directory, "meetings.json"), '{"doc":1}');
			writeFileSync(join(directory, "meetings.answers.json"), '{"a":1}');
			const store = fileDecisionStore(directory);
			expect([await store.readDocument("meetings"), await store.readAnswers("meetings")]).toStrictEqual([
				'{"doc":1}',
				'{"a":1}',
			]);
		});

		it("writes answers by renaming a temp file, leaving no temp file behind", async () => {
			writeFileSync(join(directory, "meetings.answers.json"), "old");
			const store = fileDecisionStore(directory);
			await store.writeAnswers("meetings", '{"new":true}');
			expect({
				files: readdirSync(directory),
				text: readFileSync(join(directory, "meetings.answers.json"), "utf8"),
			}).toStrictEqual({files: ["meetings.answers.json"], text: '{"new":true}'});
		});

		it("refuses a slug that could escape the directory", async () => {
			const store = fileDecisionStore(directory);
			await expect(store.readDocument("../etc")).rejects.toThrow(
				new Error('Decision slug must match [a-z0-9-]+, got "../etc"'),
			);
		});
	});

	describe("fileDecisionStore openMedia", () => {
		let photos: string;

		beforeEach(() => {
			photos = join(directory, "photos");
			mkdirSync(join(photos, "status-2026-11-03"), {recursive: true});
			writeFileSync(join(photos, "status-2026-11-03", "shot.jpg"), "jpeg bytes");
			writeFileSync(join(photos, "status-2026-11-03", "clip.mp4"), "0123456789");
			writeFileSync(join(photos, "notes.txt"), "not an image");
			writeFileSync(join(directory, "outside.jpg"), "secret");
			writeFileSync(join(directory, "outside.mov"), "secret video");
		});

		/** The whole file's text, or null when the store refuses it. */
		async function read(path: string): Promise<string | null> {
			const media = await fileDecisionStore(directory, photos).openMedia(path);
			return media === null ? null : new Response(media.read(0, media.size - 1)).text();
		}

		it("reads an image by its path under the photos directory", async () => {
			await expect(read("status-2026-11-03/shot.jpg")).resolves.toBe("jpeg bytes");
		});

		it("reports a video's size and reads inclusive byte slices of it", async () => {
			const media = await fileDecisionStore(directory, photos).openMedia("status-2026-11-03/clip.mp4");
			if (media === null) {
				throw new Error("clip.mp4 not opened");
			}
			expect({
				size: media.size,
				slices: await Promise.all([
					new Response(media.read(0, 9)).text(),
					new Response(media.read(2, 5)).text(),
					new Response(media.read(9, 9)).text(),
				]),
			}).toStrictEqual({size: 10, slices: ["0123456789", "2345", "9"]});
		});

		it("reads null for a missing file", async () => {
			await expect(
				Promise.all([read("status-2026-11-03/missing.png"), read("status-2026-11-03/missing.webm")]),
			).resolves.toStrictEqual([null, null]);
		});

		it("reads null for a directory with a media extension", async () => {
			mkdirSync(join(photos, "folder.mp4"));
			await expect(read("folder.mp4")).resolves.toBeNull();
		});

		it("refuses paths that climb out of the photos directory", async () => {
			await expect(
				Promise.all([
					read("../outside.jpg"),
					read("status-2026-11-03/../../outside.jpg"),
					read("../outside.mov"),
					read("status-2026-11-03/../../outside.mov"),
					read(".."),
				]),
			).resolves.toStrictEqual([null, null, null, null, null]);
		});

		it("refuses an absolute path even when it names a real file", async () => {
			await expect(
				Promise.all([read(join(directory, "outside.jpg")), read(join(directory, "outside.mov"))]),
			).resolves.toStrictEqual([null, null]);
		});

		it("refuses a symlink inside the photos directory that points outside it", async () => {
			symlinkSync(join(directory, "outside.jpg"), join(photos, "escape.jpg"));
			symlinkSync(join(directory, "outside.mov"), join(photos, "escape.mov"));
			await expect(Promise.all([read("escape.jpg"), read("escape.mov")])).resolves.toStrictEqual([null, null]);
		});

		it("refuses a file without an image or video extension", async () => {
			await expect(read("notes.txt")).resolves.toBeNull();
		});

		it("reads null for every file when the host has no photos directory", async () => {
			const store = fileDecisionStore(directory);
			await expect(
				Promise.all([
					store.openMedia("status-2026-11-03/shot.jpg"),
					store.openMedia("status-2026-11-03/clip.mp4"),
				]),
			).resolves.toStrictEqual([null, null]);
		});
	});

	describe("decisionPhotosDirectory", () => {
		it("honors OUTLINEDB_DECISION_PHOTOS_DIR", () => {
			expect(decisionPhotosDirectory({OUTLINEDB_DECISION_PHOTOS_DIR: "/pics"})).toBe("/pics");
		});

		it("defaults to the repo's .llm/photos", () => {
			expect(decisionPhotosDirectory({})).toBe(join(import.meta.dirname, "../../../.llm/photos"));
		});
	});

	describe("decisionsDirectory", () => {
		it("honors OUTLINEDB_DECISIONS_DIR", () => {
			expect(decisionsDirectory({OUTLINEDB_DECISIONS_DIR: "/somewhere"})).toBe("/somewhere");
		});

		it("defaults to the repo's .llm/gtd/review/decisions", () => {
			expect(decisionsDirectory({})).toBe(join(import.meta.dirname, "../../../.llm/gtd/review/decisions"));
		});
	});
});

describe("decision tokens", () => {
	describe("bodyTokens", () => {
		it("splits out dates, durations and counts, leaving the rest as plain text", () => {
			expect(bodyTokens("skipped 1 runs since 2026-10-24, every 3w or 16 days")).toStrictEqual([
				{text: "skipped ", kind: null},
				{text: "1", kind: "count"},
				{text: " runs since ", kind: null},
				{text: "2026-10-24", kind: "date"},
				{text: ", every ", kind: null},
				{text: "3w", kind: "duration"},
				{text: " or ", kind: null},
				{text: "16", kind: "count"},
				{text: " days", kind: null},
			]);
		});

		it("marks the numbers on an overdue line as warnings, but not its dates", () => {
			expect(bodyTokens("Overdue 13d (due 2026-10-17)")).toStrictEqual([
				{text: "Overdue ", kind: null},
				{text: "13d", kind: "overdue"},
				{text: " (due ", kind: null},
				{text: "2026-10-17", kind: "date"},
				{text: ")", kind: null},
			]);
		});

		it("warns only on an overdue line's first number, so later counts keep their own color", () => {
			expect(bodyTokens("overdue 7d, skipped 1 runs")).toStrictEqual([
				{text: "overdue ", kind: null},
				{text: "7d", kind: "overdue"},
				{text: ", skipped ", kind: null},
				{text: "1", kind: "count"},
				{text: " runs", kind: null},
			]);
		});

		it("leaves digits inside words, ids and versions alone", () => {
			expect(bodyTokens("Q3 plan v2 for abc123 and x-9")).toStrictEqual([
				{text: "Q3 plan v2 for abc123 and x-9", kind: null},
			]);
		});

		it("returns a line without numbers as one plain token, and nothing for an empty line", () => {
			expect({plain: bodyTokens("<b>not html</b>"), empty: bodyTokens("")}).toStrictEqual({
				plain: [{text: "<b>not html</b>", kind: null}],
				empty: [],
			});
		});
	});
});
