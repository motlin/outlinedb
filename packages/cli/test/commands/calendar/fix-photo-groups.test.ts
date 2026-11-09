import {beforeEach, vi, afterEach, expect, describe, it} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {and, eq} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {MockInstance} from "vite-plus/test";
import FixPhotoGroups from "../../../src/commands/calendar/fix-photo-groups.js";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {createTestNode} from "../../helpers/node-fixtures.js";
import {requestJson} from "../../helpers/request-body.js";

interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
}

function s3File(nodeId: string, fileName: string, systemFrom = "2026-01-01 00:00:00.000") {
	return {
		nodeId,
		fileName,
		fileType: "image/jpeg",
		objectFolder: null,
		isAnimatedGif: null,
		imageOriginalWidth: null,
		imageOriginalHeight: null,
		imageOriginalPixels: null,
		isDeleted: null,
		systemFrom,
		systemTo: FAR_FUTURE_DATE,
	};
}

/** Wrapper `wrapper` under entry `entry`, holding photos in reverse order. */
function seedWrappedGroup(testDatabase: TestDatabase) {
	seedTestData(testDatabase, {
		...nodeFixtures([
			createTestNode({id: "day", name: "Sat, May 23, 2026", parentId: null}),
			createTestNode({id: "entry", name: "Drove to a friend’s house", parentId: "day"}),
			createTestNode({id: "wrapper", name: "", note: null, parentId: "entry"}),
			createTestNode({id: "photo-1", name: "", parentId: "wrapper", priority: 100}),
			createTestNode({id: "photo-2", name: "", parentId: "wrapper", priority: 200}),
			createTestNode({id: "photo-3", name: "", parentId: "wrapper", priority: 300}),
		]),
		s3Files: [
			s3File("photo-1", "IMG_0300.jpeg"),
			s3File("photo-2", "IMG_0200.jpeg"),
			s3File("photo-3", "IMG_0100.jpeg"),
		],
	});
}

describe("calendar:fix-photo-groups command", () => {
	let originalEnv: typeof process.env;
	let fetchStub: MockInstance;
	let tempDir: string;
	let testDatabase: TestDatabase;
	let requests: RecordedRequest[];

	beforeEach(() => {
		originalEnv = {...process.env};

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-photo-groups-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.WORKFLOWY_DB_PATH = testDbPath;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
		// Without this the staleness check decompresses every real monthly backup
		// archive on disk, costing ~1.5s per test and coupling results to the
		// developer's machine.
		process.env.WORKFLOWY_BACKUPS_DIR = path.join(tempDir, "backups");

		requests = [];
		const movedToBottom: string[] = [];
		fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			const urlString = url instanceof Request ? url.url : String(url);
			const method = init?.method ?? "GET";
			requests.push({
				url: urlString,
				method,
				body: requestJson(init),
			});

			const {pathname, searchParams} = new URL(urlString);
			const nodeId = pathname.split("/")[4]!;
			if (method === "POST" && pathname.endsWith("/move")) {
				movedToBottom.push(nodeId);
			}
			// Every write here is a move to the bottom of "entry", so a moved node sits
			// below the rest in move order.
			const apiNode = (id: string, parentId: string) => ({
				id,
				name: "",
				parent_id: parentId,
				priority: movedToBottom.includes(id) ? 1000 + movedToBottom.indexOf(id) * 100 : 0,
				completed: false,
				createdAt: 1_700_000_000_000,
				modifiedAt: 1_700_000_000_000,
				completedAt: null,
				data: {},
			});
			const parentId = searchParams.get("parent_id");
			if (method === "GET" && parentId !== null) {
				// Workflowy lists the cached children with every move applied: a moved node leaves its old parent for "entry".
				const cached = testDatabase.db
					.select({id: nodeContent.id})
					.from(nodeContent)
					.where(and(eq(nodeContent.parentId, parentId), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
					.all()
					.map(({id}) => id)
					.filter((id) => !movedToBottom.includes(id));
				const ids = parentId === "entry" ? [...cached, ...movedToBottom] : cached;
				const nodes = ids.map((id) => apiNode(id, parentId));
				return Promise.resolve(Response.json({nodes}, {status: 200}));
			}
			if (method === "GET") {
				return Promise.resolve(Response.json({node: apiNode(nodeId, "entry")}, {status: 200}));
			}

			return Promise.resolve(Response.json({}, {status: 200}));
		});
	});

	afterEach(() => {
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("previews a wrapped group without calling the API", async () => {
		seedWrappedGroup(testDatabase);

		const {stdout} = await captureOutput(async () => {
			await FixPhotoGroups.run(["--dry-run"]);
		});

		expect(stdout).toBe(
			'Found 1 photo groups: 1 to fix, 0 left alone\n\n--- DRY RUN ---\n  wrapper wrapper under entry entry "Drove to a friend’s house" — reverse (filenames descend)\n    photo-3  IMG_0100.jpeg\n    photo-2  IMG_0200.jpeg\n    photo-1  IMG_0300.jpeg\n\nTotal: 1 groups would be fixed\n',
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("unwraps and reverses a wrapped group, then deletes the wrapper", async () => {
		seedWrappedGroup(testDatabase);

		await captureOutput(async () => {
			await FixPhotoGroups.run(["--delay", "0"]);
		});

		const writes = requests
			.filter((request) => request.method === "POST" || request.method === "DELETE")
			.map((request) => [request.method, request.url.replace(/^.*\/api\/v1/u, ""), request.body]);

		expect(writes).toStrictEqual([
			["POST", "/nodes/photo-3/move", {parent_id: "entry", position: "bottom"}],
			["POST", "/nodes/photo-2/move", {parent_id: "entry", position: "bottom"}],
			["POST", "/nodes/photo-1/move", {parent_id: "entry", position: "bottom"}],
			["DELETE", "/nodes/wrapper", undefined],
		]);
	});

	it("reverses a loose group in place without deleting anything", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "day", name: "Wed, Jul 1, 2026", parentId: null}),
				createTestNode({id: "entry", name: "Flat Rock Brook", parentId: "day"}),
				createTestNode({id: "photo-1", name: "", parentId: "entry", priority: 100}),
				createTestNode({id: "photo-2", name: "", parentId: "entry", priority: 200}),
			]),
			s3Files: [s3File("photo-1", "IMG_3695.jpeg"), s3File("photo-2", "IMG_3667.jpeg")],
		});

		await captureOutput(async () => {
			await FixPhotoGroups.run(["--delay", "0"]);
		});

		const writes = requests
			.filter((request) => request.method === "POST" || request.method === "DELETE")
			.map((request) => [request.method, request.url.replace(/^.*\/api\/v1/u, ""), request.body]);

		expect(writes).toStrictEqual([
			["POST", "/nodes/photo-2/move", {parent_id: "entry", position: "bottom"}],
			["POST", "/nodes/photo-1/move", {parent_id: "entry", position: "bottom"}],
		]);
	});

	it("leaves a loose group alone when its filenames give no ordering evidence", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "day", name: "Wed, Jul 1, 2026", parentId: null}),
				createTestNode({id: "entry", name: "Flat Rock Brook", parentId: "day"}),
				createTestNode({id: "photo-1", name: "", parentId: "entry", priority: 100}),
				createTestNode({id: "photo-2", name: "", parentId: "entry", priority: 200}),
			]),
			s3Files: [s3File("photo-1", "image.jpeg"), s3File("photo-2", "image.jpeg")],
		});

		const {stdout} = await captureOutput(async () => {
			await FixPhotoGroups.run(["--delay", "0"]);
		});

		expect(stdout).toBe(
			"Found 1 photo groups: 0 to fix, 1 left alone\n  1 left alone: loose group without filename evidence\n",
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("leaves a group alone when its filenames already ascend", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "day", name: "Wed, Jul 1, 2026", parentId: null}),
				createTestNode({id: "entry", name: "Flat Rock Brook", parentId: "day"}),
				createTestNode({id: "photo-1", name: "", parentId: "entry", priority: 100}),
				createTestNode({id: "photo-2", name: "", parentId: "entry", priority: 200}),
			]),
			s3Files: [s3File("photo-1", "IMG_3667.jpeg"), s3File("photo-2", "IMG_3695.jpeg")],
		});

		await captureOutput(async () => {
			await FixPhotoGroups.run(["--delay", "0"]);
		});

		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("restricts work to one group using its short ID", async () => {
		const wrapperId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "day", name: "Sat, May 23, 2026", parentId: null}),
				createTestNode({id: "entry", name: "Drove to a friend’s house", parentId: "day"}),
				createTestNode({id: wrapperId, shortId: "eeeeeeeeeeee", name: "", parentId: "entry"}),
				createTestNode({id: "photo-1", name: "", parentId: wrapperId, priority: 100}),
				createTestNode({id: "photo-2", name: "", parentId: wrapperId, priority: 200}),
				createTestNode({id: "other-entry", name: "Another entry", parentId: "day"}),
				createTestNode({id: "other-wrapper", name: "", parentId: "other-entry"}),
				createTestNode({id: "photo-3", name: "", parentId: "other-wrapper", priority: 100}),
				createTestNode({id: "photo-4", name: "", parentId: "other-wrapper", priority: 200}),
			]),
			s3Files: [
				s3File("photo-1", "image.jpeg"),
				s3File("photo-2", "image.jpeg"),
				s3File("photo-3", "image.jpeg"),
				s3File("photo-4", "image.jpeg"),
			],
		});

		await captureOutput(async () => {
			await FixPhotoGroups.run(["--node-id", "eeeeeeeeeeee", "--delay", "0"]);
		});

		const movedIds = requests
			.filter((request) => request.url.includes("/move"))
			.map((request) => request.url.split("/nodes/")[1]?.replace("/move", ""));

		expect(movedIds).toStrictEqual(["photo-2", "photo-1"]);
	});

	it("resolves a short ID for a dry run without an API key", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		const wrapperId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "day", name: "Sat, May 23, 2026", parentId: null}),
				createTestNode({id: "entry", name: "Drove to a friend’s house", parentId: "day"}),
				createTestNode({id: wrapperId, shortId: "eeeeeeeeeeee", name: "", parentId: "entry"}),
				createTestNode({id: "photo-1", name: "", parentId: wrapperId, priority: 100}),
				createTestNode({id: "photo-2", name: "", parentId: wrapperId, priority: 200}),
			]),
			s3Files: [s3File("photo-1", "image.jpeg"), s3File("photo-2", "image.jpeg")],
		});

		const {stdout} = await captureOutput(async () => {
			await FixPhotoGroups.run(["--node-id", "eeeeeeeeeeee", "--dry-run"]);
		});

		expect(stdout).toBe(
			`Found 1 photo groups: 1 to fix, 0 left alone\n\n--- DRY RUN ---\n  wrapper ${wrapperId} under entry entry "Drove to a friend’s house" — reverse (wrapped group, assuming a single reversed paste)\n    photo-2  image.jpeg\n    photo-1  image.jpeg\n\nTotal: 1 groups would be fixed\n`,
		);
		expect(fetchStub.mock.calls).toStrictEqual([]);
	});

	it("requires WORKFLOWY_API_KEY when not doing a dry run", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		seedWrappedGroup(testDatabase);

		await expect(FixPhotoGroups.run(["--delay", "0"])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});
