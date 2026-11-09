import {assert, beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import {CacheService, NodeTreeReader} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {cleanupTestDatabase, createTestDatabase, nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createTestNode} from "../helpers/node-fixtures.js";

describe("NodeTreeReader", () => {
	let tempDir: string;
	let testDatabase: TestDatabase;
	let reader: NodeTreeReader;
	const from = formatTemporalTimestamp(new Date(Date.now() - 1000));

	beforeEach(() => {
		vi.useFakeTimers({shouldAdvanceTime: true});
		vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-tree-test-"));
		testDatabase = createTestDatabase(path.join(tempDir, "test.sqlite"));
		reader = new NodeTreeReader(new CacheService(testDatabase.db));
	});

	afterEach(() => {
		vi.useRealTimers();
		cleanupTestDatabase(testDatabase);
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("reads children as subtrees to the requested depth", async () => {
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "c1", name: "Child 1", parentId: "p", priority: 0}),
				createTestNode({id: "c2", name: "Child 2", parentId: "p", priority: 1}),
				createTestNode({id: "gc1", name: "Grandchild", parentId: "c1"}),
			]),
		);

		const trees = await reader.readChildren("p", {depth: 2});

		expect(trees).toStrictEqual([
			{
				id: "c1",
				shortId: "c1",
				parentId: "p",
				name: "Child 1",
				note: null,
				priority: 0,
				layoutMode: "bullets",
				createdAt: new Date("2026-01-01T12:00:00.000Z"),
				modifiedAt: new Date("2026-01-01T12:00:00.000Z"),
				completedAt: null,
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemFrom: "2026-01-01 12:00:00.000",
				systemTo: FAR_FUTURE_DATE,
				inChat: false,
				hasReferencesRoot: false,
				children: [
					{
						id: "gc1",
						shortId: "gc1",
						parentId: "c1",
						name: "Grandchild",
						note: null,
						priority: 0,
						layoutMode: "bullets",
						createdAt: new Date("2026-01-01T12:00:00.000Z"),
						modifiedAt: new Date("2026-01-01T12:00:00.000Z"),
						completedAt: null,
						collapsed: false,
						mirror: {isMirror: false, originalNodeId: null},
						systemFrom: "2026-01-01 12:00:00.000",
						systemTo: FAR_FUTURE_DATE,
						inChat: false,
						hasReferencesRoot: false,
					},
				],
			},
			{
				id: "c2",
				shortId: "c2",
				parentId: "p",
				name: "Child 2",
				note: null,
				priority: 1,
				layoutMode: "bullets",
				createdAt: new Date("2026-01-01T12:00:00.000Z"),
				modifiedAt: new Date("2026-01-01T12:00:00.000Z"),
				completedAt: null,
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemFrom: "2026-01-01 12:00:00.000",
				systemTo: FAR_FUTURE_DATE,
				inChat: false,
				hasReferencesRoot: false,
			},
		]);
	});

	it("does not resolve children at depth 0", async () => {
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "c1", name: "Child 1", parentId: "p"}),
			]),
		);

		const trees = await reader.readChildren("p", {depth: 0});

		expect(trees).toStrictEqual([
			{
				id: "c1",
				shortId: "c1",
				parentId: "p",
				name: "Child 1",
				note: null,
				priority: 0,
				layoutMode: "bullets",
				createdAt: new Date("2026-01-01T12:00:00.000Z"),
				modifiedAt: new Date("2026-01-01T12:00:00.000Z"),
				completedAt: null,
				collapsed: false,
				mirror: {isMirror: false, originalNodeId: null},
				systemFrom: "2026-01-01 12:00:00.000",
				systemTo: FAR_FUTURE_DATE,
				inChat: false,
				hasReferencesRoot: false,
			},
		]);
	});

	it("surfaces the inChat and hasReferencesRoot flags", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "chat", name: "In chat", parentId: "p", priority: 0}),
				createTestNode({id: "ref", name: "Ref root", parentId: "p", priority: 1}),
				createTestNode({id: "plain", name: "Plain", parentId: "p", priority: 2}),
			]),
			aiMetadata: [{nodeId: "chat", inChat: 1, systemFrom: from, systemTo: FAR_FUTURE_DATE}],
			referencesRoots: [{nodeId: "ref", systemFrom: from, systemTo: FAR_FUTURE_DATE}],
		});

		const [chat, ref, plain] = await reader.readChildren("p", {depth: 0});
		assert(chat && ref && plain);

		expect({inChat: chat.inChat, ref: chat.hasReferencesRoot}).toStrictEqual({inChat: true, ref: false});
		expect({inChat: ref.inChat, ref: ref.hasReferencesRoot}).toStrictEqual({inChat: false, ref: true});
		expect({inChat: plain.inChat, ref: plain.hasReferencesRoot}).toStrictEqual({inChat: false, ref: false});
	});

	it("inherits a mirror original content and children", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "orig", name: "Original Name", note: "Original Note", parentId: "elsewhere"}),
				createTestNode({id: "orig-child", name: "Original Child", parentId: "orig"}),
				// A mirror carries no content of its own.
				createTestNode({id: "mir", name: null, parentId: "p"}),
			]),
			mirrors: [{originalId: "orig", mirrorId: "mir", systemFrom: from, systemTo: FAR_FUTURE_DATE}],
		});

		const [mirror] = await reader.readChildren("p", {depth: 1});
		assert(mirror);

		expect(mirror.mirror.isMirror).toBe(true);
		expect({name: mirror.name, note: mirror.note}).toStrictEqual({name: "Original Name", note: "Original Note"});
		expect(mirror.children?.map((c) => c.name)).toStrictEqual(["Original Child"]);
	});

	it("reads a mirror's completion from its original and ignores the mirror's own completedAt", async () => {
		seedTestData(testDatabase, {
			...nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "open-orig", name: "Open", parentId: "elsewhere"}),
				createTestNode({id: "done-orig", name: "Done", parentId: "elsewhere", completedAt: new Date(5000)}),
				createTestNode({id: "stale-mir", name: null, parentId: "p", priority: 1, completedAt: new Date(1234)}),
				createTestNode({id: "done-mir", name: null, parentId: "p", priority: 2}),
				createTestNode({id: "orphan-mir", name: null, parentId: "p", priority: 3, completedAt: new Date(99)}),
			]),
			mirrors: [
				{originalId: "open-orig", mirrorId: "stale-mir", systemFrom: from, systemTo: FAR_FUTURE_DATE},
				{originalId: "done-orig", mirrorId: "done-mir", systemFrom: from, systemTo: FAR_FUTURE_DATE},
				{originalId: "uncached", mirrorId: "orphan-mir", systemFrom: from, systemTo: FAR_FUTURE_DATE},
			],
		});

		const mirrors = await reader.readChildren("p", {depth: 0});

		expect(mirrors.map((m) => [m.id, m.completedAt])).toStrictEqual([
			["stale-mir", null],
			["done-mir", new Date(5000)],
			["orphan-mir", null],
		]);
	});

	it("populates linkTargets when following Workflowy links", async () => {
		const linkName = 'See <a href="https://workflowy.com/#/abcdef012345">target</a>';
		seedTestData(
			testDatabase,
			nodeFixtures([
				createTestNode({id: "p", name: "Parent", parentId: null}),
				createTestNode({id: "src", name: linkName, parentId: "p"}),
				createTestNode({id: "tgt", name: "Target Node", shortId: "abcdef012345", parentId: "elsewhere"}),
			]),
		);

		const [source] = await reader.readChildren("p", {depth: 1, followLinks: true});
		assert(source);

		expect(source.linkTargets?.map((t) => t.name)).toStrictEqual(["Target Node"]);
		expect(source.linkTargets?.[0]?.shortId).toBe("abcdef012345");
	});
});
