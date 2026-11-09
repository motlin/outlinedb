import {Command, Flags} from "@oclif/core";
import chalk from "chalk";
import {ChangeDetector, parseSince} from "@outlinedb/shared/changes";
import type {ChangeSummary, ChangeTreeNode, NodeChange} from "@outlinedb/shared/changes";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {createDatabase} from "../../db/index.js";
import {htmlToAnsi} from "../../utils/html-to-ansi.js";

export default class Changes extends Command {
	static override description = "Show nodes changed since a given time";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --since 2d",
		"<%= config.bin %> <%= command.id %> --since 12h",
		"<%= config.bin %> <%= command.id %> --since 2026-02-01",
		"<%= config.bin %> <%= command.id %> --json",
	];

	static override flags = {
		since: Flags.string({
			char: "s",
			description: "Time range: duration (1d, 12h, 1w) or ISO date",
			default: "1d",
		}),
		json: Flags.boolean({
			description: "Output as JSON",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(Changes);

		const cutoffDate = parseSince(flags.since);
		const db = createDatabase();
		const detector = new ChangeDetector(db);
		const result = detector.detectChanges(cutoffDate);

		if (flags.json) {
			this.log(JSON.stringify(result, null, 2));
			return;
		}

		if (result.changes.length === 0) {
			this.log(`No changes since ${cutoffDate.toISOString()}`);
			return;
		}

		this.log(`Changes since ${cutoffDate.toISOString()}:`);
		this.log(this.formatSummary(result.summary));
		this.log("");

		this.renderTree(result.tree, []);
	}

	private formatSummary(summary: ChangeSummary): string {
		const parts: string[] = [];
		if (summary.added > 0) {
			parts.push(chalk.green(`${summary.added} added`));
		}
		if (summary.deleted > 0) {
			parts.push(chalk.red(`${summary.deleted} deleted`));
		}
		if (summary.moved > 0) {
			parts.push(chalk.blue(`${summary.moved} moved`));
		}
		if (summary.changed > 0) {
			parts.push(chalk.yellow(`${summary.changed} changed`));
		}
		if (summary.completed > 0) {
			parts.push(chalk.gray(`${summary.completed} completed`));
		}
		if (summary.uncompleted > 0) {
			parts.push(chalk.gray(`${summary.uncompleted} uncompleted`));
		}
		return `  ${parts.join(", ")}`;
	}

	private renderTree(nodes: ChangeTreeNode[], ancestors: boolean[]): void {
		for (const [i, node] of nodes.entries()) {
			const isLast = i === nodes.length - 1;

			const indent = ancestors.map((hasMore) => (hasMore ? "│   " : "    ")).join("");
			const branch = isLast ? "└── " : "├── ";
			const prefix = indent + branch;

			const name = node.name ? htmlToAnsi(node.name) : "(unnamed)";
			const plainName = node.name ? stripHtmlTags(node.name) : "(unnamed)";

			if (node.isContext) {
				this.log(`${prefix}${chalk.dim(plainName)}`);
			} else if (node.change) {
				const marker = this.getMarker(node.change);
				const annotations = this.getAnnotations(node.change);
				const annotationStr = annotations.length > 0 ? ` ${chalk.dim(`[${annotations.join(", ")}]`)}` : "";
				this.log(`${prefix}${marker} ${name}${annotationStr}`);
			}

			if (node.children.length > 0) {
				this.renderTree(node.children, [...ancestors, !isLast]);
			}
		}
	}

	private getMarker(change: NodeChange): string {
		if (change.isNew) {
			return chalk.green("+");
		}
		if (change.isDeleted) {
			return chalk.red("-");
		}
		if (change.parentChanged && !change.contentChanged && !change.noteChanged) {
			return chalk.blue(">");
		}
		return chalk.yellow("~");
	}

	private getAnnotations(change: NodeChange): string[] {
		const annotations: string[] = [];
		if (change.parentChanged && (change.contentChanged || change.noteChanged)) {
			annotations.push("moved");
		}
		if (change.completionChanged) {
			annotations.push(change.currentCompletedAt ? "completed" : "uncompleted");
		}
		if (change.noteChanged && !change.contentChanged) {
			annotations.push("note edited");
		}
		return annotations;
	}
}
