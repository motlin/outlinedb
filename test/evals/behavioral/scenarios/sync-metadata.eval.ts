/**
 * Behavioral eval: sync-metadata.sh script against local cache.
 *
 * Validates that the sync-metadata.sh script runs against the eval database,
 * reads metadata from the cache, and produces valid JSON files in .llm/gtd/metadata/.
 *
 * The script derives PROJECT_ROOT from its own location, so .llm/ output goes
 * to the real project root. We verify the script succeeds and produces valid output.
 */

import {beforeAll, expect, describe, afterAll, it} from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createEvalContext, runInEvalContext} from "../helpers/eval-db-setup.js";
import type {EvalContext} from "../helpers/eval-types.js";

const MetadataRootSchema = z.looseObject({id: z.unknown(), children: z.array(z.unknown())});
const TagFrequencySchema = z.object({
	generatedFrom: z.string(),
	distinctTags: z.number(),
	taggedRowsScanned: z.number(),
	tags: z.record(z.string(), z.unknown()),
});

// Phase 3 of sync-metadata.sh emits this aggregate rather than a node dump.
const TAG_FREQUENCY_FILE = "tag-frequency.json";

describe("Behavioral Eval: sync-metadata.sh", () => {
	let ctx: EvalContext;
	let metadataDir: string;

	beforeAll(() => {
		ctx = createEvalContext();
		metadataDir = path.join(ctx.projectRoot, ".llm/gtd/metadata");
	});

	afterAll(() => {
		ctx.cleanup();
	});

	it("should run without errors against the eval database", {timeout: 120_000}, async () => {
		const result = await runInEvalContext(ctx, "plugins/gtd/scripts/sync-metadata.sh");

		expect(result.exitCode, `Script failed with stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
		expect(result.stdout).toContain("Phase 1:");
		expect(result.stdout).toContain("Sync complete");
	});

	it("should create metadata.json root index", {timeout: 120_000}, async () => {
		await runInEvalContext(ctx, "plugins/gtd/scripts/sync-metadata.sh");

		const rootFile = path.join(ctx.projectRoot, ".llm/gtd/metadata.json");
		expect(fs.existsSync(rootFile), `Expected ${rootFile} to exist`).toBe(true);

		const content = fs.readFileSync(rootFile, "utf8");
		const parsed = MetadataRootSchema.parse(JSON.parse(content));

		expect(parsed.children.length).toBeGreaterThan(0);
	});

	it("should create section JSON files in metadata/", {timeout: 120_000}, async () => {
		await runInEvalContext(ctx, "plugins/gtd/scripts/sync-metadata.sh");

		expect(fs.existsSync(metadataDir), `Expected ${metadataDir} to exist`).toBe(true);

		const files = fs.readdirSync(metadataDir).filter((f) => f.endsWith(".json"));
		expect(files.length, "Should have at least one section JSON file").toBeGreaterThan(0);

		// Phase 1/2 write one node dump per section; Phase 3 writes tag-frequency.json,
		// an aggregate over the cache that is deliberately not shaped like a node.
		for (const file of files) {
			const filePath = path.join(metadataDir, file);
			const content = fs.readFileSync(filePath, "utf8").trim();
			if (content.length === 0) {
				continue;
			}
			const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(content));

			if (file === TAG_FREQUENCY_FILE) {
				expect(Object.keys(parsed), `${file} should be a tag-frequency aggregate`).toStrictEqual([
					"generatedFrom",
					"distinctTags",
					"taggedRowsScanned",
					"tags",
				]);
				const tagFrequency = TagFrequencySchema.parse(parsed);
				expect(tagFrequency.generatedFrom).toBe("outlinedb.sqlite");
				expect(tagFrequency.distinctTags).toBe(Object.keys(tagFrequency.tags).length);
				continue;
			}

			expect(parsed, `${file} should have an id`).toHaveProperty("id");
		}
	});

	it("should create subdirectories for link-based sections", {timeout: 120_000}, async () => {
		await runInEvalContext(ctx, "plugins/gtd/scripts/sync-metadata.sh");

		// Check for at least one subdirectory (e.g., inboxes/, next-actions/)
		const entries = fs.readdirSync(metadataDir, {withFileTypes: true});
		const subdirs = entries.filter((e) => e.isDirectory());

		expect(subdirs.length, "Should have at least one link-based section subdirectory").toBeGreaterThan(0);

		// Each subdirectory should contain JSON files
		for (const subdir of subdirs) {
			const subdirPath = path.join(metadataDir, subdir.name);
			const subFiles = fs.readdirSync(subdirPath).filter((f) => f.endsWith(".json"));
			expect(subFiles.length, `${subdir.name}/ should have at least one JSON file`).toBeGreaterThan(0);
		}
	});
});
