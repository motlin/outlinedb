import {describe, expect, it} from "vite-plus/test";
import {orderChanges, renameChanges, starChanges, starsFromRootMeta, unstarChanges} from "../src/internal/stars.js";
import type {StarNodes} from "../src/internal/stars.js";

const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const P2 = "5e6f7a8b-0000-4000-8000-000000000002";
const GONE = "9c9c9c9c-0000-4000-8000-000000000009";

const names: Record<string, string> = {[P1]: "Alpha", [P2]: "Bravo"};
const nodes: StarNodes = {
	exists: (nodeId) => Object.hasOwn(names, nodeId),
	nameText: (nodeId) => (nodeId === null ? "Home" : (names[nodeId] ?? "")),
};

describe("starsFromRootMeta", () => {
	it("follows starring.order (uniqueIds) and reads renames keyed by uniqueId", () => {
		const meta = {
			starring: {
				locations: {[P1]: "None", [`${P1}_#todo`]: "None"},
				order: `None/${P1}/#todo,None/${P1}/`,
			},
			location: {renamed: {[`None/${P1}/`]: "Alice"}},
		};

		expect(starsFromRootMeta(meta, nodes)).toStrictEqual([
			{key: `${P1}_#todo`, nodeId: P1, query: "#todo", name: null, position: 0},
			{key: P1, nodeId: P1, query: null, name: "Alice", position: 1},
		]);
	});

	it("drops unknown, duplicate and invalid order entries and appends valid stars missing from it", () => {
		const meta = {
			starring: {
				locations: {[P2]: "None", [GONE]: "None", None: "None", [P1]: "None"},
				order: `None/${P1}/,None/${P1}/,None/${GONE}/,None/zzz/`,
			},
		};

		expect(starsFromRootMeta(meta, nodes)).toStrictEqual([
			{key: P1, nodeId: P1, query: null, name: null, position: 0},
			{key: P2, nodeId: P2, query: null, name: null, position: 1},
			{key: "None", nodeId: null, query: null, name: null, position: 2},
		]);
	});

	it("uses the default order (searches by query, then pages by name) without starring.order", () => {
		const meta = {
			starring: {locations: {[P2]: "None", [`${P1}_zeta`]: "None", [`${P1}_alpha`]: "None", [P1]: "None"}},
		};

		expect(starsFromRootMeta(meta, nodes).map((s) => s.key)).toStrictEqual([`${P1}_alpha`, `${P1}_zeta`, P1, P2]);
	});

	it("ignores stars in other trees and an empty metadata object", () => {
		expect({
			shared: starsFromRootMeta({starring: {locations: {[P1]: "other-tree"}}}, nodes),
			empty: starsFromRootMeta({}, nodes),
		}).toStrictEqual({shared: [], empty: []});
	});
});

describe("starChanges", () => {
	it("sets the location and appends the uniqueId to an existing order", () => {
		const meta = {starring: {isSynced: true, locations: {[P1]: "None"}, order: `None/${P1}/`}};

		expect(starChanges(meta, `${P1}_#todo`)).toStrictEqual([
			{path: ["starring", "locations", `${P1}_#todo`], value: "None"},
			{path: ["starring", "order"], value: `None/${P1}/,None/${P1}/#todo`},
		]);
	});

	it("leaves the order alone when the account has none (never reordered), like upstream", () => {
		const meta = {starring: {isSynced: true}};

		expect(starChanges(meta, "None")).toStrictEqual([{path: ["starring", "locations", "None"], value: "None"}]);
	});

	it("marks a fresh account with no starring metadata as synced, like upstream's first toggle", () => {
		expect(starChanges({}, P1)).toStrictEqual([
			{path: ["starring", "locations", P1], value: "None"},
			{path: ["starring", "isSynced"], value: true},
		]);
	});

	it("marks an account whose stars are not yet synced as synced", () => {
		const meta = {starring: {isSynced: false, locations: {}}};

		expect(starChanges(meta, P1)).toStrictEqual([
			{path: ["starring", "locations", P1], value: "None"},
			{path: ["starring", "isSynced"], value: true},
		]);
	});

	it("does not duplicate an order entry that is already there", () => {
		const meta = {starring: {isSynced: true, locations: {}, order: `None/${P1}/`}};

		expect(starChanges(meta, P1)).toStrictEqual([{path: ["starring", "locations", P1], value: "None"}]);
	});
});

describe("unstarChanges", () => {
	it("removes the location and its order entry, and keeps the custom name", () => {
		const meta = {
			starring: {isSynced: true, locations: {[P1]: "None", [P2]: "None"}, order: `None/${P2}/,None/${P1}/`},
			location: {renamed: {[`None/${P1}/`]: "Alice"}},
		};

		expect(unstarChanges(meta, P1)).toStrictEqual([
			{path: ["starring", "locations", P1], value: undefined},
			{path: ["starring", "order"], value: `None/${P2}/`},
		]);
	});

	it("only removes the location when there is no order", () => {
		const meta = {starring: {isSynced: true, locations: {[P1]: "None"}}};

		expect(unstarChanges(meta, P1)).toStrictEqual([{path: ["starring", "locations", P1], value: undefined}]);
	});

	it("marks a fresh account with no starring metadata as synced", () => {
		expect(unstarChanges({}, P1)).toStrictEqual([
			{path: ["starring", "locations", P1], value: undefined},
			{path: ["starring", "isSynced"], value: true},
		]);
	});
});

describe("re-starring after an unstar", () => {
	it("shows the custom name kept through the unstar", () => {
		const meta = {starring: {locations: {[P1]: "None"}}, location: {renamed: {[`None/${P1}/`]: "Alice"}}};

		expect(starsFromRootMeta(meta, nodes).map((star) => star.name)).toStrictEqual(["Alice"]);
	});
});

describe("renameChanges and orderChanges", () => {
	it("renames by uniqueId and clears on null or empty", () => {
		expect({
			set: renameChanges(`${P1}_#todo`, "Inbox triage"),
			cleared: renameChanges(`${P1}_#todo`, null),
			empty: renameChanges(`${P1}_#todo`, ""),
		}).toStrictEqual({
			set: [{path: ["location", "renamed", `None/${P1}/#todo`], value: "Inbox triage"}],
			cleared: [{path: ["location", "renamed", `None/${P1}/#todo`], value: undefined}],
			empty: [{path: ["location", "renamed", `None/${P1}/#todo`], value: undefined}],
		});
	});

	it("stores keys as comma-joined uniqueIds", () => {
		expect(orderChanges([`${P1}_#todo`, "None", P2])).toStrictEqual([
			{path: ["starring", "order"], value: `None/${P1}/#todo,None/None/,None/${P2}/`},
		]);
	});
});
