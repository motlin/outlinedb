import {ancestorChain} from "@outlinedb/shared/cache";
import {describe, expect, it} from "vite-plus/test";

interface Row {
	id: string;
	parentId: string | null;
}

function lookup(rows: Row[]): (id: string) => Row | undefined {
	const byId = new Map(rows.map((row) => [row.id, row]));
	return (id) => byId.get(id);
}

describe("ancestorChain", () => {
	it("lists the start node and its ancestors nearest first up to Home", () => {
		const get = lookup([
			{id: "root", parentId: null},
			{id: "child", parentId: "root"},
			{id: "leaf", parentId: "child"},
		]);

		expect(ancestorChain("leaf", get)).toStrictEqual([
			{id: "leaf", parentId: "child"},
			{id: "child", parentId: "root"},
			{id: "root", parentId: null},
		]);
	});

	it("is empty for Home", () => {
		expect(ancestorChain(null, lookup([]))).toStrictEqual([]);
	});

	it("stops at a node the lookup does not find", () => {
		const get = lookup([{id: "leaf", parentId: "missing"}]);

		expect(ancestorChain("leaf", get)).toStrictEqual([{id: "leaf", parentId: "missing"}]);
	});

	it("stops where a stale cache's chain loops back on itself", () => {
		const get = lookup([
			{id: "leaf", parentId: "a"},
			{id: "a", parentId: "b"},
			{id: "b", parentId: "a"},
		]);

		expect(ancestorChain("leaf", get)).toStrictEqual([
			{id: "leaf", parentId: "a"},
			{id: "a", parentId: "b"},
			{id: "b", parentId: "a"},
		]);
	});
});
