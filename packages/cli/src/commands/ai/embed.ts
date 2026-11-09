import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {EmbeddingGeneratorService} from "../../services/embedding-generator.js";
import {EMBEDDING_MODELS} from "../../services/embeddings.js";

export default class Embed extends Command {
	static override description = "Generate vector embeddings for all Workflowy nodes";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --batch-size 50",
		"<%= config.bin %> <%= command.id %> --force",
	];

	static override flags = {
		"batch-size": Flags.integer({
			char: "b",
			description: "Number of nodes to process in each batch",
			default: 20,
		}),
		force: Flags.boolean({
			char: "f",
			description: "Regenerate embeddings for nodes that already have them",
			default: false,
		}),
		model: Flags.string({
			char: "m",
			description: "Embedding model to use (generates for local models by default)",
			options: Object.keys(EMBEDDING_MODELS),
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(Embed);

		const database = createDatabase();
		const service = new EmbeddingGeneratorService(database);
		const model = flags.model;

		const result = await service.generateEmbeddings(
			{
				batchSize: flags["batch-size"],
				force: flags.force,
				model,
			},
			(progress) => {
				if (progress.message) {
					this.log(progress.message);
				} else {
					this.log(
						`  [${progress.currentModel}] ${progress.processed}/${progress.total} (${progress.elapsed.toFixed(1)}s elapsed, ~${progress.estimatedRemaining}s remaining)`,
					);
				}
			},
		);

		if (result.alreadyComplete) {
			this.log("✨ All nodes already have embeddings!");
			this.log("   Use --force to regenerate them");
			return;
		}

		this.log(`\n✅ Generated embeddings for ${result.totalProcessed} nodes in ${result.totalTime.toFixed(1)}s`);
		this.log(`\n🔍 You can now search with: outlinedb ai:search --query "your query"`);
	}
}
