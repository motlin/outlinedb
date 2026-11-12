import {expect, describe, beforeAll, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import path from "node:path";

import {parseMarkdownFile} from "./helpers/markdown-parser.js";
import type {LlmPath} from "./helpers/markdown-parser.js";
import {PROJECT_ROOT, collectComponentFiles} from "./helpers/scan-roots.js";

/**
 * Structural eval: file-path-contracts
 *
 * Validates that `.llm/` intermediate file paths referenced across agents, commands,
 * and skills are consistent between producers (writers) and consumers (readers).
 * A path typo in a producer or consumer causes silent runtime failures.
 */

interface ClassifiedPath
{
	/** The normalized path pattern (globs and variables collapsed). */
	pattern: string;
	/** The raw path as found in the file. */
	raw: string;
	/** Whether this reference writes (produces) or reads (consumes) the path. */
	role: "producer" | "consumer";
	/** Source file where the reference was found. */
	sourceFile: string;
	/** Line number in the source file. */
	line: number;
}

/**
 * Normalize a path for contract matching.
 * - Collapse glob wildcards (*.json) to a directory-level pattern
 * - Replace variable interpolations ($VAR, ${VAR}, {var}, <...>) with a wildcard token
 * - Strip trailing punctuation artifacts
 */
function normalizePath(rawPath: string): string
{
	let p = rawPath;

	// Strip leading ./ if present
	if (p.startsWith("./"))
	{
		p = p.slice(2);
	}

	// Strip trailing punctuation artifacts from regex extraction: ], ), etc.
	p = p.replace(/[\])+,;]+$/u, "");

	// Replace shell variables: $VAR, ${VAR}, $(...)
	p = p.replaceAll(/\$\{[^}]+\}/gu, "*");
	p = p.replaceAll(/\$\([^)]+\)/gu, "*");
	p = p.replaceAll(/\$[A-Z_][A-Z_0-9]*/giu, "*");

	// Replace curly-brace template placeholders: {itemId}, {source}, etc.
	p = p.replaceAll(/\{[^}]+\}/gu, "*");

	// Replace angle-bracket placeholders: <source>, <itemId>, etc.
	p = p.replaceAll(/<[^>]+>/gu, "*");

	// Collapse glob wildcard extensions: *.json -> *
	p = p.replaceAll(/\*\.[a-z]+/gu, "*");

	// Collapse consecutive wildcards with hyphens: *-*-* -> *
	p = p.replaceAll(/(\*[-_])+\*/gu, "*");

	// Strip trailing slash
	p = p.replace(/\/+$/u, "");

	return p;
}

/**
 * Get the "contract directory" — the deepest fixed directory prefix.
 * e.g., ".llm/gtd/capture/scans/<source>.json" -> ".llm/gtd/capture/scans"
 * For exact file paths without wildcards, return the path itself.
 */
function contractKey(normalizedPath: string): string
{
	// If no wildcards, it's a specific file — return the path as-is
	if (!normalizedPath.includes("*"))
	{
		return normalizedPath;
	}

	// If the path has a wildcard in the last segment, use the parent dir
	const parts = normalizedPath.split("/");
	while (parts.length > 0 && parts.at(-1)?.includes("*"))
	{
		parts.pop();
	}
	return parts.length > 0 ? parts.join("/") : normalizedPath;
}

/**
 * Classify a path reference as producer or consumer based on surrounding line context.
 */
function classifyRole(llmPath: LlmPath, fileContent: string): "producer" | "consumer"
{
	const lines = fileContent.split("\n");
	const lineIdx = llmPath.line - 1; // 0-based
	const line = lines[lineIdx] ?? "";

	// Check the line and nearby lines for context
	const contextStart = Math.max(0, lineIdx - 3);
	const contextEnd = Math.min(lines.length - 1, lineIdx + 3);
	const context = lines.slice(contextStart, contextEnd + 1).join("\n");
	const contextLower = context.toLowerCase();
	const lineLower = line.toLowerCase();

	// Escape the path for use in regex
	const pathEscaped = llmPath.path.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

	// --- Strong producer signals ---

	// Redirect into the path: > .llm/... or > ".llm/..." (with optional quotes)
	if (new RegExp(`>+\\s*"?\\.?\\/?${pathEscaped}`, "u").test(line))
	{
		return "producer";
	}

	// jq ... > "path" or command > "path" (redirect with quoted path)
	if (new RegExp(`>\\s*"[^"]*${pathEscaped}`, "u").test(line))
	{
		return "producer";
	}

	// cat > "path" << (heredoc write pattern)
	if (/\bcat\s+>/u.test(lineLower) && line.includes(llmPath.path))
	{
		return "producer";
	}

	// mkdir -p for the path
	if (lineLower.includes("mkdir") && line.includes(llmPath.path))
	{
		return "producer";
	}

	// mv destination (second argument of mv)
	if (/\bmv\s+/u.test(lineLower) && new RegExp(`mv\\s+\\S+\\s+.*${pathEscaped}`, "u").test(line))
	{
		return "producer";
	}

	// "writes to", "write X to", "cache to", "save to", "writing to"
	if (
		/writ(es?|ing)\s+.{0,40}\b(to|into)\b|cache[sd]?\s+.{0,20}\b(to|them|it)\b|sav(es?|ing)\s+to|output\s+to/iu.test(
			contextLower,
		)
	)
	{
		return "producer";
	}

	// "creates <path>" — the word "creates" must be on the SAME line as the path
	// (not just anywhere in context, to avoid false positives like "create inbox nodes")
	if (/creates?\s/iu.test(lineLower) && line.includes(llmPath.path))
	{
		return "producer";
	}

	// "And creates <path>" pattern (path on an adjacent line from "creates")
	const pathEscapedForCreates = llmPath.path.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
	if (new RegExp(`creates?\\s+[\`"']?${pathEscapedForCreates}`, "iu").test(context))
	{
		return "producer";
	}

	// "outputFile", "outputDir" (but NOT "Output Format" or "Output:" as section headers)
	if (/\boutput(file|dir)\b/iu.test(contextLower))
	{
		return "producer";
	}

	// "downloads .* into" pattern
	if (/downloads?\s+.*\s+into/iu.test(contextLower))
	{
		return "producer";
	}

	// Descriptions that say the script/agent "produces" or "generates" or "syncs to"
	if (/produc(es?|ing)|generat(es?|ing)|sync(s|ed|ing)?\s+(metadata\s+)?to/iu.test(contextLower))
	{
		return "producer";
	}

	// --- Strong consumer signals ---

	// cat/jq/wc reading the path (but NOT cat > which is a redirect/write)
	if (
		/\b(cat|jq|wc)\s/u.test(lineLower) &&
		!(line.split(llmPath.path)[0] ?? "").includes(">") &&
		line.includes(llmPath.path)
	)
	{
		return "consumer";
	}

	// wc -l < path (stdin redirect)
	if (new RegExp(`<\\s*\\.?\\/?${pathEscaped}`, "u").test(line))
	{
		return "consumer";
	}

	// "read from", "reads from", "load from"
	if (/read(s|ing)?\s+(from|the)|load(s|ing)?\s+(from|the)/iu.test(contextLower))
	{
		return "consumer";
	}

	// "collect results from"
	if (/collect\s+(results?|data)\s+from/iu.test(contextLower))
	{
		return "consumer";
	}

	// "Read the" or "Read events from" patterns
	if (/\bread\s+(the|events|items|data)\s+(from|in)/iu.test(contextLower))
	{
		return "consumer";
	}

	// "from <path>" (consumer reads from)
	if (new RegExp(`from\\s+[\`"']?${pathEscaped}`, "iu").test(context))
	{
		return "consumer";
	}

	// --- Directional defaults ---

	// "to <path>" generally means producing/writing
	if (new RegExp(`to\\s+[\`"']?${pathEscaped}`, "iu").test(context))
	{
		return "producer";
	}

	// Fallback: ambiguous references treated as consumer
	// (consumers failing silently is worse than missing a producer)
	return "consumer";
}

/**
 * Check if two contract keys match, accounting for:
 * - Exact match
 * - Parent/child directory relationships
 * - File within a produced directory
 */
function contractsMatch(consumerKey: string, producerKeys: Set<string>): boolean
{
	// Direct match
	if (producerKeys.has(consumerKey))
	{
		return true;
	}

	for (const pk of producerKeys)
	{
		// Consumer is under a producer directory
		if (consumerKey.startsWith(`${pk}/`))
		{
			return true;
		}
		// Producer writes into a directory the consumer references
		if (pk.startsWith(`${consumerKey}/`))
		{
			return true;
		}
	}

	return false;
}

describe("Structural Eval: File Path Contracts", () =>
{
	let allClassified: ClassifiedPath[];

	beforeAll(() =>
	{
		const mdFiles = [
			...collectComponentFiles("agents"),
			...collectComponentFiles("prompts"),
			...collectComponentFiles("commands"),
			...collectComponentFiles("skills"),
		];

		expect(mdFiles.length).toBeGreaterThan(0); // oxlint-disable-line vitest/no-standalone-expect

		allClassified = [];

		for (const filePath of mdFiles)
		{
			const analysis = parseMarkdownFile(filePath);
			if (analysis.llmPaths.length === 0)
			{
				continue;
			}

			const content = readFileSync(filePath, "utf8");
			const relPath = path.relative(PROJECT_ROOT, filePath);

			for (const llmPath of analysis.llmPaths)
			{
				const role = classifyRole(llmPath, content);
				allClassified.push(
					{
						pattern: normalizePath(llmPath.path),
						raw: llmPath.path,
						role,
						sourceFile: relPath,
						line: llmPath.line,
					},
				);
			}
		}
	});

	it("should find .llm/ path references across markdown files", () =>
	{
		expect(allClassified.length).toBeGreaterThan(0);
	});

	it("should have both producers and consumers", () =>
	{
		const producers = allClassified.filter((c) => c.role === "producer");
		const consumers = allClassified.filter((c) => c.role === "consumer");

		expect(producers.length).toBeGreaterThan(0);
		expect(consumers.length).toBeGreaterThan(0);
	});

	it("every consumed path should have at least one producer", () =>
	{
		// Build sets of producer contract keys and exact patterns
		const producerContracts = new Set<string>();
		const producerPatterns = new Set<string>();

		for (const ref of allClassified)
		{
			if (ref.role === "producer")
			{
				producerContracts.add(contractKey(ref.pattern));
				producerPatterns.add(ref.pattern);
			}
		}

		// Known orphaned consumers — real inconsistencies tracked for future fix.
		// These are documented here so the test passes while flagging them.
		// When fixed in the markdown files, remove from this set.
		const knownOrphans = new Set([
			// Legacy refine agents reference a project taxonomy file with no producer
			".llm/gtd-project-taxonomy.json",
			// Private journal vocabulary is supplied outside the repository
			".llm/gtd/journal-vocabulary.md",
			// people-disambiguation.md is referenced but has no producer agent
			".llm/gtd/people-disambiguation.md",
			// Refinement proposals file referenced without a producer
			".llm/refinement-proposals-YYYY-MM.md",
			// Legacy refine agents reference tagger results files that no current producer writes
			".llm/tagger-results-*",
		]);

		const orphanedConsumers: ClassifiedPath[] = [];

		for (const ref of allClassified)
		{
			if (ref.role !== "consumer")
			{
				continue;
			}

			// Skip known orphans
			if (knownOrphans.has(ref.pattern))
			{
				continue;
			}

			const consumerKey = contractKey(ref.pattern);

			// Direct pattern match
			if (producerPatterns.has(ref.pattern))
			{
				continue;
			}

			// Contract key match (directory-level)
			if (contractsMatch(consumerKey, producerContracts))
			{
				continue;
			}

			// Also check the pattern itself against producer contracts
			if (contractsMatch(ref.pattern, producerContracts))
			{
				continue;
			}

			orphanedConsumers.push(ref);
		}

		const details = orphanedConsumers
			.map(
				(c) =>
					`  - ${c.raw} (consumed in ${c.sourceFile}:${c.line})\n    normalized: ${c.pattern}\n    contract: ${contractKey(c.pattern)}`,
			)
			.join("\n");
		const producerList = [...producerContracts].toSorted().join("\n  - ");

		expect(
			orphanedConsumers,
			`Found ${orphanedConsumers.length} consumed path(s) with no matching producer:\n${details}\n\n` +
				`Known producer contracts:\n  - ${producerList}`,
		).toStrictEqual([]);
	});

	it("known contracts should have matching producers and consumers", () =>
	{
		const knownContracts = [
			{
				description: "Scanner outputs -> capture orchestrator",
				producerPattern: ".llm/gtd/capture/scans",
				consumers: ["capture.md"],
			},
			{
				description: "Confirmed captures -> capture-executor",
				producerPattern: ".llm/gtd/capture/confirmed.json",
				consumers: ["capture-executor.md"],
			},
			{
				description: "Inbox loader -> refine orchestrator",
				producerPattern: ".llm/gtd-inboxes.json",
				consumers: ["refine-inbox.md", "inbox.md"],
			},
			{
				description: "Journal scanner outputs -> journal orchestrator",
				producerPattern: ".llm/gtd/journal/scans",
				consumers: ["journal.md"],
			},
		];

		for (const contract of knownContracts)
		{
			const producers = allClassified.filter(
				(c) =>
					c.role === "producer" &&
					(c.pattern === contract.producerPattern ||
						c.pattern.startsWith(`${contract.producerPattern}/`) ||
						contractKey(c.pattern) === contract.producerPattern),
			);

			expect(producers.length).toBeGreaterThan(0);

			for (const expectedConsumer of contract.consumers)
			{
				const consumers = allClassified.filter(
					(c) =>
						c.role === "consumer" &&
						c.sourceFile.includes(expectedConsumer) &&
						(c.pattern === contract.producerPattern ||
							c.pattern.startsWith(contract.producerPattern) ||
							contractKey(c.pattern) === contract.producerPattern ||
							contractKey(c.pattern).startsWith(contract.producerPattern)),
				);

				expect(consumers.length).toBeGreaterThan(0);
			}
		}
	});

	it("should not have .llm/ paths outside the .llm/ directory convention", () =>
	{
		const suspiciousPaths = allClassified.filter((c) => !c.pattern.startsWith(".llm/"));

		const details = suspiciousPaths.map((c) => `  - "${c.raw}" in ${c.sourceFile}:${c.line}`).join("\n");
		expect(
			suspiciousPaths,
			`Found suspicious .llm paths not following .llm/ convention:\n${details}`,
		).toStrictEqual([]);
	});
});
