import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {readAccountSnapshot, readImportTime} from "../src/cache/account-store.js";
import {readExpansion} from "../src/cache/expansion-store.js";
import {readTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

/** A copy of the migrations folder whose journal stops before `tag`. */
function migrationsBefore(tag: string, tempDir: string): string {
	fs.cpSync(migrationsFolder, tempDir, {recursive: true});
	const journalPath = path.join(tempDir, "meta/_journal.json");
	const journal: {entries: {tag: string}[]} = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	const index = journal.entries.findIndex((entry) => entry.tag === tag);
	fs.writeFileSync(journalPath, JSON.stringify({...journal, entries: journal.entries.slice(0, index)}));
	return tempDir;
}

const ROOT_METADATA = {
	color: {tags: {"#next": 2, "@alice": 3, "#bad": "x"}},
	latestColor: {attribute: 12, value: 2},
	slash: {discovered: true},
	searchForChangesAfter: 354_215_365,
	starring: {locations: {n1: "None", "n2_query ": "None"}, isSynced: true, order: "None/n2/query ,None/n1/"},
	ai: {embeddingStatus: "finished", embedding_tooltip_dismissed: true, chat_history: {}, mailboxId: "mb"},
	changelog: {read: {may27: true, june01: false}},
	dateFormat: "YYYY-MM-DD",
	timeFormat: "HH:mm",
	cmd_metrics: {failed: 23},
	calendar: {rootId: "cal", ts_added_v2: true, tooltip_seen: true, dateId_added_v1: true},
	emoji: {options: {selected: "system"}},
	"weekly-report": {on: true},
	inbox_id: "inbox",
	location: {renamed: {"None/n2/query ": "Old name"}},
	surveys: {"panes-v1": {status: "dismissed", at: 1_793_201_591_840}},
};

const SETTINGS = {
	email: "alice@example.com",
	username: "alice",
	theme: "system",
	font: "system",
	timezone: "America/New_York",
	show_completed: false,
	show_keyboard_shortcuts: true,
	backup_to_dropbox: true,
	ignore_loom: "no",
	saved_views_json: JSON.stringify([
		{zoomedProject: {projectid: "p1"}, searchQuery: ""},
		{zoomedProject: {projectid: "None", auxiliaryRootProjectId: "None"}, searchQuery: "q"},
	]),
	features: {dates: true, table: true, old: false},
	mfa: {enabled: true},
	read_states: {},
	ai: {
		assistants: [{id: "gpt_5", name: "GPT 5", model: "openai/gpt-5", system_user_id: -7}],
		default_agent_id: "gpt_5",
		prompt_buttons: {draft: [], reply: [{id: "sum", name: "Summarize", icon: "align-left"}]},
		context_limit: 1000,
	},
};

describe("migration 0043_replace_account_state", () => {
	let tempDir: string | undefined;
	afterEach(() => {
		if (tempDir !== undefined) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	function migratedFrom(
		accountState: Record<string, unknown>,
		localSettings: Record<string, unknown>,
	): {sqlite: DatabaseConstructor.Database; db: ReturnType<typeof drizzle<typeof schema>>} {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0043-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore("0043_replace_account_state", tempDir)});
		const insertState = sqlite.prepare("INSERT INTO account_state (key, json, fetched_at) VALUES (?, ?, ?)");
		for (const [key, value] of Object.entries(accountState)) {
			insertState.run(key, JSON.stringify(value), 1_793_463_618_718);
		}
		const insertLocal = sqlite.prepare("INSERT INTO local_settings (key, json, updated_at) VALUES (?, ?, 0)");
		for (const [key, value] of Object.entries(localSettings)) {
			insertLocal.run(key, JSON.stringify(value));
		}
		migrate(db, {migrationsFolder});
		return {sqlite, db};
	}

	it("backfills every account table from account_state and local_settings, local values winning, then drops local_settings", () => {
		const {sqlite, db} = migratedFrom(
			{
				account: {userId: 107, dateJoinedSec: 1_324_752_241, fullName: "Alice Smith"},
				root_metadata: ROOT_METADATA,
				settings: SETTINGS,
				visible_features: [
					{codename: "dates", name: "Dates", label: null, description: "d"},
					{codename: "table", name: "Tables", label: "LABS", description: null},
				],
				entropy_key: "k".repeat(64),
				expanded_keys: ["aaaaaaaa", "bbbbbbbb"],
				tree_tx_id: "1180698978",
				calendar_layout_undo: {rootId: "cal", writes: [], metadata: {}},
			},
			{
				"setting:theme": "dark",
				"setting:features": {dates: true},
				"root:weekStartDay": 1,
				"root:dateFormat": null,
				"root:starring.order": "None/n1/",
				"expansion:aaaaaaaa": false,
				"expansion:cccccccc": true,
			},
		);

		expect({
			snapshot: readAccountSnapshot(db),
			expansion: readExpansion(db),
			txId: readTreeTxId(db),
			accountFetchedAt: readImportTime(db, "account"),
			expansionSeededAt: readImportTime(db, "expanded_nodes"),
			accountState: sqlite.prepare("SELECT key FROM account_state").all(),
			localSettings: sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'local_settings'").all(),
		}).toStrictEqual({
			snapshot: {
				account: {
					userId: 107,
					dateJoinedSec: 1_324_752_241,
					fullName: "Alice Smith",
					entropyKey: "k".repeat(64),
				},
				rootMetadata: {
					timeFormat: "HH:mm",
					weekStartDay: 1,
					slash: {discovered: true},
					"weekly-report": {on: true},
					latestColor: {attribute: 12, value: 2},
					searchForChangesAfter: 354_215_365,
					starring: {isSynced: true, locations: {n1: "None", "n2_query ": "None"}, order: "None/n1/"},
					ai: {embeddingStatus: "finished", embedding_tooltip_dismissed: true, mailboxId: "mb"},
					cmd_metrics: {failed: 23},
					calendar: {rootId: "cal", ts_added_v2: true, tooltip_seen: true, dateId_added_v1: true},
					emoji: {options: {selected: "system"}},
					inbox_id: "inbox",
					color: {tags: {"#next": 2, "@alice": 3}},
					location: {renamed: {"None/n2/query ": "Old name"}},
					changelog: {read: {may27: true, june01: false}},
					surveys: {"panes-v1": {status: "dismissed", at: 1_793_201_591_840}},
				},
				settings: {
					username: "alice",
					email: "alice@example.com",
					theme: "dark",
					font: "system",
					timezone: "America/New_York",
					show_completed: false,
					show_keyboard_shortcuts: true,
					ignore_loom: false,
					backup_to_dropbox: true,
					mfa: {enabled: true},
					ai: {
						default_agent_id: "gpt_5",
						context_limit: 1000,
						assistants: [{id: "gpt_5", name: "GPT 5", model: "openai/gpt-5", system_user_id: -7}],
						prompt_buttons: {reply: [{id: "sum", name: "Summarize", icon: "align-left"}]},
					},
					features: {dates: true},
					saved_views_json: JSON.stringify([
						{zoomedProject: {projectid: "p1"}, searchQuery: ""},
						{zoomedProject: {projectid: "None", auxiliaryRootProjectId: "None"}, searchQuery: "q"},
					]),
				},
				visibleFeatures: [
					{codename: "dates", name: "Dates", label: null, description: "d"},
					{codename: "table", name: "Tables", label: "LABS", description: null},
				],
			},
			expansion: new Set(["bbbbbbbb", "cccccccc"]),
			txId: "1180698978",
			accountFetchedAt: 1_793_463_618_000,
			expansionSeededAt: 1_793_463_618_000,
			accountState: [{key: "calendar_layout_undo"}],
			localSettings: [],
		});
	});

	it("backfills nothing and leaves expansion unseeded on an empty database", () => {
		const {db} = migratedFrom({}, {"expansion:aaaaaaaa": true});

		expect({
			snapshot: readAccountSnapshot(db),
			expansion: readExpansion(db),
			txId: readTreeTxId(db),
			expanded: db.select().from(schema.expandedNodes).all(),
		}).toStrictEqual({snapshot: undefined, expansion: undefined, txId: undefined, expanded: []});
	});

	it("keeps an empty starring order as one empty entry, distinct from an absent order", () => {
		const {db} = migratedFrom(
			{
				account: {userId: 1, dateJoinedSec: 2},
				root_metadata: {starring: {order: ""}},
				settings: {},
			},
			{},
		);

		expect(readAccountSnapshot(db)?.rootMetadata).toStrictEqual({starring: {order: ""}});
	});
});
