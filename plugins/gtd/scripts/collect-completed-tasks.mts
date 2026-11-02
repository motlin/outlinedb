#!/usr/bin/env node
// List completed items still sitting under each root's `✅ Tasks` wrapper, for the daily review's
// Clean Up Completed phase. Read-only: it never mutates Workflowy.
//
// Usage:
//   node collect-completed-tasks.mts Personal=root-personal.json Work=root-work.json [--timezone IANA]
//
// Each file is `node get --id <next-root> --depth 6 --json --fields id,name,completedAt,children`.
// Emits a JSON array of rows to stdout. Only the top-most completed item of a subtree is a row; its
// descendants travel with it. `completedDate` is the local calendar date of `completedAt`, which is
// the 📅 Calendar date the item is journaled under.

import {readFileSync} from "node:fs";
import {isObject} from "./json.mts";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";

export interface CompletedNode
{
	id?: string;
	name: string;
	completedAt?: string | null;
	children?: CompletedNode[];
}

export interface RootInput
{
	root: string;
	tree: CompletedNode;
}

export interface CompletedRow
{
	root: string;
	id: string;
	name: string;
	completedAt: string;
	completedDate: string;
	/** Names from the `✅ Tasks` wrapper down to the item's parent. */
	path: string[];
	childCount: number;
}

/** The YYYY-MM-DD local date of an ISO timestamp in the given IANA time zone. */
export function completionDate(completedAt: string, timeZone: string): string
{
	return new Intl.DateTimeFormat(
		"en-CA",
		{
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		},
	).format(new Date(completedAt));
}

export function collectCompletedTasks(roots: readonly RootInput[], timeZone: string): CompletedRow[]
{
	const rows: CompletedRow[] = [];
	const walk = (root: string, node: CompletedNode, path: string[]): void =>
	{
		for (const child of node.children ?? [])
		{
			if (child.completedAt && child.id)
			{
				rows.push(
					{
						root,
						id: child.id,
						name: child.name,
						completedAt: child.completedAt,
						completedDate: completionDate(child.completedAt, timeZone),
						path,
						childCount: child.children?.length ?? 0,
					},
				);
			}
			else
			{
				walk(root, child, [...path, child.name]);
			}
		}
	};
	for (const {root, tree} of roots)
	{
		for (const wrapper of tree.children ?? [])
		{
			if (wrapper.name.startsWith("✅"))
			{
				walk(root, wrapper, [wrapper.name]);
			}
		}
	}
	return rows;
}

function isCompletedNode(value: unknown): value is CompletedNode
{
	return isObject(value) && typeof value.name === "string";
}

function main(argv: string[]): void
{
	const args = argv[Symbol.iterator]();
	let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const roots: RootInput[] = [];
	for (let next = args.next(); next.done !== true; next = args.next())
	{
		const arg = next.value;
		if (arg === "--timezone")
		{
			timeZone = takeValue(args, "--timezone");
			continue;
		}
		const [root, file] = arg.split("=");
		if (!root || !file)
		{
			throw new Error(`Expected Label=path.json, got: ${arg}`);
		}
		const tree: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isCompletedNode(tree))
		{
			throw new TypeError(`${file} must hold a node with a name`);
		}
		roots.push(
			{
				root,
				tree,
			},
		);
	}
	process.stdout.write(`${JSON.stringify(collectCompletedTasks(roots, timeZone), null, 2)}\n`);
}

if (isMain(import.meta.url))
{
	main(process.argv.slice(2));
}
