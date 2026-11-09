import {describe, expect, it} from "vite-plus/test";
import {subpathsNotLoadedFromSource} from "./helpers/source-resolution.js";

describe("@outlinedb/shared resolution in CLI tests", () => {
	it("loads every subpath from source, never from the gitignored dist build", async () => {
		await expect(subpathsNotLoadedFromSource(async (specifier) => import(specifier))).resolves.toStrictEqual([]);
	});
});
