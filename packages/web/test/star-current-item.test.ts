import {describe, expect, it, vi} from "vite-plus/test";
import type {StarredLocation} from "@outlinedb/shared";
import {starCurrentItemCommand} from "../src/client/star-commands.js";

function run(zoomedId: string | null, query: string | null): StarredLocation[] {
	const toggleStar = vi.fn<(loc: StarredLocation) => Promise<unknown>>(async () => Promise.resolve());
	starCurrentItemCommand(toggleStar, () => query).execute({zoomedId} as never);
	return toggleStar.mock.calls.map(([loc]) => loc);
}

describe("star_current_item", () => {
	it("stars the zoomed page plus the committed search query", () => {
		expect(run("S", "zzq")).toStrictEqual([{nodeId: "S", query: "zzq"}]);
	});

	it("stars Home when nothing is zoomed or searched", () => {
		expect(run(null, null)).toStrictEqual([{nodeId: null, query: null}]);
	});

	it("stars the page alone when the query is empty", () => {
		expect(run("S", "")).toStrictEqual([{nodeId: "S", query: null}]);
	});
});
