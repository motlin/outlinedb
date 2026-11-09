import {expect, describe, it} from "vite-plus/test";
import {parseMarkdownContent, resolveCommandId} from "./markdown-parser.js";

describe("markdown-parser", () => {
	describe("resolveCommandId", () => {
		it("resolves two-word command to colon-separated ID", () => {
			const result = resolveCommandId(["node", "create"]);
			expect(result).toStrictEqual({command: "node:create", remaining: []});
		});

		it("resolves three-word command", () => {
			const result = resolveCommandId(["utils", "path-to-id"]);
			expect(result).toStrictEqual({command: "utils:path-to-id", remaining: []});
		});

		it("resolves four-word command", () => {
			const result = resolveCommandId(["gtd", "cache", "data", "source"]);
			expect(result).toStrictEqual({command: "gtd:cache:data:source", remaining: []});
		});

		it("returns remaining tokens after command resolution", () => {
			const result = resolveCommandId(["node", "list"]);
			expect(result).toStrictEqual({command: "node:list", remaining: []});
		});

		it("handles single-word command with flag following", () => {
			const result = resolveCommandId(["--help"]);
			// Starts with -, so no command words found
			expect(result).toStrictEqual({command: "--help", remaining: []});
		});
	});

	describe("CLI invocation extraction", () => {
		it("extracts a simple CLI invocation", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node list --verbose");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:list", flags: ["verbose"], line: 1, raw: "./bin/run.js node list --verbose"},
			]);
		});

		it("extracts CLI invocation with short flags", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node get -i abc123");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:get", flags: ["i"], line: 1, raw: "./bin/run.js node get -i abc123"},
			]);
		});

		it("handles multiline commands with continuation", () => {
			const content = [
				"./bin/run.js node create \\",
				'  --parent-path "Work,Tasks" \\',
				'  --name "New Task" \\',
				"  --verbose",
			].join("\n");
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "node:create",
					flags: ["parent-path", "name", "verbose"],
					line: 1,
					raw: './bin/run.js node create    --parent-path "Work,Tasks"    --name "New Task"    --verbose',
				},
			]);
		});

		it("handles LOG_LEVEL prefix before ./bin/run.js", () => {
			const analysis = parseMarkdownContent("test.md", "LOG_LEVEL=fatal ./bin/run.js node list --json");
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "node:list",
					flags: ["json"],
					line: 1,
					raw: "LOG_LEVEL=fatal ./bin/run.js node list --json",
				},
			]);
		});

		it("handles pipe with xargs leading to second invocation", () => {
			const content =
				'./bin/run.js utils path-to-id --path "Next Actions" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {} --verbose';
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "utils:path-to-id",
					flags: ["path", "data-source"],
					line: 1,
					raw: content,
				},
				{command: "node:list", flags: ["parent-id", "verbose"], line: 1, raw: content},
			]);
		});

		it("stops parsing flags at pipe", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node list --verbose | jq .name");
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "node:list",
					flags: ["verbose"],
					line: 1,
					raw: "./bin/run.js node list --verbose | jq .name",
				},
			]);
		});

		it("stops parsing flags at redirect", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node list --verbose 2>/dev/null");
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "node:list",
					flags: ["verbose"],
					line: 1,
					raw: "./bin/run.js node list --verbose 2>/dev/null",
				},
			]);
		});

		it("handles --no- prefix for boolean flags", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node list --no-cache --verbose");
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "node:list",
					flags: ["cache", "verbose"],
					line: 1,
					raw: "./bin/run.js node list --no-cache --verbose",
				},
			]);
		});

		it("handles --flag=value syntax", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js cache import-backup --format=json");
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "cache:import-backup",
					flags: ["format"],
					line: 1,
					raw: "./bin/run.js cache import-backup --format=json",
				},
			]);
		});

		it("skips variable substitution values", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js node get --id $ITEM_ID");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:get", flags: ["id"], line: 1, raw: "./bin/run.js node get --id $ITEM_ID"},
			]);
		});

		it("handles three-word command (utils path-to-id)", () => {
			const analysis = parseMarkdownContent("test.md", './bin/run.js utils path-to-id --path "Test"');
			expect(analysis.cliInvocations).toStrictEqual([
				{
					command: "utils:path-to-id",
					flags: ["path"],
					line: 1,
					raw: './bin/run.js utils path-to-id --path "Test"',
				},
			]);
		});

		it("strips closing code-span backtick and trailing colon from command", () => {
			const analysis = parseMarkdownContent("test.md", "Add, via `./bin/run.js node create`:");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:create", flags: [], line: 1, raw: "Add, via `./bin/run.js node create`:"},
			]);
		});

		it("handles lines without ./bin/run.js", () => {
			const analysis = parseMarkdownContent("test.md", "This is a normal line without CLI commands.");
			expect(analysis.cliInvocations).toStrictEqual([]);
		});

		it("handles --help and --version as global flags", () => {
			const analysis = parseMarkdownContent("test.md", "./bin/run.js --help");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "", flags: ["help"], line: 1, raw: "./bin/run.js --help"},
			]);
		});

		it("reports correct line numbers for multiple invocations", () => {
			const content = [
				"Some text",
				"./bin/run.js node get --id abc",
				"More text",
				"./bin/run.js node list --verbose",
			].join("\n");
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:get", flags: ["id"], line: 2, raw: "./bin/run.js node get --id abc"},
				{command: "node:list", flags: ["verbose"], line: 4, raw: "./bin/run.js node list --verbose"},
			]);
		});

		it("preserves raw text of the invocation", () => {
			const analysis = parseMarkdownContent("test.md", "  ./bin/run.js node list --verbose");
			expect(analysis.cliInvocations).toStrictEqual([
				{command: "node:list", flags: ["verbose"], line: 1, raw: "./bin/run.js node list --verbose"},
			]);
		});
	});

	describe("subagent reference extraction", () => {
		it("extracts double-quoted subagent_type", () => {
			const analysis = parseMarkdownContent("test.md", '- subagent_type: "metadata-sync"');
			expect(analysis.subagentRefs).toStrictEqual([{name: "metadata-sync", line: 1}]);
		});

		it("extracts single-quoted subagent_type", () => {
			const analysis = parseMarkdownContent("test.md", "- subagent_type: 'item-refiner'");
			expect(analysis.subagentRefs).toStrictEqual([{name: "item-refiner", line: 1}]);
		});

		it("extracts multiple subagent_type references", () => {
			const content = [
				'- subagent_type: "inbox-loader"',
				'  prompt: "Load items"',
				'- subagent_type: "metadata-sync"',
				'  prompt: "Sync metadata"',
			].join("\n");
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.subagentRefs).toStrictEqual([
				{name: "inbox-loader", line: 1},
				{name: "metadata-sync", line: 3},
			]);
		});

		it("ignores lines without subagent_type", () => {
			const analysis = parseMarkdownContent("test.md", "This mentions subagent but not the right pattern");
			expect(analysis.subagentRefs).toStrictEqual([]);
		});
	});

	describe(".llm/ path extraction", () => {
		it("extracts .llm/ paths", () => {
			const analysis = parseMarkdownContent("test.md", "Write to `.llm/gtd/inbox-ids.txt`");
			expect(analysis.llmPaths).toStrictEqual([{path: ".llm/gtd/inbox-ids.txt", line: 1}]);
		});

		it("extracts .llm/ paths with leading ./", () => {
			const analysis = parseMarkdownContent("test.md", "Read `./.llm/gtd/metadata/`");
			expect(analysis.llmPaths).toStrictEqual([{path: ".llm/gtd/metadata/", line: 1}]);
		});

		it("extracts multiple .llm/ paths from different lines", () => {
			const content = ["`.llm/gtd/inbox-ids.txt` - inbox items", "`.llm/gtd/metadata/` - metadata cache"].join(
				"\n",
			);
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.llmPaths).toStrictEqual([
				{path: ".llm/gtd/inbox-ids.txt", line: 1},
				{path: ".llm/gtd/metadata/", line: 2},
			]);
		});

		it("handles paths in quotes", () => {
			const analysis = parseMarkdownContent("test.md", 'Write to ".llm/gtd/capture/analysis/"');
			expect(analysis.llmPaths).toStrictEqual([{path: ".llm/gtd/capture/analysis/", line: 1}]);
		});
	});

	describe("command reference extraction", () => {
		it("extracts /gtd:inbox reference", () => {
			const analysis = parseMarkdownContent("test.md", "Run `/gtd:inbox` to execute moves.");
			expect(analysis.commandRefs).toStrictEqual([{ref: "/gtd:inbox", line: 1}]);
		});

		it("extracts /gtd:refine reference", () => {
			const analysis = parseMarkdownContent("test.md", "First run `/gtd:refine` to analyze items.");
			expect(analysis.commandRefs).toStrictEqual([{ref: "/gtd:refine", line: 1}]);
		});

		it("extracts /gtd:capture reference", () => {
			const analysis = parseMarkdownContent("test.md", "- `/gtd:capture` - Capture new items");
			expect(analysis.commandRefs).toStrictEqual([{ref: "/gtd:capture", line: 1}]);
		});

		it("handles multi-segment command refs", () => {
			const analysis = parseMarkdownContent("test.md", "Use `/workflowy:upload-attachment`");
			expect(analysis.commandRefs).toStrictEqual([{ref: "/workflowy:upload-attachment", line: 1}]);
		});

		it("does not match single-segment slash paths", () => {
			// /gtd alone is not a valid command ref (needs colon)
			const analysis = parseMarkdownContent("test.md", "The /dev/null path");
			expect(analysis.commandRefs).toStrictEqual([]);
		});
	});

	describe("script reference extraction", () => {
		it("extracts .claude/scripts/ references", () => {
			const analysis = parseMarkdownContent("test.md", "Run `.claude/scripts/gtd/load-inboxes.sh`");
			expect(analysis.scriptRefs).toStrictEqual([{path: ".claude/scripts/gtd/load-inboxes.sh", line: 1}]);
		});

		it("extracts ./.claude/scripts/ references with leading ./", () => {
			const analysis = parseMarkdownContent("test.md", "./.claude/scripts/gtd/load-inboxes.sh");
			expect(analysis.scriptRefs).toStrictEqual([{path: ".claude/scripts/gtd/load-inboxes.sh", line: 1}]);
		});

		it("extracts multiple script references", () => {
			const content = ["`.claude/scripts/gtd/sync-metadata.sh`", "`.claude/scripts/gtd/load-declined.sh`"].join(
				"\n",
			);
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.scriptRefs).toStrictEqual([
				{path: ".claude/scripts/gtd/sync-metadata.sh", line: 1},
				{path: ".claude/scripts/gtd/load-declined.sh", line: 2},
			]);
		});

		it("extracts ${CLAUDE_PLUGIN_ROOT}/scripts/ references", () => {
			const analysis = parseMarkdownContent("test.md", "Run `${CLAUDE_PLUGIN_ROOT}/scripts/sync-metadata.sh`");
			expect(analysis.scriptRefs).toStrictEqual([
				{path: "${CLAUDE_PLUGIN_ROOT}/scripts/sync-metadata.sh", line: 1},
			]);
		});
	});

	describe("threshold extraction", () => {
		it("extracts >= 0.85 threshold", () => {
			const analysis = parseMarkdownContent("test.md", "Confidence >= 0.85 AND no duplicate");
			expect(analysis.thresholds).toStrictEqual([
				{value: 0.85, context: "Confidence >= 0.85 AND no duplicate", line: 1},
			]);
		});

		it("extracts >= 0.9 threshold", () => {
			const analysis = parseMarkdownContent("test.md", "**High confidence (>= 0.9)**: Auto-accept");
			expect(analysis.thresholds).toStrictEqual([
				{value: 0.9, context: "**High confidence (>= 0.9)**: Auto-accept", line: 1},
			]);
		});

		it("extracts multiple thresholds from different lines", () => {
			const content = [
				"Confidence >= 0.85 for capture",
				"Confidence >= 0.9 for auto-accept",
				"Confidence >= 0.5 for tags",
			].join("\n");
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.thresholds).toStrictEqual([
				{value: 0.85, context: "Confidence >= 0.85 for capture", line: 1},
				{value: 0.9, context: "Confidence >= 0.9 for auto-accept", line: 2},
				{value: 0.5, context: "Confidence >= 0.5 for tags", line: 3},
			]);
		});

		it("extracts > 0.7 threshold (without equals)", () => {
			const analysis = parseMarkdownContent("test.md", "Confidence > 0.7 for dates");
			expect(analysis.thresholds).toStrictEqual([{value: 0.7, context: "Confidence > 0.7 for dates", line: 1}]);
		});

		it("reports correct line numbers", () => {
			const content = ["Line 1", "Confidence >= 0.85", "Line 3"].join("\n");
			const analysis = parseMarkdownContent("test.md", content);
			expect(analysis.thresholds).toStrictEqual([{value: 0.85, context: "Confidence >= 0.85", line: 2}]);
		});

		it("does not extract values > 1.0", () => {
			const analysis = parseMarkdownContent("test.md", "version >= 0.0 is invalid");
			expect(analysis.thresholds).toStrictEqual([]);
		});
	});

	describe("full file parsing", () => {
		it("extracts all reference types from a realistic markdown file", () => {
			const content = `---
name: refine
description: GTD inbox refinement
---

# Refinement Command

Launch loaders:
\`\`\`
Task tool calls (parallel):
- subagent_type: "inbox-loader"
  prompt: "Load items to .llm/gtd/inbox-ids.txt"
- subagent_type: "metadata-sync"
  prompt: "Sync metadata to .llm/gtd/metadata/"
\`\`\`

Run the CLI:
\`\`\`bash
./bin/run.js node list \\
  --parent-id {} \\
  --verbose
\`\`\`

Run sync script:
\`\`\`bash
.claude/scripts/gtd/sync-metadata.sh
\`\`\`

Confidence >= 0.85 for capture decisions.

See also \`/gtd:inbox\` for execution.
`;
			const analysis = parseMarkdownContent("test.md", content);

			expect(analysis).toStrictEqual({
				filePath: "test.md",
				cliInvocations: [
					{
						command: "node:list",
						flags: ["parent-id", "verbose"],
						line: 19,
						raw: "./bin/run.js node list    --parent-id {}    --verbose",
					},
				],
				subagentRefs: [
					{name: "inbox-loader", line: 11},
					{name: "metadata-sync", line: 13},
				],
				llmPaths: [
					{path: ".llm/gtd/inbox-ids.txt", line: 12},
					{path: ".llm/gtd/metadata/", line: 14},
				],
				commandRefs: [{ref: "/gtd:inbox", line: 31}],
				scriptRefs: [{path: ".claude/scripts/gtd/sync-metadata.sh", line: 26}],
				thresholds: [{value: 0.85, context: "Confidence >= 0.85 for capture decisions.", line: 29}],
			});
		});
	});
});
