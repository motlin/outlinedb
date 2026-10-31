import {QueryClient} from "@tanstack/react-query";
import {describe, expect, it} from "vite-plus/test";
import {queryClientDefaults} from "../src/client/query-retry.js";
import {shareById} from "../src/client/structural-sharing.js";

const row = (id: string, priority: number) => ({id, name: `row ${id}`, priority, data: {layoutMode: null}});

describe("shareById", () => {
	it("keeps each unchanged row's object when rows before it leave the list", () => {
		const a = row("a", 0);
		const b = row("b", 1);
		const c = row("c", 2);
		const d = row("d", 3);
		const shared = shareById([a, b, c, d], [row("a", 0), row("d", 3)]) as unknown[];
		expect([shared[0] === a, shared[1] === d, shared.length]).toStrictEqual([true, true, 2]);
	});

	it("keeps each unchanged row's object when rows are inserted before it", () => {
		const a = row("a", 0);
		const d = row("d", 3);
		const shared = shareById([a, d], [row("a", 0), row("b", 1), row("d", 3)]) as unknown[];
		expect([shared[0] === a, shared[2] === d]).toStrictEqual([true, true]);
	});

	it("returns a changed row as a new object that still shares its unchanged nested values", () => {
		const a = row("a", 0);
		const shared = shareById([a], [row("a", 5)]) as (typeof a)[];
		expect({
			same: shared[0] === a,
			data: shared[0]?.data === a.data,
			value: shared[0],
		}).toStrictEqual({same: false, data: true, value: row("a", 5)});
	});

	it("returns the previous list itself when nothing changed", () => {
		const previous = [row("a", 0), row("b", 1)];
		expect(shareById(previous, [row("a", 0), row("b", 1)])).toBe(previous);
	});

	it("shares rows by id inside nested lists, such as a children response keyed by parent", () => {
		const d = row("d", 3);
		const previous = {children: {p: [row("a", 0), row("b", 1), d]}};
		const shared = shareById(previous, {children: {p: [row("a", 0), row("d", 3)]}}) as typeof previous;
		expect(shared.children.p[1] === d).toBe(true);
	});

	it("falls back to positions for lists without unique ids", () => {
		const first = {name: "x"};
		const shared = shareById([first, {name: "y"}], [{name: "x"}, {name: "z"}]) as unknown[];
		expect([shared[0] === first, shared[1]]).toStrictEqual([true, {name: "z"}]);
	});
});

describe("queryClientDefaults", () => {
	it("keeps an unmoved row's object when a block above it moves out of its children list", () => {
		const client = new QueryClient({defaultOptions: queryClientDefaults});
		const key = ["nodes", "children", "p"];
		const rows = [row("a", 0), row("b", 1), row("c", 2), row("d", 3)];
		client.setQueryData(key, rows);
		client.setQueryData(key, (previous: typeof rows | undefined) =>
			previous?.filter((node) => node.id === "a" || node.id === "d"),
		);
		expect(client.getQueryData<typeof rows>(key)?.[1]).toBe(rows[3]);
	});
});
