import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import type {RegistryNode} from "./label-pool.js";
import {WorkersAiClefClient} from "./workers-ai-client.js";

const RegistryNodeSchema: z.ZodType<RegistryNode> = z.lazy(() =>
	z.object({name: z.string(), children: z.array(RegistryNodeSchema).optional()}),
);
const TagFrequencySchema = z.object({tags: z.record(z.string(), z.number())});

/** The registries the label pool is built from. */
export interface LabelRegistries {
	readonly people: RegistryNode;
	readonly hobbies: RegistryNode;
	readonly tagFrequency: Readonly<Record<string, number>>;
}

/** Reads `people.json`, `hobbies-registry.json` and `tag-frequency.json` from `metadataDir`. */
export function readLabelRegistries(metadataDir: string): LabelRegistries {
	const readJson = <T>(file: string, schema: z.ZodType<T>): T =>
		schema.parse(JSON.parse(fs.readFileSync(path.join(metadataDir, file), "utf8")));
	return {
		people: readJson("people.json", RegistryNodeSchema),
		hobbies: readJson("hobbies-registry.json", RegistryNodeSchema),
		tagFrequency: readJson("tag-frequency.json", TagFrequencySchema).tags,
	};
}

/** A Workers AI Clef client from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN`, or the reason it can't be made. */
export function clefClientFromEnv(): WorkersAiClefClient | {error: string} {
	const token = process.env.CLOUDFLARE_AI_TOKEN;
	if (!token) {
		return {
			error: "CLOUDFLARE_AI_TOKEN is not set: add it to .envrc as an op:// reference and run through `op run --`",
		};
	}
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!accountId) {
		return {error: "CLOUDFLARE_ACCOUNT_ID is not set: add it to .envrc"};
	}
	return new WorkersAiClefClient(accountId, token);
}
