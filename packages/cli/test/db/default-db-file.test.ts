import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {DEFAULT_DB_FILE, defaultDbPath} from "../../src/db/default-db-file.js";

describe("defaultDbPath", () =>
{
	let root: string;

	beforeEach(() =>
	{
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "default-db-file-")));
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		fs.writeFileSync(path.join(root, DEFAULT_DB_FILE), "");
	});

	afterEach(() =>
	{
		fs.rmSync(
			root,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("resolves to the repo root's database from a subdirectory with no package.json", () =>
	{
		const subdirectory = path.join(root, ".llm", "gtd", "review");
		fs.mkdirSync(
			subdirectory,
			{
				recursive: true,
			},
		);

		expect(defaultDbPath(subdirectory)).toBe(path.join(root, DEFAULT_DB_FILE));
	});

	it("resolves to the working directory's database when no ancestor marks a project root", () =>
	{
		const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "default-db-file-outside-")));
		try
		{
			expect(defaultDbPath(outside)).toBe(path.join(outside, DEFAULT_DB_FILE));
		}
		finally
		{
			fs.rmSync(
				outside,
				{
					recursive: true,
					force: true,
				},
			);
		}
	});
});
