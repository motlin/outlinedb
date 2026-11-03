import {afterEach, describe, expect, test} from "vite-plus/test";
import {execFileSync, spawn, spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const script = join(import.meta.dirname, "build-fresh-database.sh");

// A copy of the script in a scratch repo, so its repo-relative watcher check and default database never touch the real ones.
/** @returns {string} */
function scratchRepo() {
	// realpath: the script resolves its repo physically, as lsof reports a watcher's cwd (macOS /var is /private/var).
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "build-fresh-database-")));
	mkdirSync(join(repo, "scripts"));
	mkdirSync(join(repo, "packages", "web"), {recursive: true});
	copyFileSync(script, join(repo, "scripts", "build-fresh-database.sh"));
	return repo;
}

/**
 * @param {string} repo
 * @param {string[]} args
 */
function runScript(repo, args) {
	const {WORKFLOWY_DB_PATH: _unused, ...env} = process.env;
	return spawnSync("bash", [join(repo, "scripts", "build-fresh-database.sh"), ...args], {
		encoding: "utf8",
		env: {...env, WORKFLOWY_EPOCH: "2020-01-01"},
	});
}

/**
 * @param {string} db
 * @param {string} sql
 */
function sqlite(db, sql) {
	return execFileSync("sqlite3", [db, sql], {encoding: "utf8"}).trim();
}

/** @type {string} */
let repo;
/** @type {import("node:child_process").ChildProcess | undefined} */
let watcher;

afterEach(() => {
	watcher?.kill();
	watcher = undefined;
	rmSync(repo, {recursive: true, force: true});
});

// Same command line and working directory as the `just web` dev:server watcher, without being one.
/** @param {string} cwd */
async function startFakeWatcher(cwd) {
	const child = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "tsx", "watch", "--conditions=source", "src/server/index.ts"],
		{cwd, stdio: "ignore"},
	);
	watcher = child;
	await new Promise((resolve) => {
		child.once("spawn", resolve);
	});
	return child.pid;
}

describe("build-fresh-database.sh", () => {
	test("refuses up front while the just web watcher runs in this repo", async () => {
		repo = scratchRepo();
		const pid = await startFakeWatcher(join(repo, "packages", "web"));

		const result = runScript(repo, ["--offline"]);

		expect({
			status: result.status,
			mentionsPid: result.stderr.includes(String(pid)),
			stdout: result.stdout,
		}).toStrictEqual({
			status: 1,
			mentionsPid: true,
			stdout: "",
		});
		expect(result.stderr).toContain("`just web` is running");
	});

	test("ignores a watcher running in another checkout", async () => {
		repo = scratchRepo();
		const other = mkdtempSync(join(tmpdir(), "other-checkout-"));
		try {
			await startFakeWatcher(other);

			const result = runScript(repo, ["--swap-only"]);

			expect({status: result.status, stderr: result.stderr}).toStrictEqual({
				status: 1,
				stderr: `❌ --swap-only needs ${join(repo, "workflowy.rebuilding.sqlite")}, which does not exist\n`,
			});
		} finally {
			rmSync(other, {recursive: true, force: true});
		}
	});

	test("--swap-only swaps the existing rebuilt database in", () => {
		repo = scratchRepo();
		const target = join(repo, "workflowy.sqlite");
		const building = join(repo, "workflowy.rebuilding.sqlite");
		sqlite(target, "create table t(v); insert into t values ('old')");
		sqlite(building, "pragma journal_mode=wal; create table t(v); insert into t values ('new'), ('new2')");

		const result = runScript(repo, ["--swap-only"]);

		expect({
			status: result.status,
			stderr: result.stderr,
			building: existsSync(building),
			wal: existsSync(`${building}-wal`),
			rows: sqlite(target, "select group_concat(v) from t"),
			journalMode: sqlite(target, "pragma journal_mode"),
			backups: readdirSync(repo)
				.filter((name) => name.startsWith("workflowy.pre-rebuild-"))
				.map((name) => sqlite(join(repo, name), "select group_concat(v) from t")),
		}).toStrictEqual({
			status: 0,
			stderr: "",
			building: false,
			wal: false,
			rows: "new,new2",
			journalMode: "delete",
			backups: ["old"],
		});
		expect(result.stdout).toContain(`✅ Rebuilt ${target}`);
	});
});
