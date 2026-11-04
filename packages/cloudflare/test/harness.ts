import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {build} from "esbuild";
import {Miniflare} from "miniflare";
import type {MiniflareOptions} from "miniflare";

const clientDir = new URL("../../web/dist/client", import.meta.url).pathname;

/** The Worker serves the built client as static assets, so build it once when it is missing. */
function ensureClientBuilt(): void {
	if (!existsSync(join(clientDir, "index.html"))) {
		execFileSync("vp", ["run", "--filter", "@workflowy/web", "build"], {stdio: "inherit"});
	}
}

/** Bundle a Worker entry for workerd, resolving workspace packages through their `source` export. */
async function bundleWorker(entry: string): Promise<string> {
	const result = await build({
		entryPoints: [new URL(entry, import.meta.url).pathname],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		conditions: ["source", "workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["cloudflare:workers", "node:*"],
	});
	return result.outputFiles[0]?.text ?? "";
}

export interface Harness {
	mf: Miniflare;
	persistDir: string;
	dispose(keepData?: boolean): Promise<void>;
}

/** A Miniflare running the bundled Worker with a persisted USER_STORE Durable Object and the built client as assets. */
export async function startHarness(
	entry: string,
	className = "UserStore",
	existingPersistDir?: string,
	bindings: Record<string, string> = {ACCESS_DEV_IDENTITY: "dev"},
	extra: {outboundService?: Extract<MiniflareOptions, {modules: true}>["outboundService"]} = {},
): Promise<Harness> {
	ensureClientBuilt();
	const script = await bundleWorker(entry);
	const persistDir = existingPersistDir ?? mkdtempSync(join(tmpdir(), "wf-cf-"));
	const mf = new Miniflare({
		modules: true,
		script,
		compatibilityDate: "2026-08-01",
		compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
		bindings,
		...extra,
		durableObjects: {USER_STORE: {className, useSQLite: true}},
		durableObjectsPersist: join(persistDir, "do"),
		r2Buckets: ["SNAPSHOTS"],
		r2Persist: join(persistDir, "r2"),
		kvNamespaces: ["OAUTH_KV"],
		kvPersist: join(persistDir, "kv"),
		assets: {
			directory: clientDir,
			binding: "ASSETS",
			routerConfig: {has_user_worker: true, invoke_user_worker_ahead_of_assets: false},
			assetConfig: {not_found_handling: "single-page-application"},
		},
	});
	await mf.ready;
	return {
		mf,
		persistDir,
		async dispose(keepData = false) {
			await mf.dispose();
			if (!keepData) {
				rmSync(persistDir, {recursive: true, force: true});
			}
		},
	};
}

/** Read a response body as JSON, inflating it first when the app compressed it (Miniflare drops the header). */
export async function readJson(response: {arrayBuffer(): Promise<ArrayBuffer>}): Promise<unknown> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
	const body = gzipped ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")) : new Blob([bytes]);
	return new Response(body).json();
}

export interface SchemaRow {
	type: string;
	name: string;
	sql: string;
}

export interface ProbeResult {
	names: string[];
	schema: SchemaRow[];
	migrations: number;
	appliedOnBoot: number;
}

/** GET the probe path straight from the "dev" Durable Object, which the Worker does not route. */
export async function probeStore<T = ProbeResult>(mf: Miniflare, path = "/__probe"): Promise<T> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch(`http://localhost${path}`);
	return response.json();
}

/** Run one HTTP request and return how many `UserStore.call`s it made on the named Durable Object (needs the ProbeStore entry). */
export async function countStoreCalls(mf: Miniflare, name: string, request: () => Promise<unknown>): Promise<number> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const stub = ns.get(ns.idFromName(name));
	await stub.fetch("http://localhost/__calls?reset");
	await request();
	const result: {calls: number} = await (await stub.fetch("http://localhost/__calls")).json();
	return result.calls;
}
