/**
 * Every web test parses each op's successful value against the op's output schema. The registry is wrapped when
 * something first imports it, so the web files that never touch server code skip loading it. The factory imports the
 * real modules, so a file's own `vi.mock` still reaches the modules the ops import.
 */
import {vi} from "vite-plus/test";
import {checkOpOutputs} from "../helpers/check-op-outputs.js";

vi.mock(import("../../src/server/ops/index.js"), async (importOriginal) => {
	const registry = await importOriginal();
	checkOpOutputs(registry.Ops);
	return registry;
});
