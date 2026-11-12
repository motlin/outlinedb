/** A node from a Workflowy registry export (`.llm/gtd/metadata/people.json`, `hobbies-registry.json`). */
export interface RegistryNode
{
	readonly name: string;
	readonly children?: readonly RegistryNode[];
}

export type LabelKind = "person" | "tag";

export interface PoolLabel
{
	/** Clef question/option id: `p.` or `t.` plus the label, restricted to `[A-Za-z0-9_.-]`. */
	readonly optionId: string;
	/** Canonical `@Name` or `#tag`. */
	readonly label: string;
	readonly kind: LabelKind;
	/** At most {@link MAX_DESCRIPTION_WORDS} words for Clef to read (people: `personDescriptionWords` if given). */
	readonly description: string;
}

export interface LabelPoolInput
{
	readonly people: RegistryNode;
	readonly hobbies: RegistryNode;
	/** `tags` map from `tag-frequency.json`: `#tag` to usage count. */
	readonly tagFrequency: Readonly<Record<string, number>>;
	/** `@mentions` and `#tags` already on the entry; dropped from its pool. */
	readonly entryLabels: readonly string[];
	/** Frequency tags used fewer times than this are left out. */
	readonly minTagCount?: number;
	/** Extra phrases per lowercased `@name` (aliases, typos, homonym context), appended to that person's description. */
	readonly personHints?: ReadonlyMap<string, readonly string[]>;
	/** Word cap for person descriptions; defaults to {@link MAX_DESCRIPTION_WORDS}. */
	readonly personDescriptionWords?: number;
}

/** Workflow, GTD-context and priority tags that are never content labels. */
export const WORKFLOW_TAGS: ReadonlySet<string> = new Set([
	"#agenda",
	"#anywhere",
	"#buy",
	"#call",
	"#deep-work",
	"#discuss",
	"#document",
	"#drafts",
	"#email",
	"#errands",
	"#high",
	"#home",
	"#llm-task",
	"#low",
	"#low-energy",
	"#medium",
	"#meeting",
	"#next",
	"#next-action",
	"#plan",
	"#read",
	"#someday",
	"#soon",
]);

const MAX_DESCRIPTION_WORDS = 12;
const DEFAULT_MIN_TAG_COUNT = 3;
const PERSON_NAME = /^@[\p{L}\p{N}_-]+$/u;
const HOBBY_NAME = /(?:^|\s)(#[\p{L}\p{N}_-]+)$/u;
const FIELD = /^[^:]{1,40}:/u;

/** Builds the per-entry label pool that the Clef shortlist pass chooses from. Pure. */
export function buildLabelPool(input: LabelPoolInput): PoolLabel[]
{
	const excluded = new Set([...WORKFLOW_TAGS, ...input.entryLabels.map((label) => label.toLowerCase())]);
	const pool = new Map<string, PoolLabel>();

	const add = (label: string, kind: LabelKind, description: string, words = MAX_DESCRIPTION_WORDS): void =>
	{
		const key = label.toLowerCase();
		if (excluded.has(key))
		{
			return;
		}
		const existing = pool.get(key);
		if (existing === undefined)
		{
			pool.set(
				key,
				{
					optionId: optionIdFor(label, kind),
					label,
					kind,
					description: truncate(description, words),
				},
			);
		}
		else if (existing.description === "" && description !== "")
		{
			pool.set(
				key,
				{
					...existing,
					description: truncate(description, words),
				},
			);
		}
	};

	for (const node of walk(input.people))
	{
		if (PERSON_NAME.test(node.name))
		{
			const hints = input.personHints?.get(node.name.toLowerCase()) ?? [];
			const base = personDescription(node);
			const description = hints.length === 0 ? base : `${base}; text may say ${hints.join(", ")}`;
			add(node.name, "person", description, input.personDescriptionWords);
		}
	}

	for (const node of walk(input.hobbies))
	{
		const tag = HOBBY_NAME.exec(node.name)?.[1];
		if (tag !== undefined)
		{
			add(tag, "tag", hobbyDescription(node, tag));
		}
	}

	const minTagCount = input.minTagCount ?? DEFAULT_MIN_TAG_COUNT;
	const frequent = Object.entries(input.tagFrequency)
		.filter(([, count]) => count >= minTagCount)
		.toSorted(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b));
	for (const [tag] of frequent)
	{
		add(tag, "tag", humanizeTag(tag));
	}

	return [...pool.values()];
}

function* walk(node: RegistryNode): Generator<RegistryNode>
{
	yield node;
	for (const child of node.children ?? [])
	{
		yield* walk(child);
	}
}

function optionIdFor(label: string, kind: LabelKind): string
{
	const prefix = kind === "person" ? "p." : "t.";
	return (prefix + label.slice(1).replaceAll(/[^A-Za-z0-9_.-]/gu, "_")).slice(0, 100);
}

function personDescription(node: RegistryNode): string
{
	const fullName = node.name.slice(1).replaceAll(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
	const relationship = fieldValue(node, "👥 Relationship");
	return relationship === undefined ? fullName : `${fullName}, ${relationship}`;
}

function hobbyDescription(node: RegistryNode, tag: string): string
{
	const fullName = fieldValue(node, "Full name");
	if (fullName !== undefined)
	{
		return fullName;
	}
	const summary = node.children
		?.map((child) => plainText(child.name))
		.find((text) => text !== "" && !FIELD.test(text));
	return summary ?? humanizeTag(tag);
}

function fieldValue(node: RegistryNode, field: string): string | undefined
{
	const prefix = `${field}:`;
	const child = node.children?.find((candidate) => candidate.name.startsWith(prefix));
	return child === undefined ? undefined : plainText(child.name.slice(prefix.length));
}

function plainText(html: string): string
{
	return html
		.replaceAll(/<[^>]*>/gu, "")
		.replaceAll("↗", "")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function humanizeTag(tag: string): string
{
	return tag.slice(1).replaceAll(/[-_]+/gu, " ");
}

function truncate(description: string, words: number): string
{
	return description.split(" ").slice(0, words).join(" ");
}
