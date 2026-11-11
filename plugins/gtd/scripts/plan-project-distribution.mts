#!/usr/bin/env node
// Build the project table for the daily-review Distribute phase: each project's absolute path,
// its .llm/todo.md, its Workflowy tasks link and tags, and any herdr panes already open in it.
// Usage: plan-project-distribution.mts --projects <project-directories.json> --panes <herdr-pane-list.json>
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, realpathSync} from "node:fs";
import {homedir} from "node:os";
import {arrayField, errorMessage, isObject, parseJson, stringField} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface ProjectNode {
	name: string;
	children?: ProjectNode[];
}

export interface ProjectEntry {
	name: string;
	path: string;
	tasksShortId: string | null;
	tasksName: string | null;
	tags: string[];
}

export interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd?: string;
}

export interface PlannedProject extends ProjectEntry {
	todoPath: string;
	todoExists: boolean;
	notGitToplevel: boolean;
	openPanes: {paneId: string; tabId: string; workspaceId: string}[];
}

export function expandHome(path: string, home: string): string {
	if (path === "~") {
		return home;
	}
	return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

const LINK = /<a href="https:\/\/workflowy\.com\/#\/([0-9a-f]+)">(.*?)<\/a>/u;

export function parseProjectDirectories(exported: {children?: ProjectNode[]}, home: string): ProjectEntry[] {
	return (exported.children ?? []).flatMap((project): ProjectEntry[] => {
		const children = project.children ?? [];
		const pathChild = children.at(0);
		const linkChild = children.at(1);
		if (pathChild === undefined) {
			return [];
		}
		const link = linkChild === undefined ? null : LINK.exec(linkChild.name);
		const tasksName = link ? (link[2] ?? null) : null;
		return [
			{
				name: project.name,
				path: expandHome(pathChild.name.trim(), home),
				tasksShortId: link ? (link[1] ?? null) : null,
				tasksName,
				tags: tasksName ? (tasksName.match(/#[\w-]+/gu) ?? []) : [],
			},
		];
	});
}

export function planProjects(
	projects: readonly ProjectEntry[],
	panes: readonly HerdrPane[],
	todoExists: (path: string) => boolean,
	checkGitToplevel: (path: string) => boolean,
): PlannedProject[] {
	return projects.map((project) => {
		const todoPath = `${project.path}/.llm/todo.md`;
		const openPanes = panes
			.filter((pane) => pane.cwd === project.path || pane.cwd?.startsWith(`${project.path}/`))
			.map((pane) => ({paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id}));
		return {
			...project,
			todoPath,
			todoExists: todoExists(todoPath),
			notGitToplevel: !checkGitToplevel(project.path),
			openPanes,
		};
	});
}

export function isGitToplevel(path: string): boolean {
	try {
		const top = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return realpathSync(top) === realpathSync(path);
	} catch {
		return false;
	}
}

function toProjectNode(value: unknown): ProjectNode {
	if (!isObject(value)) {
		return {name: ""};
	}
	return {name: stringField(value, "name") ?? "", children: arrayField(value, "children").map(toProjectNode)};
}

function toPanes(paneList: unknown): HerdrPane[] {
	if (!isObject(paneList)) {
		return [];
	}
	const raw = isObject(paneList.result) ? paneList.result.panes : paneList.panes;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter(isObject).map((pane) => ({
		pane_id: stringField(pane, "pane_id") ?? "",
		tab_id: stringField(pane, "tab_id") ?? "",
		workspace_id: stringField(pane, "workspace_id") ?? "",
		cwd: stringField(pane, "cwd"),
	}));
}

function main(): void {
	const args = process.argv.slice(2);
	const value = (flag: string): string => {
		const index = args.indexOf(flag);
		const file = index === -1 ? undefined : args[index + 1];
		if (!file) {
			throw new Error(`${flag} <file> is required`);
		}
		return file;
	};
	const exported = toProjectNode(parseJson(readFileSync(value("--projects"), "utf8")));
	const panes = toPanes(parseJson(readFileSync(value("--panes"), "utf8")));
	const plan = planProjects(parseProjectDirectories(exported, homedir()), panes, existsSync, isGitToplevel);
	process.stdout.write(`${JSON.stringify(plan, null, "\t")}\n`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n`);
		process.exit(1);
	}
}
