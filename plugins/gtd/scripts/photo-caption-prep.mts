#!/usr/bin/env node
// Stage recent uncaptioned favorite photos for the "Add captions to favorite
// photos" review item, so Claude can Read every image before proposing a caption.
//
// Favorites whose originals are on disk convert straight to a viewable JPEG.
// iCloud-optimized favorites (no local original) are exported through Photos,
// which is slow (minutes), so launch this in the background before the walk
// rather than skipping them.
//
// Usage:
//   node plugins/gtd/scripts/photo-caption-prep.mts [--days 14] [--out .llm/gtd/photo-captions] [--workflowy-db outlinedb.sqlite]
//   node plugins/gtd/scripts/photo-caption-prep.mts --count-only [--days 14]
//   node plugins/gtd/scripts/photo-caption-prep.mts --since YYYY-MM-DD [--sample 3] [--out .llm/gtd/status-photos]
//   node plugins/gtd/scripts/photo-caption-prep.mts --since YYYY-MM-DD --count-only
//   node plugins/gtd/scripts/photo-caption-prep.mts --since YYYY-MM-DD --write-captions captions.json
//
// --since is the "Add photos to Status" mode: every photo taken since local
// midnight of the date, grouped by Photos moment (the app's event groups). One
// caption is chosen per group and written to every photo in it, and only the
// group's favorites are later posted to Workflowy, so more gets captioned than
// posted. It writes <out>/groups.json; each group lists all uuids, its
// favorites, existing captions (good seeds), that day's journalSeeds, and view
// JPEGs for every favorite plus --sample evenly spaced other photos. Favorites
// also get a full-size postPath JPEG for the Workflowy upload. Prints
//   groups=<n> uncaptioned=<n> favorites=<n> viewable=<n> unviewable=<n> manifest=<path>
// --count-only prints groups=<n> uncaptioned=<n> favorites=<n>.
// --write-captions reads [{"id": "<group id>", "caption": "..."}] and the
// groups.json from <out>, writes the caption to every photo of each group
// through Photos with read-back, and prints written=<n> failed=<n>.
//
// Each manifest photo carries journalSeeds: that day's journal entries from the
// Workflowy cache with emoji, @ signs, and trailing tags stripped, so proposed
// captions start from the user's own wording.
//
// A favorite with a Workflowy entry whose <time> matches its exact minute is
// already journaled, so it counts as captioned: it is left out of the manifest
// and of remaining. This is checked against the cache per photo every run.
//
// Full run writes <out>/manifest.json and prints
//   total=<n> viewable=<n> unviewable=<n> journaled=<n> manifest=<path>
// --count-only re-reads a fresh DB copy and prints remaining=<n> journaled=<n>:
// favorites in the window with neither a Photos caption nor a journal entry.

import {spawnSync} from "node:child_process";
import {constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {arrayField, expectArray, expectObject, numberField, parseJson, readJsonFile, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface Favorite
{
	uuid: string;
	created: string;
	directory: string;
	filename: string;
	originalFilename: string;
}

type ManifestFavorite = Pick<Favorite, "uuid" | "created" | "originalFilename">;

export interface LocalFavorite extends Favorite
{
	originalPath: string;
}

export interface PhotoFaces
{
	named: string[];
	unnamed: number;
}

export interface FaceRow
{
	uuid: string;
	name: string;
}

export interface JournalRow
{
	day: string;
	entry: string | null;
}

export interface NameRow
{
	name: string | null;
}

export interface ManifestEntry
{
	uuid: string;
	created: string;
	date: string;
	journalSeeds: string[];
	originalFilename: string;
	source: "local" | "icloud";
	viewPath: string | null;
	faces: PhotoFaces;
	facesSummary: string;
}

export interface Manifest
{
	total: number;
	viewable: number;
	unviewable: number;
	photos: ManifestEntry[];
}

export interface EventPhotoRow extends Favorite
{
	favorite: boolean;
	caption: string;
	moment: string;
	place: string;
}

export interface EventGroup
{
	id: string;
	place: string;
	date: string;
	start: string;
	end: string;
	photos: EventPhotoRow[];
	favorites: string[];
	captions: string[];
	uncaptioned: number;
}

export interface GroupView
{
	uuid: string;
	favorite: boolean;
	viewPath: string | null;
	postPath: string | null;
	faces: PhotoFaces;
	facesSummary: string;
}

export interface GroupManifestEntry
{
	id: string;
	place: string;
	date: string;
	start: string;
	end: string;
	photoCount: number;
	uuids: string[];
	favorites: string[];
	captions: string[];
	uncaptioned: number;
	journalSeeds: string[];
	views: GroupView[];
}

export interface CaptionChoice
{
	id: string;
	caption: string;
}

export interface CaptionTarget
{
	caption: string;
	uuids: string[];
}

interface Args
{
	days: number;
	out: string | null;
	countOnly: boolean;
	workflowyDb: string;
	since: string | null;
	sample: number;
	writeCaptions: string | null;
}

const UUID_RE = /^[0-9A-Fa-f-]+$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/u;
const MINUTE_TIME_RE =
	/<time startYear="(\d+)" startMonth="(\d+)" startDay="(\d+)" startHour="(\d+)" startMinute="(\d+)">/gu;
const CURRENT = "system_to=9007199254740991";
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D/gu;
const ENTITIES: Record<string, string> =
{
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

export function favoritesQuery(days: unknown): string
{
	if (typeof days !== "number" || !Number.isInteger(days) || days < 1)
	{
		throw new Error(`days must be a positive integer, got ${String(days)}`);
	}
	return (
		"SELECT A.ZUUID AS uuid, datetime(A.ZDATECREATED+978307200,'unixepoch','localtime') AS created, A.ZDIRECTORY AS directory, A.ZFILENAME AS filename, COALESCE(B.ZORIGINALFILENAME,'') AS originalFilename" +
		" FROM ZASSET A LEFT JOIN ZADDITIONALASSETATTRIBUTES B ON A.Z_PK=B.ZASSET" +
		" WHERE A.ZFAVORITE=1 AND A.ZTRASHEDSTATE=0 AND A.ZHIDDEN=0 AND A.ZKIND=0" +
		` AND A.ZDATECREATED > strftime('%s','now','-${days} days')-978307200` +
		" AND COALESCE(B.ZTITLE,'')='' AND COALESCE(B.ZACCESSIBILITYDESCRIPTION,'')=''" +
		" ORDER BY A.ZDATECREATED DESC;"
	);
}

// Local midnight of `since` to UTC seconds, then to the Apple epoch.
export function eventPhotosQuery(since: string): string
{
	if (!DATE_RE.test(since))
	{
		throw new Error(`Invalid date: ${since}`);
	}
	return (
		"SELECT A.ZUUID AS uuid, datetime(A.ZDATECREATED+978307200,'unixepoch','localtime') AS created, A.ZDIRECTORY AS directory, A.ZFILENAME AS filename, COALESCE(B.ZORIGINALFILENAME,'') AS originalFilename, A.ZFAVORITE AS favorite, COALESCE(B.ZTITLE,'') AS caption, COALESCE(M.ZUUID,'') AS moment, COALESCE(M.ZTITLE,'') AS place" +
		" FROM ZASSET A LEFT JOIN ZADDITIONALASSETATTRIBUTES B ON A.Z_PK=B.ZASSET LEFT JOIN ZMOMENT M ON A.ZMOMENT=M.Z_PK" +
		" WHERE A.ZTRASHEDSTATE=0 AND A.ZHIDDEN=0 AND A.ZKIND=0" +
		` AND A.ZDATECREATED >= strftime('%s','${since}','utc')-978307200` +
		" ORDER BY A.ZDATECREATED;"
	);
}

// Photos assigns each asset to a moment (its event group). A photo Photos has
// not processed yet has no moment, so it stands alone rather than merging with
// other unassigned photos from different events.
export function groupEvents(rows: EventPhotoRow[]): EventGroup[]
{
	const groups = new Map<string, EventGroup>();
	for (const row of rows)
	{
		const id = row.moment || row.uuid;
		let group = groups.get(id);
		if (!group)
		{
			group =
			{
				id,
				place: row.place,
				date: row.created.slice(0, 10),
				start: row.created,
				end: row.created,
				photos: [],
				favorites: [],
				captions: [],
				uncaptioned: 0,
			};
			groups.set(id, group);
		}
		group.photos.push(row);
		group.start = row.created < group.start ? row.created : group.start;
		group.end = row.created > group.end ? row.created : group.end;
		group.date = group.start.slice(0, 10);
		if (row.favorite)
		{
			group.favorites.push(row.uuid);
		}
		if (!row.caption)
		{
			group.uncaptioned += 1;
		}
		else if (!group.captions.includes(row.caption))
		{
			group.captions.push(row.caption);
		}
	}
	return [...groups.values()].toSorted((a, b) => a.start.localeCompare(b.start));
}

// iCloud exports take ~10s each, so a 90-photo event shows its favorites plus
// a few evenly spaced others: enough to caption the event, not every frame.
export function pickViewPhotos(group: EventGroup, sample: number): string[]
{
	const others = group.photos.filter((photo) => !photo.favorite);
	const count = Math.min(sample, others.length);
	const picked: string[] = [];
	for (let i = 0; i < count; i++)
	{
		const other = others[Math.floor(((i + 0.5) * others.length) / count)];
		if (other)
		{
			picked.push(other.uuid);
		}
	}
	return [...group.favorites, ...picked];
}

export function captionTargets(
	groups:
	{
		id: string;
		photos:
		{
			uuid: string;
		}[];
	}[],
	choices: CaptionChoice[],
): CaptionTarget[]
{
	const byId = new Map(groups.map((group) => [group.id, group]));
	return choices.map(({id, caption}) =>
	{
		const group = byId.get(id);
		if (!group)
		{
			throw new Error(`Unknown event group: ${id}`);
		}
		const trimmed = caption.trim();
		if (!trimmed)
		{
			throw new Error(`Blank caption for event group ${id}`);
		}
		return {
			caption: trimmed,
			uuids: group.photos.map((photo) => photo.uuid),
		};
	});
}

// The caption and uuids arrive as osascript arguments, so quotes or
// backslashes in a caption can never break or inject into the script.
export function buildCaptionAppleScript(): string[]
{
	return [
		"on run argv",
		"set cap to item 1 of argv",
		"set okCount to 0",
		'tell application "Photos"',
		"repeat with i from 2 to (count of argv)",
		"set u to (item i of argv)",
		"try",
		'set m to media item id (u & "/L0/001")',
		"set name of m to cap",
		"if (name of m) is cap then",
		"set okCount to okCount + 1",
		"else",
		'log ("mismatch " & u)',
		"end if",
		"on error e",
		'log ("failed " & u & ": " & e)',
		"end try",
		"end repeat",
		"end tell",
		"return okCount",
		"end run",
	];
}

export function facesQuery(uuids: string[]): string
{
	for (const uuid of uuids)
	{
		if (!UUID_RE.test(uuid))
		{
			throw new Error(`Invalid uuid: ${uuid}`);
		}
	}
	const list = uuids.map((uuid) => `'${uuid}'`).join(",");
	return (
		"SELECT A.ZUUID AS uuid, COALESCE(NULLIF(P.ZFULLNAME,''),'') AS name" +
		" FROM ZASSET A JOIN ZDETECTEDFACE F ON F.ZASSETFORFACE=A.Z_PK LEFT JOIN ZPERSON P ON F.ZPERSONFORFACE=P.Z_PK" +
		` WHERE A.ZUUID IN (${list});`
	);
}

export function groupFaces(rows: FaceRow[]): Record<string, PhotoFaces>
{
	const byUuid: Record<string, PhotoFaces> = {};
	for (const {uuid, name} of rows)
	{
		const entry = (byUuid[uuid] ??=
		{
			named: [],
			unnamed: 0,
		});
		if (!name)
		{
			entry.unnamed += 1;
		}
		else if (!entry.named.includes(name))
		{
			entry.named.push(name);
		}
	}
	return byUuid;
}

export function facesSummary({named, unnamed}: PhotoFaces): string
{
	if (named.length === 0 && unnamed === 0)
	{
		return "No faces detected.";
	}
	const tagged = `Tagged: ${named.length > 0 ? named.join(", ") : "nobody"}.`;
	if (unnamed === 0)
	{
		return tagged;
	}
	return `${tagged} ${unnamed} untagged face${unnamed === 1 ? "" : "s"}, ready to tag in Photos.`;
}

// Captions should read like the user's own journal, so seed them from that
// day's entry text rather than describing the image.
export function captionSeed(name: string): string
{
	return name
		.replaceAll(/<[^>]*>/gu, "")
		.replaceAll(/&(amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity] ?? entity)
		.replaceAll(EMOJI_RE, "")
		.replaceAll(/[\u2018\u2019]/gu, "'")
		.replaceAll(/[\u201C\u201D]/gu, '"')
		.replace(/(\s*#[\w-]+)+\s*$/u, "")
		.replaceAll(/[@#](?=\w)/gu, "")
		.replaceAll(/\s+'s\b/gu, "'s")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function dayPrefix(date: string): string
{
	const match = DATE_RE.exec(date);
	if (!match)
	{
		throw new Error(`Invalid date: ${date}`);
	}
	const [, year, month, day] = match;
	return `<time startYear="${year}" startMonth="${Number(month)}" startDay="${Number(day)}">`;
}

export function journalQuery(dates: string[]): string
{
	const days = dates.map((date) => `D.name LIKE '${dayPrefix(date)}%'`).join(" OR ");
	return (
		"SELECT D.name AS day, E.name AS entry FROM node_content D" +
		` JOIN node_content E ON E.parent_id=D.id AND E.${CURRENT}` +
		` WHERE D.${CURRENT} AND (${days});`
	);
}

export function groupJournal(rows: JournalRow[]): Record<string, string[]>
{
	const byDate: Record<string, string[]> = {};
	for (const {day, entry} of rows)
	{
		const [, year, month, day2] = /startYear="(\d+)" startMonth="(\d+)" startDay="(\d+)"/u.exec(day) ?? [];
		if (year === undefined || month === undefined || day2 === undefined)
		{
			continue;
		}
		const date = `${year}-${month.padStart(2, "0")}-${day2.padStart(2, "0")}`;
		const seed = captionSeed(entry ?? "");
		const seeds = (byDate[date] ??= []);
		if (seed && !seeds.includes(seed))
		{
			seeds.push(seed);
		}
	}
	return byDate;
}

// The journal seeds and journaled check read the Workflowy cache, so a cache
// older than maxAgeMinutes means entries written since (e.g. in the app) are
// invisible and captions would start from an old version of the notes.
// System times are integer microseconds since the epoch.
export function cacheIsStale(latestSystemFrom: number | null, nowMs: number, maxAgeMinutes: number): boolean
{
	if (latestSystemFrom === null)
	{
		return true;
	}
	return nowMs - latestSystemFrom / 1000 > maxAgeMinutes * 60_000;
}

function refreshStaleCache(workflowyDb: string): void
{
	const [row] = sqliteJson(workflowyDb, "SELECT max(system_from) AS latest FROM node_content;");
	const latest = row ? (numberField(row, "latest") ?? null) : null;
	if (!cacheIsStale(latest, Date.now(), 60))
	{
		return;
	}
	process.stderr.write("Workflowy cache is stale; running cache import-api\n");
	const result = spawnSync(
		"./bin/run.js",
		["cache", "import-api"],
		{
			encoding: "utf8",
			stdio: "inherit",
		},
	);
	if (result.status !== 0)
	{
		throw new Error("cache import-api failed; re-run after fixing the import");
	}
}

function minuteTime(created: string): string
{
	const match = TIMESTAMP_RE.exec(created);
	if (!match)
	{
		throw new Error(`Invalid timestamp: ${created}`);
	}
	const [, year, month, day, hour, minute] = match.map(Number);
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}" startHour="${hour}" startMinute="${minute}">`;
}

// A favorite already journaled in Workflowy (an entry whose <time> matches the
// photo's minute) counts as captioned, so the review never asks about it again.
export function journaledQuery(favorites: Pick<Favorite, "uuid" | "created">[]): string
{
	const times = favorites.map((favorite) => `name LIKE '%${minuteTime(favorite.created)}%'`).join(" OR ");
	return `SELECT name FROM node_content WHERE ${CURRENT} AND (${times});`;
}

export function splitJournaled<F extends Pick<Favorite, "created">>(
	favorites: F[],
	rows: NameRow[],
):
{
	journaled: F[];
	remaining: F[];
}
{
	const times = new Set<string>();
	for (const {name} of rows)
	{
		for (const match of (name ?? "").matchAll(MINUTE_TIME_RE))
		{
			times.add(match[0]);
		}
	}
	const journaled: F[] = [];
	const remaining: F[] = [];
	for (const favorite of favorites)
	{
		(times.has(minuteTime(favorite.created)) ? journaled : remaining).push(favorite);
	}
	return {
		journaled,
		remaining,
	};
}

export function planSources(
	favorites: Favorite[],
	libraryPath: string,
	exists: (path: string) => boolean,
):
{
	local: LocalFavorite[];
	icloud: Favorite[];
}
{
	const local: LocalFavorite[] = [];
	const icloud: Favorite[] = [];
	for (const favorite of favorites)
	{
		const originalPath = join(libraryPath, "originals", favorite.directory, favorite.filename);
		if (exists(originalPath))
		{
			local.push(
				{
					...favorite,
					originalPath,
				},
			);
		}
		else
		{
			icloud.push(favorite);
		}
	}
	return {
		local,
		icloud,
	};
}

// Photos' `whose` filter is lazy; `get` forces the list so `count` and `export`
// see real items (the -1728 rule). Each uuid lands in its own folder because
// Photos names exports IMG_xxxx, which can't be mapped back otherwise.
export function buildExportAppleScript(uuids: string[]): string[]
{
	const ids = uuids.map((uuid) => `"${uuid}"`).join(", ");
	return [
		"on run argv",
		"set outDir to item 1 of argv",
		`set ids to {${ids}}`,
		"set okCount to 0",
		'tell application "Photos"',
		"repeat with i in ids",
		"set u to (i as string)",
		"try",
		"with timeout of 600 seconds",
		'set m to (get every media item whose id is (u & "/L0/001"))',
		"if (count of m) > 0 then",
		'export m to POSIX file (outDir & "/" & u)',
		"set okCount to okCount + 1",
		'log ("exported " & u)',
		"else",
		'log ("missing " & u)',
		"end if",
		"end timeout",
		"on error e",
		'log ("failed " & u & ": " & e)',
		"end try",
		"end repeat",
		"end tell",
		"return okCount",
		"end run",
	];
}

export function buildManifest({
	local,
	icloud,
	views,
	faces,
	journal,
}: {
	local: ManifestFavorite[];
	icloud: ManifestFavorite[];
	views: Record<string, string>;
	faces: Record<string, PhotoFaces>;
	journal: Record<string, string[]>;
}): Manifest
{
	const toEntry = (favorite: ManifestFavorite, source: "local" | "icloud"): ManifestEntry =>
	{
		const photoFaces = faces[favorite.uuid] ??
		{
			named: [],
			unnamed: 0,
		};
		const date = favorite.created.slice(0, 10);
		return {
			uuid: favorite.uuid,
			created: favorite.created,
			date,
			journalSeeds: journal[date] ?? [],
			originalFilename: favorite.originalFilename,
			source,
			viewPath: views[favorite.uuid] ?? null,
			faces: photoFaces,
			facesSummary: facesSummary(photoFaces),
		};
	};
	const photos = [...local.map((f) => toEntry(f, "local")), ...icloud.map((f) => toEntry(f, "icloud"))];
	const viewable = photos.filter((p) => p.viewPath !== null && p.viewPath !== "").length;
	return {
		total: photos.length,
		viewable,
		unviewable: photos.length - viewable,
		photos,
	};
}

function parseArgs(argv: string[]): Args
{
	const args: Args =
	{
		days: 14,
		out: null,
		countOnly: false,
		workflowyDb: "outlinedb.sqlite",
		since: null,
		sample: 3,
		writeCaptions: null,
	};
	for (let i = 0; i < argv.length; i++)
	{
		if (argv[i] === "--days")
		{
			args.days = Number(argv[++i]);
		}
		else if (argv[i] === "--workflowy-db")
		{
			args.workflowyDb = argv[++i] ?? args.workflowyDb;
		}
		else if (argv[i] === "--out")
		{
			args.out = argv[++i] ?? args.out;
		}
		else if (argv[i] === "--since")
		{
			args.since = argv[++i] ?? null;
		}
		else if (argv[i] === "--sample")
		{
			args.sample = Number(argv[++i]);
		}
		else if (argv[i] === "--write-captions")
		{
			args.writeCaptions = argv[++i] ?? null;
		}
		else if (argv[i] === "--count-only")
		{
			args.countOnly = true;
		}
		else
		{
			throw new Error(`Unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

function toFavorite(row: JsonObject): Favorite
{
	return {
		uuid: stringField(row, "uuid") ?? "",
		created: stringField(row, "created") ?? "",
		directory: stringField(row, "directory") ?? "",
		filename: stringField(row, "filename") ?? "",
		originalFilename: stringField(row, "originalFilename") ?? "",
	};
}

const toEventPhotoRow = (row: JsonObject): EventPhotoRow => (
{
	...toFavorite(row),
	favorite: numberField(row, "favorite") === 1,
	caption: stringField(row, "caption") ?? "",
	moment: stringField(row, "moment") ?? "",
	place: stringField(row, "place") ?? "",
});

const toFaceRow = (row: JsonObject): FaceRow => (
{
	uuid: stringField(row, "uuid") ?? "",
	name: stringField(row, "name") ?? "",
});

const toJournalRow = (row: JsonObject): JournalRow => (
{
	day: stringField(row, "day") ?? "",
	entry: stringField(row, "entry") ?? null,
});

const toNameRow = (row: JsonObject): NameRow => (
{
	name: stringField(row, "name") ?? null,
});

const DB_SUFFIXES = ["", "-wal", "-shm"];

function removeDatabaseCopy(target: string): void
{
	for (const suffix of DB_SUFFIXES)
	{
		rmSync(
			target + suffix,
			{
				force: true,
			},
		);
	}
}

// COPYFILE_FICLONE makes APFS clone the multi-GB DB (copy-on-write, near-zero space),
// falling back to a real copy where cloning is unsupported.
function copyDatabase(libraryPath: string, outDir: string): string
{
	const target = join(outDir, "photos-ro.sqlite");
	removeDatabaseCopy(target);
	const source = join(libraryPath, "database", "Photos.sqlite");
	for (const suffix of DB_SUFFIXES)
	{
		if (suffix === "" || existsSync(source + suffix))
		{
			copyFileSync(source + suffix, target + suffix, constants.COPYFILE_FICLONE);
		}
	}
	return target;
}

export function withDatabaseCopy<T>(libraryPath: string, outDir: string, fn: (dbPath: string) => T): T
{
	const dbPath = copyDatabase(libraryPath, outDir);
	try
	{
		return fn(dbPath);
	}
	finally
	{
		removeDatabaseCopy(dbPath);
	}
}

function sqliteJson(dbPath: string, sql: string): JsonObject[]
{
	const result = spawnSync(
		"sqlite3",
		["-readonly", "-json", dbPath, sql],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0)
	{
		throw new Error(`sqlite3 failed: ${result.stderr}`);
	}
	return result.stdout.trim()
		? expectArray(parseJson(result.stdout), "sqlite3 output").map((row) => expectObject(row, "sqlite3 row"))
		: [];
}

/**
 * The sips arguments for a 900px view JPEG. sips carries the source's EXIF orientation flag
 * into the JPEG and browsers honor it, so rotating the pixels too would show it sideways.
 */
export function viewJpegArgs(source: string, viewPath: string): string[]
{
	return ["-s", "format", "jpeg", "-Z", "900", source, "--out", viewPath];
}

export function postJpegArgs(source: string, postPath: string): string[]
{
	return ["-s", "format", "jpeg", source, "--out", postPath];
}

function toViewJpeg(source: string, viewPath: string, argsFor = viewJpegArgs): boolean
{
	const result = spawnSync(
		"sips",
		argsFor(source, viewPath),
		{
			encoding: "utf8",
		},
	);
	return result.status === 0 && existsSync(viewPath);
}

function main(): void
{
	const args = parseArgs(process.argv.slice(2));
	const libraryPath = join(homedir(), "Pictures", "Photos Library.photoslibrary");
	const outDir = resolve(args.out ?? (args.since === null ? ".llm/gtd/photo-captions" : ".llm/gtd/status-photos"));
	mkdirSync(
		outDir,
		{
			recursive: true,
		},
	);
	if (args.since !== null && args.writeCaptions !== null)
	{
		writeCaptions(args.writeCaptions, outDir);
		return;
	}
	withDatabaseCopy(libraryPath, outDir, (dbPath) =>
		args.since === null
			? run(args, libraryPath, outDir, dbPath)
			: runEvents(args, args.since, libraryPath, outDir, dbPath),
	);
}

function resetDir(dir: string): void
{
	rmSync(
		dir,
		{
			recursive: true,
			force: true,
		},
	);
	mkdirSync(
		dir,
		{
			recursive: true,
		},
	);
}

// Converts local originals straight to view JPEGs and exports iCloud-only
// photos through Photos first. Photos in postUuids also get a full-size JPEG.
function stagePhotos(
	photos: Favorite[],
	libraryPath: string,
	outDir: string,
	postUuids: Set<string>,
):
{
	local: LocalFavorite[];
	icloud: Favorite[];
	views: Record<string, string>;
	posts: Record<string, string>;
}
{
	const viewDir = join(outDir, "view");
	const postDir = join(outDir, "post");
	const exportDir = join(outDir, "export");
	resetDir(viewDir);
	resetDir(exportDir);
	if (postUuids.size > 0)
	{
		resetDir(postDir);
	}
	const views: Record<string, string> = {};
	const posts: Record<string, string> = {};
	const convert = (uuid: string, source: string): void =>
	{
		const viewPath = join(viewDir, `${uuid}.jpg`);
		if (toViewJpeg(source, viewPath))
		{
			views[uuid] = viewPath;
		}
		const postPath = join(postDir, `${uuid}.jpg`);
		if (postUuids.has(uuid) && toViewJpeg(source, postPath, postJpegArgs))
		{
			posts[uuid] = postPath;
		}
	};

	const {local, icloud} = planSources(photos, libraryPath, existsSync);
	for (const photo of local)
	{
		convert(photo.uuid, photo.originalPath);
	}

	if (icloud.length > 0)
	{
		for (const photo of icloud)
		{
			mkdirSync(
				join(exportDir, photo.uuid),
				{
					recursive: true,
				},
			);
		}
		const script = buildExportAppleScript(icloud.map((f) => f.uuid)).flatMap((line) => ["-e", line]);
		const result = spawnSync(
			"osascript",
			[...script, exportDir],
			{
				encoding: "utf8",
			},
		);
		writeFileSync(
			join(outDir, "export.log"),
			`${result.stderr}exit=${result.status} exported=${result.stdout.trim()}\n`,
		);
		for (const photo of icloud)
		{
			const [file] = readdirSync(join(exportDir, photo.uuid));
			if (file)
			{
				convert(photo.uuid, join(exportDir, photo.uuid, file));
			}
		}
	}
	return {
		local,
		icloud,
		views,
		posts,
	};
}

function run(args: Args, libraryPath: string, outDir: string, dbPath: string): void
{
	const workflowyDb = resolve(args.workflowyDb);
	if (!existsSync(workflowyDb))
	{
		throw new Error(`Workflowy cache not found: ${workflowyDb}`);
	}
	refreshStaleCache(workflowyDb);
	const candidates = sqliteJson(dbPath, favoritesQuery(args.days)).map(toFavorite);
	const empty:
	{
		journaled: Favorite[];
		remaining: Favorite[];
	} =
	{
		journaled: [],
		remaining: [],
	};
	const {journaled, remaining: favorites} =
		candidates.length > 0
			? splitJournaled(candidates, sqliteJson(workflowyDb, journaledQuery(candidates)).map(toNameRow))
			: empty;
	if (args.countOnly)
	{
		process.stdout.write(`remaining=${favorites.length} journaled=${journaled.length}\n`);
		return;
	}

	const {local, icloud, views} = stagePhotos(favorites, libraryPath, outDir, new Set());
	const faces =
		favorites.length > 0
			? groupFaces(sqliteJson(dbPath, facesQuery(favorites.map((f) => f.uuid))).map(toFaceRow))
			: {};
	const dates = [...new Set(favorites.map((f) => f.created.slice(0, 10)))];
	const journal =
		dates.length > 0 ? groupJournal(sqliteJson(workflowyDb, journalQuery(dates)).map(toJournalRow)) : {};
	const manifest = buildManifest(
		{
			local,
			icloud,
			views,
			faces,
			journal,
		},
	);
	const manifestPath = join(outDir, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	process.stdout.write(
		`total=${manifest.total} viewable=${manifest.viewable} unviewable=${manifest.unviewable} journaled=${journaled.length} manifest=${manifestPath}\n`,
	);
}

function runEvents(args: Args, since: string, libraryPath: string, outDir: string, dbPath: string): void
{
	if (!Number.isInteger(args.sample) || args.sample < 0)
	{
		throw new Error(`--sample must be a non-negative integer, got ${String(args.sample)}`);
	}
	const groups = groupEvents(sqliteJson(dbPath, eventPhotosQuery(since)).map(toEventPhotoRow));
	const uncaptioned = groups.filter((group) => group.uncaptioned > 0).length;
	const favoriteCount = groups.reduce((sum, group) => sum + group.favorites.length, 0);
	if (args.countOnly)
	{
		process.stdout.write(`groups=${groups.length} uncaptioned=${uncaptioned} favorites=${favoriteCount}\n`);
		return;
	}

	const workflowyDb = resolve(args.workflowyDb);
	if (!existsSync(workflowyDb))
	{
		throw new Error(`Workflowy cache not found: ${workflowyDb}`);
	}
	refreshStaleCache(workflowyDb);
	const picks = new Map(groups.map((group) => [group.id, pickViewPhotos(group, args.sample)]));
	const pickedUuids = new Set([...picks.values()].flat());
	const toStage = groups.flatMap((group) => group.photos).filter((photo) => pickedUuids.has(photo.uuid));
	const favorites = new Set(groups.flatMap((group) => group.favorites));
	const {views, posts} = stagePhotos(toStage, libraryPath, outDir, favorites);
	const faces =
		pickedUuids.size > 0 ? groupFaces(sqliteJson(dbPath, facesQuery([...pickedUuids])).map(toFaceRow)) : {};
	const dates = [...new Set(groups.map((group) => group.date))];
	const journal =
		dates.length > 0 ? groupJournal(sqliteJson(workflowyDb, journalQuery(dates)).map(toJournalRow)) : {};
	const entries: GroupManifestEntry[] = groups.map((group) => (
	{
		id: group.id,
		place: group.place,
		date: group.date,
		start: group.start,
		end: group.end,
		photoCount: group.photos.length,
		uuids: group.photos.map((photo) => photo.uuid),
		favorites: group.favorites,
		captions: group.captions,
		uncaptioned: group.uncaptioned,
		journalSeeds: journal[group.date] ?? [],
		views: (picks.get(group.id) ?? []).map((uuid) =>
		{
			const photoFaces = faces[uuid] ??
			{
				named: [],
				unnamed: 0,
			};
			return {
				uuid,
				favorite: favorites.has(uuid),
				viewPath: views[uuid] ?? null,
				postPath: posts[uuid] ?? null,
				faces: photoFaces,
				facesSummary: facesSummary(photoFaces),
			};
		}),
	}));
	const viewable = Object.keys(views).length;
	const manifestPath = join(outDir, "groups.json");
	writeFileSync(manifestPath, `${JSON.stringify(entries, null, "\t")}\n`);
	process.stdout.write(
		`groups=${groups.length} uncaptioned=${uncaptioned} favorites=${favoriteCount} viewable=${viewable} unviewable=${pickedUuids.size - viewable} manifest=${manifestPath}\n`,
	);
}

function writeCaptions(choicesPath: string, outDir: string): void
{
	const groups = expectArray(readJsonFile(join(outDir, "groups.json")), "groups.json").map((value) =>
	{
		const group = expectObject(value, "group");
		return {
			id: stringField(group, "id") ?? "",
			photos: arrayField(group, "uuids").map((uuid) => (
			{
				uuid: String(uuid),
			})),
		};
	});
	const choices = expectArray(readJsonFile(choicesPath), "captions").map((value) =>
	{
		const choice = expectObject(value, "caption choice");
		return {
			id: stringField(choice, "id") ?? "",
			caption: stringField(choice, "caption") ?? "",
		};
	});
	const script = buildCaptionAppleScript().flatMap((line) => ["-e", line]);
	let written = 0;
	let failed = 0;
	for (const {caption, uuids} of captionTargets(groups, choices))
	{
		const result = spawnSync(
			"osascript",
			[...script, caption, ...uuids],
			{
				encoding: "utf8",
			},
		);
		process.stderr.write(result.stderr);
		const ok = result.status === 0 ? Number(result.stdout.trim()) : 0;
		written += ok;
		failed += uuids.length - ok;
	}
	process.stdout.write(`written=${written} failed=${failed}\n`);
}

if (isMain(import.meta.url))
{
	main();
}
