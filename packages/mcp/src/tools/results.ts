import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {systemTimesAsIso} from "@outlinedb/shared/temporal";
import type {OpResult} from "@outlinedb/web/server-app";

export function textResult(text: string): CallToolResult
{
	return {
		content: [
			{
				type: "text",
				text,
			},
		],
	};
}

/** `value` as pretty JSON, with node versions' `systemFrom`/`systemTo` as ISO text (a current `systemTo` as null). */
export function jsonResult(value: unknown): CallToolResult
{
	return textResult(JSON.stringify(value, systemTimesAsIso, 2));
}

export function errorResult(text: string): CallToolResult
{
	return {
		content: [
			{
				type: "text",
				text,
			},
		],
		isError: true,
	};
}

/** A failed op's error message: its `{error}` body, else the body itself. */
function failureText(body: unknown): string
{
	if (typeof body === "string")
	{
		return body;
	}
	if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string")
	{
		return body.error;
	}
	return JSON.stringify(body);
}

/** A failed op as a tool error. */
export function opError(
	result: Extract<
		OpResult<unknown>,
		{
			ok: false;
		}
	>,
): CallToolResult
{
	return errorResult(failureText(result.body));
}

/** A node's workflowy.com link. */
export function nodeUrl(id: string): string
{
	return `https://workflowy.com/#/${id.replaceAll("-", "")}`;
}
