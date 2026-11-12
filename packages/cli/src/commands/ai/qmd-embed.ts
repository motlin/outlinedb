import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {QmdSearchService} from "../../services/qmd-search.js";

export default class QmdEmbed extends Command
{
	static override description = "Sync Workflowy nodes into qmd index and generate embeddings";

	static override examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --force"];

	static override flags =
	{
		force: Flags.boolean(
			{
				char: "f",
				description: "Re-embed all documents (clear existing embeddings first)",
				default: false,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(QmdEmbed);

		const database = createDatabase();
		const service = new QmdSearchService(database);

		try
		{
			this.log("Syncing Workflowy nodes to qmd index...");
			const syncResult = await service.syncNodes((message) =>
			{
				this.log(`  ${message}`);
			});

			this.log(
				`\nSync complete: ${syncResult.inserted} inserted, ${syncResult.updated} updated, ${syncResult.unchanged} unchanged, ${syncResult.deactivated} deactivated (${syncResult.totalTime.toFixed(1)}s)`,
			);

			if (syncResult.inserted === 0 && syncResult.updated === 0 && !flags.force)
			{
				this.log("\nNo new content to embed. Use --force to re-embed everything.");
				return;
			}

			this.log("\nGenerating embeddings...");
			const embedResult = await service.embed(
				{
					force: flags.force,
				},
				(progress) =>
				{
					this.log(`  ${progress.chunksEmbedded}/${progress.totalChunks} chunks (${progress.errors} errors)`);
				},
			);

			this.log(
				`\nEmbed complete: ${embedResult.docsProcessed} docs, ${embedResult.chunksEmbedded} chunks in ${(embedResult.durationMs / 1000).toFixed(1)}s`,
			);

			this.log('\nYou can now search with: outlinedb ai:qmd-search --query "your query"');
		}
		finally
		{
			await service.close();
		}
	}
}
