import {resolve} from "node:path";

import {Command} from "@oclif/core";
import type {Interfaces} from "@oclif/core";

// Under vitest, require.main is unset, so Command.run falls back to @oclif/core's own package.json,
// whose oclif.devPlugins names @oclif/plugin-plugins and warns on every test that it cannot be found.
const cliRoot = resolve(import.meta.dirname, "../..");
const originalRun: unknown = Reflect.get(Command, "run");
if (typeof originalRun !== "function")
{
	throw new TypeError("@oclif/core Command.run is not a function");
}

Reflect.set(Command, "run", function (this: unknown, argv?: string[], opts?: Interfaces.LoadOptions): unknown
{
	const result: unknown = Reflect.apply(originalRun, this, [argv, opts ?? cliRoot]);
	return result;
});
