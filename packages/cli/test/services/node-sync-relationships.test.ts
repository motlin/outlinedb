import {WorkflowyApiClient} from "@workflowy/shared/api";
import type {InternalTreeItem} from "@workflowy/shared/api";
import type {WorkflowyNode} from "@workflowy/shared/types";
import {currentBacklinkItems} from "@workflowy/shared/cache";
import {referencesRoots} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {randomUUID} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {CacheService} from "../../src/services/cache.js";
import {NodeSyncService} from "../../src/services/node-sync.js";
import {cleanupTestDatabase, createTestDatabase} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";
import {createApiNode} from "../helpers/node-fixtures.js";

describe("NodeSyncService relationships", () => {
	let testDatabase: TestDatabase;
	let cacheService: CacheService;

	beforeEach(() => {
		testDatabase = createTestDatabase(path.join(os.tmpdir(), `test-workflowy-${randomUUID()}.sqlite`));
		cacheService = new CacheService(testDatabase.db);
		cacheService.storeApiResponse(
			[createApiNode({id: "target", name: "Target"}), createApiNode({id: "source", name: "Links to Target"})],
			null,
		);
		cacheService.storeApiResponse([createApiNode({id: "refs", name: "", parent_id: "target"})], "target");
		cacheService.storeApiResponse([createApiNode({id: "item", name: "", parent_id: "refs"})], "refs");
	});

	afterEach(() => {
		cleanupTestDatabase(testDatabase);
	});

	const treeItems: InternalTreeItem[] = [
		{id: "refs", metadata: {isReferencesRoot: true}},
		{
			id: "item",
			metadata: {
				mirror: {originalId: "source", isMirrorRoot: true},
				backlink: {sourceID: "source", targetID: "target"},
			},
		},
	];

	function syncService(items: InternalTreeItem[] | undefined) {
		const apiClient = new WorkflowyApiClient("test-api-key");
		const childrenOf: Record<string, WorkflowyNode[]> = {
			target: [createApiNode({id: "refs", name: "", parent_id: "target"})],
			refs: [createApiNode({id: "item", name: "", parent_id: "refs"})],
		};
		apiClient.getChildNodes = async (parentId) => Promise.resolve(childrenOf[parentId] ?? []);
		return new NodeSyncService(apiClient, cacheService, {
			database: testDatabase.db,
			treeData: async () => Promise.resolve(items),
		});
	}

	function rows() {
		return {
			referencesRoots: testDatabase.db
				.select({nodeId: referencesRoots.nodeId, systemTo: referencesRoots.systemTo})
				.from(referencesRoots)
				.all(),
			backlinks: currentBacklinkItems(testDatabase.db, undefined),
		};
	}

	it("inserts the references root and backlink mirror rows carried by the tree data", async () => {
		await syncService(treeItems).syncNode({nodeId: "target", recursive: true});

		expect(rows()).toStrictEqual({
			referencesRoots: [{nodeId: "refs", systemTo: FAR_FUTURE_DATE}],
			backlinks: [{nodeId: "item", sourceId: "source", targetId: "target"}],
		});
	});

	it("leaves the rows alone without the internal API", async () => {
		await syncService(undefined).syncNode({nodeId: "target", recursive: true});

		expect(rows()).toStrictEqual({referencesRoots: [], backlinks: []});
	});
});
