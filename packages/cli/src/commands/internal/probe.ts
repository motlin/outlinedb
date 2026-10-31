import {Args, Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {WorkflowyApiClient, WorkflowyInternalClient} from "@workflowy/shared/api";
import type {InternalSession} from "@workflowy/shared/api";
import {
	CALENDAR_ID_NAMESPACE,
	WorkflowyInternalAdapter,
	calendarNodeId,
	editOp,
	moveOp,
} from "@workflowy/shared/internal";
import type {CalendarIdLevel, EnsuredCalendarDay} from "@workflowy/shared/internal";
import {readInternalAuth} from "@workflowy/shared/node";
import {isDeepStrictEqual} from "node:util";
import {
	WorkflowyWriteThroughClient,
	keptInternalMetadata,
	readNodeInternalMetadata,
	normalizeLayoutMode,
	replaceTreeTxId,
} from "@workflowy/shared/cache";
import {sql} from "drizzle-orm";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";

const DEFAULT_OUT = ".llm/upstream-sync/internal-api-probes.md";
const STEPS = [
	"bootstrap",
	"poll",
	"error-shape",
	"index",
	"restore",
	"meta",
	"expansion",
	"root-meta",
	"root-meta-set",
	"root-meta-unset",
	"settings",
	"calendar-ids",
	"calendar-adopt",
] as const;
const ROOT_META_WRITES = new Set<string>(["root-meta-set", "root-meta-unset"]);
/** Account-global root metadata paths whose shapes `root-meta` records (read only). */
const ROOT_META_PATHS = [
	["starring", "locations"],
	["starring", "order"],
	["color", "tags"],
	["dateFormat"],
	["timeFormat"],
	["weekStartDay"],
	["slash", "discovered"],
	["notesRootId"],
];
/** The throwaway root metadata key the write steps set and remove; nothing else is ever written. */
const PROBE_KEY = "probe";
const PROBE_VALUE = {x: "1"};
const RENAMED = "probe error-shape: renamed";
/** How far the `index` step backdates the create's client clock, so the node's `createdAt` shows whether `ct` was kept. */
const CT_SHIFT_SEC = 86_400;
const NEEDS_API_KEY = new Set<string>(["error-shape", "index", "restore", "meta", "expansion", "calendar-adopt"]);
/** The list start the `meta` step sets, so the rendered numbering shows whether it was honored. */
const NUMBERED_START = 5;
/** How many of the most recent cached day nodes the `calendar-ids` step checks one by one. */
const CALENDAR_SAMPLE = 5;
const CALENDAR_LEVELS: CalendarIdLevel[] = ["day", "month", "year"];
/** The far-future day the `calendar-adopt` step ensures (user-approved 2026-10-17), and the earliest it may touch. */
const ADOPT_DATE_ID = 20_991_231;
const ADOPT_MIN_DATE_ID = 20_990_101;

/** `order` after moving `ids` (in that order) to insertion slot `index` among the same parent's children. */
export function expectedMove(order: readonly string[], ids: readonly string[], index: number): string[] {
	const kept = (part: readonly string[]) => part.filter((id) => !ids.includes(id));
	return [...kept(order.slice(0, index)), ...ids, ...kept(order.slice(index))];
}

/** The only subtree a live probe may write to. */
export const SANDBOX_ID = "7aed376b-80c8-42c5-8065-ab03ee6d2ae0";

/** Throws unless the sandbox is among `ancestorIds`; every probe write is gated on it. */
export function assertUnderSandbox(ancestorIds: readonly string[]): void {
	if (!ancestorIds.includes(SANDBOX_ID)) {
		throw new Error(`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`);
	}
}

/**
 * Check a `calendar-adopt` ensure result before anything else happens: the
 * day must be far-future and every created node under the calendar root.
 * Returns the node whose delete cleans the probe up (the topmost created one).
 */
export function planCalendarAdoptProbe(
	ensured: EnsuredCalendarDay & {dateId: number},
	calendarRootId: string,
	ancestorsOf: (id: string) => readonly string[],
): {deleteId: string} {
	assertAdoptDateId(ensured.dateId);
	for (const id of ensured.created) {
		if (!ancestorsOf(id).includes(calendarRootId)) {
			throw new Error(
				`Refusing to continue: created node ${id} is not under the calendar root ${calendarRootId}`,
			);
		}
	}
	const [deleteId] = ensured.created;
	if (deleteId === undefined) {
		throw new Error(`Refusing to continue: ensure created nothing, so ${ensured.dateId} already existed`);
	}
	return {deleteId};
}

function assertAdoptDateId(dateId: number): void {
	if (dateId < ADOPT_MIN_DATE_ID) {
		throw new Error(
			`Refusing to probe ${dateId}: the calendar-adopt probe only touches days from ${ADOPT_MIN_DATE_ID} on`,
		);
	}
}

/** Ancestor ids from `parentId` upward (nearest first, stopping at the sandbox), read from the public API. */
async function readAncestors(api: WorkflowyApiClient, firstParentId: string | null | undefined): Promise<string[]> {
	const ancestors: string[] = [];
	let parentId = firstParentId ?? null;
	while (parentId !== null) {
		ancestors.push(parentId);
		if (parentId === SANDBOX_ID) {
			break;
		}
		parentId = (await api.getNode(parentId)).parent_id ?? null;
	}
	return ancestors;
}
/** Every ancestor id from `firstParentId` up to the top level (nearest first), read from the public API. */
async function readAllAncestors(api: WorkflowyApiClient, firstParentId: string | null | undefined): Promise<string[]> {
	const ancestors: string[] = [];
	let parentId = firstParentId ?? null;
	while (parentId !== null) {
		ancestors.push(parentId);
		parentId = (await api.getNode(parentId)).parent_id ?? null;
	}
	return ancestors;
}

const BODY_PREVIEW_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function union(values: unknown[]): string {
	return [...new Set(values.map((value) => typeShape(value, false)))].toSorted().join(" | ");
}

/**
 * A value redacted to its type. The top-level object becomes a `Record` (its keys are
 * user data such as tag names or ids); nested objects keep their structural keys.
 */
export function typeShape(value: unknown, topLevel = true): string {
	if (value === undefined) {
		return "absent";
	}
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return `Array<${value.length === 0 ? "never" : union(value)}>`;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			return "{}";
		}
		if (topLevel) {
			return `Record<string, ${union(entries.map(([, inner]) => inner))}>`;
		}
		return `{${entries
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([key, inner]) => `${key}: ${typeShape(inner, false)}`)
			.join("; ")}}`;
	}
	return typeof value;
}

function getPath(value: unknown, keys: string[]): unknown {
	return keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

interface RecordedRequest {
	method: string;
	path: string;
	status: number;
	bytes: number;
	text: string;
	clientIdHeader: string | null;
}

function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A string or number as text; anything else (absent, object) as undefined. */
function scalarText(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * A fetch that records each response (path without query, status, size, the
 * `wfclientid` header) and, when `stripCrosscheck` is set, removes
 * `crosscheck_user_id` from form bodies before they leave.
 */
function recordingFetch(recorded: RecordedRequest[], stripCrosscheck: boolean): typeof fetch {
	return async (input, init) => {
		let requestInit = init;
		if (stripCrosscheck && typeof init?.body === "string") {
			const form = new URLSearchParams(init.body);
			form.delete("crosscheck_user_id");
			requestInit = {...init, body: form.toString()};
		}
		const response = await globalThis.fetch(input, requestInit);
		const text = await response.clone().text();
		recorded.push({
			method: requestInit?.method ?? "GET",
			path: new URL(urlOf(input)).pathname,
			status: response.status,
			bytes: Buffer.byteLength(text),
			text,
			clientIdHeader: response.headers.get("wfclientid"),
		});
		return response;
	};
}

/** The character classes of a value (digits to 9, letters to a/A), so formats are recorded without values. */
export function shapeOf(value: string): string {
	return value.replaceAll(/\d/gu, "9").replaceAll(/[a-z]/gu, "a").replaceAll(/[A-Z]/gu, "A");
}

function objectKeys(value: unknown): string[] {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).toSorted() : [];
}

function codeList(keys: string[]): string {
	return keys.length === 0 ? "(none)" : keys.map((key) => `\`${key}\``).join(", ");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function findInitTxId(text: string): string | undefined {
	const treeData: unknown = Reflect.get(Object(parseJson(text)), "projectTreeData");
	const info: unknown = Reflect.get(Object(treeData), "mainProjectTreeInfo");
	return scalarText(Reflect.get(Object(info), "initialMostRecentOperationTransactionId"));
}

/** One `/push_and_poll` built like `PushAndPoll` but sent once, with no retries, returning the recorded raw response. */
async function sendRawPush(
	client: WorkflowyInternalClient,
	session: InternalSession,
	recorded: RecordedRequest[],
	tree: Record<string, unknown>,
): Promise<RecordedRequest> {
	const pushPollId = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
	const form = new URLSearchParams();
	form.append("client_id", session.clientId);
	form.append("client_version", session.clientVersion);
	form.append("push_poll_id", pushPollId);
	form.append("push_poll_data", JSON.stringify([tree]));
	form.append("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
	await client.postForm(`/push_and_poll?uti=${session.userId}-${Date.now()}-${pushPollId}`, form);
	const push = recorded.findLast((request) => request.path === "/push_and_poll");
	if (push === undefined) {
		throw new Error("No /push_and_poll response was recorded");
	}
	return push;
}

export default class Probe extends Command {
	static override description =
		"Run one live probe of Workflowy's internal API (read-only, or writes confined to the sandbox) and append the findings to a markdown log";

	static override examples = [
		"<%= config.bin %> internal probe bootstrap --yes-live",
		"<%= config.bin %> internal probe poll --yes-live",
		"<%= config.bin %> internal probe poll --no-crosscheck --yes-live",
		"<%= config.bin %> internal probe error-shape --yes-live",
		"<%= config.bin %> internal probe index --yes-live",
		"<%= config.bin %> internal probe index --yes-live --keep",
		"<%= config.bin %> internal probe restore --yes-live",
		"<%= config.bin %> internal probe meta --yes-live",
		"<%= config.bin %> internal probe meta --yes-live --keep",
		"<%= config.bin %> internal probe expansion --yes-live",
		"<%= config.bin %> internal probe expansion --yes-live --keep",
		"<%= config.bin %> internal probe root-meta --yes-live",
		"<%= config.bin %> internal probe root-meta-set --yes-live --yes-account-global",
		"<%= config.bin %> internal probe root-meta-unset --yes-live --yes-account-global",
		"<%= config.bin %> internal probe settings --yes-live --yes-account-global",
		"<%= config.bin %> internal probe calendar-ids --yes-live",
		"<%= config.bin %> internal probe calendar-adopt --yes-live",
	];

	static override args = {
		step: Args.string({description: "Probe step", options: [...STEPS], required: true}),
	};

	static override flags = {
		"yes-live": Flags.boolean({description: "Confirm the probe may call workflowy.com", default: false}),
		crosscheck: Flags.boolean({
			description: "Send crosscheck_user_id on /push_and_poll (poll only)",
			default: true,
			allowNo: true,
		}),
		"yes-account-global": Flags.boolean({
			description:
				"Confirm the user approved the account-global writes: the throwaway root metadata key `probe`, or the `show_completed` flip-and-restore",
			default: false,
		}),
		keep: Flags.boolean({
			description:
				"Leave the `index`, `restore`, `meta` or `expansion` fixture in the sandbox for a visual check (delete it afterwards); `meta` then stops while the fixture is still numbered, `expansion` while it is still expanded",
			default: false,
		}),
		out: Flags.string({description: "Markdown file the findings are appended to", default: DEFAULT_OUT}),
	};

	public async run(): Promise<void> {
		const {args, flags} = await this.parse(Probe);
		if (!flags["yes-live"]) {
			this.error("Live probe against workflowy.com: pass --yes-live to run it");
		}
		if (ROOT_META_WRITES.has(args.step) && !flags["yes-account-global"]) {
			this.error(
				"Root metadata is account-global and cannot be sandboxed: pass --yes-account-global (with the user's approval) to write it",
			);
		}
		if (args.step === "settings" && !flags["yes-account-global"]) {
			this.error(
				"Account settings are account-global and cannot be sandboxed: pass --yes-account-global (with the user's approval) to write them",
			);
		}
		const apiKey = NEEDS_API_KEY.has(args.step) ? process.env.WORKFLOWY_API_KEY : undefined;
		if (NEEDS_API_KEY.has(args.step) && !apiKey) {
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}
		const auth = readInternalAuth();
		if (!auth) {
			this.error(
				"Set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
			);
		}
		const recorded: RecordedRequest[] = [];
		const client = new WorkflowyInternalClient({
			...auth,
			fetch: recordingFetch(recorded, !flags.crosscheck),
		});
		const startedAt = new Date().toISOString();
		const lines = await this.runStep(args.step, client, recorded, flags.crosscheck, apiKey, flags.keep);
		const title = args.step === "poll" && !flags.crosscheck ? "poll --no-crosscheck" : args.step;
		const section = ["", `## ${title} (${startedAt})`, "", ...lines, ""].join("\n");
		fs.mkdirSync(path.dirname(flags.out), {recursive: true});
		fs.appendFileSync(flags.out, section);
		this.log(section);
	}

	private async runStep(
		step: string,
		client: WorkflowyInternalClient,
		recorded: RecordedRequest[],
		crosscheck: boolean,
		apiKey: string | undefined,
		keep: boolean,
	): Promise<string[]> {
		if (step === "bootstrap") {
			return this.bootstrap(client, recorded);
		}
		if (step === "poll") {
			return this.poll(client, recorded, crosscheck);
		}
		if (step === "error-shape") {
			return this.errorShape(
				client,
				recorded,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
			);
		}
		if (step === "index") {
			return this.index(
				client,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
				keep,
			);
		}
		if (step === "restore") {
			return this.restore(
				client,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
				keep,
			);
		}
		if (step === "meta") {
			return this.meta(
				client,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
				keep,
			);
		}
		if (step === "expansion") {
			return this.expansion(
				client,
				recorded,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
				keep,
			);
		}
		if (step === "root-meta") {
			return this.rootMeta(client);
		}
		if (step === "settings") {
			return this.settings(client, recorded);
		}
		if (step === "calendar-ids") {
			return this.calendarIds(client, recorded);
		}
		if (step === "calendar-adopt") {
			return this.calendarAdopt(
				client,
				new WorkflowyApiClient(apiKey ?? "", undefined, process.env.WORKFLOWY_API_URL),
			);
		}
		return step === "root-meta-set" ? this.rootMetaSet(client) : this.rootMetaUnset(client);
	}

	/**
	 * Exact-index tree writes through the adapter on a fresh sandbox fixture with
	 * children `a,b,c`: `createAt` index 1 (client uuid, backdated `ct`), `moveTo`
	 * to the top, a same-parent down move, and a two-id `bulk_move`. After each
	 * step the order is read from the public API and from the cache the adapter
	 * wrote through. The fixture is deleted unless `keep`.
	 */
	private async index(client: WorkflowyInternalClient, api: WorkflowyApiClient, keep: boolean): Promise<string[]> {
		const {id: parentId} = await api.createNode({
			parent_id: SANDBOX_ID,
			name: `probe index ${new Date().toISOString()}`,
			position: "bottom",
		});
		assertUnderSandbox(await readAncestors(api, (await api.getNode(parentId)).parent_id));
		const labels = new Map<string, string>();
		for (const name of ["a", "b", "c"]) {
			const {id} = await api.createNode({parent_id: parentId, name, position: "bottom"});
			labels.set(id, name);
		}
		const db = createDatabase();
		const cache = new CacheService(db);
		const writeThrough = new WorkflowyWriteThroughClient(api, cache);
		const lines = ["- Fixture: fresh child of the sandbox with children `a,b,c` (public API); ancestors verified"];
		try {
			await writeThrough.refreshChildren([parentId]);
			const byLabel = (label: string) => [...labels].find(([, name]) => name === label)?.[0] ?? label;
			const named = (ids: string[]) => ids.map((id) => labels.get(id) ?? id).join(",");
			let order = (await writeThrough.liveChildren(parentId)).map((node) => node.id);
			const check = async (step: string, expected: string[]) => {
				const live = (await writeThrough.liveChildren(parentId)).map((node) => node.id);
				const cached = cache.getChildren(parentId).map((node) => node.id);
				const ok = isDeepStrictEqual(live, expected) && isDeepStrictEqual(cached, expected);
				lines.push(
					`- ${step}: expected \`${named(expected)}\`; public API \`${named(live)}\`; cache \`${named(cached)}\` (${ok ? "MATCH" : "MISMATCH"})`,
				);
				order = live;
			};

			const startSec = Math.floor(Date.now() / 1000);
			const backdated = new WorkflowyInternalAdapter({
				client,
				db,
				writeThrough,
				now: () => Date.now() - CT_SHIFT_SEC * 1000,
			});
			const {id: newId} = await backdated.createAt({parentId, index: 1, name: "new"});
			labels.set(newId, "new");
			await check("`createAt(index 1)` (`bulk_create`)", expectedMove([...order, newId], [newId], 1));
			const created = await api.getNode(newId).catch(() => {});
			const createdAt = created?.createdAt;
			lines.push(
				`- Client-chosen uuid: ${created?.parent_id === parentId ? "accepted (public API returns the node under that id)" : "NOT found under the id the client chose"}`,
				`- \`ct\` (backdated ${CT_SHIFT_SEC / 3600}h): ${
					createdAt === undefined
						? "unknown (no createdAt)"
						: Math.abs(createdAt - (startSec - CT_SHIFT_SEC)) < 600
							? "accepted (createdAt matches the backdated clock)"
							: Math.abs(createdAt - startSec) < 600
								? "ignored (createdAt is server time)"
								: `inconclusive (createdAt ${createdAt - startSec}s from now)`
				}`,
			);

			const adapter = new WorkflowyInternalAdapter({client, db, writeThrough});
			const c = byLabel("c");
			await adapter.moveTo({ids: [c], parentId, index: 0});
			await check("`moveTo(c, index 0)` (`move`)", expectedMove(order, [c], 0));
			const a = byLabel("a");
			await adapter.moveTo({ids: [a], parentId, index: 3});
			await check("same-parent `moveTo(a, index 3)` (`move`, down)", expectedMove(order, [a], 3));
			const pair = [byLabel("b"), newId];
			await adapter.moveTo({ids: pair, parentId, index: 0});
			await check("`moveTo([b,new], index 0)` (`bulk_move`)", expectedMove(order, pair, 0));
		} finally {
			if (keep) {
				lines.push(`- Fixture kept for a visual check: \`${parentId}\` (delete it afterwards)`);
			} else {
				assertUnderSandbox(await readAncestors(api, (await api.getNode(parentId)).parent_id));
				await writeThrough.deleteNode(parentId);
				lines.push("- Cleanup: fixture deleted through the write-through client");
			}
		}
		return lines;
	}

	/**
	 * Delete and restore with the original id on a fresh sandbox fixture: parents
	 * `from` and `to` (`to` holds `existing`), and under `from` a completed `target`
	 * with a note and a grandchild. `target` is deleted (public API), restored by
	 * `undelete` into `to` at index 0, deleted again, and restored by
	 * `POST /trash/restore/<id>/`. After each restore the id, parent, slot,
	 * children, note, completion and created time are compared with the original
	 * through the public API and the write-through cache. The fixture is deleted
	 * unless `keep`.
	 */
	private async restore(client: WorkflowyInternalClient, api: WorkflowyApiClient, keep: boolean): Promise<string[]> {
		const stamp = new Date().toISOString();
		const {id: rootId} = await api.createNode({
			parent_id: SANDBOX_ID,
			name: `probe restore ${stamp}`,
			position: "bottom",
		});
		assertUnderSandbox(await readAncestors(api, (await api.getNode(rootId)).parent_id));
		const db = createDatabase();
		const cache = new CacheService(db);
		const writeThrough = new WorkflowyWriteThroughClient(api, cache);
		const lines = [
			"- Fixture: fresh sandbox child with parents `from` and `to` (`to` holds `existing`); under `from` a completed `target` with a note and a grandchild (public API); ancestors verified",
		];
		try {
			const {id: fromId} = await writeThrough.createNode({parent_id: rootId, name: "from", position: "bottom"});
			const {id: toId} = await writeThrough.createNode({parent_id: rootId, name: "to", position: "bottom"});
			const {id: existingId} = await writeThrough.createNode({
				parent_id: toId,
				name: "existing",
				position: "bottom",
			});
			const {id: targetId} = await writeThrough.createNode({
				parent_id: fromId,
				name: "target",
				note: "target note",
				position: "bottom",
			});
			const {id: grandchildId} = await writeThrough.createNode({
				parent_id: targetId,
				name: "grandchild",
				position: "bottom",
			});
			await writeThrough.completeNode(targetId);
			const labels = new Map([
				[rootId, "fixture"],
				[fromId, "from"],
				[toId, "to"],
				[existingId, "existing"],
				[targetId, "target"],
				[grandchildId, "grandchild"],
			]);
			const named = (ids: string[]) => ids.map((id) => labels.get(id) ?? id).join(",");
			const original = await api.getNode(targetId);
			const snapshot = (node: typeof original) => ({
				name: node.name,
				note: node.note ?? null,
				completed: node.completed,
				createdAt: node.createdAt,
			});
			const deleteTarget = async () => {
				assertUnderSandbox(await readAncestors(api, (await api.getNode(targetId)).parent_id));
				await writeThrough.deleteNode(targetId);
			};
			const report = async (label: string, expectedParent: string, expectedSiblings: string[]) => {
				const restored = await api.getNode(targetId).catch(() => {});
				if (restored === undefined) {
					lines.push(`- ${label}: public API has no node under the original id (id NOT kept)`);
					return;
				}
				const parentId = restored.parent_id ?? null;
				assertUnderSandbox(await readAncestors(api, parentId));
				const siblings = (await writeThrough.liveChildren(parentId)).map((node) => node.id);
				const children = (await writeThrough.liveChildren(targetId)).map((node) => node.id);
				const before = snapshot(original);
				const after = snapshot(restored);
				const kept = Object.entries(before).map(([key, was]) => {
					const now: unknown = Reflect.get(after, key);
					return `${key} ${isDeepStrictEqual(was, now) ? "kept" : `CHANGED (\`${JSON.stringify(was)}\` -> \`${JSON.stringify(now)}\`)`}`;
				});
				const cached = cache.getNode(targetId);
				const cachedSiblings = cache.getChildren(parentId).map((node) => node.id);
				const cachedChildren = cache.getChildren(targetId).map((node) => node.id);
				lines.push(
					`- ${label}: id kept; parent \`${labels.get(parentId ?? "") ?? String(parentId)}\` (expected \`${labels.get(expectedParent)}\`); siblings \`${named(siblings)}\` (expected \`${named(expectedSiblings)}\`, ${isDeepStrictEqual(siblings, expectedSiblings) ? "MATCH" : "MISMATCH"})`,
					`  - Public API: children \`${named(children)}\` (${isDeepStrictEqual(children, [grandchildId]) ? "kept" : "LOST"}); ${kept.join("; ")}`,
					`  - Cache: node ${cached === undefined ? "ABSENT" : `present under \`${labels.get(cached.parentId ?? "") ?? String(cached.parentId)}\``}; siblings \`${named(cachedSiblings)}\`; children \`${named(cachedChildren)}\``,
				);
			};

			await deleteTarget();
			const adapter = new WorkflowyInternalAdapter({client, db, writeThrough});
			await adapter.restore({id: targetId, parentId: toId, index: 0});
			await report("`restore(target, to, index 0)` (`undelete`)", toId, [targetId, existingId]);

			await deleteTarget();
			await adapter.restore({id: targetId});
			await report("`restore(target)` (`POST /trash/restore/<id>/`)", toId, [targetId, existingId]);
		} finally {
			if (keep) {
				lines.push(`- Fixture kept for a visual check: \`${rootId}\` (delete it afterwards)`);
			} else {
				assertUnderSandbox(await readAncestors(api, (await api.getNode(rootId)).parent_id));
				await writeThrough.deleteNode(rootId);
				lines.push("- Cleanup: fixture deleted through the write-through client");
			}
		}
		return lines;
	}

	/**
	 * Node metadata through `setNodeMeta` on a fresh sandbox fixture with children
	 * `one,two,three`: `layoutMode:"numbered"` then `numbered_start`, read back from
	 * the public API (`data.layoutMode`), from `/get_tree_data/` (what `cache
	 * import-api` imports) and from the cache the adapter wrote through; then
	 * bullets (a `remove` patch on `layoutMode`) and the same read-back. Home's
	 * `layoutMode` is read from root metadata only, never written. With `keep` the
	 * fixture stays numbered for a visual check and the bullets half is skipped.
	 */
	private async meta(client: WorkflowyInternalClient, api: WorkflowyApiClient, keep: boolean): Promise<string[]> {
		const {id: fixtureId} = await api.createNode({
			parent_id: SANDBOX_ID,
			name: `probe meta ${new Date().toISOString()}`,
			position: "bottom",
		});
		assertUnderSandbox(await readAncestors(api, (await api.getNode(fixtureId)).parent_id));
		for (const name of ["one", "two", "three"]) {
			await api.createNode({parent_id: fixtureId, name, position: "bottom"});
		}
		const {rootMetadata} = await client.bootstrap();
		const homeLayout: unknown = rootMetadata.layoutMode;
		const db = createDatabase();
		const cache = new CacheService(db);
		const writeThrough = new WorkflowyWriteThroughClient(api, cache);
		const lines = [
			"- Fixture: fresh sandbox child with children `one,two,three` (public API); ancestors verified",
			`- Home \`layoutMode\` (root metadata, read only): ${homeLayout === undefined ? "absent (bullets)" : `\`${JSON.stringify(homeLayout)}\``}`,
		];
		const report = async (label: string, expected: Record<string, unknown>) => {
			const live = await api.getNode(fixtureId);
			const item = (await client.getTreeSnapshot()).items.find((candidate) => candidate.id === fixtureId);
			const imported = keptInternalMetadata(item?.metadata) ?? {};
			const cachedMeta = readNodeInternalMetadata(db, fixtureId);
			const cachedLayout = cache.getNode(fixtureId)?.layoutMode ?? null;
			const pick = (source: unknown) =>
				Object.fromEntries(Object.keys(expected).map((key) => [key, Reflect.get(Object(source), key) ?? null]));
			const want = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value ?? null]));
			const verdict = (actual: unknown) => (isDeepStrictEqual(actual, want) ? "MATCH" : "MISMATCH");
			const publicLayout = live.data?.layoutMode ?? null;
			lines.push(
				`- ${label}: expected \`${JSON.stringify(want)}\``,
				`  - Public API \`data.layoutMode\`: \`${JSON.stringify(publicLayout)}\` (${normalizeLayoutMode(publicLayout) === want.layoutMode ? "MATCH" : "MISMATCH"}, "bullets" read as absent); \`data\` keys ${codeList(objectKeys(live.data))}`,
				`  - \`/get_tree_data/\` (import): \`${JSON.stringify(pick(imported))}\` (${verdict(pick(imported))}); item ${item === undefined ? "ABSENT" : "present"}`,
				`  - Cache: typed metadata tables \`${JSON.stringify(pick(cachedMeta))}\` (${verdict(pick(cachedMeta))}); node \`layoutMode\` \`${JSON.stringify(cachedLayout)}\``,
			);
		};
		try {
			await writeThrough.refreshChildren([SANDBOX_ID]);
			const adapter = new WorkflowyInternalAdapter({client, db, writeThrough});
			await adapter.setNodeMeta(fixtureId, ["layoutMode"], "numbered");
			await adapter.setNodeMeta(fixtureId, ["numbered_start"], NUMBERED_START);
			await report(`\`setNodeMeta(layoutMode "numbered")\` + \`setNodeMeta(numbered_start ${NUMBERED_START})\``, {
				layoutMode: "numbered",
				numbered_start: NUMBERED_START,
			});
			if (!keep) {
				await adapter.setNodeMeta(fixtureId, ["layoutMode"], undefined);
				await report("bullets: `setNodeMeta(layoutMode undefined)` (`remove` patch)", {
					layoutMode: undefined,
					numbered_start: NUMBERED_START,
				});
			}
		} finally {
			if (keep) {
				lines.push(
					`- Fixture kept numbered for a visual check (list should start at ${NUMBERED_START}): \`${fixtureId}\` (delete it afterwards)`,
				);
			} else {
				assertUnderSandbox(await readAncestors(api, (await api.getNode(fixtureId)).parent_id));
				await writeThrough.deleteNode(fixtureId);
				lines.push("- Cleanup: fixture deleted through the write-through client");
			}
		}
		return lines;
	}

	/**
	 * Expansion state on a fresh sandbox fixture with one child: push
	 * `project_expansions_delta: {<first 8 chars of the fixture id>: true}` with no
	 * ops, then check the key in `/get_tree_data/` `server_expanded_projects_list`
	 * and in a fresh bootstrap; then push `false` and check again. Also counts
	 * 8-char key collisions among the cache's live ids (read only). With `keep`
	 * the fixture stays expanded for a visual check and the `false` half is skipped.
	 */
	private async expansion(
		client: WorkflowyInternalClient,
		recorded: RecordedRequest[],
		api: WorkflowyApiClient,
		keep: boolean,
	): Promise<string[]> {
		const {id: fixtureId} = await api.createNode({
			parent_id: SANDBOX_ID,
			name: `probe expansion ${new Date().toISOString()}`,
			position: "bottom",
		});
		assertUnderSandbox(await readAncestors(api, (await api.getNode(fixtureId)).parent_id));
		await api.createNode({parent_id: fixtureId, name: "inner", position: "bottom"});
		const key = fixtureId.slice(0, 8);
		const groups = createDatabase().all<{key: string; ids: number}>(
			sql`SELECT substr(id, 1, 8) AS key, COUNT(DISTINCT id) AS ids FROM node_content WHERE system_to = ${FAR_FUTURE_DATE} GROUP BY key HAVING ids > 1`,
		);
		const collidingIds = groups.reduce((total, group) => total + group.ids, 0);
		const lines = [
			"- Fixture: fresh sandbox child with one child `inner` (public API); ancestors verified",
			`- Key: first 8 chars of the fixture id (shape \`${shapeOf(key)}\`)`,
			`- 8-char key collisions among the cache's live ids (read only): ${groups.length} keys shared by ${collidingIds} ids${groups.some((group) => group.key === key) ? "; the fixture key is one of them" : ""}`,
		];
		const report = async (label: string, expected: boolean) => {
			await client.getTreeSnapshot();
			const treeData = recorded.findLast((request) => request.path === "/get_tree_data/");
			const list: unknown = Reflect.get(Object(parseJson(treeData?.text ?? "")), "server_expanded_projects_list");
			const inTree = Array.isArray(list) && list.includes(key);
			await client.bootstrap();
			const init = recorded.findLast((request) => request.path === "/get_initialization_data");
			const treeInfo: unknown = Reflect.get(
				Object(Reflect.get(Object(parseJson(init?.text ?? "")), "projectTreeData")),
				"mainProjectTreeInfo",
			);
			const initList: unknown = Reflect.get(Object(treeInfo), "serverExpandedProjectsList");
			const inInit = Array.isArray(initList) && initList.includes(key);
			const verdict = (actual: boolean) => (actual === expected ? "MATCH" : "MISMATCH");
			lines.push(
				`- ${label}: expected key ${expected ? "present" : "absent"}`,
				`  - \`/get_tree_data/\` \`server_expanded_projects_list\`: ${Array.isArray(list) ? `${list.length} keys, key ${inTree ? "present" : "absent"} (${verdict(inTree)})` : "ABSENT"}`,
				`  - Fresh bootstrap \`mainProjectTreeInfo.serverExpandedProjectsList\`: ${Array.isArray(initList) ? `${initList.length} keys, key ${inInit ? "present" : "absent"} (${verdict(inInit)})` : "ABSENT"}`,
			);
		};
		const push = async (expanded: boolean) => {
			assertUnderSandbox(await readAncestors(api, (await api.getNode(fixtureId)).parent_id));
			const session = await client.bootstrap();
			const response = await sendRawPush(client, session, recorded, {
				most_recent_operation_transaction_id: session.txId,
				project_expansions_delta: {[key]: expanded},
			});
			const first: unknown = Reflect.get(Object(Reflect.get(Object(parseJson(response.text)), "results")), 0);
			const error: unknown = Reflect.get(Object(first), "error");
			lines.push(
				`- Pushed \`project_expansions_delta: {<key>: ${expanded}}\` with no ops: HTTP ${response.status}${typeof error === "string" ? `, \`results[0].error\` \`${error}\`` : ""}`,
			);
		};
		try {
			await report("Before any push", false);
			await push(true);
			await report("After `true`", true);
			if (!keep) {
				await push(false);
				await report("After `false`", false);
			}
		} finally {
			if (keep) {
				lines.push(
					`- Fixture kept expanded for a visual check (reload workflowy.com; \`inner\` should show): \`${fixtureId}\` (collapse and delete it afterwards)`,
				);
			} else {
				assertUnderSandbox(await readAncestors(api, (await api.getNode(fixtureId)).parent_id));
				await api.deleteNode(fixtureId);
				lines.push("- Cleanup: fixture deleted via the public API");
			}
		}
		return lines;
	}

	/** Read-only: the shapes of the account-global root metadata keys, values redacted to types. */
	private async rootMeta(client: WorkflowyInternalClient): Promise<string[]> {
		const {rootMetadata} = await client.bootstrap();
		return [
			`- Top-level root metadata keys: ${codeList(objectKeys(rootMetadata))}`,
			...ROOT_META_PATHS.map((keys) => `- \`${keys.join(".")}\`: \`${typeShape(getPath(rootMetadata, keys))}\``),
		];
	}

	/**
	 * Read-only: whether upstream's deterministic calendar ids
	 * (`uuidv5(\`${entropyKey}-calendar-${level}-${dateId}\`)`) reproduce the
	 * ids of the calendar nodes already in the cache.
	 */
	private async calendarIds(client: WorkflowyInternalClient, recorded: RecordedRequest[]): Promise<string[]> {
		await client.bootstrap();
		const source = recorded.findLast(
			(request) => request.path === "/get_user_data/" || request.path === "/get_initialization_data",
		);
		const sourceName = `\`${source?.path ?? "/get_user_data/"}\` \`user\``;
		const entropyKey: unknown = getPath(parseJson(source?.text ?? ""), ["user", "entropyKey"]);
		if (typeof entropyKey !== "string" || entropyKey === "") {
			return [
				`- \`entropyKey\`: ABSENT from ${sourceName}; upstream then falls back to random ids (TD9 must name-match)`,
			];
		}
		const cached = createDatabase().all<{nodeId: string; level: string; dateId: number}>(
			sql`SELECT node_id AS nodeId, level, date_id AS dateId FROM calendar_metadata WHERE system_to = ${FAR_FUTURE_DATE} AND date_id IS NOT NULL ORDER BY date_id DESC`,
		);
		const rows = cached.filter((row): row is {nodeId: string; level: CalendarIdLevel; dateId: number} =>
			CALENDAR_LEVELS.some((level) => level === row.level),
		);
		const matches = (row: {nodeId: string; level: CalendarIdLevel; dateId: number}) =>
			calendarNodeId(entropyKey, row.level, row.dateId) === row.nodeId;
		const sample = rows.filter((row) => row.level === "day").slice(0, CALENDAR_SAMPLE);
		const totals = CALENDAR_LEVELS.map((level) => {
			const atLevel = rows.filter((row) => row.level === level);
			return `${level} ${atLevel.filter(matches).length} of ${atLevel.length}`;
		});
		return [
			`- \`entropyKey\`: present in ${sourceName} (${entropyKey.length} chars, value not recorded)`,
			`- Formula: \`\`uuidv5(\`\${entropyKey}-calendar-\${level}-\${dateId}\`, ${CALENDAR_ID_NAMESPACE})\`\``,
			`- Sample: the ${CALENDAR_SAMPLE} most recent cached day nodes by \`dateId\` (\`calendar_metadata\`, read only)`,
			...sample.map((row) => `  - \`${row.dateId}\`: ${matches(row) ? "MATCH" : "MISMATCH"}`),
			`- Sample result: ${sample.filter(matches).length} of ${sample.length} match`,
			`- All cached calendar nodes: ${totals.join(", ")} match`,
		];
	}

	/**
	 * USER-APPROVED write outside the sandbox (2026-10-17): ensure the far-future
	 * day 2099-12-31 under `📆 Calendar` through the adapter (the code behind
	 * `POST /api/v1/calendar/day/:dateId/ensure`), check every created node sits
	 * under the calendar root, and print what to check on workflowy.com and
	 * which node to delete afterwards. It deletes nothing itself.
	 */
	private async calendarAdopt(client: WorkflowyInternalClient, api: WorkflowyApiClient): Promise<string[]> {
		assertAdoptDateId(ADOPT_DATE_ID);
		const db = createDatabase();
		const writeThrough = new WorkflowyWriteThroughClient(api, new CacheService(db));
		const adapter = new WorkflowyInternalAdapter({client, db, writeThrough});
		const ensured = await adapter.ensureCalendarDay(ADOPT_DATE_ID);
		const [root] = db.all<{nodeId: string}>(
			sql`SELECT node_id AS nodeId FROM calendar_metadata WHERE root = 1 AND system_to = ${FAR_FUTURE_DATE}`,
		);
		if (root === undefined) {
			this.error("No cached calendar root after ensure");
		}
		const ancestors = new Map<string, string[]>();
		for (const id of ensured.created) {
			ancestors.set(id, await readAllAncestors(api, (await api.getNode(id)).parent_id));
		}
		const {deleteId} = planCalendarAdoptProbe(
			{...ensured, dateId: ADOPT_DATE_ID},
			root.nodeId,
			(id) => ancestors.get(id) ?? [],
		);
		return [
			`- Ensured \`${ADOPT_DATE_ID}\` through \`WorkflowyInternalAdapter.ensureCalendarDay\` (write-through to the real cache)`,
			`- \`dayId\`: \`${ensured.dayId}\`; \`firstChildId\`: \`${ensured.firstChildId}\``,
			`- \`created\` (outermost first): ${codeList(ensured.created)}`,
			`- Every created node is under the calendar root \`${root.nodeId}\` (public API ancestors)`,
			`- Cleanup: \`./bin/run.js node delete --id ${deleteId}\``,
			"- Next: on workflowy.com jump to 2099-12-31 and check it opens `dayId`, with one `2099`, one `12` and one day under `📆 Calendar`",
		];
	}

	/**
	 * An adapter over an in-memory cache, so the probe exercises `setRootMeta` without touching the real cache.
	 * The throwaway cache follows the log from the bootstrap's transaction id, an id the server returned.
	 */
	private adapter(client: WorkflowyInternalClient): WorkflowyInternalAdapter {
		const db = createDatabase(":memory:");
		const txId = client.session?.txId;
		if (txId !== undefined) {
			replaceTreeTxId(db, txId, Date.now());
		}
		return new WorkflowyInternalAdapter({client, db});
	}

	/** ACCOUNT-GLOBAL write: set the throwaway `probe.x`, then confirm it from a fresh bootstrap. */
	private async rootMetaSet(client: WorkflowyInternalClient): Promise<string[]> {
		const before = (await client.bootstrap()).rootMetadata[PROBE_KEY];
		if (before !== undefined) {
			this.error(`Refusing to write: root metadata already has a \`${PROBE_KEY}\` key`);
		}
		await this.adapter(client).setRootMeta([PROBE_KEY, "x"], PROBE_VALUE.x);
		const after = getPath((await client.bootstrap()).rootMetadata, [PROBE_KEY, "x"]);
		return [
			`- \`${PROBE_KEY}\` before: absent`,
			`- Pushed: \`setRootMeta(["${PROBE_KEY}", "x"], "${PROBE_VALUE.x}")\``,
			`- \`${PROBE_KEY}.x\` after a fresh bootstrap: ${
				after === undefined ? "absent" : `\`${JSON.stringify(after)}\``
			} (round trip ${after === PROBE_VALUE.x ? "CONFIRMED" : "FAILED"})`,
			"- Next: reload workflowy.com once and confirm it still loads, then run `internal probe root-meta-unset --yes-live --yes-account-global`",
		];
	}

	/** ACCOUNT-GLOBAL write: remove `probe` (only when it is exactly the throwaway value), then confirm it is gone. */
	private async rootMetaUnset(client: WorkflowyInternalClient): Promise<string[]> {
		const before = (await client.bootstrap()).rootMetadata[PROBE_KEY];
		if (!isDeepStrictEqual(before, PROBE_VALUE)) {
			this.error(
				`Refusing to remove: root metadata \`${PROBE_KEY}\` is not exactly ${JSON.stringify(PROBE_VALUE)}`,
			);
		}
		await this.adapter(client).setRootMeta([PROBE_KEY], undefined);
		const after = (await client.bootstrap()).rootMetadata[PROBE_KEY];
		return [
			`- \`${PROBE_KEY}\` before: \`${JSON.stringify(before)}\``,
			`- Pushed: \`setRootMeta(["${PROBE_KEY}"], undefined)\``,
			`- \`${PROBE_KEY}\` after a fresh bootstrap: ${
				after === undefined ? "absent (removal CONFIRMED)" : `\`${JSON.stringify(after)}\` (removal FAILED)`
			}`,
		];
	}

	/**
	 * ACCOUNT-GLOBAL write: post `show_completed` at its current value through `setSetting`, then flip it and
	 * restore it at once, reading each back from a fresh bootstrap. The restore runs even if the flip fails.
	 */
	private async settings(client: WorkflowyInternalClient, recorded: RecordedRequest[]): Promise<string[]> {
		const readShowCompleted = async (): Promise<unknown> => (await client.bootstrap()).settings.show_completed;
		const before = await readShowCompleted();
		if (typeof before !== "boolean") {
			this.error(
				`Refusing to write: init settings.show_completed is ${before === undefined ? "absent" : `\`${JSON.stringify(before)}\``}, not a boolean`,
			);
		}
		const adapter = this.adapter(client);
		const post = async (label: string, value: boolean): Promise<string> => {
			await adapter.setSetting("show_completed", value);
			const response = recorded.findLast((request) => request.path === "/change_settings");
			const preview = (response?.text ?? "").slice(0, BODY_PREVIEW_CHARS).replaceAll(/\s+/gu, " ").trim();
			const after = await readShowCompleted();
			return `- ${label}: posted \`show_completed=${value ? "yes" : "no"}\`: HTTP ${response?.status ?? "?"}, body \`${preview}\`; read back \`${JSON.stringify(after)}\` (${after === value ? "MATCH" : "MISMATCH"})`;
		};
		const lines = [`- \`show_completed\` before: \`${before}\` (\`boolean\`)`, await post("Same value", before)];
		try {
			lines.push(await post("Flip", !before));
		} finally {
			lines.push(await post("Restore", before));
		}
		return [...lines, "- Next: reload workflowy.com and confirm completed items show as before"];
	}

	private async bootstrap(client: WorkflowyInternalClient, recorded: RecordedRequest[]): Promise<string[]> {
		const session = await client.bootstrap();
		const init = recorded.find((request) => request.path === "/get_initialization_data");
		const clientId = init?.clientIdHeader ?? null;
		const initTxId = init === undefined ? undefined : findInitTxId(init.text);
		const usedTreeData = recorded.some((request) => request.path === "/get_tree_data/");
		const usedUserData = recorded.some((request) => request.path === "/get_user_data/");
		const versionFromGlobals = recorded.some((request) => {
			const globals: unknown = Reflect.get(Object(parseJson(request.text)), "globals");
			return (
				Array.isArray(globals) && globals.some((pair) => Array.isArray(pair) && pair[0] === "CLIENT_VERSION")
			);
		});
		return [
			`- \`wfclientid\` header: ${clientId === null ? "absent" : `present, shape \`${shapeOf(clientId)}\``}`,
			`- \`client_version\` used: \`${session.clientVersion}\` (${
				versionFromGlobals
					? "from a JSON `globals` CLIENT_VERSION"
					: "client default; no JSON `globals` CLIENT_VERSION"
			})`,
			`- \`initialMostRecentOperationTransactionId\` with \`no_root_children=1\`: ${
				initTxId === undefined ? "absent" : `present, shape \`${shapeOf(initTxId)}\``
			}`,
			`- \`get_tree_data\` fallback needed: ${usedTreeData ? "yes" : "no"}`,
			`- \`get_user_data\` needed for user/settings/root metadata: ${usedUserData ? "yes" : "no"}`,
			`- Requests: ${recorded
				.map((request) =>
					request.path === "/ajax_login"
						? `\`${request.method} ${request.path}\` ${request.status}`
						: `\`${request.method} ${request.path}\` ${request.status} (${request.bytes} bytes)`,
				)
				.join("; ")}`,
		];
	}

	/** One pure poll (no ops) with the bootstrap tx id. */
	private async poll(
		client: WorkflowyInternalClient,
		recorded: RecordedRequest[],
		crosscheck: boolean,
	): Promise<string[]> {
		const session = await client.bootstrap();
		const poll = await sendRawPush(client, session, recorded, {
			most_recent_operation_transaction_id: session.txId,
		});
		const lines = [
			`- \`crosscheck_user_id\` sent: ${crosscheck ? "yes" : "no"}`,
			`- HTTP status: ${poll.status} (${poll.bytes} bytes)`,
			poll.status === 403
				? "- CSRF: enforced or request refused (403)"
				: poll.status >= 200 && poll.status < 300
					? "- CSRF: not enforced (cookie-only client accepted)"
					: `- CSRF: inconclusive (status ${poll.status})`,
		];
		const body = parseJson(poll.text);
		if (body === undefined) {
			const preview = poll.text.slice(0, BODY_PREVIEW_CHARS).replaceAll(/\s+/gu, " ").trim();
			return [...lines, `- Body (not JSON): \`${preview}\``];
		}
		lines.push(`- Response keys: ${codeList(objectKeys(body))}`);
		const results: unknown = Reflect.get(Object(body), "results");
		const first: unknown = Array.isArray(results) ? results[0] : undefined;
		if (first === undefined) {
			return lines;
		}
		const newTxId = scalarText(Reflect.get(Object(first), "new_most_recent_operation_transaction_id"));
		const remote: unknown = Reflect.get(Object(first), "concurrent_remote_operation_transactions");
		const error: unknown = Reflect.get(Object(first), "error");
		lines.push(`- \`results[0]\` keys: ${codeList(objectKeys(first))}`);
		if (typeof error === "string") {
			lines.push(`- \`results[0].error\`: \`${error}\``);
		}
		lines.push(
			`- Tx id advanced: ${
				newTxId === undefined
					? "unknown (no new id)"
					: newTxId === session.txId
						? "no (still current)"
						: "yes (remote changes since bootstrap)"
			}`,
			`- Remote transactions: ${Array.isArray(remote) ? remote.length : "absent"}`,
		);
		return lines;
	}

	/**
	 * One batch of two ops on a fresh sandbox child: a valid `edit` rename, then a
	 * `move` into a parent that does not exist. Records the result's `error` and
	 * whether the first op applied, then deletes the child.
	 */
	private async errorShape(
		client: WorkflowyInternalClient,
		recorded: RecordedRequest[],
		api: WorkflowyApiClient,
	): Promise<string[]> {
		const originalName = `probe error-shape ${new Date().toISOString()}`;
		const {id} = await api.createNode({parent_id: SANDBOX_ID, name: originalName, position: "bottom"});
		assertUnderSandbox(await readAncestors(api, (await api.getNode(id)).parent_id));
		const index = (await api.getChildNodes(SANDBOX_ID)).findIndex((child) => child.id === id);
		const session = await client.bootstrap();
		const clock = {now: Date.now(), dateJoinedSec: session.dateJoinedSec};
		const operations = [
			editOp({...clock, id, name: RENAMED, previous: {name: originalName}}),
			moveOp({
				...clock,
				id,
				parentId: crypto.randomUUID(),
				index: 0,
				from: {parentId: SANDBOX_ID, index: Math.max(index, 0)},
			}),
		];
		const push = await sendRawPush(client, session, recorded, {
			most_recent_operation_transaction_id: session.txId,
			operations,
		});
		const lines = [
			"- Fixture: fresh child created under the sandbox via the public API; ancestors verified",
			"- Batch: `edit` (rename the child) then `move` (into a nonexistent parent), one `/push_and_poll`",
			`- HTTP status: ${push.status}`,
		];
		const body = parseJson(push.text);
		const results: unknown = Reflect.get(Object(body), "results");
		const first: unknown = Array.isArray(results) ? results[0] : undefined;
		if (first === undefined) {
			const preview = push.text.slice(0, BODY_PREVIEW_CHARS).replaceAll(/\s+/gu, " ").trim();
			lines.push(`- Body (no \`results[0]\`): \`${preview}\``);
		} else {
			const error: unknown = Reflect.get(Object(first), "error");
			const serverRun: unknown = Reflect.get(Object(first), "server_run_operation_transaction_json");
			const newTxId = scalarText(Reflect.get(Object(first), "new_most_recent_operation_transaction_id"));
			const serverRunOps: unknown = Reflect.get(Object(parseJson(String(serverRun))), "ops");
			lines.push(
				`- \`results[0]\` keys: ${codeList(objectKeys(first))}`,
				`- \`results[0].error\`: ${typeof error === "string" ? `\`${error}\`` : "absent"}`,
				`- \`server_run_operation_transaction_json\`: ${
					typeof serverRun === "string"
						? `present (${
								Array.isArray(serverRunOps)
									? serverRunOps
											.map((op) => `\`${String(Reflect.get(Object(op), "type"))}\``)
											.join(", ")
									: "unparsed"
							})`
						: "absent"
				}`,
				`- Tx id advanced: ${newTxId === undefined ? "unknown" : newTxId === session.txId ? "no" : "yes"}`,
			);
		}
		const after = await api.getNode(id);
		const parentAfter = after.parent_id ?? null;
		const ancestorsAfter = await readAncestors(api, parentAfter);
		lines.push(
			`- First op (\`edit\`) applied: ${after.name === RENAMED ? "yes (name changed)" : "no (name unchanged)"}`,
			`- Child parent after push: ${parentAfter === SANDBOX_ID ? "sandbox" : `not the sandbox (\`${String(parentAfter)}\`)`}`,
		);
		assertUnderSandbox(ancestorsAfter);
		await api.deleteNode(id);
		lines.push("- Cleanup: child deleted via the public API");
		return lines;
	}
}
