import type {ApiLogger} from "@outlinedb/shared/api";
import pino from "pino";
import pinoPretty from "pino-pretty";
import {format} from "sql-formatter";
import {highlight} from "sql-highlight";
import {z} from "zod";

/**
 * Category filter definition.
 */
interface CategoryFilter
{
	category: string;
	subcategory?: string;
}

/**
 * Category filters mapped to environment variables.
 * Each env var can enable multiple category/subcategory combinations.
 */
const CATEGORY_FILTERS: Record<string, CategoryFilter[]> =
{
	OUTLINEDB_SQL_READ_LOGGING: [
		{
			category: "sql",
			subcategory: "read",
		},
	],
	OUTLINEDB_SQL_WRITE_LOGGING: [
		{
			category: "sql",
			subcategory: "write",
		},
	],
	OUTLINEDB_SQL_SCHEMA_LOGGING: [
		{
			category: "sql",
			subcategory: "schema",
		},
	],
	OUTLINEDB_SQL_BULK_LOGGING: [
		{
			category: "sql",
			subcategory: "bulk",
		},
	],
	OUTLINEDB_SQL_QUERY_LOGGING: [
		{
			category: "sql",
			subcategory: "read",
		},
		{
			category: "sql",
			subcategory: "write",
		},
		{
			category: "sql",
			subcategory: "schema",
		},
		{
			category: "sql",
			subcategory: "bulk",
		},
	],
	OUTLINEDB_SQL_RESULTS_LOGGING: [
		{
			category: "sql",
			subcategory: "result",
		},
	],
	OUTLINEDB_REST_LOGGING: [
		{
			category: "rest",
			subcategory: "request",
		},
		{
			category: "rest",
			subcategory: "response",
		},
		{
			category: "rest",
			subcategory: "error",
		},
	],
	OUTLINEDB_GENERAL_LOGGING: [
		{
			category: "general",
		},
	],
};

/**
 * Check if any logging category is enabled via environment variables.
 */
const anyLoggingEnabled =
	process.env.OUTLINEDB_SQL_QUERY_LOGGING === "true" ||
	process.env.OUTLINEDB_SQL_READ_LOGGING === "true" ||
	process.env.OUTLINEDB_SQL_WRITE_LOGGING === "true" ||
	process.env.OUTLINEDB_SQL_SCHEMA_LOGGING === "true" ||
	process.env.OUTLINEDB_SQL_BULK_LOGGING === "true" ||
	process.env.OUTLINEDB_SQL_RESULTS_LOGGING === "true" ||
	process.env.OUTLINEDB_REST_LOGGING === "true" ||
	process.env.OUTLINEDB_GENERAL_LOGGING === "true";

/**
 * Check if a log object should be shown based on its category/subcategory
 * and the enabled environment variables.
 */
function isEnabled(category?: string, subcategory?: string): boolean
{
	for (const [envVar, filters] of Object.entries(CATEGORY_FILTERS))
	{
		if (process.env[envVar] !== "true")
		{
			continue;
		}

		for (const filter of filters)
		{
			if (category === filter.category && (!filter.subcategory || subcategory === filter.subcategory))
			{
				return true;
			}
		}
	}
	return false;
}

/**
 * ANSI color codes for JSON-like param coloring.
 */
const COLORS =
{
	cyan: "\u001B[36m",
	green: "\u001B[32m",
	yellow: "\u001B[33m",
	reset: "\u001B[0m",
};

/**
 * Format params array for display.
 */
function formatParams(params: unknown[], colorize: boolean): string
{
	if (params.length === 0)
	{
		return colorize ? `${COLORS.cyan}params=[]${COLORS.reset}` : "params=[]";
	}

	const formatted = params
		.map((p) =>
		{
			const json = JSON.stringify(p);
			if (!colorize)
			{
				return json;
			}
			if (typeof p === "string")
			{
				return `${COLORS.green}${json}${COLORS.reset}`;
			}
			if (typeof p === "number")
			{
				return `${COLORS.yellow}${json}${COLORS.reset}`;
			}
			return json;
		})
		.join(colorize ? `${COLORS.cyan},${COLORS.reset}` : ",");

	return colorize
		? `${COLORS.cyan}params=[${COLORS.reset}${formatted}${COLORS.cyan}]${COLORS.reset}`
		: `params=[${formatted}]`;
}

/**
 * Pino log level:
 * - Uses OUTLINEDB_LOG_LEVEL if set
 * - Otherwise 'debug' if any logging is enabled (to allow filtering)
 * - Otherwise 'silent' to disable all logging
 */
const level = process.env.OUTLINEDB_LOG_LEVEL ?? (anyLoggingEnabled ? "debug" : "silent");

function optionalString(value: unknown): string | undefined
{
	return typeof value === "string" ? value : undefined;
}

/**
 * Synchronous pino-pretty stream that writes to stderr.
 * Using sync mode ensures logs are written immediately, not buffered.
 * Filtering is done via the write hook.
 */
const prettyStream = pinoPretty(
	{
		colorize: true,
		translateTime: "SYS:standard",
		ignore: "pid,hostname,category,subcategory,params",
		destination: 2, // stderr
		sync: true, // Synchronous writes - critical for correct output ordering
		messageFormat(log, messageKey)
		{
			const msg = String(log[messageKey]);
			const category = optionalString(log.category);
			const subcategory = optionalString(log.subcategory);
			const params: unknown[] | undefined = Array.isArray(log.params) ? log.params : undefined;

			// Skip if category filtering doesn't pass
			if (!isEnabled(category, subcategory))
			{
				return "";
			}

			const categoryTag = subcategory ? `${category}:${subcategory}` : category;
			const paramsStr = params === undefined ? "" : ` ${formatParams(params, true)}`;
			const metadataSuffix = categoryTag ? ` [${categoryTag}]${paramsStr}` : "";

			if (msg.startsWith("SQL\n"))
			{
				const query = msg.slice(4);
				return `SQL${metadataSuffix}\n${query}`;
			}

			const newlineIndex = msg.indexOf("\n");
			if (newlineIndex !== -1 && metadataSuffix)
			{
				const firstLine = msg.slice(0, newlineIndex);
				const rest = msg.slice(newlineIndex);
				return `${firstLine}${metadataSuffix}${rest}`;
			}

			return `${msg}${metadataSuffix}`;
		},
	},
);

/**
 * Filtering wrapper stream that only passes through enabled log categories.
 * This prevents pino-pretty from outputting anything for filtered logs.
 */
const LogLineCategorySchema = z.object(
	{
		category: z.string().optional(),
		subcategory: z.string().optional(),
	},
);

const filteringStream =
{
	write(chunk: string): void
	{
		try
		{
			const log = LogLineCategorySchema.parse(JSON.parse(chunk));
			if (isEnabled(log.category, log.subcategory))
			{
				prettyStream.write(chunk);
			}
		}
		catch
		{
			// If parsing fails, pass through as-is
			prettyStream.write(chunk);
		}
	},
};

/**
 * Base pino logger with synchronous filtering stream.
 *
 * The stream handles:
 * - Category-based filtering via environment variables
 * - Pretty printing with colorized output
 * - Synchronous writes to ensure correct ordering with stdout
 */
const baseLogger = pino(
	{
		level,
	},
	filteringStream,
);

// Child loggers with category/subcategory context
const sqlReadLogger = baseLogger.child(
	{
		category: "sql",
		subcategory: "read",
	},
);
const sqlWriteLogger = baseLogger.child(
	{
		category: "sql",
		subcategory: "write",
	},
);
const sqlSchemaLogger = baseLogger.child(
	{
		category: "sql",
		subcategory: "schema",
	},
);
const sqlBulkLogger = baseLogger.child(
	{
		category: "sql",
		subcategory: "bulk",
	},
);
const sqlResultLogger = baseLogger.child(
	{
		category: "sql",
		subcategory: "result",
	},
);
const restRequestLogger = baseLogger.child(
	{
		category: "rest",
		subcategory: "request",
	},
);
const restResponseLogger = baseLogger.child(
	{
		category: "rest",
		subcategory: "response",
	},
);
const restErrorLogger = baseLogger.child(
	{
		category: "rest",
		subcategory: "error",
	},
);
const generalLogger = baseLogger.child(
	{
		category: "general",
	},
);

/**
 * Export child loggers directly.
 * Callers choose the appropriate severity level (debug, info, warn, error).
 */
export const log =
{
	sql:
	{
		read: sqlReadLogger,
		write: sqlWriteLogger,
		schema: sqlSchemaLogger,
		bulk: sqlBulkLogger,
		result: sqlResultLogger,
	},
	rest:
	{
		request: restRequestLogger,
		response: restResponseLogger,
		error: restErrorLogger,
	},
	general: generalLogger,
};

/**
 * SQL query categories for granular logging control.
 */
type SqlCategory = "read" | "write" | "schema" | "bulk";

/**
 * Classify a SQL query as read, write, schema (DDL), or bulk operation.
 * Used for granular logging control via environment variables.
 */
function classifyQuery(query: string): SqlCategory
{
	// Normalize: strip leading whitespace and comments
	const normalized = query.replaceAll(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/gu, "").trim();

	// Read: SELECT or WITH...SELECT (CTEs)
	if (/^(SELECT|WITH\b)/iu.test(normalized))
	{
		return "read";
	}

	// Schema (DDL): CREATE, ALTER, DROP statements for tables, indexes, triggers, views
	if (/^(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TRIGGER|VIEW|VIRTUAL TABLE)/iu.test(normalized))
	{
		return "schema";
	}

	// Bulk: multiple VALUES tuples or INSERT...SELECT
	if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+.*VALUES\s*\([^)]*\)\s*,/iu.test(normalized))
	{
		return "bulk";
	}
	if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+.*\bSELECT\b/iu.test(normalized))
	{
		return "bulk";
	}

	// Write: INSERT, UPDATE, DELETE, REPLACE (single-row DML)
	return "write";
}

/**
 * Maximum params to show for bulk INSERT queries before truncating.
 */
const MAX_BULK_PARAMS = 10;

/**
 * Sanitize SQL params for logging by replacing Buffer objects with placeholders.
 * This prevents large binary data (like embeddings) from cluttering logs.
 * For bulk queries, truncates after MAX_BULK_PARAMS items.
 */
function sanitizeParams(params: unknown[], isBulk: boolean): unknown[]
{
	let sanitized = params.map((param) =>
	{
		if (Buffer.isBuffer(param))
		{
			return `[Buffer: ${param.length} bytes]`;
		}
		return param;
	});

	// Truncate bulk INSERT params after 10 items
	if (isBulk && sanitized.length > MAX_BULK_PARAMS)
	{
		const remaining = sanitized.length - MAX_BULK_PARAMS;
		sanitized = [...sanitized.slice(0, MAX_BULK_PARAMS), `...and ${remaining} more`];
	}

	return sanitized;
}

/**
 * Maximum size for logged data before truncation (~5 pages of terminal output).
 */
const MAX_LOG_DATA_SIZE = 10_000;

/**
 * Truncate large data objects for logging.
 * Returns a placeholder for objects that would produce large JSON output.
 */
function truncateData(data: unknown): unknown
{
	if (data === null || data === undefined)
	{
		return data;
	}

	const json = JSON.stringify(data);
	if (json.length <= MAX_LOG_DATA_SIZE)
	{
		return data;
	}

	// For arrays, show count
	if (Array.isArray(data))
	{
		return `[Array: ${data.length} items, ${json.length} bytes]`;
	}

	// For objects, show keys and size
	if (typeof data === "object")
	{
		const keys = Object.keys(data);
		return `[Object: ${keys.length} keys, ${json.length} bytes]`;
	}

	// For strings, truncate with ellipsis
	if (typeof data === "string")
	{
		return `${data.slice(0, MAX_LOG_DATA_SIZE)}...`;
	}

	return data;
}

/**
 * Threshold for short query single-line formatting.
 * Queries shorter than this are displayed on a single line.
 */
const SHORT_QUERY_THRESHOLD = 120;

/**
 * Format and syntax-highlight SQL query for display.
 * Short queries (≤120 chars) are normalized to single line.
 * Long queries are pretty-printed with sql-formatter.
 * All queries get syntax highlighting with ANSI colors.
 */
function formatSql(query: string): string
{
	// Short queries stay on a single line, long queries get pretty-printed
	const formatted =
		query.length <= SHORT_QUERY_THRESHOLD
			? query.trim().replaceAll(/\s+/gu, " ")
			: format(
					query,
					{
						language: "sqlite",
						tabWidth: 2,
						keywordCase: "upper",
					},
				);

	// Apply syntax highlighting
	return highlight(formatted);
}

/**
 * Unified logger that implements ApiLogger interface.
 * Delegates to the appropriate child loggers based on log type.
 *
 * For backward compatibility, this class provides the same interface
 * as the previous Logger class while using the new pino architecture.
 */
class Logger implements ApiLogger
{
	/**
	 * Log a debug message (general category)
	 */
	debug(message: string, data?: Record<string, unknown>): void
	{
		if (data)
		{
			generalLogger.debug(data, message);
		}
		else
		{
			generalLogger.debug(message);
		}
	}

	/**
	 * Log a warning message (general category)
	 */
	warn(message: string, data?: Record<string, unknown>): void
	{
		if (data)
		{
			generalLogger.warn(data, message);
		}
		else
		{
			generalLogger.warn(message);
		}
	}

	/**
	 * Log an info message (general category)
	 */
	info(message: string, data?: Record<string, unknown>): void
	{
		if (data)
		{
			generalLogger.info(data, message);
		}
		else
		{
			generalLogger.info(message);
		}
	}

	/**
	 * Log a SQL query with appropriate severity level and category.
	 * READ operations (SELECT): debug severity, sql:read category
	 * WRITE operations (INSERT, UPDATE, DELETE): info severity, sql:write category
	 * SCHEMA operations (CREATE, ALTER, DROP): info severity, sql:schema category
	 * BULK operations (multi-row INSERT): info severity, sql:bulk category
	 */
	logSql(query: string, params: unknown[]): void
	{
		const category = classifyQuery(query);
		const formattedQuery = formatSql(query);
		const sanitizedParams = sanitizeParams(params, category === "bulk");

		const loggers =
		{
			read: sqlReadLogger,
			write: sqlWriteLogger,
			schema: sqlSchemaLogger,
			bulk: sqlBulkLogger,
		};
		const logger = loggers[category];

		// Read operations use debug level, write/schema/bulk use info
		if (category === "read")
		{
			logger.debug(
				{
					params: sanitizedParams,
				},
				`SQL\n${formattedQuery}`,
			);
		}
		else
		{
			logger.info(
				{
					params: sanitizedParams,
				},
				`SQL\n${formattedQuery}`,
			);
		}
	}

	/**
	 * Log SQL query results.
	 */
	logSqlResult(label: string, result: unknown): void
	{
		sqlResultLogger.debug(
			{
				result,
			},
			`SQL Result: ${label}`,
		);
	}

	/**
	 * Log an API request (ApiLogger interface)
	 * Large request bodies are truncated to prevent log flooding.
	 */
	logRequest(url: string, method: string, body?: unknown): void
	{
		restRequestLogger.debug(
			{
				method,
				url,
				body: truncateData(body),
			},
			`-> ${method} ${url}`,
		);
	}

	/**
	 * Log an API response (ApiLogger interface)
	 * Large response bodies are truncated to prevent log flooding.
	 */
	logResponse(url: string, method: string, status: number, statusText: string, data: unknown, duration: number): void
	{
		restResponseLogger.debug(
			{
				method,
				url,
				status,
				statusText,
				data: truncateData(data),
				duration,
			},
			`<- ${status} ${statusText} (${duration.toFixed(0)}ms)`,
		);
	}

	/**
	 * Log an API error (ApiLogger interface)
	 */
	logError(url: string, method: string, error: unknown, duration: number): void
	{
		restErrorLogger.error(
			{
				method,
				url,
				error: error instanceof Error ? error.message : String(error),
				duration,
			},
			`X ${method} ${url} failed after ${duration.toFixed(0)}ms`,
		);
	}
}

/**
 * Singleton logger instance for backward compatibility.
 * Use this when you need the ApiLogger interface or the wrapper methods.
 * For direct pino access, use the exported `log` object instead.
 */
export const logger = new Logger();
