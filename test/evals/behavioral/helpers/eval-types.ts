/**
 * Type definitions for behavioral eval scenarios.
 *
 * Behavioral evals run skills, scripts, and CLI commands against a local
 * SQLite copy of the Workflowy data and evaluate outcomes.
 */

/** Captured tool call from an LLM eval conversation. */
export interface CapturedToolCall
{
	name: string;
	input: Record<string, unknown>;
	result: string;
}

/** Result of running an LLM eval scenario. */
export interface LlmEvalResult
{
	toolCalls: CapturedToolCall[];
	finalResponse: string;
	inputTokens: number;
	outputTokens: number;
	stopReason: string;
	subagentExecutions: SubagentExecution[];
}

export interface SubagentExecution
{
	/** The subagent_type string from the Agent tool call */
	agentName: string;
	/** The prompt sent to the subagent */
	prompt: string;
	/** The full eval result from the subagent's conversation */
	result: LlmEvalResult;
}

export interface EvalContext
{
	/** Path to the temporary copy of outlinedb.sqlite */
	dbPath: string;
	/** Path to the temporary .llm/ directory for intermediate files */
	llmDir: string;
	/** Project root directory (for resolving relative paths) */
	projectRoot: string;
	/** Temp working directory for `claude -p` runs: holds `.llm/` and a `bin` symlink to the repo CLI */
	workDir: string;
	/** Environment variables to set when running commands */
	env: Record<string, string>;
	/** Clean up temp files and restore environment */
	cleanup: () => void;
	/** Port the mock Workflowy server is listening on */
	mockServerPort?: number;
}

export interface EvalResult
{
	/** Standard output from the command */
	stdout: string;
	/** Standard error from the command */
	stderr: string;
	/** Process exit code */
	exitCode: number;
	/** Files created in the .llm/ temp directory, keyed by relative path */
	filesCreated: Record<string, string>;
}
