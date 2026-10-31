/**
 * Splits a decision body line into plain text and the numbers worth a glance
 * (dates, durations like 7d or 3w, bare counts) so the page can color them.
 * The result is rendered as React text nodes, never as HTML.
 */

export type BodyTokenKind = "date" | "duration" | "count" | "overdue";

export interface BodyToken {
	text: string;
	kind: BodyTokenKind | null;
}

// A date, a duration (number plus d/w/h/m/mo/y), or a bare count, standing alone: not inside a word, id or version.
const NUMBER = /(?<![\w-])(?:(\d{4}-\d{2}-\d{2})|(\d+(?:mo|[dwhmy]))|(\d+))(?![\w-])/gu;

export function bodyTokens(line: string): BodyToken[] {
	// The first number on a line that starts with "overdue" is how late it is.
	let overdue = /^\s*overdue\b/iu.test(line);
	const tokens: BodyToken[] = [];
	let last = 0;
	for (const match of line.matchAll(NUMBER)) {
		const [text, date, duration] = match;
		if (match.index > last) {
			tokens.push({text: line.slice(last, match.index), kind: null});
		}
		let kind: BodyTokenKind;
		if (date !== undefined) {
			kind = "date";
		} else if (overdue) {
			kind = "overdue";
			overdue = false;
		} else {
			kind = duration === undefined ? "count" : "duration";
		}
		tokens.push({text, kind});
		last = match.index + text.length;
	}
	if (last < line.length) {
		tokens.push({text: line.slice(last), kind: null});
	}
	return tokens;
}
