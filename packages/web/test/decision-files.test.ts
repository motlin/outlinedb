import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {decisionPhotosDirectory, decisionsDirectory, fileDecisionStore} from "../src/server/decision-files.js";

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
		expect([await store.readDocument("meetings"), await store.readAnswers("meetings")]).toStrictEqual([null, null]);
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

describe("fileDecisionStore readImage", () => {
	let photos: string;

	beforeEach(() => {
		photos = join(directory, "photos");
		mkdirSync(join(photos, "status-2026-11-03"), {recursive: true});
		writeFileSync(join(photos, "status-2026-11-03", "shot.jpg"), "jpeg bytes");
		writeFileSync(join(photos, "notes.txt"), "not an image");
		writeFileSync(join(directory, "outside.jpg"), "secret");
	});

	async function read(path: string): Promise<string | null> {
		const bytes = await fileDecisionStore(directory, photos).readImage(path);
		return bytes === null ? null : Buffer.from(bytes).toString("utf8");
	}

	it("reads an image by its path under the photos directory", async () => {
		await expect(read("status-2026-11-03/shot.jpg")).resolves.toBe("jpeg bytes");
	});

	it("reads null for a missing image", async () => {
		await expect(read("status-2026-11-03/missing.png")).resolves.toBeNull();
	});

	it("refuses paths that climb out of the photos directory", async () => {
		await expect(
			Promise.all([read("../outside.jpg"), read("status-2026-11-03/../../outside.jpg"), read("..")]),
		).resolves.toStrictEqual([null, null, null]);
	});

	it("refuses an absolute path even when it names a real image", async () => {
		await expect(read(join(directory, "outside.jpg"))).resolves.toBeNull();
	});

	it("refuses a symlink inside the photos directory that points outside it", async () => {
		symlinkSync(join(directory, "outside.jpg"), join(photos, "escape.jpg"));
		await expect(read("escape.jpg")).resolves.toBeNull();
	});

	it("refuses a file without an image extension", async () => {
		await expect(read("notes.txt")).resolves.toBeNull();
	});

	it("reads null for every image when the host has no photos directory", async () => {
		await expect(fileDecisionStore(directory).readImage("status-2026-11-03/shot.jpg")).resolves.toBeNull();
	});
});

describe("decisionPhotosDirectory", () => {
	it("honors WORKFLOWY_DECISION_PHOTOS_DIR", () => {
		expect(decisionPhotosDirectory({WORKFLOWY_DECISION_PHOTOS_DIR: "/pics"})).toBe("/pics");
	});

	it("defaults to the repo's .llm/photos", () => {
		expect(decisionPhotosDirectory({})).toBe(join(import.meta.dirname, "../../../.llm/photos"));
	});
});

describe("decisionsDirectory", () => {
	it("honors WORKFLOWY_DECISIONS_DIR", () => {
		expect(decisionsDirectory({WORKFLOWY_DECISIONS_DIR: "/somewhere"})).toBe("/somewhere");
	});

	it("defaults to the repo's .llm/gtd/review/decisions", () => {
		expect(decisionsDirectory({})).toBe(join(import.meta.dirname, "../../../.llm/gtd/review/decisions"));
	});
});
