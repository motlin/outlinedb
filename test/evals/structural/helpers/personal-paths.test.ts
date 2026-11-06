import {expect, describe, it} from "vite-plus/test";
import {findPersonalHomePaths} from "./personal-paths.js";

describe("findPersonalHomePaths", () => {
	it("accepts placeholder home directories", () => {
		const lines = [
			'const home = "/Users/alice";',
			"path: /home/alice/repos/my-app",
			'expandHome("~/projects", "/home/me")',
			"cd /Users/Bob/projects && ls /Users/carol",
		];
		expect(lines.map((line) => findPersonalHomePaths(line))).toStrictEqual([[], [], [], []]);
	});

	it("flags real or arbitrary home directories", () => {
		expect(findPersonalHomePaths("cd /Users/craig/projects/workflowy")).toStrictEqual(["/Users/craig"]);
		expect(findPersonalHomePaths("ls /home/zebulon/.config")).toStrictEqual(["/home/zebulon"]);
	});

	it("flags a real name that only starts like a placeholder", () => {
		expect(findPersonalHomePaths("/Users/alicewong/notes")).toStrictEqual(["/Users/alicewong"]);
	});

	it("flags every real home directory on a line, even after a placeholder", () => {
		expect(findPersonalHomePaths("/Users/alice and /Users/craig and /home/someone")).toStrictEqual([
			"/Users/craig",
			"/home/someone",
		]);
	});
});
