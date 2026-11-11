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
import {expectArray, expectObject, parseJson, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface Favorite {
	uuid: string;
	created: string;
	directory: string;
	filename: string;
	originalFilename: string;
	/** EXIF orientation from Photos (1 = upright, 3/6/8 = rotated); 0 when unknown. */
	orientation: number;
}

type ManifestFavorite = Pick<Favorite, "uuid" | "created" | "originalFilename">;

export interface LocalFavorite extends Favorite {
	originalPath: string;
}

export interface PhotoFaces {
	named: string[];
	unnamed: number;
}

export interface FaceRow {
	uuid: string;
	name: string;
}

export interface JournalRow {
	day: string;
	entry: string | null;
}

export interface NameRow {
	name: string | null;
}

export interface ManifestEntry {
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

export interface Manifest {
	total: number;
	viewable: number;
	unviewable: number;
	photos: ManifestEntry[];
}

interface Args {
	days: number;
	out: string;
	countOnly: boolean;
	workflowyDb: string;
}

const UUID_RE = /^[0-9A-Fa-f-]+$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/u;
const MINUTE_TIME_RE =
	/<time startYear="(\d+)" startMonth="(\d+)" startDay="(\d+)" startHour="(\d+)" startMinute="(\d+)">/gu;
const CURRENT = "system_to='9999-12-31 23:59:59'";
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D/gu;
const ENTITIES: Record<string, string> = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"};

export function favoritesQuery(days: unknown): string {
	if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
		throw new Error(`days must be a positive integer, got ${String(days)}`);
	}
	return (
		"SELECT A.ZUUID AS uuid, datetime(A.ZDATECREATED+978307200,'unixepoch','localtime') AS created, A.ZDIRECTORY AS directory, A.ZFILENAME AS filename, COALESCE(B.ZORIGINALFILENAME,'') AS originalFilename, A.ZORIENTATION AS orientation" +
		" FROM ZASSET A LEFT JOIN ZADDITIONALASSETATTRIBUTES B ON A.Z_PK=B.ZASSET" +
		" WHERE A.ZFAVORITE=1 AND A.ZTRASHEDSTATE=0 AND A.ZHIDDEN=0 AND A.ZKIND=0" +
		` AND A.ZDATECREATED > strftime('%s','now','-${days} days')-978307200` +
		" AND COALESCE(B.ZTITLE,'')='' AND COALESCE(B.ZACCESSIBILITYDESCRIPTION,'')=''" +
		" ORDER BY A.ZDATECREATED DESC;"
	);
}

export function facesQuery(uuids: string[]): string {
	for (const uuid of uuids) {
		if (!UUID_RE.test(uuid)) {
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

export function groupFaces(rows: FaceRow[]): Record<string, PhotoFaces> {
	const byUuid: Record<string, PhotoFaces> = {};
	for (const {uuid, name} of rows) {
		const entry = (byUuid[uuid] ??= {named: [], unnamed: 0});
		if (!name) {
			entry.unnamed += 1;
		} else if (!entry.named.includes(name)) {
			entry.named.push(name);
		}
	}
	return byUuid;
}

export function facesSummary({named, unnamed}: PhotoFaces): string {
	if (named.length === 0 && unnamed === 0) {
		return "No faces detected.";
	}
	const tagged = `Tagged: ${named.length > 0 ? named.join(", ") : "nobody"}.`;
	if (unnamed === 0) {
		return tagged;
	}
	return `${tagged} ${unnamed} untagged face${unnamed === 1 ? "" : "s"}, ready to tag in Photos.`;
}

// Captions should read like the user's own journal, so seed them from that
// day's entry text rather than describing the image.
export function captionSeed(name: string): string {
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

function dayPrefix(date: string): string {
	const match = DATE_RE.exec(date);
	if (!match) {
		throw new Error(`Invalid date: ${date}`);
	}
	const [, year, month, day] = match;
	return `<time startYear="${year}" startMonth="${Number(month)}" startDay="${Number(day)}">`;
}

export function journalQuery(dates: string[]): string {
	const days = dates.map((date) => `D.name LIKE '${dayPrefix(date)}%'`).join(" OR ");
	return (
		"SELECT D.name AS day, E.name AS entry FROM node_content D" +
		` JOIN node_content E ON E.parent_id=D.id AND E.${CURRENT}` +
		` WHERE D.${CURRENT} AND (${days});`
	);
}

export function groupJournal(rows: JournalRow[]): Record<string, string[]> {
	const byDate: Record<string, string[]> = {};
	for (const {day, entry} of rows) {
		const [, year, month, day2] = /startYear="(\d+)" startMonth="(\d+)" startDay="(\d+)"/u.exec(day) ?? [];
		if (year === undefined || month === undefined || day2 === undefined) {
			continue;
		}
		const date = `${year}-${month.padStart(2, "0")}-${day2.padStart(2, "0")}`;
		const seed = captionSeed(entry ?? "");
		const seeds = (byDate[date] ??= []);
		if (seed && !seeds.includes(seed)) {
			seeds.push(seed);
		}
	}
	return byDate;
}

// The journal seeds and journaled check read the Workflowy cache, so a cache
// older than maxAgeMinutes means entries written since (e.g. in the app) are
// invisible and captions would start from an old version of the notes.
export function cacheIsStale(latestSystemFrom: string | null, nowMs: number, maxAgeMinutes: number): boolean {
	if (!latestSystemFrom) {
		return true;
	}
	const latest = Date.parse(`${latestSystemFrom.replace(" ", "T")}Z`);
	return Number.isNaN(latest) || nowMs - latest > maxAgeMinutes * 60_000;
}

function refreshStaleCache(workflowyDb: string): void {
	const [row] = sqliteJson(workflowyDb, "SELECT max(system_from) AS latest FROM node_content;");
	const latest = row ? (stringField(row, "latest") ?? null) : null;
	if (!cacheIsStale(latest, Date.now(), 60)) {
		return;
	}
	process.stderr.write("Workflowy cache is stale; running cache import-api\n");
	const result = spawnSync("./bin/run.js", ["cache", "import-api"], {encoding: "utf8", stdio: "inherit"});
	if (result.status !== 0) {
		throw new Error("cache import-api failed; re-run after fixing the import");
	}
}

function minuteTime(created: string): string {
	const match = TIMESTAMP_RE.exec(created);
	if (!match) {
		throw new Error(`Invalid timestamp: ${created}`);
	}
	const [, year, month, day, hour, minute] = match.map(Number);
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}" startHour="${hour}" startMinute="${minute}">`;
}

// A favorite already journaled in Workflowy (an entry whose <time> matches the
// photo's minute) counts as captioned, so the review never asks about it again.
export function journaledQuery(favorites: Pick<Favorite, "uuid" | "created">[]): string {
	const times = favorites.map((favorite) => `name LIKE '%${minuteTime(favorite.created)}%'`).join(" OR ");
	return `SELECT name FROM node_content WHERE ${CURRENT} AND (${times});`;
}

export function splitJournaled<F extends Pick<Favorite, "created">>(
	favorites: F[],
	rows: NameRow[],
): {journaled: F[]; remaining: F[]} {
	const times = new Set<string>();
	for (const {name} of rows) {
		for (const match of (name ?? "").matchAll(MINUTE_TIME_RE)) {
			times.add(match[0]);
		}
	}
	const journaled: F[] = [];
	const remaining: F[] = [];
	for (const favorite of favorites) {
		(times.has(minuteTime(favorite.created)) ? journaled : remaining).push(favorite);
	}
	return {journaled, remaining};
}

export function planSources(
	favorites: Favorite[],
	libraryPath: string,
	exists: (path: string) => boolean,
): {local: LocalFavorite[]; icloud: Favorite[]} {
	const local: LocalFavorite[] = [];
	const icloud: Favorite[] = [];
	for (const favorite of favorites) {
		const originalPath = join(libraryPath, "originals", favorite.directory, favorite.filename);
		if (exists(originalPath)) {
			local.push({...favorite, originalPath});
		} else {
			icloud.push(favorite);
		}
	}
	return {local, icloud};
}

// Photos' `whose` filter is lazy; `get` forces the list so `count` and `export`
// see real items (the -1728 rule). Each uuid lands in its own folder because
// Photos names exports IMG_xxxx, which can't be mapped back otherwise.
export function buildExportAppleScript(uuids: string[]): string[] {
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
}): Manifest {
	const toEntry = (favorite: ManifestFavorite, source: "local" | "icloud"): ManifestEntry => {
		const photoFaces = faces[favorite.uuid] ?? {named: [], unnamed: 0};
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
	return {total: photos.length, viewable, unviewable: photos.length - viewable, photos};
}

function parseArgs(argv: string[]): Args {
	const args: Args = {days: 14, out: ".llm/gtd/photo-captions", countOnly: false, workflowyDb: "outlinedb.sqlite"};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--days") {
			args.days = Number(argv[++i]);
		} else if (argv[i] === "--workflowy-db") {
			args.workflowyDb = argv[++i] ?? args.workflowyDb;
		} else if (argv[i] === "--out") {
			args.out = argv[++i] ?? args.out;
		} else if (argv[i] === "--count-only") {
			args.countOnly = true;
		} else {
			throw new Error(`Unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

function toFavorite(row: JsonObject): Favorite {
	return {
		uuid: stringField(row, "uuid") ?? "",
		created: stringField(row, "created") ?? "",
		directory: stringField(row, "directory") ?? "",
		filename: stringField(row, "filename") ?? "",
		originalFilename: stringField(row, "originalFilename") ?? "",
		orientation: typeof row.orientation === "number" ? row.orientation : 0,
	};
}

const toFaceRow = (row: JsonObject): FaceRow => ({
	uuid: stringField(row, "uuid") ?? "",
	name: stringField(row, "name") ?? "",
});

const toJournalRow = (row: JsonObject): JournalRow => ({
	day: stringField(row, "day") ?? "",
	entry: stringField(row, "entry") ?? null,
});

const toNameRow = (row: JsonObject): NameRow => ({name: stringField(row, "name") ?? null});

const DB_SUFFIXES = ["", "-wal", "-shm"];

function removeDatabaseCopy(target: string): void {
	for (const suffix of DB_SUFFIXES) {
		rmSync(target + suffix, {force: true});
	}
}

// COPYFILE_FICLONE makes APFS clone the multi-GB DB (copy-on-write, near-zero space),
// falling back to a real copy where cloning is unsupported.
function copyDatabase(libraryPath: string, outDir: string): string {
	const target = join(outDir, "photos-ro.sqlite");
	removeDatabaseCopy(target);
	const source = join(libraryPath, "database", "Photos.sqlite");
	for (const suffix of DB_SUFFIXES) {
		if (suffix === "" || existsSync(source + suffix)) {
			copyFileSync(source + suffix, target + suffix, constants.COPYFILE_FICLONE);
		}
	}
	return target;
}

export function withDatabaseCopy<T>(libraryPath: string, outDir: string, fn: (dbPath: string) => T): T {
	const dbPath = copyDatabase(libraryPath, outDir);
	try {
		return fn(dbPath);
	} finally {
		removeDatabaseCopy(dbPath);
	}
}

function sqliteJson(dbPath: string, sql: string): JsonObject[] {
	const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {encoding: "utf8"});
	if (result.status !== 0) {
		throw new Error(`sqlite3 failed: ${result.stderr}`);
	}
	return result.stdout.trim()
		? expectArray(parseJson(result.stdout), "sqlite3 output").map((row) => expectObject(row, "sqlite3 row"))
		: [];
}

/** Clockwise degrees `sips -r` needs to show an image upright, by EXIF orientation. */
const ROTATION: Readonly<Record<number, string>> = {3: "180", 6: "90", 8: "270"};

/**
 * The sips arguments for a 900px view JPEG. sips drops the EXIF orientation flag when it
 * converts, so a rotated original comes out sideways unless the pixels are rotated too.
 */
export function viewJpegArgs(source: string, viewPath: string, orientation: number): string[] {
	const rotation = ROTATION[orientation];
	return ["-s", "format", "jpeg", "-Z", "900", ...(rotation ? ["-r", rotation] : []), source, "--out", viewPath];
}

function toViewJpeg(source: string, viewPath: string, orientation: number): boolean {
	const result = spawnSync("sips", viewJpegArgs(source, viewPath, orientation), {
		encoding: "utf8",
	});
	return result.status === 0 && existsSync(viewPath);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const libraryPath = join(homedir(), "Pictures", "Photos Library.photoslibrary");
	const outDir = resolve(args.out);
	mkdirSync(outDir, {recursive: true});
	withDatabaseCopy(libraryPath, outDir, (dbPath) => run(args, libraryPath, outDir, dbPath));
}

function run(args: Args, libraryPath: string, outDir: string, dbPath: string): void {
	const workflowyDb = resolve(args.workflowyDb);
	if (!existsSync(workflowyDb)) {
		throw new Error(`Workflowy cache not found: ${workflowyDb}`);
	}
	refreshStaleCache(workflowyDb);
	const candidates = sqliteJson(dbPath, favoritesQuery(args.days)).map(toFavorite);
	const empty: {journaled: Favorite[]; remaining: Favorite[]} = {journaled: [], remaining: []};
	const {journaled, remaining: favorites} =
		candidates.length > 0
			? splitJournaled(candidates, sqliteJson(workflowyDb, journaledQuery(candidates)).map(toNameRow))
			: empty;
	if (args.countOnly) {
		process.stdout.write(`remaining=${favorites.length} journaled=${journaled.length}\n`);
		return;
	}

	const viewDir = join(outDir, "view");
	const exportDir = join(outDir, "export");
	rmSync(viewDir, {recursive: true, force: true});
	rmSync(exportDir, {recursive: true, force: true});
	mkdirSync(viewDir, {recursive: true});

	const {local, icloud} = planSources(favorites, libraryPath, existsSync);
	const views: Record<string, string> = {};
	for (const favorite of local) {
		const viewPath = join(viewDir, `${favorite.uuid}.jpg`);
		if (toViewJpeg(favorite.originalPath, viewPath, favorite.orientation)) {
			views[favorite.uuid] = viewPath;
		}
	}

	if (icloud.length > 0) {
		for (const favorite of icloud) {
			mkdirSync(join(exportDir, favorite.uuid), {recursive: true});
		}
		const script = buildExportAppleScript(icloud.map((f) => f.uuid)).flatMap((line) => ["-e", line]);
		const result = spawnSync("osascript", [...script, exportDir], {encoding: "utf8"});
		writeFileSync(
			join(outDir, "export.log"),
			`${result.stderr}exit=${result.status} exported=${result.stdout.trim()}\n`,
		);
		for (const favorite of icloud) {
			const folder = join(exportDir, favorite.uuid);
			const [file] = readdirSync(folder);
			const viewPath = join(viewDir, `${favorite.uuid}.jpg`);
			// Photos applies the orientation when it exports, so the exported file is already upright.
			if (file && toViewJpeg(join(folder, file), viewPath, 1)) {
				views[favorite.uuid] = viewPath;
			}
		}
	}

	const faces =
		favorites.length > 0
			? groupFaces(sqliteJson(dbPath, facesQuery(favorites.map((f) => f.uuid))).map(toFaceRow))
			: {};
	const dates = [...new Set(favorites.map((f) => f.created.slice(0, 10)))];
	const journal =
		dates.length > 0 ? groupJournal(sqliteJson(workflowyDb, journalQuery(dates)).map(toJournalRow)) : {};
	const manifest = buildManifest({local, icloud, views, faces, journal});
	const manifestPath = join(outDir, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	process.stdout.write(
		`total=${manifest.total} viewable=${manifest.viewable} unviewable=${manifest.unviewable} journaled=${journaled.length} manifest=${manifestPath}\n`,
	);
}

if (isMain(import.meta.url)) {
	main();
}
