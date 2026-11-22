#!/usr/bin/env node
import
{
	addInterval,
	buildTimeElement,
	localTodayISO,
	parseTimeISO,
	readTreeFile,
	swapTimeElement,
} from "./compute-overdue.mts";
import type {Interval, TreeNode, TreeRoot} from "./compute-overdue.mts";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";
import {DISKS_PREFIX, missingDisks, requiredDisks} from "./disk-marker.mts";
import {chmodSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";

const ROOT_NAMES = new Set(["Import", "Prep", "Presentation"]);
const PLAN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INTERVAL_PREFIX = "Interval: ";
const FILE_PREFIX = "File: ";
const TEST_PREFIX = "Test: ";
/** Where test files land, relative to the scripts directory; the planner owns and rewrites it. */
export const TESTS_SUBDIRECTORY = "tests";
const FILE_NAME_PATTERN = /^[\w.-]+$/u;
const SCRIPTS_DIRECTORY = ".llm/gtd/review/scripts";
const SCRIPT_REFERENCE_PATTERN = /\.llm\/gtd\/review\/scripts\/([\w.-]*[\w-])/gu;
const INTERVAL_PATTERN = /^(\d+)([dmy])$/u;
const TASK_COMMAND_PATTERN = /^\/[a-z0-9-]+:([a-z0-9-]+)(?:\s|$)/u;

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const markerChildren = (node: TreeNode, prefix: string): TreeNode[] =>
	(node.children ?? []).filter((child) => child.name.startsWith(prefix));

function optionalMarker(node: TreeNode, prefix: string, context: string): string | null
{
	const matches = markerChildren(node, prefix);
	if (matches.length > 1)
	{
		throw new Error(`${context} has multiple ${prefix.trim()} markers`);
	}
	return matches[0]?.name.slice(prefix.length) ?? null;
}

function isIntervalUnit(unit: string): unit is Interval["unit"]
{
	return unit === "d" || unit === "m" || unit === "y";
}

function parseInterval(node: TreeNode, context: string): Interval
{
	const value = optionalMarker(node, INTERVAL_PREFIX, context);
	if (value === null)
	{
		return {
			amount: 1,
			unit: "d",
		};
	}
	const match = value.match(INTERVAL_PATTERN);
	const unit = match?.[2] ?? "";
	if (!match || Number(match[1]) === 0 || !isIntervalUnit(unit))
	{
		throw new Error(`${context} has invalid interval "${value}"`);
	}
	return {
		amount: Number(match[1]),
		unit,
	};
}

function isMarker(child: TreeNode): boolean
{
	const name = child.name;
	return (
		name.startsWith(INTERVAL_PREFIX) ||
		name.startsWith(FILE_PREFIX) ||
		name.startsWith(DISKS_PREFIX) ||
		name === "Auto"
	);
}

function instructions(node: TreeNode, context: string): TreeNode[]
{
	const obsoleteKey = (node.children ?? []).find((child) => child.name.startsWith("Key:"));
	if (obsoleteKey)
	{
		throw new Error(`${context} has obsolete Key marker "${obsoleteKey.name}"`);
	}
	const result = (node.children ?? []).filter((child) => !isMarker(child) && child.name.trim() !== "");
	if (result.length === 0)
	{
		throw new Error(`${context} has no instructions`);
	}
	return result;
}

function taskDisplayName(name: string): string
{
	return name.replaceAll(/<time[^>]*>.*?<\/time>\s*/gu, "").trim();
}

/** The prep command's slug, or the task name's when the task is plain instructions (inline shell, prose) with no command. */
function taskSlug(taskInstructions: TreeNode[], context: string, name: string): string
{
	const commandSlugs = taskInstructions.flatMap((instruction) =>
	{
		const slug = instruction.name.trim().match(TASK_COMMAND_PATTERN)?.[1];
		return slug ? [slug] : [];
	});
	if (commandSlugs.length > 1)
	{
		throw new Error(`${context} must have at most one plugin command`);
	}
	const [slug] = commandSlugs;
	if (slug === undefined)
	{
		return name
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, "-")
			.replaceAll(/^-|-$/gu, "");
	}
	return slug.replace(/-(?:prep|auto)$/u, "");
}

interface PrepTask
{
	slug: string;
	name: string;
	id: string | undefined;
	shortId: string | null | undefined;
	instructions: TreeNode[];
	auto: boolean;
	due: boolean;
	prepped: boolean;
	disks: string[];
	missingDisks: string[];
	dueDate: string;
	interval: Interval;
	advance:
	{
		nextDate: string;
		newName: string;
		applyOp: string;
	};
}

interface PresentationTask
{
	name: string;
	id: string | undefined;
	shortId: string | null | undefined;
	instructions: TreeNode[];
}

function parsePrepTask(node: TreeNode, today: string): PrepTask
{
	const name = taskDisplayName(node.name);
	const context = `prep task "${name}"`;
	const taskInstructions = instructions(node, context);
	const slug = taskSlug(taskInstructions, context, name);
	const dueDate = parseTimeISO(node.name);
	if (dueDate === null)
	{
		throw new Error(`${context} is missing its date`);
	}
	const interval = parseInterval(node, context);
	const autoMarkers = (node.children ?? []).filter((child) => child.name === "Auto");
	if (autoMarkers.length > 1)
	{
		throw new Error(`${context} has multiple Auto markers`);
	}
	const due = node.completedAt === null && dueDate <= today;
	const nextDate = addInterval(today, interval);
	const newName = swapTimeElement(node.name, buildTimeElement(nextDate));

	return {
		slug,
		name,
		id: node.id,
		shortId: node.shortId,
		instructions: taskInstructions,
		auto: autoMarkers.length === 1,
		due,
		prepped: false,
		disks: requiredDisks(node),
		missingDisks: [],
		dueDate,
		interval,
		advance:
		{
			nextDate,
			newName,
			applyOp: `./bin/run.js node update --id ${node.id} --name ${shellSingleQuote(newName)} --expect-name ${shellSingleQuote(node.name)}`,
		},
	};
}

function parsePresentationTask(node: TreeNode): PresentationTask
{
	const name = taskDisplayName(node.name);
	const context = `presentation task "${name}"`;
	if (parseTimeISO(node.name) !== null)
	{
		throw new Error(`${context} must inherit its date from prep`);
	}
	if (markerChildren(node, INTERVAL_PREFIX).length > 0)
	{
		throw new Error(`${context} must inherit its interval from prep`);
	}
	if ((node.children ?? []).some((child) => child.name === "Auto"))
	{
		throw new Error(`${context} cannot be Auto`);
	}
	return {
		name,
		id: node.id,
		shortId: node.shortId,
		instructions: instructions(node, context),
	};
}

function uniqueBy<K extends string, T extends Record<K, string>>(
	tasks: T[],
	property: K,
	context: string,
): Map<string, T>
{
	const result = new Map<string, T>();
	for (const task of tasks)
	{
		const value = task[property];
		if (result.has(value))
		{
			throw new Error(`${context} has duplicate ${property} "${value}"`);
		}
		result.set(value, task);
	}
	return result;
}

interface RootGroups
{
	importNode: TreeNode;
	prepNode: TreeNode;
	presentationNode: TreeNode;
}

function rootGroups(tree: TreeRoot): RootGroups
{
	const children = tree.children ?? [];
	const firstUnexpected = children.find((child) => !ROOT_NAMES.has(child.name));
	if (firstUnexpected)
	{
		throw new Error(`LLM Tasks has unexpected child "${taskDisplayName(firstUnexpected.name)}"`);
	}
	const rootNamed = (name: string): TreeNode =>
	{
		const matches = children.filter((child) => child.name === name);
		const [match] = matches;
		if (matches.length !== 1 || !match)
		{
			throw new Error(`LLM Tasks must contain exactly one ${name} node`);
		}
		return match;
	};
	return {
		importNode: rootNamed("Import"),
		prepNode: rootNamed("Prep"),
		presentationNode: rootNamed("Presentation"),
	};
}

/**
 * `prepped` names the slugs already prepped earlier in this review session. A review that runs
 * past midnight recomputes its plan for the new local date, and without this every daily task,
 * including the ones just prepped, would come due again. Prepped tasks stay off the new plan and
 * are listed as skipped with an `advance` computed from the new date.
 *
 * `disks` names the disks disk-check.mts found available. A due task whose `Disks:` marker names
 * one that is missing is listed as skipped with reason `disks`, so it keeps its date. Null gates
 * nothing.
 */
export function computeLlmDag(
	tree: TreeRoot,
	today: string,
	prepped: ReadonlySet<string> = new Set(),
	disks: ReadonlySet<string> | null = null,
)
{
	// planDate ships in the plan and the executor compares it to the local date before advancing
	// any task. An unpadded date never matches, so it would restage the import barrier forever.
	if (!PLAN_DATE_PATTERN.test(today))
	{
		throw new Error(`plan date must be YYYY-MM-DD, got "${today}"`);
	}
	const {importNode, prepNode, presentationNode} = rootGroups(tree);
	const parsedBranches = (prepNode.children ?? []).map((child) =>
	{
		if (child.name.startsWith("Serial: "))
		{
			const serialTasks = child.children ?? [];
			if (serialTasks.length === 0)
			{
				throw new Error(`serial group "${child.name}" is empty`);
			}
			return {
				mode: "serial" as const,
				name: child.name.slice("Serial: ".length),
				tasks: serialTasks.map((task) => parsePrepTask(task, today)),
			};
		}
		return {
			mode: "parallel" as const,
			tasks: [parsePrepTask(child, today)],
		};
	});
	const allPrepTasks = parsedBranches.flatMap((branch) => branch.tasks);
	const allPresentationTasks = (presentationNode.children ?? []).map(parsePresentationTask);
	const prepByName = uniqueBy(allPrepTasks, "name", "Prep");
	const prepBySlug = uniqueBy(allPrepTasks, "slug", "Prep");
	for (const slug of prepped)
	{
		if (!prepBySlug.has(slug))
		{
			throw new Error(`prepped slug "${slug}" names no prep task`);
		}
	}
	for (const prepTask of allPrepTasks)
	{
		if (prepTask.due && prepped.has(prepTask.slug))
		{
			prepTask.due = false;
			prepTask.prepped = true;
		}
		if (prepTask.due && disks !== null)
		{
			prepTask.missingDisks = missingDisks(prepTask.disks, disks);
			prepTask.due = prepTask.missingDisks.length === 0;
		}
	}
	const presentationByName = uniqueBy(allPresentationTasks, "name", "Presentation");

	for (const prepTask of allPrepTasks)
	{
		if (prepTask.auto && presentationByName.has(prepTask.name))
		{
			throw new Error(`auto prep task "${prepTask.name}" must not have a presentation task`);
		}
		if (!prepTask.auto && !presentationByName.has(prepTask.name))
		{
			throw new Error(`prep task "${prepTask.name}" has no matching presentation task`);
		}
	}
	for (const presentationTask of allPresentationTasks)
	{
		if (!prepByName.has(presentationTask.name))
		{
			throw new Error(`presentation task "${presentationTask.name}" has no matching prep task`);
		}
	}

	const prepBranches = parsedBranches
		.map((branch) => (
		{
			...branch,
			tasks: branch.tasks.filter((task) => task.due),
		}))
		.filter((branch) => branch.tasks.length > 0);
	const dueNames = new Set(allPrepTasks.filter((task) => task.due).map((task) => task.name));
	const presentation = allPresentationTasks
		.filter((task) => dueNames.has(task.name))
		.map((task) => (
		{
			...task,
			slug: prepByName.get(task.name)?.slug,
		}));
	const skipped = allPrepTasks
		.filter((task) => !task.due)
		.map((task) =>
		{
			if (task.prepped)
			{
				return {
					slug: task.slug,
					reason: "prepped",
					dueDate: task.dueDate,
					advance: task.advance,
				};
			}
			if (task.missingDisks.length > 0)
			{
				return {
					slug: task.slug,
					reason: "disks",
					dueDate: task.dueDate,
					missingDisks: task.missingDisks,
				};
			}
			return {
				slug: task.slug,
				reason: task.dueDate > today ? "future" : "completed",
				dueDate: task.dueDate,
			};
		});

	return {
		planDate: today,
		import:
		{
			id: importNode.id,
			instructions: instructions(importNode, "Import"),
		},
		prepBranches,
		presentation,
		skipped,
	};
}

export interface TaskFile
{
	name: string;
	content: string;
}

/**
 * The task a node belongs to, phrased like the planner's other errors: the first node below the
 * Import, Prep, Presentation, and Serial group levels.
 */
function taskContext(path: TreeNode[]): string
{
	const [group, ...rest] = path;
	if (group === undefined)
	{
		return "LLM Tasks";
	}
	if (group.name === "Import")
	{
		return "Import";
	}
	const task = rest[0]?.name.startsWith("Serial: ") ? rest[1] : rest[0];
	const kind = group.name === "Presentation" ? "presentation" : "prep";
	return task === undefined ? group.name : `${kind} task "${taskDisplayName(task.name)}"`;
}

/**
 * Every `File: <name>` node in the tree, in document order. Its note is the file's exact content,
 * so a task's scripts live in Workflowy and are written to disk before the tasks run. A name or
 * note that runs `.llm/gtd/review/scripts/<name>` with no matching File node fails the plan here,
 * naming its task, rather than leaving the worker to find the script missing.
 *
 * A `Test: <name>` node beside a File node holds that script's test, returned as
 * `tests/<name>`; run-review-script-tests.mts runs them all.
 */
export function taskFiles(tree: TreeNode): TaskFile[]
{
	const files: TaskFile[] = [];
	const references:
	{
		name: string;
		context: string;
	}[] = [];
	const visit = (node: TreeNode, path: TreeNode[]): void =>
	{
		const context = taskContext(path);
		for (const text of [node.name, node.note ?? ""])
		{
			for (const match of text.matchAll(SCRIPT_REFERENCE_PATTERN))
			{
				references.push(
					{
						name: match[1] ?? "",
						context,
					},
				);
			}
		}
		const prefix = [FILE_PREFIX, TEST_PREFIX].find((candidate) => node.name.startsWith(candidate));
		if (prefix !== undefined)
		{
			const kind = prefix.slice(0, -2);
			const name = node.name.slice(prefix.length).trim();
			if (!FILE_NAME_PATTERN.test(name) || name.startsWith("."))
			{
				throw new Error(`${context} ${kind} "${name}" must be a plain file name`);
			}
			if (node.note == null || node.note === "")
			{
				throw new Error(`${context} ${kind} "${name}" has no note`);
			}
			const outputName = prefix === TEST_PREFIX ? `${TESTS_SUBDIRECTORY}/${name}` : name;
			if (files.some((file) => file.name === outputName))
			{
				throw new Error(`${context} has duplicate ${kind} "${name}"`);
			}
			const siblings = path.at(-2)?.children ?? tree.children ?? [];
			if (prefix === TEST_PREFIX && !siblings.some((sibling) => sibling.name.startsWith(FILE_PREFIX)))
			{
				throw new Error(`${context} Test "${name}" has no File sibling to test`);
			}
			files.push(
				{
					name: outputName,
					content: node.note,
				},
			);
		}
		for (const child of node.children ?? [])
		{
			visit(child, [...path, child]);
		}
	};
	visit(tree, []);
	const defined = new Set(files.map((file) => file.name));
	const missing = references.find((reference) => !defined.has(reference.name));
	if (missing)
	{
		throw new Error(
			`${missing.context} references ${SCRIPTS_DIRECTORY}/${missing.name}, but no "${FILE_PREFIX}${missing.name}" node defines it`,
		);
	}
	return files;
}

/** Writes each file under the directory, first clearing tests/ so a deleted Test node stops running. */
function writeTaskFiles(files: TaskFile[], directory: string): void
{
	rmSync(
		join(directory, TESTS_SUBDIRECTORY),
		{
			recursive: true,
			force: true,
		},
	);
	for (const {name, content} of files)
	{
		const path = join(directory, name);
		mkdirSync(
			dirname(path),
			{
				recursive: true,
			},
		);
		writeFileSync(path, content);
		chmodSync(path, 0o755);
	}
}

function main(arguments_: string[]): void
{
	const argumentsList = arguments_.slice(2);
	let inputPath = ".llm/gtd/review/phase0-llm-tasks.json";
	let today = localTodayISO();
	let filesDirectory: string | null = null;
	const prepped = new Set<string>();
	let disks: Set<string> | null = null;
	const argumentIterator = argumentsList[Symbol.iterator]();
	for (const argument of argumentIterator)
	{
		if (argument === "--today")
		{
			today = takeValue(argumentIterator, argument);
		}
		else if (argument === "--prepped")
		{
			for (const slug of takeValue(argumentIterator, argument).split(","))
			{
				if (slug !== "")
				{
					prepped.add(slug);
				}
			}
		}
		else if (argument === "--disks")
		{
			disks = new Set(
				takeValue(argumentIterator, argument)
					.split(",")
					.filter((name) => name !== ""),
			);
		}
		else if (argument === "--files-dir")
		{
			filesDirectory = takeValue(argumentIterator, argument);
		}
		else if (argument.startsWith("--"))
		{
			throw new Error(`unknown option: ${argument}`);
		}
		else
		{
			inputPath = argument;
		}
	}
	const tree = readTreeFile(inputPath);
	const plan = computeLlmDag(tree, today, prepped, disks);
	if (filesDirectory !== null)
	{
		writeTaskFiles(taskFiles(tree), filesDirectory);
	}
	process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (isMain(import.meta.url))
{
	main(process.argv);
}
