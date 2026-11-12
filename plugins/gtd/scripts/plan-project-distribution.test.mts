// Run: node --test plugins/gtd/scripts/plan-project-distribution.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {expandHome, parseProjectDirectories, planProjects} from "./plan-project-distribution.mts";

const projectNode = (name: string, pathName: string, linkName?: string) => (
{
	name,
	shortId: `${name}-short`,
	id: `${name}-id`,
	children: [
		{
			name: pathName,
			shortId: `${name}-path`,
			id: `${name}-path-id`,
		},
		...(linkName
			? [
					{
						name: linkName,
						shortId: `${name}-link`,
						id: `${name}-link-id`,
					},
				]
			: []),
	],
});

test("expandHome replaces a leading tilde only", () =>
{
	assert.strictEqual(expandHome("~/projects/alpha", "/home/me"), "/home/me/projects/alpha");
	assert.strictEqual(expandHome("/opt/alpha", "/home/me"), "/opt/alpha");
	assert.strictEqual(expandHome("/opt/~alpha", "/home/me"), "/opt/~alpha");
});

test("parseProjectDirectories reads name, absolute path, tasks link, and tag", () =>
{
	const exported =
	{
		name: "📂 Project Directories",
		children: [
			projectNode(
				"alpha",
				"~/projects/alpha",
				'<a href="https://workflowy.com/#/9faf73f167aa">📦 Alpha #alpha-tag</a>',
			),
			projectNode("beta", "/opt/beta"),
		],
	};
	assert.deepStrictEqual(parseProjectDirectories(exported, "/home/me"), [
		{
			name: "alpha",
			path: "/home/me/projects/alpha",
			tasksShortId: "9faf73f167aa",
			tasksName: "📦 Alpha #alpha-tag",
			tags: ["#alpha-tag"],
		},
		{
			name: "beta",
			path: "/opt/beta",
			tasksShortId: null,
			tasksName: null,
			tags: [],
		},
	]);
});

test("parseProjectDirectories skips a project with no path child", () =>
{
	const exported =
	{
		children: [
			{
				name: "empty",
				shortId: "e",
				id: "e-id",
				children: [],
			},
		],
	};
	assert.deepStrictEqual(parseProjectDirectories(exported, "/home/me"), []);
});

test("planProjects marks open panes by exact cwd or a subdirectory, and todo presence", () =>
{
	const projects = [
		{
			name: "alpha",
			path: "/p/alpha",
			tasksShortId: null,
			tasksName: null,
			tags: [],
		},
		{
			name: "beta",
			path: "/p/beta",
			tasksShortId: null,
			tasksName: null,
			tags: [],
		},
		{
			name: "gamma",
			path: "/p/gamma",
			tasksShortId: null,
			tasksName: null,
			tags: [],
		},
	];
	const panes = [
		{
			pane_id: "w1:p1",
			tab_id: "w1:t1",
			workspace_id: "w1",
			cwd: "/p/alpha",
		},
		{
			pane_id: "w1:p2",
			tab_id: "w1:t2",
			workspace_id: "w1",
			cwd: "/p/beta/sub",
		},
		{
			pane_id: "w1:p3",
			tab_id: "w1:t3",
			workspace_id: "w1",
			cwd: "/p/gamma-other",
		},
	];
	const todoExists = (path: string): boolean => path === "/p/alpha/.llm/todo.md";
	const isToplevel = (path: string): boolean => path !== "/p/beta";
	assert.deepStrictEqual(planProjects(projects, panes, todoExists, isToplevel), [
		{
			name: "alpha",
			path: "/p/alpha",
			tasksShortId: null,
			tasksName: null,
			tags: [],
			todoPath: "/p/alpha/.llm/todo.md",
			todoExists: true,
			notGitToplevel: false,
			openPanes: [
				{
					paneId: "w1:p1",
					tabId: "w1:t1",
					workspaceId: "w1",
				},
			],
		},
		{
			name: "beta",
			path: "/p/beta",
			tasksShortId: null,
			tasksName: null,
			tags: [],
			todoPath: "/p/beta/.llm/todo.md",
			todoExists: false,
			notGitToplevel: true,
			openPanes: [
				{
					paneId: "w1:p2",
					tabId: "w1:t2",
					workspaceId: "w1",
				},
			],
		},
		{
			name: "gamma",
			path: "/p/gamma",
			tasksShortId: null,
			tasksName: null,
			tags: [],
			todoPath: "/p/gamma/.llm/todo.md",
			todoExists: false,
			notGitToplevel: false,
			openPanes: [],
		},
	]);
});
