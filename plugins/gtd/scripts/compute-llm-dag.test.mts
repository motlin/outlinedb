// Run: node --test plugins/gtd/scripts/compute-llm-dag.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {computeLlmDag} from "./compute-llm-dag.mts";
import type {TreeNode} from "./compute-overdue.mts";
import {at} from "./test-helpers.mts";

interface TaskSpec
{
	name: string;
	id: string;
	date: string;
	command: string;
	interval?: string;
	auto?: boolean;
}

const time = (date: string, label: string): string =>
{
	const [year, month, day] = date.split("-").map(Number);
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${label}</time> `;
};

const instruction = (name: string): TreeNode => (
{
	name,
	children: [],
});

const task = ({name, id, date, command, interval, auto = false}: TaskSpec): TreeNode => (
{
	name: `${name} ${time(date, "Sat, Jan 1, 2000")}`,
	id,
	shortId: `${id}-short`,
	completedAt: null,
	children: [
		instruction(`/gtd:${command}`),
		...(interval ? [instruction(`Interval: ${interval}`)] : []),
		...(auto ? [instruction("Auto")] : []),
	],
});

const presentation = ({name, id, command}: Omit<TaskSpec, "date">): TreeNode => (
{
	name,
	id,
	shortId: `${id}-short`,
	completedAt: null,
	children: [instruction(`/gtd:${command}`)],
});

/** The root's child with this name, whose children array the test then edits in place. */
function childrenOf(tree: TreeNode, name: string): TreeNode[]
{
	const child = tree.children?.find((candidate) => candidate.name === name);
	assert.ok(child?.children, `expected a ${name} node with children`);
	return child.children;
}

/** The first child of the root's child with this name. */
function firstChildOf(tree: TreeNode, name: string): TreeNode
{
	const children = childrenOf(tree, name);
	assert.ok(children.length > 0, `expected ${name} to have a child`);
	return at(children, 0);
}

/** The node's children array, created when absent so a test can append to it. */
function ownChildren(node: TreeNode): TreeNode[]
{
	node.children ??= [];
	return node.children;
}

const fixture = (): TreeNode => (
{
	name: "LLM Tasks:",
	children: [
		{
			name: "Import",
			id: "import",
			children: [instruction("op run -- just daily")],
		},
		{
			name: "Prep",
			id: "prep",
			children: [
				task(
					{
						name: "Daily task",
						id: "daily",
						date: "2000-01-01",
						command: "daily-prep",
					},
				),
				{
					name: "Serial: calendar",
					id: "serial",
					children: [
						task(
							{
								name: "Weekly task",
								id: "weekly",
								date: "1999-12-31",
								command: "weekly-prep",
								interval: "7d",
							},
						),
					],
				},
				task(
					{
						name: "Future auto task",
						id: "future",
						date: "2000-01-02",
						command: "future-auto",
						auto: true,
					},
				),
			],
		},
		{
			name: "Presentation",
			id: "presentation",
			children: [
				presentation(
					{
						name: "Weekly task",
						id: "weekly-presentation",
						command: "weekly-apply",
					},
				),
				presentation(
					{
						name: "Daily task",
						id: "daily-presentation",
						command: "daily-apply",
					},
				),
			],
		},
	],
});

test("computeLlmDag inherits due state from prep and preserves presentation order", () =>
{
	const plan = computeLlmDag(fixture(), "2000-01-01");

	assert.deepStrictEqual(
		plan.prepBranches.map((branch) => (
		{
			mode: branch.mode,
			slugs: branch.tasks.map((item) => item.slug),
		})),
		[
			{
				mode: "parallel",
				slugs: ["daily"],
			},
			{
				mode: "serial",
				slugs: ["weekly"],
			},
		],
	);
	assert.deepStrictEqual(
		plan.presentation.map((item) => item.slug),
		["weekly", "daily"],
	);
	assert.deepStrictEqual(plan.skipped, [
		{
			slug: "future",
			reason: "future",
			dueDate: "2000-01-02",
		},
	]);
});

test("computeLlmDag defaults to daily and honors explicit weekly intervals", () =>
{
	const plan = computeLlmDag(fixture(), "2000-01-01");
	const tasks = plan.prepBranches.flatMap((branch) => branch.tasks);
	const daily = tasks.find((item) => item.slug === "daily");
	const weekly = tasks.find((item) => item.slug === "weekly");
	assert.ok(daily && weekly);

	assert.deepStrictEqual(
		daily.interval,
		{
			amount: 1,
			unit: "d",
		},
	);
	assert.strictEqual(daily.advance.nextDate, "2000-01-02");
	assert.deepStrictEqual(
		weekly.interval,
		{
			amount: 7,
			unit: "d",
		},
	);
	assert.strictEqual(weekly.advance.nextDate, "2000-01-08");
	assert.match(weekly.advance.applyOp, /--id weekly/u);
	assert.match(weekly.advance.applyOp, /--expect-name/u);
});

test("computeLlmDag records the plan date that every next date is computed from", () =>
{
	const plan = computeLlmDag(fixture(), "2000-01-01");

	assert.strictEqual(plan.planDate, "2000-01-01");
	assert.strictEqual(at(at(plan.prepBranches, 0).tasks, 0).advance.nextDate, "2000-01-02");
});

test("computeLlmDag rejects a plan date that is not a padded ISO date", () =>
{
	// The executor compares planDate to the local date, so an unpadded or empty date never
	// matches and would restart the import barrier forever instead of failing loudly here.
	assert.throws(() => computeLlmDag(fixture(), "2000-1-1"), /plan date must be YYYY-MM-DD, got "2000-1-1"/u);
});

test("computeLlmDag rejects unexpected root children", () =>
{
	const tree = fixture();
	ownChildren(tree).push(
		task(
			{
				name: "Orphan",
				id: "orphan",
				date: "2000-01-01",
				command: "orphan-prep",
			},
		),
	);

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /unexpected child "Orphan/u);
});

test("computeLlmDag rejects unmatched task names", () =>
{
	const tree = fixture();
	childrenOf(tree, "Presentation").pop();

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /prep task "Daily task" has no matching presentation task/u);
});

test("computeLlmDag rejects dates on presentation tasks", () =>
{
	const tree = fixture();
	const item = firstChildOf(tree, "Presentation");
	item.name += ` ${time("2000-01-01", "Sat, Jan 1, 2000")}`;

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /presentation task "Weekly task" must inherit its date/u);
});

test("computeLlmDag rejects invalid intervals", () =>
{
	const tree = fixture();
	const item = firstChildOf(tree, "Prep");
	ownChildren(item).push(instruction("Interval: weekly"));

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /invalid interval "weekly"/u);
});

test("computeLlmDag rejects a presentation task for an auto prep task", () =>
{
	const tree = fixture();
	childrenOf(tree, "Presentation").push(
		presentation(
			{
				name: "Future auto task",
				id: "future-presentation",
				command: "future-apply",
			},
		),
	);

	assert.throws(
		() => computeLlmDag(tree, "2000-01-01"),
		/auto prep task "Future auto task" must not have a presentation task/u,
	);
});

test("computeLlmDag infers the artifact slug from the prep command", () =>
{
	const tree = fixture();
	const prep = childrenOf(tree, "Prep");
	prep.unshift(
		task(
			{
				name: "Refine exercise",
				id: "exercise",
				date: "2000-01-01",
				command: "refine-exercise-prep",
			},
		),
	);
	const presentations = childrenOf(tree, "Presentation");
	presentations.push(
		presentation(
			{
				name: "Refine exercise",
				id: "exercise-presentation",
				command: "refine-exercise-apply",
			},
		),
	);

	prep.unshift(
		{
			name: `Backups prune ${time("2000-01-01", "Sat, Jan 1, 2000")}`,
			id: "prune",
			shortId: "prune-short",
			completedAt: null,
			children: [
				instruction("Run the script below."),
				instruction("<code>echo prune</code>"),
				instruction("Auto"),
			],
		},
	);

	const plan = computeLlmDag(tree, "2000-01-01");
	assert.deepStrictEqual(
		at(plan.prepBranches, 0).tasks.map((item) => item.slug),
		["backups-prune"],
	);
	assert.strictEqual(at(at(plan.prepBranches, 1).tasks, 0).slug, "refine-exercise");
	assert.strictEqual(plan.presentation.at(-1)?.slug, "refine-exercise");
});

test("computeLlmDag pairs different commands through the shared task name", () =>
{
	const tree = fixture();
	const prep = childrenOf(tree, "Prep");
	prep.unshift(
		task(
			{
				name: "Process inbox",
				id: "inbox",
				date: "2000-01-01",
				command: "refine-inbox",
			},
		),
	);
	const presentations = childrenOf(tree, "Presentation");
	presentations.push(
		presentation(
			{
				name: "Process inbox",
				id: "inbox-presentation",
				command: "inbox",
			},
		),
	);

	const plan = computeLlmDag(tree, "2000-01-01");
	assert.strictEqual(at(at(plan.prepBranches, 0).tasks, 0).slug, "refine-inbox");
	assert.strictEqual(plan.presentation.at(-1)?.slug, "refine-inbox");
});

test("computeLlmDag rejects duplicate inferred slugs", () =>
{
	const tree = fixture();
	const prep = childrenOf(tree, "Prep");
	prep.push(
		task(
			{
				name: "Another daily task",
				id: "another-daily",
				date: "2000-01-01",
				command: "daily-auto",
				auto: true,
			},
		),
	);

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /Prep has duplicate slug "daily"/u);
});

test("computeLlmDag rejects obsolete Key markers", () =>
{
	const tree = fixture();
	const item = firstChildOf(tree, "Prep");
	ownChildren(item).push(instruction("Key: daily"));

	assert.throws(() => computeLlmDag(tree, "2000-01-01"), /obsolete Key marker/u);
});
