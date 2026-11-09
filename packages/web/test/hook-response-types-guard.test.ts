import {readdirSync, readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const CLIENT_DIR = new URL("../src/client/", import.meta.url);

/** The type argument of each `readJson<...>(` call, scanning balanced angle brackets (skipping `=>`). */
function readJsonTypeArgs(source: string): string[] {
	const args: string[] = [];
	let start = source.indexOf("readJson<");
	while (start !== -1) {
		const open = start + "readJson<".length;
		let depth = 1;
		let index = open;
		for (; index < source.length && depth > 0; index++) {
			const char = source[index];
			if (char === "<") {
				depth++;
			} else if (char === ">" && source[index - 1] !== "=") {
				depth--;
			}
		}
		args.push(source.slice(open, index - 1));
		start = source.indexOf("readJson<", index);
	}
	return args;
}

/** Each type name imported from another client module: anything relative except `node-types.js` and the server. */
function clientImportedTypes(source: string): Set<string> {
	const names = new Set<string>();
	for (const [, list = "", from = ""] of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/gu)) {
		if (!from.startsWith(".") || /node-types\.js$|\/server\//u.test(from)) {
			continue;
		}
		for (const specifier of list.split(",")) {
			const name = specifier
				.replace(/^\s*type\s+/u, "")
				.split(/\s+as\s+/u)
				.at(-1)
				?.trim();
			if (name) {
				names.add(name);
			}
		}
	}
	return names;
}

/**
 * `file: Name` for every response type a client module declares itself, or imports from another client module, and
 * `file: readJson<{...}>` for every inline object type. Such a copy drifts silently from the op's output schema (the
 * useMoveNode bug); infer the type from the schema in `node-types.ts` instead.
 */
function handTypedResponses(): string[] {
	const found = new Set<string>();
	// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
	for (const file of readdirSync(CLIENT_DIR, {recursive: true, encoding: "utf8"}).sort()) {
		if (!/\.tsx?$/u.test(file) || file === "read-json.ts") {
			continue;
		}
		const source = readFileSync(new URL(file, CLIENT_DIR), "utf8");
		const local = new Set([...source.matchAll(/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/gmu)].map((m) => m[1]));
		const copied = clientImportedTypes(source);
		for (const arg of readJsonTypeArgs(source)) {
			if (arg.includes("{")) {
				found.add(`${file}: readJson<${arg}>`);
			}
			for (const name of arg.match(/\b[A-Z]\w*\b/gu) ?? []) {
				if (local.has(name) || copied.has(name)) {
					found.add(`${file}: ${name}`);
				}
			}
		}
	}
	// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
	return [...found].sort();
}

/**
 * Reads exempt from schema inference: only the decisions page, which leaves this repo with the rest of GTD. Never add
 * one; infer the type from the op's output schema in `node-types.ts` instead.
 */
const EXEMPT_READS = [
	// The decisions page is GTD and moves to its own repo with its backend; it gets no op here.
	"components/decisions-view.tsx: readJson<{error: string}>",
];

describe("client modules read op responses as schema-inferred types", () => {
	it("declares, copies or inlines no response type beyond the exempt decisions reads", () => {
		expect(handTypedResponses()).toStrictEqual(EXEMPT_READS);
	});

	it("finds a locally declared type inside a readJson type argument", () => {
		expect(
			readJsonTypeArgs(
				"interface Local {a: string}\nreadJson<Partial<Local> & {error?: string}>(r); readJson<{f: () => X}>(r);",
			),
		).toStrictEqual(["Partial<Local> & {error?: string}", "{f: () => X}"]);
	});

	it("treats types imported from client modules as copies, but not node-types or server types", () => {
		expect([
			...clientImportedTypes(
				[
					'import type {Copy, Other as Renamed} from "../calendar-layout-model.js";',
					'import {type Mixed, value} from "./mirror-menu.js";',
					'import type {NodeResponse} from "../../node-types.js";',
					'import type {SwitcherResponse} from "../../server/switcher-search.js";',
					'import type {Star} from "@outlinedb/shared";',
				].join("\n"),
			),
		]).toStrictEqual(["Copy", "Renamed", "Mixed", "value"]);
	});
});
