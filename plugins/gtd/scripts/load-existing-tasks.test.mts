// Run: node --test plugins/gtd/scripts/load-existing-tasks.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {arrayField, expectObject, parseJson, stringField} from "./json.mts";

const here = import.meta.dirname;
const loader = join(here, "load-existing-tasks.sh");
const syncScript = join(here, "sync-metadata.sh");

interface TaskNode
{
	id: string;
	name: string;
	completedAt: string | null;
	children: TaskNode[];
}

function metadataDirWith(workNext: TaskNode): string
{
	const root = mkdtempSync(join(tmpdir(), "load-existing-tasks-"));
	mkdirSync(
		join(root, "next-actions"),
		{
			recursive: true,
		},
	);
	mkdirSync(
		join(root, "projects"),
		{
			recursive: true,
		},
	);
	mkdirSync(
		join(root, "calendar"),
		{
			recursive: true,
		},
	);
	writeFileSync(join(root, "next-actions", "work-next.json"), JSON.stringify(workNext));
	return root;
}

function node(id: string, name: string, children: TaskNode[] = [], completedAt: string | null = null): TaskNode
{
	return {
		id,
		name,
		completedAt,
		children,
	};
}

test("nextActions includes open tasks on the asap ladder tiers and skips tiers and completed tasks", () =>
{
	const workNext = node("root", "☑️ Next (Work)", [
		node("tasks", "✅ Tasks", [
			node("ladder", "📌 Tasks (asap) (work)", [
				node("done", "Done", [node("t-old", "Shipped last week", [], "2026-10-01T00:00:00Z")]),
				node("tier1", "1st", [
					node("t-open", "Arrange Dev Practice work into Arcs"),
					node("t-finished", "Finished but not yet moved", [], "2026-10-06T00:00:00Z"),
				]),
				node("tier2", "2nd", [node("t-two", "Set up a weekly Dev Practice meeting")]),
			]),
		]),
	]);
	const metadataDir = metadataDirWith(workNext);

	const output = expectObject(
		parseJson(
			execFileSync(
				"bash",
				[loader],
				{
					env:
					{
						...process.env,
						GTD_METADATA_DIR: metadataDir,
					},
					encoding: "utf8",
				},
			),
		),
		"loader output",
	);

	assert.deepEqual(
		arrayField(output, "nextActions")
			.map((task) =>
			{
				const object = expectObject(task, "next action");
				return {
					id: stringField(object, "id") ?? "",
					name: stringField(object, "name"),
				};
			})
			.toSorted((a, b) => a.id.localeCompare(b.id)),
		[
			{
				id: "t-open",
				name: "Arrange Dev Practice work into Arcs",
			},
			{
				id: "t-two",
				name: "Set up a weekly Dev Practice meeting",
			},
		],
	);
});

test("next-actions link targets sync deep enough to reach tasks inside asap tiers", () =>
{
	const script = readFileSync(syncScript, "utf8");
	const fn = script.match(/^link_target_depth\(\) \{[\s\S]*?^\}/mu);
	assert.ok(fn, "sync-metadata.sh defines link_target_depth()");

	const depthFor = (section: string): string =>
		execFileSync(
			"bash",
			["-c", `${fn[0]}\nlink_target_depth "$1"`, "bash", section],
			{
				encoding: "utf8",
			},
		).trim();

	// Next > ✅ Tasks > 📌 Tasks (asap) > tier > task > child
	assert.deepEqual(
		{
			nextActions: depthFor("next-actions"),
			reference: depthFor("reference"),
		},
		{
			nextActions: "5",
			reference: "3",
		},
	);
});
