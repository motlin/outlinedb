/** Pure option building for the `@` mention popup (upstream's `people` and `tags` groups). */

export type MentionOption =
	|
	  {
			kind: "person";
			id: string;
			text: string;
	  }
	|
	  {
			kind: "tag";
			text: string;
	  };

export interface MentionGroup
{
	name: "People" | "Tags";
	options: MentionOption[];
}

const MAX_TAGS = 8;

export function matchesTerm(term: string, name: string): boolean
{
	return term === "*" || name.toLowerCase().startsWith(term.toLowerCase());
}

export function mentionGroups({
	term,
	account,
	tags,
}: {
	term: string;
	account:
	{
		userId: number | string;
		fullName: string | null;
	} | null;
	tags: readonly string[];
}): MentionGroup[]
{
	const groups: MentionGroup[] = [];
	const name = account?.fullName ?? null;
	if (account !== null && name !== null && (term === "me" || matchesTerm(term, name)))
	{
		groups.push(
			{
				name: "People",
				options: [
					{
						kind: "person",
						id: String(account.userId),
						text: name,
					},
				],
			},
		);
	}
	if (tags.length > 0)
	{
		groups.push(
			{
				name: "Tags",
				options: tags.slice(0, MAX_TAGS).map((tag): MentionOption => (
				{
					kind: "tag",
					text: `@${tag.slice(1)}`,
				})),
			},
		);
	}
	return groups;
}

export function avatarInitials(fullName: string): string
{
	const words = fullName.split(/\s+/u).filter((word) => word !== "");
	const first = words[0]?.[0] ?? "";
	const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/** Replace `[chipStart, chipEnd)` with `inserted`, spaced like upstream, and put the caret after the trailing space. */
export function insertSuggestion(
	plain: string,
	chipStart: number,
	chipEnd: number,
	inserted: string,
):
{
	text: string;
	caret: number;
}
{
	const previous = plain[chipStart - 1];
	const next = plain[chipEnd];
	const lead = chipStart > 0 && previous !== " " ? " " : "";
	const trail = next === " " ? "" : " ";
	const head = plain.slice(0, chipStart) + lead + inserted;
	return {
		text: head + trail + plain.slice(chipEnd),
		caret: head.length + 1,
	};
}
