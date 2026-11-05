const MENTION = /@[\p{L}\p{N}_-]+/gu;
const SEPARATOR_ROW = /^\|[\s|:-]+\|$/u;

/**
 * Reads the markdown tables of a people-disambiguation file (`| Name in text | Person | Notes |`) into hint phrases
 * per person: each `@Name` in a row's second column gets the row's first-column text (quotes and backticks removed).
 * Rows whose second column says `NOT` are skipped; prose and header rows are ignored. Keys are lowercased `@names`. Pure.
 */
export function parsePeopleHints(markdown: string): Map<string, string[]> {
	const hints = new Map<string, string[]>();
	for (const line of markdown.split("\n")) {
		const row = line.trim();
		if (!row.startsWith("|") || SEPARATOR_ROW.test(row)) {
			continue;
		}
		const [phrase, people] = row
			.slice(1, -1)
			.split("|")
			.map((cell) => cell.trim());
		if (phrase === undefined || people === undefined || /\bNOT\b/u.test(people)) {
			continue;
		}
		const text = phrase.replaceAll(/["`]/gu, "").replaceAll(/\s+/gu, " ").trim();
		for (const [mention] of people.matchAll(MENTION)) {
			const key = mention.toLowerCase();
			const list = hints.get(key) ?? [];
			if (text !== "" && !list.includes(text)) {
				list.push(text);
			}
			hints.set(key, list);
		}
	}
	return hints;
}
