import {expect, describe, it} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import Schema from "../../../src/commands/node/schema.js";

const EXPECTED_STDOUT = `// Output type for: node get --json
// Source: NodeTree
interface NodeGetOutput {
  children?: NodeGetOutput[];
  linkTargets?: LinkTarget[];
  inChat: boolean;
  hasReferencesRoot: boolean;
  id: string;
  shortId: string | null;
  parentId: string | null;
  name: string | null;
  note: string | null;
  priority: number;
  layoutMode: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  completedAt: string | null;
  collapsed: boolean;
  mirror: { isMirror: boolean; originalNodeId: string | null };
  systemFrom: string;
  systemTo: string;
}


interface LinkTarget {
  shortId: string | null;
  children?: NodeGetOutput[];
  id: string;
  parentId: string | null;
  name: string | null;
  note: string | null;
  priority: number;
  layoutMode: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  completedAt: string | null;
  collapsed: boolean;
  mirror: { isMirror: boolean; originalNodeId: string | null };
  systemFrom: string;
  systemTo: string;
}


// Output type for: node list --json
// Source: NodeTree
interface NodeListOutput {
  children?: NodeListOutput[];
  linkTargets?: LinkTarget[];
  inChat: boolean;
  hasReferencesRoot: boolean;
  id: string;
  shortId: string | null;
  parentId: string | null;
  name: string | null;
  note: string | null;
  priority: number;
  layoutMode: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  completedAt: string | null;
  collapsed: boolean;
  mirror: { isMirror: boolean; originalNodeId: string | null };
  systemFrom: string;
  systemTo: string;
}


interface LinkTarget {
  shortId: string | null;
  children?: NodeListOutput[];
  id: string;
  parentId: string | null;
  name: string | null;
  note: string | null;
  priority: number;
  layoutMode: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  completedAt: string | null;
  collapsed: boolean;
  mirror: { isMirror: boolean; originalNodeId: string | null };
  systemFrom: string;
  systemTo: string;
}


// Output type for: node search --json
// Source: TextSearchResult
interface NodeSearchOutput {
  shortId: string | null;
  name: string | null;
  note: string | null;
  path: string;
}

// Output type for: node changes --json
// Source: ChangeDetectionResult
interface NodeChangesOutput {
  changes: NodeChange[];
  tree: ChangeTreeNode[];
  summary: ChangeSummary;
  cutoffDate: string;
}

interface NodeChange {
  id: string;
  isNew: boolean;
  isDeleted: boolean;
  contentChanged: boolean;
  parentChanged: boolean;
  completionChanged: boolean;
  noteChanged: boolean;
  oldName: string | null;
  oldNote: string | null;
  oldParentId: string | null;
  oldCompletedAt: string | null;
  currentName: string | null;
  currentNote: string | null;
  currentParentId: string | null;
  currentCompletedAt: string | null;
  parentId: string | null;
}

interface ChangeTreeNode {
  id: string;
  name: string | null;
  isContext: boolean;
  change: NodeChange | null;
  children: ChangeTreeNode[];
}



interface ChangeSummary {
  added: number;
  deleted: number;
  changed: number;
  moved: number;
  completed: number;
  uncompleted: number;
}

`;

const EXPECTED_MIRROR_STDOUT = `// Output type for: node mirror --json
// Source: NodeMirrorResult
interface NodeMirrorOutput {
  action: string;
  mirrorId: string;
  originId: string | null;
  parentId: string | null;
}
`;

describe("node schema command", () =>
{
	it("generates schema for all commands", async () =>
	{
		const {stdout} = await captureOutput(async () =>
		{
			await Schema.run([]);
		});

		expect(stdout).toBe(EXPECTED_STDOUT + EXPECTED_MIRROR_STDOUT);
	});

	it("generates schema for node mirror", async () =>
	{
		const {stdout} = await captureOutput(async () =>
		{
			await Schema.run(["--command", "mirror"]);
		});

		expect(stdout).toBe(EXPECTED_MIRROR_STDOUT);
	});

	it("has correct description", () =>
	{
		expect(Schema.description).toBe("Show JSON output schema for node commands (for LLM discovery)");
	});

	it("has examples", () =>
	{
		expect(Schema.examples).toStrictEqual([
			"# Show all command output schemas",
			"<%= config.bin %> <%= command.id %>",
			"",
			"# Show schema for a specific command",
			"<%= config.bin %> <%= command.id %> --command get",
		]);
	});
});
