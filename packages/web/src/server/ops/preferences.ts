/**
 * Account-global preferences stored in upstream's root (Home) metadata and
 * server-saved account settings: through the internal API in a mirror, so they
 * match workflowy.com, and in the local tables when there is no internal API.
 *
 * `GET /` -> preferences; `PATCH /` with any subset -> the full preferences.
 * A `null` removes the stored value.
 */

import {z} from "zod";
import {LocalAccount} from "@outlinedb/shared/cache";
import type {ServerSetting} from "@outlinedb/shared/internal";
import {withAccountState} from "../account-state.js";
import type {AccountState} from "../account-state.js";
import {reapplyWeekLayout} from "../calendar-layout.js";
import {COLOR_VALUE, isColorName} from "../../color-palette.js";
import {TAG_COLORS} from "../../tag-colors.js";
import {defineOp, ok} from "./define.js";

/** The toolbar's latest color as the client sees it: a text or highlight color from the palette. */
const LatestColorSchema = z.strictObject({kind: z.enum(["text", "highlight"]), color: z.enum(TAG_COLORS)});

type LatestColor = z.output<typeof LatestColorSchema>;

/** Upstream's `latestColor.attribute`: 11 colors the text, 12 the background. */
const COLOR_ATTRIBUTE = {text: 11, highlight: 12} as const;

/** Upstream's `{attribute, value}` as a latest color, or null when either is missing or unknown. */
function latestColorFrom(raw: unknown): LatestColor | null {
	if (typeof raw !== "object" || raw === null || !("attribute" in raw) || !("value" in raw)) {
		return null;
	}
	const kind =
		raw.attribute === COLOR_ATTRIBUTE.text
			? "text"
			: raw.attribute === COLOR_ATTRIBUTE.highlight
				? "highlight"
				: null;
	const color = Object.entries(COLOR_VALUE).find(([, value]) => value === raw.value)?.[0];
	return kind !== null && isColorName(color) ? {kind, color} : null;
}

function latestColorTo({kind, color}: LatestColor): {attribute: number; value: number} {
	return {attribute: COLOR_ATTRIBUTE[kind], value: COLOR_VALUE[color]};
}

const PreferencesPatchSchema = z
	.object({
		dateFormat: z.string().nullable(),
		timeFormat: z.string().nullable(),
		weekStartDay: z.number().int().min(0).max(6).nullable(),
		slashDiscovered: z.boolean(),
		/** Upstream's `calendar.tooltip_seen`: the calendar onboarding tooltip was dismissed or tried, which shows Today. */
		calendarTooltipSeen: z.boolean(),
		/** Upstream's `emoji.options.selected`: the emoji style (`system`, `noto`), applied as body class `emoji-<name>`. */
		emojiSelected: z.string().nullable(),
		/** Upstream's `ai.embeddingStatus`: unset until "Enable AI", then "requested" until the server indexes the notes ("finished"). */
		aiEmbeddingStatus: z.string().nullable(),
		/** Upstream's `ai.embedding_tooltip_dismissed`: set the first time the ready AI panel opens. */
		aiEmbeddingTooltipDismissed: z.boolean(),
		notesRootId: z.string().nullable(),
		showCompleted: z.boolean(),
		showKeyboardShortcuts: z.boolean(),
		sameColorForLinks: z.boolean(),
		theme: z.string(),
		/** Upstream's account `font` (`system`, `helvetica`, `etBook`, ...), applied as body class `font-<name>`. */
		font: z.string(),
		displayImagePreviewsAsThumbnails: z.boolean(),
		ignoreYoutube: z.boolean(),
		ignoreYtShort: z.boolean(),
		ignoreTwitter: z.boolean(),
		ignoreLoom: z.boolean(),
		unsubscribeFromSummaryEmails: z.boolean(),
		unsubscribeFromCommentsEmails: z.boolean(),
		/** Upstream's `backup_to_dropbox`: the daily Dropbox auto-backup is on (connecting Dropbox happens on workflowy.com). */
		backupToDropbox: z.boolean(),
		weeklyReportOn: z.boolean(),
		latestColor: LatestColorSchema.nullable(),
		/** When the account's change tracking started (upstream's `searchForChangesAfter`), as an ISO date. */
		searchForChangesAfter: z.iso.datetime().nullable(),
	})
	.partial()
	.strict();

/** The full preferences: every patch field present, with `theme` and `font` null when unset. */
export const PreferencesSchema = z.strictObject({
	...PreferencesPatchSchema.required().omit({theme: true, font: true}).shape,
	theme: z.string().nullable(),
	font: z.string().nullable(),
	/**
	 * Upstream's `changelog.read.<id>` (read-only parity data): which of upstream's What's New entries were read, or
	 * null when none were ever set. Our own entries' read state is `/api/v1/whats-new`, never this key.
	 */
	changelogRead: z.record(z.string(), z.boolean()).nullable(),
	/** The signed-in account's name and email (read-only), null unless both are known. */
	account: z.strictObject({username: z.string(), email: z.string()}).nullable(),
	/** Upstream's `settings.mfa` (read-only; turning it on or off happens on workflowy.com), null when the account has none. */
	mfa: z.strictObject({enabled: z.boolean()}).nullable(),
});

type Preferences = z.output<typeof PreferencesSchema>;

const KEYS = [
	"dateFormat",
	"timeFormat",
	"weekStartDay",
	"slashDiscovered",
	"calendarTooltipSeen",
	"emojiSelected",
	"aiEmbeddingStatus",
	"aiEmbeddingTooltipDismissed",
	"notesRootId",
	"weeklyReportOn",
] as const;

/** Each root-metadata preference's path. */
const PATHS: Record<(typeof KEYS)[number], string[]> = {
	dateFormat: ["dateFormat"],
	timeFormat: ["timeFormat"],
	weekStartDay: ["weekStartDay"],
	slashDiscovered: ["slash", "discovered"],
	calendarTooltipSeen: ["calendar", "tooltip_seen"],
	emojiSelected: ["emoji", "options", "selected"],
	aiEmbeddingStatus: ["ai", "embeddingStatus"],
	aiEmbeddingTooltipDismissed: ["ai", "embedding_tooltip_dismissed"],
	notesRootId: ["notesRootId"],
	weeklyReportOn: ["weekly-report", "on"],
};

/** Upstream's `WF.CoreKv` `latestColor`, kept whole in root metadata. */
const LATEST_COLOR_PATH = ["latestColor"];

/** Upstream's `WF.CoreKv` `changelog.read`: one boolean per What's New entry id. */
const CHANGELOG_READ_PATH = ["changelog", "read"];

/** The stored read flags, keeping only booleans, or null when `changelog.read` is not an object. */
function changelogReadFrom(raw: unknown): Record<string, boolean> | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	return Object.fromEntries(
		Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
	);
}

/** Upstream's `WF.CoreKv` `searchForChangesAfter`: a client timestamp (whole seconds since the join date). */
const SEARCH_FOR_CHANGES_AFTER_PATH = ["searchForChangesAfter"];

/** A stored client timestamp as an ISO date, or null when it is not a number. */
async function searchForChangesAfterFrom(adapter: AccountState, raw: unknown): Promise<string | null> {
	if (typeof raw !== "number") {
		return null;
	}
	const {joinedAt} = await adapter.getAccount();
	return new Date(joinedAt.getTime() + raw * 1000).toISOString();
}

/** Upstream's `getClientTimestampForTimestamp`: whole seconds from the join date to `iso`. */
async function searchForChangesAfterTo(adapter: AccountState, iso: string): Promise<number> {
	const {joinedAt} = await adapter.getAccount();
	return Math.floor((Date.parse(iso) - joinedAt.getTime()) / 1000);
}

/** Flag preferences kept in upstream's account settings rather than root metadata. */
const SETTINGS = {
	showCompleted: "show_completed",
	showKeyboardShortcuts: "show_keyboard_shortcuts",
	sameColorForLinks: "same_color_for_links",
	displayImagePreviewsAsThumbnails: "display_image_previews_as_thumbnails",
	ignoreYoutube: "ignore_youtube",
	ignoreYtShort: "ignore_yt_short",
	ignoreTwitter: "ignore_twitter",
	ignoreLoom: "ignore_loom",
	unsubscribeFromSummaryEmails: "unsubscribe_from_summary_emails",
	unsubscribeFromCommentsEmails: "unsubscribe_from_comments_emails",
	backupToDropbox: "backup_to_dropbox",
} as const satisfies Record<string, ServerSetting>;

const FLAG_KEYS = [
	"showCompleted",
	"showKeyboardShortcuts",
	"sameColorForLinks",
	"displayImagePreviewsAsThumbnails",
	"ignoreYoutube",
	"ignoreYtShort",
	"ignoreTwitter",
	"ignoreLoom",
	"unsubscribeFromSummaryEmails",
	"unsubscribeFromCommentsEmails",
	"backupToDropbox",
] as const;

/** The server-saved settings that are strings rather than yes/no flags. */
const STRING_SETTINGS = {theme: "theme", font: "font"} as const satisfies Record<string, ServerSetting>;

/** Upstream sends flags as `"yes"`/`"no"`; the adapter caches a written flag as a boolean. */
function asFlag(value: unknown): boolean {
	return value === true || value === "yes";
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Upstream's `settings.mfa` object (a cached row decodes to `{enabled}`), or null when absent. */
function mfaFrom(raw: unknown): {enabled: boolean} | null {
	return typeof raw === "object" && raw !== null && "enabled" in raw ? {enabled: asFlag(raw.enabled)} : null;
}

/** Read the preferences, treating missing or mistyped values as null (false for the flag). */
async function readPreferences(adapter: AccountState): Promise<Preferences> {
	const [
		rootValues,
		latestColor,
		searchForChangesAfter,
		flagValues,
		theme,
		font,
		username,
		email,
		mfa,
		changelogRead,
	] = await Promise.all([
		Promise.all(KEYS.map(async (key) => adapter.getRootMeta(PATHS[key]))),
		adapter.getRootMeta(LATEST_COLOR_PATH),
		adapter.getRootMeta(SEARCH_FOR_CHANGES_AFTER_PATH).then(async (raw) => searchForChangesAfterFrom(adapter, raw)),
		Promise.all(FLAG_KEYS.map(async (key) => adapter.getSetting(SETTINGS[key]))),
		adapter.getSetting(STRING_SETTINGS.theme),
		adapter.getSetting(STRING_SETTINGS.font),
		adapter.getSetting("username"),
		adapter.getSetting("email"),
		adapter.getSetting("mfa"),
		adapter.getRootMeta(CHANGELOG_READ_PATH),
	]);
	const root = Object.fromEntries(KEYS.map((key, index) => [key, rootValues[index]]));
	const flag = (key: (typeof FLAG_KEYS)[number]): boolean => asFlag(flagValues[FLAG_KEYS.indexOf(key)]);
	const name = asString(username);
	const address = asString(email);
	return {
		dateFormat: asString(root.dateFormat),
		timeFormat: asString(root.timeFormat),
		weekStartDay: typeof root.weekStartDay === "number" ? root.weekStartDay : null,
		slashDiscovered: root.slashDiscovered === true,
		calendarTooltipSeen: root.calendarTooltipSeen === true,
		emojiSelected: asString(root.emojiSelected),
		aiEmbeddingStatus: asString(root.aiEmbeddingStatus),
		aiEmbeddingTooltipDismissed: root.aiEmbeddingTooltipDismissed === true,
		notesRootId: asString(root.notesRootId),
		weeklyReportOn: root.weeklyReportOn === true,
		latestColor: latestColorFrom(latestColor),
		searchForChangesAfter,
		showCompleted: flag("showCompleted"),
		showKeyboardShortcuts: flag("showKeyboardShortcuts"),
		sameColorForLinks: flag("sameColorForLinks"),
		displayImagePreviewsAsThumbnails: flag("displayImagePreviewsAsThumbnails"),
		ignoreYoutube: flag("ignoreYoutube"),
		ignoreYtShort: flag("ignoreYtShort"),
		ignoreTwitter: flag("ignoreTwitter"),
		ignoreLoom: flag("ignoreLoom"),
		unsubscribeFromSummaryEmails: flag("unsubscribeFromSummaryEmails"),
		unsubscribeFromCommentsEmails: flag("unsubscribeFromCommentsEmails"),
		backupToDropbox: flag("backupToDropbox"),
		theme: asString(theme),
		font: asString(font),
		account: name !== null && address !== null ? {username: name, email: address} : null,
		mfa: mfaFrom(mfa),
		changelogRead: changelogReadFrom(changelogRead),
	};
}

/** The account-global preferences. */
export const preferencesGet = defineOp({
	input: z.object({}),
	output: PreferencesSchema,
	async run(ctx) {
		return withAccountState(ctx, async (state) => ok(await readPreferences(state)));
	},
});

/** Applies any subset of preferences (a `null` removes one) and answers the full preferences. */
export const preferencesPatch = defineOp({
	input: z.object({patch: PreferencesPatchSchema}),
	output: PreferencesSchema,
	async run(ctx, {patch}) {
		return withAccountState(ctx, async (adapter) => {
			const previousWeekStartDay =
				patch.weekStartDay === undefined ? undefined : await adapter.getRootMeta(PATHS.weekStartDay);
			const changes: Parameters<AccountState["setRootMetaValues"]>[0] = KEYS.filter((key) => key in patch).map(
				(key) => ({
					path: PATHS[key],
					value: patch[key] ?? undefined,
				}),
			);
			if (patch.latestColor !== undefined) {
				changes.push({
					path: LATEST_COLOR_PATH,
					value: patch.latestColor === null ? undefined : latestColorTo(patch.latestColor),
				});
			}
			if (patch.searchForChangesAfter !== undefined) {
				changes.push({
					path: SEARCH_FOR_CHANGES_AFTER_PATH,
					value:
						patch.searchForChangesAfter === null
							? undefined
							: await searchForChangesAfterTo(adapter, patch.searchForChangesAfter),
				});
			}
			const settings: [ServerSetting, string | boolean][] = [
				...FLAG_KEYS.flatMap((key): [ServerSetting, boolean][] => {
					const value = patch[key];
					return value === undefined ? [] : [[SETTINGS[key], value]];
				}),
				...(patch.theme === undefined ? [] : [[STRING_SETTINGS.theme, patch.theme] as [ServerSetting, string]]),
				...(patch.font === undefined ? [] : [[STRING_SETTINGS.font, patch.font] as [ServerSetting, string]]),
			];
			if (adapter instanceof LocalAccount) {
				// One unit of work: separate writes would replace the settings row within its own millisecond.
				adapter.change(changes, settings);
				return ok(await readPreferences(adapter));
			}
			if (changes.length > 0) {
				await adapter.setRootMetaValues(changes);
			}
			for (const [name, value] of settings) {
				await adapter.setSetting(name, value);
			}
			// Re-laying out the calendar's weeks writes through the internal API; without one the layout stays as it is.
			if (
				patch.weekStartDay !== undefined &&
				(patch.weekStartDay ?? undefined) !== (previousWeekStartDay ?? undefined)
			) {
				await reapplyWeekLayout(ctx, adapter);
			}
			return ok(await readPreferences(adapter));
		});
	},
});
