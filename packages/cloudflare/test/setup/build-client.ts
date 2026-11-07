import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";

const indexHtml = new URL("../../../web/dist/client/index.html", import.meta.url).pathname;

/**
 * The Worker serves the built client as static assets, so build it once for the whole run when it is missing.
 * Test files run in parallel workers: a per-file check started several builds that raced emptying the out dir.
 */
export function setup(): void {
	if (!existsSync(indexHtml)) {
		execFileSync("vp", ["run", "--filter", "@workflowy/web", "build"], {stdio: "inherit"});
	}
}
