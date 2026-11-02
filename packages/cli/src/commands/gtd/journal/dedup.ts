import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import path from "node:path";
import {z} from "zod";
import {createDatabase} from "../../../db/index.js";
import {CacheService} from "../../../services/cache.js";
import {loadExistingEntries} from "../../../services/journal-existing-entries.js";
import {parseStrictNumber} from "../../../utils/parse-strict-number.js";
import {DEFAULT_DB_FILE} from "../../../db/default-db-file.js";

interface ScannedItem
{
	title: string;
	date: string;
	source: string;
	[key: string]: unknown;
}

const ScanFileSchema = z.object(
	{
		items: z
			.array(
				z.looseObject(
					{
						title: z.string().optional(),
						eventDate: z.string().optional(),
					},
				),
			)
			.optional(),
	},
);

interface DuplicateMatch
{
	scanned_title: string;
	existing_entry: string;
	date: string;
	score: number;
	method: string;
	source: string;
}

interface DedupOutput
{
	status: string;
	analyzed_at: string;
	threshold: number;
	summary:
	{
		total_scanned: number;
		duplicates: number;
		new_items: number;
		existing_entries_checked: number;
	};
	duplicates: DuplicateMatch[];
	newItems: ScannedItem[];
}

// Location aliases for better matching
const LOCATION_ALIASES: Record<string, Set<string>> =
{
	mia: new Set(["fl", "florida", "miami"]),
	ewr: new Set(["newark", "new jersey", "nj", "york"]),
	jfk: new Set(["kennedy", "new york", "ny", "queens"]),
	lga: new Set(["laguardia", "new york", "ny"]),
	lax: new Set(["ca", "california", "los angeles"]),
	sfo: new Set(["ca", "california", "san francisco"]),
	ord: new Set(["chicago", "il", "illinois", "ohare"]),
};

/**
 * Journal Deduplication.
 *
 * Compares scanned journal events against existing calendar entries
 * to identify and filter duplicates before creating new entries.
 */
export default class Dedup extends Command
{
	static override description = "Deduplicate journal entries against existing calendar";

	static override examples = [
		"# Run deduplication analysis",
		"<%= config.bin %> <%= command.id %>",
		"",
		"# Use custom threshold",
		"<%= config.bin %> <%= command.id %> --threshold 0.6",
	];

	static override enableJsonFlag = true;

	static override flags =
	{
		threshold: Flags.string(
			{
				char: "t",
				description: "Similarity threshold (0.0-1.0)",
				default: "0.55",
			},
		),
	};

	public async run(): Promise<DedupOutput>
	{
		const {flags} = await this.parse(Dedup);

		const threshold = parseStrictNumber(flags.threshold);
		if (threshold === undefined)
		{
			this.error(`Invalid --threshold value: "${flags.threshold}". Must be a number.`);
		}
		const projectRoot = this.findProjectRoot();
		const scansDir = path.join(projectRoot, ".llm", "gtd", "journal", "scans");
		const dbPath = path.join(projectRoot, DEFAULT_DB_FILE);
		const outputPath = path.join(projectRoot, ".llm", "gtd", "journal", "dedup-analysis.json");

		// Load scanned events
		const scanned = this.loadScannedEvents(scansDir);

		if (scanned.length === 0)
		{
			const output: DedupOutput =
			{
				status: "no_events",
				analyzed_at: new Date().toISOString(),
				threshold,
				summary:
				{
					total_scanned: 0,
					duplicates: 0,
					new_items: 0,
					existing_entries_checked: 0,
				},
				duplicates: [],
				newItems: [],
			};

			// Ensure output directory exists
			const outputDir = path.dirname(outputPath);
			if (!fs.existsSync(outputDir))
			{
				fs.mkdirSync(
					outputDir,
					{
						recursive: true,
					},
				);
			}
			fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

			if (!this.jsonEnabled())
			{
				this.log(JSON.stringify(output.summary, null, 2));
			}

			return output;
		}

		// Get unique dates from scanned events
		const dates = [...new Set(scanned.map((item) => item.date).filter(Boolean))];

		// Load existing entries for those dates
		const existing = this.loadExistingEntries(dbPath, dates);

		// Deduplicate
		const results = this.deduplicate(scanned, existing, threshold);

		const output: DedupOutput =
		{
			status: "success",
			analyzed_at: new Date().toISOString(),
			threshold,
			summary:
			{
				total_scanned: scanned.length,
				duplicates: results.duplicates.length,
				new_items: results.newItems.length,
				existing_entries_checked: Object.values(existing).reduce((sum, arr) => sum + arr.length, 0),
			},
			duplicates: results.duplicates,
			newItems: results.newItems,
		};

		// Ensure output directory exists
		const outputDir = path.dirname(outputPath);
		if (!fs.existsSync(outputDir))
		{
			fs.mkdirSync(
				outputDir,
				{
					recursive: true,
				},
			);
		}
		fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

		if (!this.jsonEnabled())
		{
			this.log(JSON.stringify(output.summary, null, 2));
		}

		return output;
	}

	/**
	 * Normalize text for comparison.
	 */
	private normalize(text: string): string
	{
		if (!text)
		{
			return "";
		}
		// Remove HTML tags
		let normalized = text.replaceAll(/<[^>]+>/gu, "");
		// Remove non-word characters except spaces
		normalized = normalized.replaceAll(/[^\w\s]/gu, " ");
		// Lowercase and collapse whitespace
		return normalized.toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
	}

	/**
	 * Extract significant keywords from text.
	 */
	private extractKeywords(text: string): Set<string>
	{
		const normalized = this.normalize(text);
		const stopwords = new Set([
			"a",
			"all",
			"an",
			"and",
			"at",
			"be",
			"been",
			"browsed",
			"bump",
			"dependabot",
			"deps",
			"dev",
			"for",
			"from",
			"got",
			"in",
			"is",
			"merged",
			"of",
			"on",
			"or",
			"our",
			"out",
			"pr",
			"read",
			"the",
			"to",
			"up",
			"visited",
			"was",
			"we",
			"went",
			"were",
			"with",
		]);
		return new Set(normalized.split(" ").filter((w) => w.length > 2 && !stopwords.has(w)));
	}

	/**
	 * Expand keywords with known location aliases.
	 */
	private expandKeywords(keywords: Set<string>): Set<string>
	{
		const expanded = new Set(keywords);
		for (const kw of keywords)
		{
			const kwLower = kw.toLowerCase();
			for (const alias of LOCATION_ALIASES[kwLower] ?? [])
			{
				expanded.add(alias);
			}
			for (const [code, aliases] of Object.entries(LOCATION_ALIASES))
			{
				if (aliases.has(kwLower))
				{
					expanded.add(code);
				}
			}
		}
		return expanded;
	}

	/**
	 * Calculate similarity between two strings.
	 */
	private similarity(
		s1: string,
		s2: string,
	):
	{
		score: number;
		method: string;
	}
	{
		const n1 = this.normalize(s1);
		const n2 = this.normalize(s2);

		// Exact match
		if (n1 === n2)
		{
			return {
				score: 1,
				method: "exact",
			};
		}

		// Substring match
		if (n1.includes(n2) || n2.includes(n1))
		{
			return {
				score: 0.85,
				method: "substring",
			};
		}

		// Sequence similarity (simple implementation)
		const seqRatio = this.sequenceRatio(n1, n2);

		// Keyword matching
		const kw1 = this.expandKeywords(this.extractKeywords(s1));
		const kw2 = this.expandKeywords(this.extractKeywords(s2));

		if (kw1.size > 0 && kw2.size > 0)
		{
			const intersection = new Set([...kw1].filter((x) => kw2.has(x)));
			const union = new Set([...kw1, ...kw2]);
			const jaccard = intersection.size / union.size;

			if (intersection.size >= 2 || (intersection.size > 0 && jaccard > 0.2))
			{
				const score = Math.max(0.6, Math.min(0.9, jaccard + 0.3));
				const matchedKeywords = [...intersection].slice(0, 5);
				return {
					score,
					method: `keywords: ${JSON.stringify(matchedKeywords)}`,
				};
			}
		}

		// Proper noun matching
		const proper1 = new Set(s1.match(/\b[A-Z][A-Z]+\b|\b[A-Z][a-z]{2,}\b/gu));
		const proper2 = new Set(s2.match(/\b[A-Z][A-Z]+\b|\b[A-Z][a-z]{2,}\b/gu));
		const properMatch = new Set([...proper1].filter((x) => proper2.has(x)));

		if (properMatch.size > 0)
		{
			const overlapRatio = properMatch.size / Math.max(proper1.size, proper2.size, 1);
			if (overlapRatio > 0.2 || properMatch.size > 0)
			{
				const matchedNouns = [...properMatch].slice(0, 5);
				return {
					score: Math.max(0.6, seqRatio + 0.2),
					method: `proper_nouns: ${JSON.stringify(matchedNouns)}`,
				};
			}
		}

		return {
			score: seqRatio,
			method: "sequence",
		};
	}

	/**
	 * Simple sequence similarity ratio.
	 */
	private sequenceRatio(s1: string, s2: string): number
	{
		if (s1.length === 0 && s2.length === 0)
		{
			return 1;
		}
		if (s1.length === 0 || s2.length === 0)
		{
			return 0;
		}

		// Simple LCS-based ratio
		const lcs = this.longestCommonSubsequence(s1, s2);
		return (2 * lcs) / (s1.length + s2.length);
	}

	/**
	 * Longest common subsequence length.
	 */
	private longestCommonSubsequence(s1: string, s2: string): number
	{
		// Rolling single-row DP over UTF-16 code units: previous[j] is the LCS of s1[..i) and s2[..j).
		let previous: number[] = Array.from(
			{
				length: s2.length + 1,
			},
			() => 0,
		);
		for (let i = 0; i < s1.length; i++)
		{
			const current: number[] = [0];
			let left = 0;
			for (let j = 0; j < s2.length; j++)
			{
				const value =
					s1.charAt(i) === s2.charAt(j) ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, left);
				current.push(value);
				left = value;
			}
			previous = current;
		}

		return previous[s2.length] ?? 0;
	}

	/**
	 * Load scanned events from JSON files.
	 */
	private loadScannedEvents(scansDir: string): ScannedItem[]
	{
		const scanned: ScannedItem[] = [];

		if (!fs.existsSync(scansDir))
		{
			return scanned;
		}

		const files = fs.readdirSync(scansDir).filter((f) => f.endsWith(".json"));

		for (const file of files)
		{
			try
			{
				const filePath = path.join(scansDir, file);
				const data = ScanFileSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
				const source = path.basename(file, ".json");

				for (const item of data.items ?? [])
				{
					scanned.push(
						{
							title: item.title ?? "",
							date: item.eventDate ?? "",
							source,
							...item,
						},
					);
				}
			}
			catch
			{
				// Skip invalid files
			}
		}

		return scanned;
	}

	/**
	 * Load existing calendar entries for the specified dates from the day nodes workflowy.com uses.
	 */
	private loadExistingEntries(dbPath: string, dates: string[]): Record<string, string[]>
	{
		if (!fs.existsSync(dbPath))
		{
			return {};
		}
		try
		{
			const database = createDatabase(dbPath);
			try
			{
				return loadExistingEntries(database, new CacheService(database), dates);
			}
			finally
			{
				database.$client.close();
			}
		}
		catch
		{
			// Return empty on error
			return {};
		}
	}

	/**
	 * Compare scanned events against existing entries and identify duplicates.
	 */
	private deduplicate(
		scanned: ScannedItem[],
		existing: Record<string, string[]>,
		threshold: number,
	):
	{
		duplicates: DuplicateMatch[];
		newItems: ScannedItem[];
	}
	{
		const duplicates: DuplicateMatch[] = [];
		const newItems: ScannedItem[] = [];

		for (const item of scanned)
		{
			const {date} = item;
			const {title} = item;
			const {source} = item;

			const existingEntries = existing[date];
			if (existingEntries === undefined)
			{
				newItems.push(item);
				continue;
			}

			let bestMatch: string | null = null;
			let bestScore = 0;
			let bestMethod = "";

			for (const entry of existingEntries)
			{
				const {score, method} = this.similarity(title, entry);
				if (score > bestScore)
				{
					bestScore = score;
					bestMatch = entry;
					bestMethod = method;
				}
			}

			if (bestScore >= threshold && bestMatch)
			{
				duplicates.push(
					{
						scanned_title: title,
						existing_entry: bestMatch,
						date,
						score: Math.round(bestScore * 1000) / 1000,
						method: bestMethod,
						source,
					},
				);
			}
			else
			{
				newItems.push(item);
			}
		}

		return {
			duplicates,
			newItems,
		};
	}

	private findProjectRoot(): string
	{
		let dir = process.cwd();

		while (dir !== "/")
		{
			if (fs.existsSync(path.join(dir, DEFAULT_DB_FILE)) || fs.existsSync(path.join(dir, "package.json")))
			{
				return dir;
			}
			dir = path.dirname(dir);
		}

		return process.cwd();
	}
}
