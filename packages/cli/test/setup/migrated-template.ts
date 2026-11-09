import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {TestProject} from "vite-plus/test/node";
import {createDatabase} from "../../src/db/index.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** A database file with every migration applied, which `createTestDatabase` copies instead of migrating again. */
		migratedDatabaseTemplate: string;
	}
}

/**
 * Migrate one template database for the whole run. Test files are module-isolated, so a cache kept in the
 * helper module was rebuilt by every database-backed file inside its first beforeEach.
 */
export function setup(project: TestProject): () => void {
	const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-db-template-"));
	const templatePath = path.join(templateDir, "template.sqlite");
	const template = createDatabase(templatePath).$client;
	// Rollback journaling keeps the bytes loadable as an in-memory database; each copy picks its own mode on open.
	template.pragma("journal_mode = DELETE");
	template.close();
	project.provide("migratedDatabaseTemplate", templatePath);

	return () => {
		fs.rmSync(templateDir, {recursive: true, force: true});
	};
}
