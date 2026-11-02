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

const ROOT_NAMES = new Set(["Import", "Prep", "Presentation"]);
const PLAN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INTERVAL_PREFIX = "Interval: ";
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
	return name.startsWith(INTERVAL_PREFIX) || name === "Auto";
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

export function computeLlmDag(tree: TreeRoot, today: string)
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
	uniqueBy(allPrepTasks, "slug", "Prep");
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
		.map((task) => (
		{
			slug: task.slug,
			reason: task.dueDate > today ? "future" : "completed",
			dueDate: task.dueDate,
		}));

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

function main(arguments_: string[]): void
{
	const argumentsList = arguments_.slice(2);
	let inputPath = ".llm/gtd/review/phase0-llm-tasks.json";
	let today = localTodayISO();
	const argumentIterator = argumentsList[Symbol.iterator]();
	for (const argument of argumentIterator)
	{
		if (argument === "--today")
		{
			today = takeValue(argumentIterator, argument);
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
	process.stdout.write(`${JSON.stringify(computeLlmDag(tree, today), null, 2)}\n`);
}

if (isMain(import.meta.url))
{
	main(process.argv);
}
