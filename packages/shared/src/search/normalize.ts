const ASCII = /^\p{ASCII}*$/u;

/** Fold a string for search: strip diacritics (NFD + drop combining marks) and lowercase. */
export function normalizeForSearch(s: string): string {
	// ASCII has no combining marks and is already NFD, and skipping NFD and the mark scan halves a whole-tree jump-menu pass.
	if (ASCII.test(s)) {
		return s.toLowerCase();
	}
	return s
		.normalize("NFD")
		.replaceAll(/\p{M}+/gu, "")
		.toLowerCase();
}

export interface NormalizedText {
	text: string;
	/** Original start offset for each normalized code unit. */
	starts: number[];
	/** Original end offset for each normalized code unit (extended over dropped combining marks). */
	ends: number[];
}

/**
 * {@link normalizeWithOffsets}' text alone, without the two offset arrays: folds one character at a time, so it can
 * differ from {@link normalizeForSearch} (a word-final capital sigma folds to σ, not ς).
 */
export function foldPerCharacter(s: string): string {
	if (ASCII.test(s)) {
		return s.toLowerCase();
	}
	// ASCII runs lowercase in one slice; other characters fold through a memo, since text reuses few of them.
	const pieces: string[] = [];
	let runStart = 0;
	let i = 0;
	while (i < s.length) {
		if ((s.codePointAt(i) ?? 0) < 0x80) {
			i++;
			continue;
		}
		if (runStart < i) {
			pieces.push(s.slice(runStart, i).toLowerCase());
		}
		const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
		let folded = foldedCharacters.get(ch);
		if (folded === undefined) {
			folded = normalizeForSearch(ch);
			foldedCharacters.set(ch, folded);
		}
		pieces.push(folded);
		i += ch.length;
		runStart = i;
	}
	if (runStart < s.length) {
		pieces.push(s.slice(runStart).toLowerCase());
	}
	return pieces.join("");
}

const foldedCharacters = new Map<string, string>();

/** Normalize `s` while tracking how each normalized code unit maps back to the original string. */
export function normalizeWithOffsets(s: string): NormalizedText {
	if (ASCII.test(s)) {
		// ASCII has no combining marks and lowercases one code unit to one, so offsets are the identity.
		return {text: s.toLowerCase(), starts: Array.from(s, (_, i) => i), ends: Array.from(s, (_, i) => i + 1)};
	}
	// Collect pieces and join once: `text += piece` per character leaves a rope of one cons cell per character, ~10x the flat string's memory.
	const pieces: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	for (const ch of s) {
		const folded = normalizeForSearch(ch);
		const end = offset + ch.length;
		if (folded.length === 0) {
			if (ends.length > 0) {
				ends[ends.length - 1] = end;
			}
		} else {
			for (let i = 0; i < folded.length; i++) {
				starts.push(offset);
				ends.push(end);
			}
			pieces.push(folded);
		}
		offset = end;
	}
	return {text: pieces.join(""), starts, ends};
}
