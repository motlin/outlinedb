import {it, expect, beforeAll, describe} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {parseMarkdownFile} from "./helpers/markdown-parser.js";
import type {CliInvocation, MarkdownFileAnalysis} from "./helpers/markdown-parser.js";
import {collectComponentFiles} from "./helpers/scan-roots.js";

interface ManifestCommand
{
	id: string;
	flags: Record<
		string,
		{
			name: string;
			char?: string;
			type: string;
		}
	>;
	hidden?: boolean;
}

interface Manifest
{
	commands: Record<string, ManifestCommand>;
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifest(value: unknown): value is Manifest
{
	return (
		isRecord(value) &&
		isRecord(value.commands) &&
		Object.values(value.commands).every(
			(command) => isRecord(command) && typeof command.id === "string" && isRecord(command.flags),
		)
	);
}

/** Universal flags accepted by all oclif commands, even if not in the manifest. */
const UNIVERSAL_FLAGS = new Set(["help", "json", "verbose", "version", "yes"]);

/** Hidden base commands that shouldn't be used directly. */
const HIDDEN_BASE_COMMANDS = new Set(["base-completion-command", "base-list-command"]);

/** Build a short-flag-to-long-flag lookup for a command. */
function buildCharMap(flags: ManifestCommand["flags"]): Map<string, string>
{
	const map = new Map<string, string>();
	for (const flag of Object.values(flags))
	{
		if (flag.char)
		{
			map.set(flag.char, flag.name);
		}
	}
	return map;
}

/**
 * Resolve a short flag char to its long flag name for a given command.
 * Returns the char itself if no mapping is found.
 */
function resolveFlag(flag: string, charMap: Map<string, string>): string
{
	return flag.length === 1 ? (charMap.get(flag) ?? flag) : flag;
}

describe("CLI Reference Validation", () =>
{
	const projectRoot = join(import.meta.dirname, "..", "..", "..");
	const manifestPath = join(projectRoot, "packages", "cli", "oclif.manifest.json");

	let manifest: Manifest;
	let allAnalyses: MarkdownFileAnalysis[];
	let allInvocations:
	{
		invocation: CliInvocation;
		filePath: string;
	}[];

	beforeAll(() =>
	{
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (!isManifest(parsed))
		{
			throw new Error(`${manifestPath} is not an oclif manifest with a commands map`);
		}
		manifest = parsed;

		const markdownFiles = [
			...collectComponentFiles("skills"),
			...collectComponentFiles("commands"),
			...collectComponentFiles("agents"),
			...collectComponentFiles("prompts"),
		];

		allAnalyses = markdownFiles.map((f) => parseMarkdownFile(f));

		allInvocations = allAnalyses.flatMap((analysis) =>
			analysis.cliInvocations.map((invocation) => (
			{
				invocation,
				filePath: analysis.filePath,
			})),
		);
	});

	it("finds CLI references in skill files", () =>
	{
		expect(allInvocations.length).toBeGreaterThan(0);
	});

	it("all commands resolve to valid manifest entries", () =>
	{
		const commandIds = new Set(Object.keys(manifest.commands));
		const errors: string[] = [];

		for (const {invocation, filePath} of allInvocations)
		{
			const {command, line} = invocation;

			// Skip empty commands (bare ./bin/run.js --help, --version)
			if (!command)
			{
				continue;
			}

			// Skip hidden base commands
			if (HIDDEN_BASE_COMMANDS.has(command))
			{
				continue;
			}

			// Skip template placeholders like <command>
			if (command.includes("<") || command.includes(">"))
			{
				continue;
			}

			if (!commandIds.has(command))
			{
				const relativePath = filePath.replace(`${projectRoot}/`, "");
				const validCommands = [...commandIds]
					.filter((id) => !HIDDEN_BASE_COMMANDS.has(id))
					.toSorted()
					.join(", ");
				errors.push(
					`${relativePath}:${line}: ./bin/run.js ${command}\n` +
						`  Unknown command "${command}". Valid commands: ${validCommands}`,
				);
			}
		}

		expect(errors).toStrictEqual([]);
	});

	it("all flags are valid for their commands", () =>
	{
		const commandIds = new Set(Object.keys(manifest.commands));
		const errors: string[] = [];

		for (const {invocation, filePath} of allInvocations)
		{
			const {command, flags, line} = invocation;

			// Skip empty commands or commands not in manifest (caught by the previous test)
			if (!command || !commandIds.has(command))
			{
				continue;
			}

			const manifestCmd = manifest.commands[command];
			if (manifestCmd === undefined)
			{
				continue;
			}
			const validFlags = new Set(Object.keys(manifestCmd.flags));
			const charMap = buildCharMap(manifestCmd.flags);

			for (const flag of flags)
			{
				const resolvedFlag = resolveFlag(flag, charMap);

				if (UNIVERSAL_FLAGS.has(resolvedFlag))
				{
					continue;
				}
				// The parser strips a `--no-` prefix, which may be a real flag name (`--no-child`) or a negation.
				if (validFlags.has(resolvedFlag) || validFlags.has(`no-${resolvedFlag}`))
				{
					continue;
				}

				const relativePath = filePath.replace(`${projectRoot}/`, "");
				const validFlagList = [...validFlags].toSorted().join(", ");
				errors.push(
					`${relativePath}:${line}: --${flag} on command "${command}"\n` +
						`  Unknown flag "${resolvedFlag}". Valid flags for ${command}: ${validFlagList}`,
				);
			}
		}

		expect(errors).toStrictEqual([]);
	});
});
