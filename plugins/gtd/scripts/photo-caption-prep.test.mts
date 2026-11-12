// Run: node --test plugins/gtd/scripts/photo-caption-prep.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
	buildExportAppleScript,
	buildManifest,
	cacheIsStale,
	captionSeed,
	facesQuery,
	facesSummary,
	favoritesQuery,
	groupFaces,
	groupJournal,
	journaledQuery,
	journalQuery,
	planSources,
	splitJournaled,
	viewJpegArgs,
	withDatabaseCopy,
} from "./photo-caption-prep.mts";

test("favoritesQuery selects uncaptioned, untrashed, visible favorite photos within the window", () => {
	assert.strictEqual(
		favoritesQuery(14),
		"SELECT A.ZUUID AS uuid, datetime(A.ZDATECREATED+978307200,'unixepoch','localtime') AS created, A.ZDIRECTORY AS directory, A.ZFILENAME AS filename, COALESCE(B.ZORIGINALFILENAME,'') AS originalFilename FROM ZASSET A LEFT JOIN ZADDITIONALASSETATTRIBUTES B ON A.Z_PK=B.ZASSET WHERE A.ZFAVORITE=1 AND A.ZTRASHEDSTATE=0 AND A.ZHIDDEN=0 AND A.ZKIND=0 AND A.ZDATECREATED > strftime('%s','now','-14 days')-978307200 AND COALESCE(B.ZTITLE,'')='' AND COALESCE(B.ZACCESSIBILITYDESCRIPTION,'')='' ORDER BY A.ZDATECREATED DESC;",
	);
});

test("favoritesQuery rejects a non-integer window so nothing is interpolated into SQL", () => {
	assert.throws(() => favoritesQuery("14; DROP TABLE ZASSET"), /positive integer/u);
	assert.throws(() => favoritesQuery(0), /positive integer/u);
});

test("facesQuery lists every detected face for the given uuids with its person name", () => {
	assert.strictEqual(
		facesQuery(["AAA", "BBB"]),
		"SELECT A.ZUUID AS uuid, COALESCE(NULLIF(P.ZFULLNAME,''),'') AS name FROM ZASSET A JOIN ZDETECTEDFACE F ON F.ZASSETFORFACE=A.Z_PK LEFT JOIN ZPERSON P ON F.ZPERSONFORFACE=P.Z_PK WHERE A.ZUUID IN ('AAA','BBB');",
	);
});

test("facesQuery rejects uuids that are not uuid-shaped", () => {
	assert.throws(() => facesQuery(["x') OR 1=1 --"]), /Invalid uuid/u);
});

test("groupFaces splits named people from the unnamed face count per uuid", () => {
	assert.deepStrictEqual(
		groupFaces([
			{uuid: "AAA", name: "Alice"},
			{uuid: "AAA", name: ""},
			{uuid: "AAA", name: "Bob"},
			{uuid: "AAA", name: "Alice"},
			{uuid: "BBB", name: ""},
		]),
		{
			AAA: {named: ["Alice", "Bob"], unnamed: 1},
			BBB: {named: [], unnamed: 1},
		},
	);
});

test("facesSummary names tagged people and flags untagged faces as ready to tag", () => {
	assert.deepStrictEqual(
		[
			facesSummary({named: ["Alice", "Bob"], unnamed: 2}),
			facesSummary({named: ["Alice"], unnamed: 1}),
			facesSummary({named: [], unnamed: 3}),
			facesSummary({named: ["Alice"], unnamed: 0}),
			facesSummary({named: [], unnamed: 0}),
		],
		[
			"Tagged: Alice, Bob. 2 untagged faces, ready to tag in Photos.",
			"Tagged: Alice. 1 untagged face, ready to tag in Photos.",
			"Tagged: nobody. 3 untagged faces, ready to tag in Photos.",
			"Tagged: Alice.",
			"No faces detected.",
		],
	);
});

test("captionSeed keeps the journal wording but drops emoji, @ signs, markup, and trailing tags", () => {
	assert.deepStrictEqual(
		[
			captionSeed("🎤 Meeting with the MC for @Alice 's party, with @Bob and @Carol."),
			captionSeed("🛹 When I got home, I went for a #onewheel ride up and down Main Street."),
			captionSeed("📺 Watched S03E01 of Some Show. #watched #tv"),
			captionSeed("✡️ Holiday. Didn't go to temple."),
			captionSeed('👨‍👩‍👧 Dinner at <a href="https://example.com">Tom &amp; Jerry\'s</a> with @Alice'),
			captionSeed("💪 #exercise"),
			captionSeed("Rain all weekend. \u2018It\u2019s wet\u2019 said the \u201Cnews\u201D."),
		],
		[
			"Meeting with the MC for Alice's party, with Bob and Carol.",
			"When I got home, I went for a onewheel ride up and down Main Street.",
			"Watched S03E01 of Some Show.",
			"Holiday. Didn't go to temple.",
			"Dinner at Tom & Jerry's with Alice",
			"",
			"Rain all weekend. 'It's wet' said the \"news\".",
		],
	);
});

test("journalQuery selects the entries under each date-only day node for the given dates", () => {
	assert.strictEqual(
		journalQuery(["2026-09-21", "2026-09-05"]),
		'SELECT D.name AS day, E.name AS entry FROM node_content D JOIN node_content E ON E.parent_id=D.id AND E.system_to=\'9999-12-31 23:59:59\' WHERE D.system_to=\'9999-12-31 23:59:59\' AND (D.name LIKE \'<time startYear="2026" startMonth="9" startDay="21">%\' OR D.name LIKE \'<time startYear="2026" startMonth="9" startDay="5">%\');',
	);
});

test("journalQuery rejects dates that are not YYYY-MM-DD", () => {
	assert.throws(() => journalQuery(["2026-09-21' OR 1=1 --"]), /Invalid date/u);
});

test("groupJournal maps each day node back to its date and keeps non-empty, distinct caption seeds", () => {
	assert.deepStrictEqual(
		groupJournal([
			{
				day: '<time startYear="2026" startMonth="9" startDay="21">Mon, Sep 21, 2026</time> ',
				entry: "🛝 Went to the park with @Alice.",
			},
			{
				day: '<time startYear="2026" startMonth="9" startDay="21">Mon, Sep 21, 2026</time>',
				entry: "💪 #exercise",
			},
			{
				day: '<time startYear="2026" startMonth="9" startDay="21">Mon, Sep 21, 2026</time>',
				entry: "🛝 Went to the park with @Alice.",
			},
			{day: '<time startYear="2026" startMonth="9" startDay="5">Sat, Sep 5, 2026</time>', entry: "Pizza night."},
		]),
		{
			"2026-09-21": ["Went to the park with Alice."],
			"2026-09-05": ["Pizza night."],
		},
	);
});

test("planSources splits favorites into local originals and iCloud-only ones", () => {
	const favorites = [
		{
			uuid: "AAA",
			created: "2026-09-21 16:18:00",
			directory: "A",
			filename: "AAA.heic",
			originalFilename: "IMG_1.HEIC",
		},
		{
			uuid: "BBB",
			created: "2026-09-12 20:05:00",
			directory: "B",
			filename: "BBB.heic",
			originalFilename: "IMG_2.HEIC",
		},
	];
	const exists = (path: string): boolean => path === "/lib/originals/A/AAA.heic";
	assert.deepStrictEqual(planSources(favorites, "/lib", exists), {
		local: [{...favorites[0], originalPath: "/lib/originals/A/AAA.heic"}],
		icloud: [favorites[1]],
	});
});

test("buildExportAppleScript exports each uuid into its own subfolder so files map back by uuid", () => {
	assert.deepStrictEqual(buildExportAppleScript(["AAA", "BBB"]), [
		"on run argv",
		"set outDir to item 1 of argv",
		'set ids to {"AAA", "BBB"}',
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
	]);
});

test("buildManifest records source, view path, faces, and that day's journal seeds, and counts what is still unviewable", () => {
	const local = [
		{
			uuid: "AAA",
			created: "2026-09-21 16:18:00",
			originalFilename: "IMG_1.HEIC",
			originalPath: "/lib/originals/A/AAA.heic",
		},
	];
	const icloud = [
		{uuid: "BBB", created: "2026-09-12 20:05:00", originalFilename: "IMG_2.HEIC"},
		{uuid: "CCC", created: "2026-09-11 17:49:00", originalFilename: "IMG_3.HEIC"},
	];
	const views = {AAA: "/out/view/AAA.jpg", BBB: "/out/view/BBB.jpg"};
	const faces = {AAA: {named: ["Alice"], unnamed: 2}};
	const journal = {"2026-09-21": ["Went to the park with Alice."]};
	assert.deepStrictEqual(buildManifest({local, icloud, views, faces, journal}), {
		total: 3,
		viewable: 2,
		unviewable: 1,
		photos: [
			{
				uuid: "AAA",
				created: "2026-09-21 16:18:00",
				date: "2026-09-21",
				journalSeeds: ["Went to the park with Alice."],
				originalFilename: "IMG_1.HEIC",
				source: "local",
				viewPath: "/out/view/AAA.jpg",
				faces: {named: ["Alice"], unnamed: 2},
				facesSummary: "Tagged: Alice. 2 untagged faces, ready to tag in Photos.",
			},
			{
				uuid: "BBB",
				created: "2026-09-12 20:05:00",
				date: "2026-09-12",
				journalSeeds: [],
				originalFilename: "IMG_2.HEIC",
				source: "icloud",
				viewPath: "/out/view/BBB.jpg",
				faces: {named: [], unnamed: 0},
				facesSummary: "No faces detected.",
			},
			{
				uuid: "CCC",
				created: "2026-09-11 17:49:00",
				date: "2026-09-11",
				journalSeeds: [],
				originalFilename: "IMG_3.HEIC",
				source: "icloud",
				viewPath: null,
				faces: {named: [], unnamed: 0},
				facesSummary: "No faces detected.",
			},
		],
	});
});

test("journaledQuery finds current nodes carrying a minute-precision <time> at any favorite timestamp", () => {
	assert.strictEqual(
		journaledQuery([
			{uuid: "AAA", created: "2026-10-06 19:37:42"},
			{uuid: "BBB", created: "2026-09-05 08:04:00"},
		]),
		'SELECT name FROM node_content WHERE system_to=\'9999-12-31 23:59:59\' AND (name LIKE \'%<time startYear="2026" startMonth="10" startDay="6" startHour="19" startMinute="37">%\' OR name LIKE \'%<time startYear="2026" startMonth="9" startDay="5" startHour="8" startMinute="4">%\');',
	);
});

test("journaledQuery rejects timestamps that are not YYYY-MM-DD HH:MM", () => {
	assert.throws(() => journaledQuery([{uuid: "AAA", created: "2026-10-06' OR 1=1 --"}]), /Invalid timestamp/u);
});

test("splitJournaled separates favorites with a journal entry at their exact minute from the rest", () => {
	const favorites = [
		{uuid: "AAA", created: "2026-10-06 19:37:42"},
		{uuid: "BBB", created: "2026-10-06 19:38:00"},
		{uuid: "CCC", created: "2026-10-03 15:06:10"},
		{uuid: "DDD", created: "2026-10-03 09:00:00"},
	];
	const rows = [
		{
			name: '📷 <time startYear="2026" startMonth="10" startDay="6" startHour="19" startMinute="37">Tue, Oct 6, 2026 at 7:37 PM</time> @Alice playing in the yard',
		},
		{
			name: '<time startYear="2026" startMonth="10" startDay="3" startHour="15" startMinute="6">Sat, Oct 3, 2026 at 3:06 PM</time> @Bob at the park',
		},
		{name: '<time startYear="2026" startMonth="10" startDay="3">Sat, Oct 3, 2026</time>'},
	];
	assert.deepStrictEqual(splitJournaled(favorites, rows), {
		journaled: [favorites[0], favorites[2]],
		remaining: [favorites[1], favorites[3]],
	});
});

function fakeLibrary(): {root: string; library: string; out: string} {
	const root = mkdtempSync(join(tmpdir(), "photo-caption-prep-"));
	const library = join(root, "Photos Library.photoslibrary");
	mkdirSync(join(library, "database"), {recursive: true});
	writeFileSync(join(library, "database", "Photos.sqlite"), "db");
	writeFileSync(join(library, "database", "Photos.sqlite-wal"), "wal");
	const out = join(root, "out");
	mkdirSync(out);
	return {root, library, out};
}

test("withDatabaseCopy hands the callback a copy of the Photos DB and deletes it afterwards", () => {
	const {root, library, out} = fakeLibrary();
	try {
		const seen = withDatabaseCopy(library, out, (dbPath) => ({
			db: readFileSync(dbPath, "utf8"),
			wal: readFileSync(`${dbPath}-wal`, "utf8"),
			shm: existsSync(`${dbPath}-shm`),
		}));
		assert.deepStrictEqual(seen, {db: "db", wal: "wal", shm: false});
		assert.deepStrictEqual(
			["photos-ro.sqlite", "photos-ro.sqlite-wal", "photos-ro.sqlite-shm"].map((f) => existsSync(join(out, f))),
			[false, false, false],
		);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test("withDatabaseCopy deletes the Photos DB copy even when the callback throws", () => {
	const {root, library, out} = fakeLibrary();
	try {
		assert.throws(
			() =>
				withDatabaseCopy(library, out, () => {
					throw new Error("query failed");
				}),
			/query failed/u,
		);
		assert.deepStrictEqual(
			["photos-ro.sqlite", "photos-ro.sqlite-wal"].map((f) => existsSync(join(out, f))),
			[false, false],
		);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test("cacheIsStale compares the newest cached node version (UTC) with the allowed age", () => {
	const now = Date.parse("2026-10-26T10:00:00Z");
	assert.strictEqual(cacheIsStale("2026-10-26 09:30:00.000", now, 60), false);
	assert.strictEqual(cacheIsStale("2026-10-26 08:59:00.000", now, 60), true);
	assert.strictEqual(cacheIsStale(null, now, 60), true);
});

test("viewJpegArgs keeps the EXIF orientation flag instead of rotating, since sips carries the flag over and a rotated copy would display sideways", () => {
	assert.deepStrictEqual(viewJpegArgs("in.heic", "out.jpg"), [
		"-s",
		"format",
		"jpeg",
		"-Z",
		"900",
		"in.heic",
		"--out",
		"out.jpg",
	]);
});
