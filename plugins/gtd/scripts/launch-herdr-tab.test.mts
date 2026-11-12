// Run: node --test plugins/gtd/scripts/launch-herdr-tab.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {PaneIo} from "./launch-herdr-tab.mts";
import
{
	commandIsStuckAtPrompt,
	insertIndexRightOf,
	isShellPrompt,
	parseArgs,
	runWhenReady,
	socketRequest,
} from "./launch-herdr-tab.mts";

const tab = (
	workspace_id: string,
	tab_id: string,
):
{
	workspace_id: string;
	tab_id: string;
} => (
{
	workspace_id,
	tab_id,
});

test("insert index sits immediately right of the caller tab within its workspace", () =>
{
	const tabs = [
		tab("w1", "w1:t1"),
		tab("w8", "w8:t8"),
		tab("w8", "w8:t27"),
		tab("w8", "w8:t32"),
		tab("w8", "w8:t40"),
	];
	assert.strictEqual(insertIndexRightOf(tabs, "w8", "w8:t27"), 2);
});

test("a caller tab that is already last yields the end position", () =>
{
	const tabs = [tab("w8", "w8:t8"), tab("w8", "w8:t27")];
	assert.strictEqual(insertIndexRightOf(tabs, "w8", "w8:t27"), 2);
});

test("a caller tab missing from the workspace is an error", () =>
{
	assert.throws(() => insertIndexRightOf([tab("w8", "w8:t8")], "w8", "w8:t99"), /w8:t99/u);
});

test("parseArgs splits the label, cwd, and command after --", () =>
{
	assert.deepStrictEqual(
		parseArgs(["--label", "time-machine", "--cwd", "/projects", "--", "/bin/sweep.sh", "arg"]),
		{
			label: "time-machine",
			cwd: "/projects",
			focus: true,
			command: ["/bin/sweep.sh", "arg"],
		},
	);
});

test("parseArgs honours --no-focus", () =>
{
	assert.strictEqual(parseArgs(["--label", "x", "--no-focus", "--", "echo"]).focus, false);
});

test("parseArgs requires a label and a command", () =>
{
	assert.throws(() => parseArgs(["--", "echo"]), /--label/u);
	assert.throws(() => parseArgs(["--label", "x"]), /command/u);
});

test("socketRequest decodes a multibyte character split across two chunks", async () =>
{
	const dir = mkdtempSync(join(tmpdir(), "launch-herdr-tab-"));
	const socketPath = join(dir, "herdr.sock");
	const payload = Buffer.from(
		`${JSON.stringify(
			{
				id: "launch-herdr-tab",
				result:
				{
					label: "tab 🎉",
				},
			},
		)}\n`,
		"utf8",
	);
	const split = payload.indexOf(Buffer.from("🎉", "utf8")) + 2;
	const server = createServer((connection) =>
	{
		connection.once("data", () =>
		{
			connection.write(payload.subarray(0, split));
			setTimeout(() =>
			{
				connection.end(payload.subarray(split));
			}, 50);
		});
	});
	await new Promise<void>((resolve) =>
	{
		server.listen(socketPath, resolve);
	});
	try
	{
		assert.deepStrictEqual(
			await socketRequest("tab.get", {}, socketPath),
			{
				label: "tab 🎉",
			},
		);
	}
	finally
	{
		server.close();
		rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	}
});

const fakePane = (
	reads: string[],
):
{
	io: PaneIo;
	calls: string[];
} =>
{
	const calls: string[] = [];
	let index = 0;
	const io: PaneIo =
	{
		read: () =>
		{
			const text = reads[Math.min(index, reads.length - 1)] ?? "";
			index += 1;
			return text;
		},
		run: (command) =>
		{
			calls.push(`run ${command}`);
		},
		pressEnter: () =>
		{
			calls.push("enter");
		},
		sleep: async () =>
		{
			calls.push("sleep");
			await Promise.resolve();
		},
	};
	return {
		io,
		calls,
	};
};

test("isShellPrompt recognises an idle prompt and rejects a blank or busy pane", () =>
{
	assert.strictEqual(isShellPrompt("last login\n~/projects %"), true);
	assert.strictEqual(isShellPrompt("~/projects ❯ "), true);
	assert.strictEqual(isShellPrompt(""), false);
	assert.strictEqual(isShellPrompt("compiling..."), false);
});

test("commandIsStuckAtPrompt detects text typed but not executed", () =>
{
	assert.strictEqual(commandIsStuckAtPrompt("~ % echo hi", "echo hi"), true);
	assert.strictEqual(commandIsStuckAtPrompt("~ % echo hi\nhi\n~ %", "echo hi"), false);
});

test("runWhenReady waits for the prompt before running", async () =>
{
	const {io, calls} = fakePane(["", "starting", "~ %", "~ % echo hi\nhi\n~ %"]);
	await runWhenReady(io, "echo hi");
	assert.deepStrictEqual(calls, ["sleep", "sleep", "run echo hi", "sleep"]);
});

test("runWhenReady leaves a slow command alone while its first output is still pending", async () =>
{
	const {io, calls} = fakePane(["~ %", "~ % sweep", "~ % sweep", "~ % sweep", "~ % sweep\nPassword:"]);
	await runWhenReady(io, "sweep");
	assert.deepStrictEqual(calls, ["run sweep", "sleep", "sleep", "sleep", "sleep"]);
});

test("runWhenReady presses Enter once when the command is stuck at the prompt", async () =>
{
	const {io, calls} = fakePane(["~ %", "~ % echo hi", "~ % echo hi", "~ % echo hi\nhi\n~ %"]);
	await runWhenReady(
		io,
		"echo hi",
		{
			startAttempts: 2,
		},
	);
	assert.deepStrictEqual(
		calls.filter((c) => c === "enter"),
		["enter"],
	);
});

test("runWhenReady throws when the command never starts after one retry", async () =>
{
	const {io} = fakePane(["~ %", "~ % echo hi"]);
	await assert.rejects(runWhenReady(io, "echo hi"), /did not start/u);
});

test("runWhenReady throws when no prompt ever appears", async () =>
{
	const {io} = fakePane(["busy"]);
	await assert.rejects(
		runWhenReady(
			io,
			"echo hi",
			{
				promptAttempts: 3,
			},
		),
		/prompt/u,
	);
});
