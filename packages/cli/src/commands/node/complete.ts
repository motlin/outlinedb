import type {WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import {BaseCompletionCommand} from "../base-completion-command.js";

export default class Complete extends BaseCompletionCommand {
	static override hidden = false;
	static override description = "Mark a Workflowy node as completed";

	static override examples = [
		"# Complete node by ID",
		"<%= config.bin %> <%= command.id %> --id abc123",
		"",
		"# Complete node by path",
		'<%= config.bin %> <%= command.id %> --path "Work,Tasks,My Task"',
		"",
		"# Preview the API call without executing",
		"<%= config.bin %> <%= command.id %> --id abc123 --dry-run",
		"",
		"# With verbose logging",
		"<%= config.bin %> <%= command.id %> --id abc123 --verbose",
	];

	protected override get action(): "complete" | "uncomplete" {
		return "complete";
	}

	protected override get actionPastTense(): string {
		return "marked node as completed";
	}

	protected override get actionPresent(): string {
		return "Marking node as completed";
	}

	protected override async executeAction(client: WorkflowyWriteThroughClient, nodeId: string): Promise<void> {
		await client.completeNode(nodeId);
	}
}
