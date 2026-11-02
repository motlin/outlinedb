import {readFileSync} from "node:fs";

export interface CliInvocation
{
	command: string;
	flags: string[];
	line: number;
	raw: string;
}

export interface SubagentRef
{
	name: string;
	line: number;
}

export interface LlmPath
{
	path: string;
	line: number;
}

export interface CommandRef
{
	ref: string;
	line: number;
}

export interface ScriptRef
{
	path: string;
	line: number;
}

export interface ThresholdRef
{
	value: number;
	context: string;
	line: number;
}

export interface MarkdownFileAnalysis
{
	filePath: string;
	cliInvocations: CliInvocation[];
	subagentRefs: SubagentRef[];
	llmPaths: LlmPath[];
	commandRefs: CommandRef[];
	scriptRefs: ScriptRef[];
	thresholds: ThresholdRef[];
}

/**
 * Resolve a CLI invocation like `node list` to a manifest command ID like `node:list`.
 * Uses greedy longest-prefix match: try 4-word, 3-word, 2-word, 1-word joined with `:`.
 */
export function resolveCommandId(words: string[]):
{
	command: string;
	remaining: string[];
}
{
	const maxLen = Math.min(words.length, 4);
	for (let len = maxLen; len >= 1; len--)
	{
		const command = words.slice(0, len).join(":");
		const remaining = words.slice(len);
		if (len > 1 || remaining.length === 0 || remaining[0]?.startsWith("-"))
		{
			return {
				command,
				remaining,
			};
		}
	}
	return {
		command: words[0] ?? "",
		remaining: words.slice(1),
	};
}

/**
 * Join continuation lines (lines ending with `\`) into a single logical line.
 * Returns an array of {text, lineNumber} where lineNumber is the 1-based start line.
 */
export function joinContinuationLines(lines: string[]):
{
	text: string;
	lineNumber: number;
}[]
{
	const result:
	{
		text: string;
		lineNumber: number;
	}[] = [];
	let buffer = "";
	let startLine = 0;

	for (const [i, line] of lines.entries())
	{
		if (buffer === "")
		{
			startLine = i + 1; // 1-based
		}

		if (line.endsWith("\\"))
		{
			buffer += `${line.slice(0, -1)} `;
		}
		else
		{
			buffer += line;
			result.push(
				{
					text: buffer,
					lineNumber: startLine,
				},
			);
			buffer = "";
		}
	}

	if (buffer !== "")
	{
		result.push(
			{
				text: buffer,
				lineNumber: startLine,
			},
		);
	}

	return result;
}

/**
 * Check if a token is a stop token for flag parsing (pipes, redirects, etc.).
 */
function isStopToken(token: string): boolean
{
	const stopTokens = new Set(["2>", "2>>", "&&", ";", "<", ">", ">>", "|", "||"]);
	return (
		stopTokens.has(token) ||
		token.startsWith("#") ||
		token.startsWith("|") ||
		token.startsWith(">") ||
		token.startsWith("<")
	);
}

/**
 * Extract flags from CLI argument tokens.
 * Stops at pipes `|`, redirects `>`, `<`, `2>`, and comments `#`.
 * Handles `--no-` prefix for boolean flags (strips it to get the base flag name).
 * Skips variable substitutions (`$VAR`, `${VAR}`) as flag values.
 */
function extractFlags(tokens: string[]): string[]
{
	const flags: string[] = [];

	for (let i = 0; i < tokens.length; i++)
	{
		const token = tokens[i];

		if (token === undefined || isStopToken(token))
		{
			break;
		}

		if (token.startsWith("--"))
		{
			const rawFlagName = token.includes("=") ? token.slice(2, token.indexOf("=")) : token.slice(2);
			// Strip trailing markdown artifacts (backticks, quotes, brackets)
			const flagName = rawFlagName.replace(/[`"')\]]+$/u, "");

			const normalizedFlag = flagName.startsWith("no-") ? flagName.slice(3) : flagName;

			if (normalizedFlag)
			{
				flags.push(normalizedFlag);
			}

			// If the next token is a value (not another flag, not a stop token), skip it
			if (!token.includes("=") && i + 1 < tokens.length)
			{
				const next = tokens[i + 1];
				if (next && !next.startsWith("-") && !isStopToken(next))
				{
					i++; // skip the value
				}
			}
		}
		else if (token.startsWith("-") && token.length === 2)
		{
			flags.push(token.slice(1));
		}
	}

	return flags;
}

/**
 * Tokenize a CLI command string, handling quoted strings.
 */
function tokenize(str: string): string[]
{
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (const ch of str)
	{
		if (ch === "'" && !inDouble)
		{
			inSingle = !inSingle;
			current += ch;
		}
		else if (ch === '"' && !inSingle)
		{
			inDouble = !inDouble;
			current += ch;
		}
		else if (ch === " " && !inSingle && !inDouble)
		{
			if (current)
			{
				tokens.push(current);
				current = "";
			}
		}
		else
		{
			current += ch;
		}
	}

	if (current)
	{
		tokens.push(current);
	}

	return tokens;
}

/**
 * Parse a single CLI invocation line into a CliInvocation.
 */
function parseCliInvocation(text: string, lineNumber: number): CliInvocation | null
{
	const runJsIndex = text.indexOf("./bin/run.js");
	if (runJsIndex === -1)
	{
		return null;
	}

	const afterRunJs = text.slice(runJsIndex + "./bin/run.js".length).trim();
	if (!afterRunJs)
	{
		return {
			command: "",
			flags: [],
			line: lineNumber,
			raw: text.trim(),
		};
	}

	const tokens = tokenize(afterRunJs);
	if (tokens.length === 0)
	{
		return {
			command: "",
			flags: [],
			line: lineNumber,
			raw: text.trim(),
		};
	}

	// Separate command words from flags/values
	const commandTokens: string[] = [];
	let flagStartIndex = 0;

	for (const [i, token] of tokens.entries())
	{
		if (token.startsWith("-") || isStopToken(token))
		{
			flagStartIndex = i;
			break;
		}
		if (token.startsWith("$") || token.startsWith('"') || token.startsWith("'") || token.startsWith("{"))
		{
			flagStartIndex = i;
			break;
		}

		// Strip trailing markdown artifacts (closing code-span backtick, prose
		// punctuation) so `via `./bin/run.js node create`:` resolves to `node:create`.
		const cleanToken = token.replace(/[`"':,.)\]]+$/u, "");
		if (cleanToken)
		{
			commandTokens.push(cleanToken);
		}
		flagStartIndex = i + 1;
	}

	let command: string;
	let remaining: string[];
	if (commandTokens.length === 0)
	{
		command = "";
		remaining = [];
	}
	else
	{
		({command, remaining} = resolveCommandId(commandTokens));
	}

	const allFlagTokens = [...remaining, ...tokens.slice(flagStartIndex)];
	const flags = extractFlags(allFlagTokens);

	return {
		command,
		flags,
		line: lineNumber,
		raw: text.trim(),
	};
}

/**
 * Extract CLI invocations from joined lines.
 * Handles: `./bin/run.js`, `LOG_LEVEL=fatal ./bin/run.js`, pipes with `xargs ... ./bin/run.js`
 */
function extractCliInvocations(
	joinedLines:
	{
		text: string;
		lineNumber: number;
	}[],
): CliInvocation[]
{
	const results: CliInvocation[] = [];

	for (const {text, lineNumber} of joinedLines)
	{
		let searchStart = 0;
		while (true)
		{
			const idx = text.indexOf("./bin/run.js", searchStart);
			if (idx === -1)
			{
				break;
			}

			const afterRunJs = text.slice(idx + "./bin/run.js".length);

			const nextRunJs = afterRunJs.indexOf("./bin/run.js");
			const segment = nextRunJs === -1 ? afterRunJs : afterRunJs.slice(0, nextRunJs);

			const cleanSegment = segment
				.replace(/\|\s*xargs\s.*$/u, "")
				.replace(/\|\s*$/u, "")
				.trim();

			const invocation = parseCliInvocation(`./bin/run.js ${cleanSegment}`, lineNumber);
			if (invocation)
			{
				invocation.raw = text.trim();
				results.push(invocation);
			}

			searchStart = idx + "./bin/run.js".length;
		}
	}

	return results;
}

/**
 * Extract subagent_type references.
 * Matches patterns like: subagent_type: "name" or subagent_type: 'name'
 */
function extractSubagentRefs(lines: string[]): SubagentRef[]
{
	const results: SubagentRef[] = [];
	const pattern = /subagent_type:\s*["']([^"']+)["']/u;

	for (const [i, line] of lines.entries())
	{
		const match = pattern.exec(line);
		const name = match?.[1];
		if (name !== undefined)
		{
			results.push(
				{
					name,
					line: i + 1,
				},
			);
		}
	}

	return results;
}

/**
 * Extract .llm/ path references.
 */
function extractLlmPaths(lines: string[]): LlmPath[]
{
	const results: LlmPath[] = [];
	// Require at least one path segment after `.llm/` so bare directory-root
	// mentions (e.g. "track progress through `.llm/` files") aren't treated as
	// intermediate-file contracts.
	const pattern = /(?:^|[\s"'`(])(\.?\/?\.llm\/[^\s"'`),;#]+)/gu;

	for (const [i, line] of lines.entries())
	{
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(line)) !== null)
		{
			let path = match[1];
			if (path === undefined)
			{
				continue;
			}
			if (path.startsWith("./"))
			{
				path = path.slice(2);
			}

			path = path.replace(/[.)]+$/u, "");
			if (path)
			{
				results.push(
					{
						path,
						line: i + 1,
					},
				);
			}
		}
	}

	return results;
}

/**
 * Extract cross-command references like /gtd:X or /workflowy:X
 */
function extractCommandRefs(lines: string[]): CommandRef[]
{
	const results: CommandRef[] = [];
	const pattern = /(?:^|[\s`"'(])(\/([\w-]+:[\w-]+(?::[\w-]+)*))/u;

	for (const [i, line] of lines.entries())
	{
		const match = pattern.exec(line);
		const ref = match?.[1];
		if (!match || ref === undefined)
		{
			continue;
		}
		const hasUrl = line.includes("http://") || line.includes("https://");
		if (!hasUrl || !/https?:$/u.test(line.slice(0, line.indexOf(match[0]))))
		{
			results.push(
				{
					ref,
					line: i + 1,
				},
			);
		}
	}

	return results;
}

/**
 * Extract script references: `.claude/scripts/...` (project-local) and
 * `${CLAUDE_PLUGIN_ROOT}/scripts/...` (plugin-relative).
 */
function extractScriptRefs(lines: string[]): ScriptRef[]
{
	const results: ScriptRef[] = [];
	const pattern = /(?:^|[\s"'`(])((?:\.?\/?\.claude|\$\{CLAUDE_PLUGIN_ROOT\})\/scripts\/[^\s"'`),;#]+)/gu;

	for (const [i, line] of lines.entries())
	{
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(line)) !== null)
		{
			let path = match[1];
			if (path === undefined)
			{
				continue;
			}
			if (path.startsWith("./"))
			{
				path = path.slice(2);
			}

			path = path.replace(/[.)]+$/u, "");
			if (path)
			{
				results.push(
					{
						path,
						line: i + 1,
					},
				);
			}
		}
	}

	return results;
}

/**
 * Extract confidence thresholds like `>= 0.85`, `> 0.9`, etc.
 */
function extractThresholds(lines: string[]): ThresholdRef[]
{
	const results: ThresholdRef[] = [];
	const pattern = />=?\s*(0\.\d+)/gu;

	for (const [i, line] of lines.entries())
	{
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(line)) !== null)
		{
			const value = Number(match[1]);
			if (value > 0 && value <= 1)
			{
				const context = line.trim().slice(0, 100);
				results.push(
					{
						value,
						context,
						line: i + 1,
					},
				);
			}
		}
	}

	return results;
}

/**
 * Parse a markdown file and return structured analysis of all cross-references.
 */
export function parseMarkdownFile(filePath: string): MarkdownFileAnalysis
{
	const content = readFileSync(filePath, "utf8");
	return parseMarkdownContent(filePath, content);
}

/**
 * Parse markdown content (for testing without filesystem access).
 */
export function parseMarkdownContent(filePath: string, content: string): MarkdownFileAnalysis
{
	const lines = content.split("\n");
	const joinedLines = joinContinuationLines(lines);

	return {
		filePath,
		cliInvocations: extractCliInvocations(joinedLines),
		subagentRefs: extractSubagentRefs(lines),
		llmPaths: extractLlmPaths(lines),
		commandRefs: extractCommandRefs(lines),
		scriptRefs: extractScriptRefs(lines),
		thresholds: extractThresholds(lines),
	};
}
