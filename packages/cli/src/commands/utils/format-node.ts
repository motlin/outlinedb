import {text} from "node:stream/consumers";
import {getWorkflowyUrl} from "@outlinedb/shared/workflowy";
import {Command} from "@oclif/core";
import {z} from "zod";
import {htmlToAnsi} from "../../utils/html-to-ansi.js";

/**
 * Schema for the expected JSON node input
 */
const NodeInputSchema = z.object(
	{
		id: z.string(),
		name: z.string(),
	},
);

/**
 * Read all content from stdin as a string
 */
async function readStdin(): Promise<string>
{
	const {stdin} = process;
	if (stdin.isTTY)
	{
		throw new Error("No input provided on stdin. Pipe a JSON node object to this command.");
	}

	return text(stdin);
}

export default class FormatNode extends Command
{
	static override description = "Format a single node from JSON input with name and URL";

	static override examples = [
		"# Format a node from JSON",
		'echo \'{"id":"722bccf5-e821-9a59-4380-3247da821f97","name":"Projects"}\' | <%= config.bin %> <%= command.id %>',
		"",
		"# Format a node with HTML styling",
		String.raw`echo '{"id":"abc123","name":"<span class=\"colored c-red\">Important</span>"}' | <%= config.bin %> <%= command.id %>`,
		"",
		"# Chain with other commands",
		"<%= config.bin %> node:get --id abc123 --json | <%= config.bin %> <%= command.id %>",
	];

	public async run(): Promise<void>
	{
		let input: string;
		try
		{
			input = await readStdin();
		}
		catch (error)
		{
			this.error(error instanceof Error ? error.message : "Failed to read from stdin");
		}

		let jsonInput: unknown;
		try
		{
			jsonInput = JSON.parse(input);
		}
		catch
		{
			this.error("Invalid JSON input");
		}

		const parseResult = NodeInputSchema.safeParse(jsonInput);
		if (!parseResult.success)
		{
			this.error(`Invalid node structure: requires "id" and "name" fields. ${parseResult.error.message}`);
		}

		const node = parseResult.data;
		const formattedName = htmlToAnsi(node.name);
		const url = getWorkflowyUrl(node.id);

		this.log(formattedName);
		this.log(`   \u001B[90m${url}\u001B[0m`);
	}
}
