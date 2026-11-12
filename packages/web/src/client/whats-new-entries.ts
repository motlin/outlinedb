/**
 * Our own What's New entries, newest first. They announce features of this app only: upstream's release notes and
 * features are never copied here. Each id is its key in `whats_new_reads` (lowercase letters, digits and `_`).
 */

export type ChangelogTag = "h2" | "h3" | "p" | "ul" | "li" | "a" | "b" | "strong" | "code" | "br";

/** A body node: text, or an element with its React props and children. */
export type ChangelogNode =
	| string
	|
	  {
			t: ChangelogTag;
			p?: Readonly<Record<string, string>>;
			c?: readonly ChangelogNode[];
	  };

export interface ChangelogEntry
{
	id: string;
	date: string;
	title: string;
	body: readonly ChangelogNode[];
}

const code = (text: string): ChangelogNode => (
{
	t: "code",
	c: [text],
});

export const WHATS_NEW_ENTRIES: readonly ChangelogEntry[] = [
	{
		id: "as_of_queries",
		date: "October 31st, 2026",
		title: "As-of queries: see what changed since any time",
		body: [
			{
				t: "p",
				c: [
					"Every edit is kept as history in the local cache, so your outline can be compared with how it was at an earlier time.",
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Open ",
							{
								t: "a",
								p:
								{
									href: "/changes",
									className: "contentLink !text-tint",
								},
								c: ["Node Changes"],
							},
							" and enter how far back to look: a duration such as ",
							code("12h"),
							", ",
							code("1d"),
							" or ",
							code("1w"),
							", or a date such as ",
							code("2026-10-01"),
							".",
						],
					},
					{
						t: "li",
						c: [
							"Each node that changed since then is shown under its ancestors and labeled Added, Deleted, Changed, Moved, Completed, Uncompleted or Note edited, with a count of each kind at the top.",
						],
					},
					{
						t: "li",
						c: ["Edited text shows a character-by-character diff of the old and new versions."],
					},
					{
						t: "li",
						c: [
							"From the command line, ",
							code("node changes --since 2d"),
							" prints the same tree, and ",
							code("--json"),
							" prints the raw changes.",
						],
					},
				],
			},
		],
	},
];
