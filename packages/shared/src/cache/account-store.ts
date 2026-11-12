/**
 * The Workflowy account's state in typed temporal tables: the account row, the
 * root (Home) metadata and the account settings, decomposed one key per column
 * or row (see `db/schema.ts`). {@link writeAccountSnapshot} merges an
 * upstream-shaped snapshot into the tables in the caller's unit of work, and
 * {@link readAccountSnapshot} rebuilds the upstream shape from the live rows,
 * so callers keep reading metadata paths and settings by name.
 *
 * Two upstream values are empty objects of unknown shape in every account seen
 * so far (root `ai.chat_history`, settings `read_states`), so no table models
 * them; any other key outside this module's map is not stored either.
 */

import {and, desc, eq, getTableColumns, getTableName} from "drizzle-orm";
import type {SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import type {VisibleFeature} from "../api/workflowy-internal-client.js";
import
{
	account,
	accountSettings,
	aiAssistants,
	aiPromptButtons,
	apiImportTimestamp,
	changelogReads,
	enabledFeatures,
	locationRenames,
	rootPreferences,
	savedViews,
	starOrder,
	stars,
	surveys,
	tagColors,
	visibleFeatures,
} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {runUnitOfWork} from "./node-composite.js";
import type {UnitOfWork} from "./node-composite.js";
import {joinKey, temporalMerge} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

type Metadata = Record<string, unknown>;

/** No account row: a standalone store that was never provisioned, or one provisioned before its row was written. */
export class AccountNotProvisionedError extends Error
{
	constructor()
	{
		super("no account row: this store was never provisioned");
		this.name = "AccountNotProvisionedError";
	}
}

/**
 * The account row as the adapter stores it; `username`/`email` travel in the settings. `userId` is the Workflowy user
 * id in decimal for a mirror, and the sign-in user id for a standalone account.
 */
export interface StoredAccount
{
	userId: string;
	dateJoinedSec: number;
	fullName?: string | undefined;
	entropyKey?: string | undefined;
}

/** The whole account state in upstream's shape. */
export interface AccountSnapshot
{
	account: StoredAccount;
	rootMetadata: Metadata;
	settings: Metadata;
	visibleFeatures: VisibleFeature[];
}

type Kind = "text" | "integer" | "flag";

/** One scalar column of a singleton account table and the upstream path it holds. */
interface ScalarField
{
	property: string;
	path: readonly string[];
	kind: Kind;
}

/** `root_preferences` columns by root-metadata path. */
export const ROOT_PREFERENCE_FIELDS: readonly ScalarField[] = [
	{
		property: "dateFormat",
		path: ["dateFormat"],
		kind: "text",
	},
	{
		property: "timeFormat",
		path: ["timeFormat"],
		kind: "text",
	},
	{
		property: "weekStartDay",
		path: ["weekStartDay"],
		kind: "integer",
	},
	{
		property: "slashDiscovered",
		path: ["slash", "discovered"],
		kind: "flag",
	},
	{
		property: "notesRootId",
		path: ["notesRootId"],
		kind: "text",
	},
	{
		property: "weeklyReportOn",
		path: ["weekly-report", "on"],
		kind: "flag",
	},
	{
		property: "homeLayoutMode",
		path: ["layoutMode"],
		kind: "text",
	},
	{
		property: "latestColorAttribute",
		path: ["latestColor", "attribute"],
		kind: "integer",
	},
	{
		property: "latestColorValue",
		path: ["latestColor", "value"],
		kind: "integer",
	},
	{
		property: "searchForChangesAfter",
		path: ["searchForChangesAfter"],
		kind: "integer",
	},
	{
		property: "starringIsSynced",
		path: ["starring", "isSynced"],
		kind: "flag",
	},
	{
		property: "aiEmbeddingStatus",
		path: ["ai", "embeddingStatus"],
		kind: "text",
	},
	{
		property: "aiEmbeddingTooltipDismissed",
		path: ["ai", "embedding_tooltip_dismissed"],
		kind: "flag",
	},
	{
		property: "aiMailboxId",
		path: ["ai", "mailboxId"],
		kind: "text",
	},
	{
		property: "cmdMetricsFailed",
		path: ["cmd_metrics", "failed"],
		kind: "integer",
	},
	{
		property: "calendarRootId",
		path: ["calendar", "rootId"],
		kind: "text",
	},
	{
		property: "calendarTsAddedV2",
		path: ["calendar", "ts_added_v2"],
		kind: "flag",
	},
	{
		property: "calendarTooltipSeen",
		path: ["calendar", "tooltip_seen"],
		kind: "flag",
	},
	{
		property: "calendarDateIdAddedV1",
		path: ["calendar", "dateId_added_v1"],
		kind: "flag",
	},
	{
		property: "emojiSelected",
		path: ["emoji", "options", "selected"],
		kind: "text",
	},
	{
		property: "inboxId",
		path: ["inbox_id"],
		kind: "text",
	},
];

/** `account_settings` columns by settings path. */
export const ACCOUNT_SETTING_FIELDS: readonly ScalarField[] = [
	{
		property: "theme",
		path: ["theme"],
		kind: "text",
	},
	{
		property: "font",
		path: ["font"],
		kind: "text",
	},
	{
		property: "timezone",
		path: ["timezone"],
		kind: "text",
	},
	{
		property: "showCompleted",
		path: ["show_completed"],
		kind: "flag",
	},
	{
		property: "showKeyboardShortcuts",
		path: ["show_keyboard_shortcuts"],
		kind: "flag",
	},
	{
		property: "sameColorForLinks",
		path: ["same_color_for_links"],
		kind: "flag",
	},
	{
		property: "displayImagePreviewsAsThumbnails",
		path: ["display_image_previews_as_thumbnails"],
		kind: "flag",
	},
	{
		property: "ignoreYoutube",
		path: ["ignore_youtube"],
		kind: "flag",
	},
	{
		property: "ignoreYtShort",
		path: ["ignore_yt_short"],
		kind: "flag",
	},
	{
		property: "ignoreTwitter",
		path: ["ignore_twitter"],
		kind: "flag",
	},
	{
		property: "ignoreLoom",
		path: ["ignore_loom"],
		kind: "flag",
	},
	{
		property: "unsubscribeFromSummaryEmails",
		path: ["unsubscribe_from_summary_emails"],
		kind: "flag",
	},
	{
		property: "unsubscribeFromCommentsEmails",
		path: ["unsubscribe_from_comments_emails"],
		kind: "flag",
	},
	{
		property: "backupToDropbox",
		path: ["backup_to_dropbox"],
		kind: "flag",
	},
	{
		property: "mfaEnabled",
		path: ["mfa", "enabled"],
		kind: "flag",
	},
	{
		property: "aiDefaultAgentId",
		path: ["ai", "default_agent_id"],
		kind: "text",
	},
	{
		property: "aiContextLimit",
		path: ["ai", "context_limit"],
		kind: "integer",
	},
];

function isRecord(value: unknown): value is Metadata
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: readonly string[]): unknown
{
	let current = value;
	for (const key of path)
	{
		if (!isRecord(current) || !Object.hasOwn(current, key))
		{
			return undefined;
		}
		current = current[key];
	}
	return current;
}

function setPath(target: Metadata, path: readonly string[], value: unknown): void
{
	let current = target;
	for (const key of path.slice(0, -1))
	{
		const next = current[key];
		if (isRecord(next))
		{
			current = next;
		}
		else
		{
			const created: Metadata = {};
			current[key] = created;
			current = created;
		}
	}
	const last = path.at(-1);
	if (last !== undefined)
	{
		current[last] = value;
	}
}

function asText(value: unknown): string | null
{
	return typeof value === "string" ? value : null;
}

function asInteger(value: unknown): number | null
{
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Upstream flags are booleans or `"yes"`/`"no"`; stored as 0/1. */
function asFlag(value: unknown): number | null
{
	if (value === true || value === "yes")
	{
		return 1;
	}
	if (value === false || value === "no")
	{
		return 0;
	}
	return null;
}

const CONVERT: Record<Kind, (value: unknown) => string | number | null> =
{
	text: asText,
	integer: asInteger,
	flag: asFlag,
};

function scalarRow(source: Metadata, fields: readonly ScalarField[]): Record<string, string | number | null>
{
	return Object.fromEntries(
		fields.map((field) => [field.property, CONVERT[field.kind](getPath(source, field.path))]),
	);
}

function applyScalars(target: Metadata, row: Record<string, unknown>, fields: readonly ScalarField[]): void
{
	for (const field of fields)
	{
		const value = row[field.property];
		if (value !== null && value !== undefined)
		{
			setPath(target, field.path, field.kind === "flag" ? value === 1 : value);
		}
	}
}

function entries(value: unknown): [string, unknown][]
{
	return isRecord(value) ? Object.entries(value) : [];
}

function list(value: unknown): unknown[]
{
	return Array.isArray(value) ? value : [];
}

function parseSavedViews(value: unknown): unknown[]
{
	if (typeof value !== "string")
	{
		return [];
	}
	try
	{
		return list(JSON.parse(value));
	}
	catch
	{
		return [];
	}
}

/** One row of `table` without its temporal envelope. */
type Row<T extends SQLiteTable> = Omit<T["$inferInsert"], "systemFrom" | "systemTo">;

/** Every account table's live rows, as {@link writeAccountSnapshot} writes them; no temporal columns. */
export interface AccountRows
{
	account: Row<typeof account>[];
	rootPreferences: Row<typeof rootPreferences>[];
	accountSettings: Row<typeof accountSettings>[];
	tagColors: Row<typeof tagColors>[];
	stars: Row<typeof stars>[];
	starOrder: Row<typeof starOrder>[];
	locationRenames: Row<typeof locationRenames>[];
	enabledFeatures: Row<typeof enabledFeatures>[];
	visibleFeatures: Row<typeof visibleFeatures>[];
	changelogReads: Row<typeof changelogReads>[];
	surveys: Row<typeof surveys>[];
	savedViews: Row<typeof savedViews>[];
	aiAssistants: Row<typeof aiAssistants>[];
	aiPromptButtons: Row<typeof aiPromptButtons>[];
}

type RowsOf<K extends keyof AccountRows> = AccountRows[K][number];

/** One account table: the Drizzle table and the properties of its key. */
interface AccountTable
{
	table: SQLiteTable;
	key: readonly string[];
}

/** Every {@link AccountRows} key, in table order. */
const ROW_NAMES = [
	"account",
	"rootPreferences",
	"accountSettings",
	"tagColors",
	"stars",
	"starOrder",
	"locationRenames",
	"enabledFeatures",
	"visibleFeatures",
	"changelogReads",
	"surveys",
	"savedViews",
	"aiAssistants",
	"aiPromptButtons",
] as const satisfies readonly (keyof AccountRows)[];

const TABLES: Record<keyof AccountRows, AccountTable> =
{
	account:
	{
		table: account,
		key: ["userId"],
	},
	rootPreferences:
	{
		table: rootPreferences,
		key: ["userId"],
	},
	accountSettings:
	{
		table: accountSettings,
		key: ["userId"],
	},
	tagColors:
	{
		table: tagColors,
		key: ["tag"],
	},
	stars:
	{
		table: stars,
		key: ["locationKey"],
	},
	starOrder:
	{
		table: starOrder,
		key: ["position"],
	},
	locationRenames:
	{
		table: locationRenames,
		key: ["locationKey"],
	},
	enabledFeatures:
	{
		table: enabledFeatures,
		key: ["codename"],
	},
	visibleFeatures:
	{
		table: visibleFeatures,
		key: ["codename"],
	},
	changelogReads:
	{
		table: changelogReads,
		key: ["entry"],
	},
	surveys:
	{
		table: surveys,
		key: ["survey"],
	},
	savedViews:
	{
		table: savedViews,
		key: ["position"],
	},
	aiAssistants:
	{
		table: aiAssistants,
		key: ["assistantId"],
	},
	aiPromptButtons:
	{
		table: aiPromptButtons,
		key: ["kind", "position"],
	},
};

/** Decompose an upstream-shaped snapshot into each account table's rows. */
export function accountRows(snapshot: AccountSnapshot): AccountRows
{
	const {account: stored, rootMetadata: root, settings} = snapshot;
	const {userId} = stored;
	const order = getPath(root, ["starring", "order"]);
	const ai = settings.ai;
	return {
		account: [
			{
				userId,
				fullName: stored.fullName ?? null,
				dateJoinedSec: stored.dateJoinedSec,
				entropyKey: stored.entropyKey ?? null,
				username: asText(settings.username),
				email: asText(settings.email),
			},
		],
		rootPreferences: [
			{
				userId,
				...scalarRow(root, ROOT_PREFERENCE_FIELDS),
			},
		],
		accountSettings: [
			{
				userId,
				...scalarRow(settings, ACCOUNT_SETTING_FIELDS),
			},
		],
		tagColors: entries(getPath(root, ["color", "tags"])).flatMap(([tag, index]) =>
		{
			const colorIndex = asInteger(index);
			return colorIndex === null
				? []
				: [
						{
							tag,
							colorIndex,
						},
					];
		}),
		stars: entries(getPath(root, ["starring", "locations"])).flatMap(([locationKey, treeRoot]) =>
			typeof treeRoot === "string"
				? [
						{
							locationKey,
							treeRoot,
						},
					]
				: [],
		),
		starOrder:
			typeof order === "string"
				? order.split(",").map((entry, position) => (
					{
						position,
						entry,
					}))
				: [],
		locationRenames: entries(getPath(root, ["location", "renamed"])).flatMap(([locationKey, name]) =>
			typeof name === "string"
				? [
						{
							locationKey,
							name,
						},
					]
				: [],
		),
		enabledFeatures: entries(settings.features).flatMap(([codename, flag]) =>
		{
			const enabled = asFlag(flag);
			return enabled === null
				? []
				: [
						{
							codename,
							enabled,
						},
					];
		}),
		visibleFeatures: snapshot.visibleFeatures.map((feature, position) => (
		{
			...feature,
			position,
		})),
		changelogReads: entries(getPath(root, ["changelog", "read"])).flatMap(([entry, flag]) =>
		{
			const read = asFlag(flag);
			return read === null
				? []
				: [
						{
							entry,
							read,
						},
					];
		}),
		surveys: entries(root.surveys).map(([survey, value]) => (
		{
			survey,
			status: asText(getPath(value, ["status"])),
			rating: asInteger(getPath(value, ["rating"])),
			at: asInteger(getPath(value, ["at"])),
		})),
		savedViews: parseSavedViews(settings.saved_views_json).map((view, position) => (
		{
			position,
			projectId: asText(getPath(view, ["zoomedProject", "projectid"])),
			auxiliaryRootProjectId: asText(getPath(view, ["zoomedProject", "auxiliaryRootProjectId"])),
			searchQuery: asText(getPath(view, ["searchQuery"])),
		})),
		aiAssistants: list(getPath(ai, ["assistants"])).flatMap((assistant, position) =>
		{
			const assistantId = asText(getPath(assistant, ["id"]));
			return assistantId === null
				? []
				: [
						{
							assistantId,
							name: asText(getPath(assistant, ["name"])),
							model: asText(getPath(assistant, ["model"])),
							systemUserId: asInteger(getPath(assistant, ["system_user_id"])),
							position,
						},
					];
		}),
		aiPromptButtons: entries(getPath(ai, ["prompt_buttons"])).flatMap(([kind, buttons]) =>
			list(buttons).map((button, position) => (
			{
				kind,
				position,
				buttonId: asText(getPath(button, ["id"])),
				name: asText(getPath(button, ["name"])),
				icon: asText(getPath(button, ["icon"])),
			})),
		),
	};
}

/** Rebuild the upstream-shaped snapshot from each account table's rows; undefined without an account row. */
export function snapshotFromRows(rows: AccountRows): AccountSnapshot | undefined
{
	const [stored] = rows.account;
	if (stored === undefined)
	{
		return undefined;
	}
	const root: Metadata = {};
	const settings: Metadata = {};
	if (stored.username !== null && stored.username !== undefined)
	{
		settings.username = stored.username;
	}
	if (stored.email !== null && stored.email !== undefined)
	{
		settings.email = stored.email;
	}
	const [preferences] = rows.rootPreferences;
	if (preferences !== undefined)
	{
		applyScalars(root, preferences, ROOT_PREFERENCE_FIELDS);
	}
	const [accountSettingsRow] = rows.accountSettings;
	if (accountSettingsRow !== undefined)
	{
		applyScalars(settings, accountSettingsRow, ACCOUNT_SETTING_FIELDS);
	}
	if (rows.tagColors.length > 0)
	{
		setPath(root, ["color", "tags"], Object.fromEntries(rows.tagColors.map((row) => [row.tag, row.colorIndex])));
	}
	if (rows.stars.length > 0)
	{
		setPath(
			root,
			["starring", "locations"],
			Object.fromEntries(rows.stars.map((row) => [row.locationKey, row.treeRoot])),
		);
	}
	if (rows.starOrder.length > 0)
	{
		setPath(
			root,
			["starring", "order"],
			byPosition(rows.starOrder)
				.map((row) => row.entry)
				.join(","),
		);
	}
	if (rows.locationRenames.length > 0)
	{
		setPath(
			root,
			["location", "renamed"],
			Object.fromEntries(rows.locationRenames.map((row) => [row.locationKey, row.name])),
		);
	}
	if (rows.enabledFeatures.length > 0)
	{
		settings.features = Object.fromEntries(rows.enabledFeatures.map((row) => [row.codename, row.enabled === 1]));
	}
	if (rows.changelogReads.length > 0)
	{
		setPath(
			root,
			["changelog", "read"],
			Object.fromEntries(rows.changelogReads.map((row) => [row.entry, row.read === 1])),
		);
	}
	for (const row of rows.surveys)
	{
		setPath(
			root,
			["surveys", row.survey],
			{
				...(row.status === null || row.status === undefined
					? {}
					:
						{
							status: row.status,
						}),
				...(row.rating === null || row.rating === undefined
					? {}
					:
						{
							rating: row.rating,
						}),
				...(row.at === null || row.at === undefined
					? {}
					:
						{
							at: row.at,
						}),
			},
		);
	}
	if (rows.savedViews.length > 0)
	{
		settings.saved_views_json = JSON.stringify(
			byPosition(rows.savedViews).map((row) => (
			{
				zoomedProject:
				{
					projectid: row.projectId ?? null,
					...(row.auxiliaryRootProjectId === null || row.auxiliaryRootProjectId === undefined
						? {}
						:
							{
								auxiliaryRootProjectId: row.auxiliaryRootProjectId,
							}),
				},
				searchQuery: row.searchQuery ?? null,
			})),
		);
	}
	if (rows.aiAssistants.length > 0)
	{
		setPath(
			settings,
			["ai", "assistants"],
			byPosition(rows.aiAssistants).map((row) => (
			{
				id: row.assistantId,
				name: row.name ?? null,
				model: row.model ?? null,
				system_user_id: row.systemUserId ?? null,
			})),
		);
	}
	for (const row of byPosition(rows.aiPromptButtons))
	{
		const path = ["ai", "prompt_buttons", row.kind];
		const buttons = list(getPath(settings, path));
		setPath(settings, path, [
			...buttons,
			{
				id: row.buttonId ?? null,
				name: row.name ?? null,
				icon: row.icon ?? null,
			},
		]);
	}
	return {
		account:
		{
			userId: stored.userId,
			dateJoinedSec: stored.dateJoinedSec,
			...(stored.fullName === null || stored.fullName === undefined
				? {}
				:
					{
						fullName: stored.fullName,
					}),
			...(stored.entropyKey === null || stored.entropyKey === undefined
				? {}
				:
					{
						entropyKey: stored.entropyKey,
					}),
		},
		rootMetadata: root,
		settings,
		visibleFeatures: byPosition(rows.visibleFeatures).map(({codename, name, label, description}) => (
		{
			codename,
			name,
			label: label ?? null,
			description: description ?? null,
		})),
	};
}

function byPosition<
	T extends
	{
		position: number;
	},
>(rows: readonly T[]): T[]
{
	return rows.toSorted((a, b) => a.position - b.position);
}

function systemToColumn(table: SQLiteTable): SQLiteColumn
{
	const column = getTableColumns(table).systemTo;
	if (column === undefined)
	{
		throw new TypeError("account table without system_to");
	}
	return column;
}

function liveRowsOf(tx: TemporalTransaction, table: SQLiteTable): Record<string, unknown>[]
{
	return tx
		.select()
		.from(table)
		.where(eq(systemToColumn(table), FAR_FUTURE_DATE))
		.all();
}

/** The row without its temporal envelope. */
function content(row: Record<string, unknown>): Record<string, unknown>
{
	const {systemFrom: _from, systemTo: _to, ...rest} = row;
	return rest;
}

function mergeTable({tx, systemTime}: UnitOfWork, {table, key}: AccountTable, incoming: object[]): void
{
	const columns = getTableColumns(table);
	const keyOf = (row: object) => joinKey(...key.map((property) => String(Reflect.get(row, property))));
	const fields = Object.keys(columns).filter((property) => property !== "systemFrom" && property !== "systemTo");
	temporalMerge(
		tx,
		{
			table,
			keyColumns: key.map((property) =>
			{
				const column = columns[property];
				if (column === undefined)
				{
					throw new TypeError(`unknown key column ${property}`);
				}
				return column;
			}),
			incomingKey: keyOf,
			currentKey: keyOf,
			contentMatches: (current, row) =>
				fields.every((field) => (Reflect.get(current, field) ?? null) === (Reflect.get(row, field) ?? null)),
			buildInsertRow: (row) =>
				content(
					{
						...row,
					},
				),
		},
		incoming,
		liveRowsOf(tx, table),
		systemTime,
	);
}

/** The rows in `rows`, summed over the account tables. */
export function accountRowTotal(rows: AccountRows): number
{
	return ROW_NAMES.reduce((sum, name) => sum + rows[name].length, 0);
}

/** Each account table's row count in `rows`, by table name. */
export function accountRowCounts(rows: AccountRows): Record<string, number>
{
	return Object.fromEntries(ROW_NAMES.map((name) => [getTableName(TABLES[name].table), rows[name].length]));
}

/** Merge every account table to `rows`, in the caller's unit of work. */
export function writeAccountRows(unitOfWork: UnitOfWork, rows: AccountRows): void
{
	for (const name of ROW_NAMES)
	{
		mergeTable(unitOfWork, TABLES[name], rows[name]);
	}
}

/** Merge every account table to the decomposed `snapshot`, in the caller's unit of work. */
export function writeAccountSnapshot(unitOfWork: UnitOfWork, snapshot: AccountSnapshot): void
{
	writeAccountRows(unitOfWork, accountRows(snapshot));
}

/**
 * Merge only the account row (its join date is the Workflowy epoch), in the caller's unit of work: for a cache with no
 * account import yet. Every other account table stays as is; the next full account write replaces the row.
 */
export function seedAccount(unitOfWork: UnitOfWork, stored: StoredAccount): void
{
	mergeTable(unitOfWork, TABLES.account, [
		{
			userId: stored.userId,
			fullName: stored.fullName ?? null,
			dateJoinedSec: stored.dateJoinedSec,
			entropyKey: stored.entropyKey ?? null,
			username: null,
			email: null,
		},
	]);
}

/** The Workflowy epoch (the account's join date in Unix seconds) from the live account row, if any. */
export function readWorkflowyEpoch(tx: TemporalTransaction): number | undefined
{
	return tx
		.select(
			{
				dateJoinedSec: account.dateJoinedSec,
			},
		)
		.from(account)
		.where(eq(account.systemTo, FAR_FUTURE_DATE))
		.get()?.dateJoinedSec;
}

/** Every account table's live rows. */
export function readAccountRows(tx: TemporalTransaction): AccountRows
{
	const read = <K extends keyof AccountRows>(name: K): RowsOf<K>[] =>
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the select returns the table's own rows
		liveRowsOf(tx, TABLES[name].table).map((row) => content(row) as RowsOf<K>);
	return {
		account: read("account"),
		rootPreferences: read("rootPreferences"),
		accountSettings: read("accountSettings"),
		tagColors: read("tagColors"),
		stars: read("stars"),
		starOrder: read("starOrder"),
		locationRenames: read("locationRenames"),
		enabledFeatures: read("enabledFeatures"),
		visibleFeatures: read("visibleFeatures"),
		changelogReads: read("changelogReads"),
		surveys: read("surveys"),
		savedViews: read("savedViews"),
		aiAssistants: read("aiAssistants"),
		aiPromptButtons: read("aiPromptButtons"),
	};
}

/** The live account state in upstream's shape, or undefined before any account import. */
export function readAccountSnapshot(tx: TemporalTransaction): AccountSnapshot | undefined
{
	return snapshotFromRows(readAccountRows(tx));
}

/** The live enabled-feature flags by codename, read without the internal API. */
export function readEnabledFeatures(tx: TemporalTransaction): Record<string, boolean>
{
	return Object.fromEntries(
		tx
			.select(
				{
					codename: enabledFeatures.codename,
					enabled: enabledFeatures.enabled,
				},
			)
			.from(enabledFeatures)
			.where(eq(enabledFeatures.systemTo, FAR_FUTURE_DATE))
			.all()
			.map((row) => [row.codename, row.enabled === 1]),
	);
}

/**
 * Replace the live enabled-feature flags with `features` (codename -> on) in one unit of work, keeping off flags as
 * `enabled = 0` rows so a deliberately empty dict still reads as stored. For an account with no internal API.
 */
export function writeEnabledFeatures(database: TemporalTransaction, features: Readonly<Record<string, boolean>>): void
{
	runUnitOfWork(database, (unitOfWork) =>
	{
		mergeTable(
			unitOfWork,
			TABLES.enabledFeatures,
			Object.entries(features).map(([codename, on]) => (
			{
				codename,
				enabled: on ? 1 : 0,
			})),
		);
	});
}

/** The `api_import_timestamp` name of the account tables' refresh time. */
export const ACCOUNT_IMPORT_NAME = "account";

/** Record `at` (Unix ms) as a named import time, in the caller's unit of work. */
export function stampImportTime({tx, systemTime}: UnitOfWork, name: string, at: number): void
{
	temporalMerge(
		tx,
		{
			table: apiImportTimestamp,
			keyColumn: apiImportTimestamp.name,
			incomingKey: (row: {name: string}) => row.name,
			currentKey: (row: {name: string}) => row.name,
			contentMatches: () => false,
			buildInsertRow: (row) => (
			{
				name: row.name,
				timestamp: new Date(at),
			}),
		},
		[
			{
				name,
			},
		],
		tx
			.select(
				{
					name: apiImportTimestamp.name,
				},
			)
			.from(apiImportTimestamp)
			.where(and(eq(apiImportTimestamp.name, name), eq(apiImportTimestamp.systemTo, FAR_FUTURE_DATE)))
			.all(),
		systemTime,
	);
}

/** A named import time (Unix ms, second precision), or undefined when it was never stamped. */
export function readImportTime(tx: TemporalTransaction, name: string): number | undefined
{
	const row = tx
		.select(
			{
				timestamp: apiImportTimestamp.timestamp,
			},
		)
		.from(apiImportTimestamp)
		.where(and(eq(apiImportTimestamp.name, name), eq(apiImportTimestamp.systemTo, FAR_FUTURE_DATE)))
		.orderBy(desc(apiImportTimestamp.systemFrom))
		.get();
	return row?.timestamp?.getTime();
}

/** The account tables' live rows plus the expanded keys (null while unseeded): the seed body of a new deployment. */
export interface AccountState
{
	rows: AccountRows;
	expandedKeys: string[] | null;
}

function isRow(table: SQLiteTable, value: unknown): boolean
{
	if (!isRecord(value))
	{
		return false;
	}
	const columns = getTableColumns(table);
	const known = Object.entries(columns).filter(([property]) => property !== "systemFrom" && property !== "systemTo");
	const types = Object.entries(value).every(([property, field]) =>
	{
		const column = columns[property];
		if (column === undefined || property === "systemFrom" || property === "systemTo")
		{
			return false;
		}
		if (field === null)
		{
			return !column.notNull;
		}
		return column.dataType === "number"
			? typeof field === "number" && Number.isInteger(field)
			: typeof field === "string";
	});
	return types && known.every(([property, column]) => !column.notNull || Object.hasOwn(value, property));
}

/**
 * Validate an {@link AccountState} received as JSON: every table's rows must carry exactly the table's own columns
 * (no temporal ones), each typed as the column is. Undefined when anything does not match.
 */
export function parseAccountState(value: unknown): AccountState | undefined
{
	if (!isRecord(value) || !isRecord(value.rows))
	{
		return undefined;
	}
	const {rows, expandedKeys} = value;
	const tablesValid =
		Object.keys(rows).every((name) => Object.hasOwn(TABLES, name)) &&
		ROW_NAMES.every((name) =>
		{
			const tableRows = rows[name];
			return Array.isArray(tableRows) && tableRows.every((row) => isRow(TABLES[name].table, row));
		});
	const keysValid =
		expandedKeys === null || (Array.isArray(expandedKeys) && expandedKeys.every((key) => typeof key === "string"));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated column by column above
	return tablesValid && keysValid ? (value as unknown as AccountState) : undefined;
}
