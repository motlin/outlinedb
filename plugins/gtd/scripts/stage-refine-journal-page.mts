#!/usr/bin/env node
// Stage refine-journal proposals as a decision page, then map the saved answers back to node update ops.
//
// Usage:
//   node stage-refine-journal-page.mts stage [--scope recent|archive] [--proposals path]
//     [--decisions-dir dir] [--today YYYY-MM-DD]
//   node stage-refine-journal-page.mts resolve --slug <slug> [--proposals path] [--decisions-dir dir] [--now ISO]
//
// `stage` writes `<decisions-dir>/<slug>.json` (one card per proposal in the scope, its rewrite as a
// diff {before, after} under a short title) and prints `{slug, ids}`. `resolve` reads the page and its
// `<slug>.answers.json` and prints `{apply, declined, followUp, unanswered}`: the ops to run per card,
// the decline-ledger rows to append, the answers the walk must settle itself (notes, options that stage
// no text), and the cards left unanswered. Card `p<i>` is `proposals[i]` of the full staged file.

import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {takeValue} from "./cli-args.mts";
import {localTodayISO} from "./compute-overdue.mts";
import {arrayField, expectObject, isObject, readJsonFile, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {isMain} from "./is-main.mts";

export type Scope = "recent" | "archive";

interface Change
{
	type: string;
	icon: string;
	detail: string;
}

interface AmbiguityOption
{
	label: string;
	description?: string | undefined;
	emoji?: string | undefined;
	after?: string | undefined;
	applyOps?: string[] | undefined;
}

export interface RefineJournalProposal
{
	nodeId: string;
	scope?: string | undefined;
	header: string;
	before: string;
	after: string;
	changes: Change[];
	ambiguity?:
	{
		prompt: string;
		options: (string | AmbiguityOption)[];
	};
	applyOps?: string[] | undefined;
}

interface Option
{
	value: string;
	label: string;
	description: string;
}

interface Card
{
	id: string;
	title: string;
	diff:
	{
		before: string;
		after: string;
	};
	body: string[];
	links: never[];
	options: Option[];
	default: string;
}

interface Answer
{
	choice: string | null;
	note: string;
}

const ACCEPT: Option =
{
	value: "accept",
	label: "Accept",
	description: "Apply the proposed text",
};

const KEEP: Option =
{
	value: "reject",
	label: "Keep as written",
	description: "Reject the rewrite; it never comes back",
};

const SKIP_LIKE = /^(?:skip\b|keep as written\b)/iu;
const EMOJI_TOKEN =
	/^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}])[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Component}]+$/u;

function optionObject(option: string | AmbiguityOption): AmbiguityOption
{
	return typeof option === "string"
		?
			{
				label: option,
			}
		: option;
}

/** The option's leading emoji: its `emoji` field, or the first word of its label when that word is an emoji. */
function optionEmoji(option: AmbiguityOption): string | undefined
{
	return option.emoji ?? leadingEmoji(option.label);
}

function leadingEmoji(text: string): string | undefined
{
	const [first] = text.split(" ");
	return first !== undefined && EMOJI_TOKEN.test(first) ? first : undefined;
}

function proposalInScope(proposal: RefineJournalProposal, scope: Scope): boolean
{
	return (proposal.scope ?? "recent") === scope;
}

function cardTitle(proposal: RefineJournalProposal): string
{
	const types = [
		...new Set(proposal.changes.map((change) => change.type).filter((type) => type !== "ambiguous")),
	].toSorted();
	return `${proposal.header}: ${types.length > 0 ? types.join(", ") : "pick one"}`;
}

function cardOptions(proposal: RefineJournalProposal): Option[]
{
	if (proposal.ambiguity === undefined)
	{
		return [ACCEPT, KEEP];
	}
	const options = proposal.ambiguity.options.map((raw, index): Option =>
	{
		const option = optionObject(raw);
		let description: string;
		if (option.description !== undefined)
		{
			description = option.description;
		}
		else if (SKIP_LIKE.test(option.label))
		{
			description = "Keep as written; it never comes back";
		}
		else if (index === 0)
		{
			description = "As in the proposed After";
		}
		else if (optionEmoji(option) === undefined)
		{
			description = "Use this instead; Claude confirms the exact text";
		}
		else
		{
			description = "Swap in this emoji";
		}
		return {
			value: `opt${index}`,
			label: option.label,
			description,
		};
	});
	const hasSkip = proposal.ambiguity.options.some((option) => SKIP_LIKE.test(optionObject(option).label));
	return hasSkip ? options : [...options, KEEP];
}

export function buildRefineJournalPage({
	proposals,
	scope,
	today,
	archiveMonth = null,
}: {
	proposals: readonly RefineJournalProposal[];
	scope: Scope;
	today: string;
	archiveMonth?: string | null;
})
{
	const groups = new Map<string, Card[]>();
	let count = 0;
	for (const [index, proposal] of proposals.entries())
	{
		if (!proposalInScope(proposal, scope))
		{
			continue;
		}
		count += 1;
		const options = cardOptions(proposal);
		const body = proposal.changes.map((change) => `${change.icon} ${change.detail}`);
		if (proposal.ambiguity !== undefined)
		{
			body.push(`⚠️ ${proposal.ambiguity.prompt}`);
		}
		const card: Card =
		{
			id: `p${index}`,
			title: cardTitle(proposal),
			diff:
			{
				before: proposal.before,
				after: proposal.after,
			},
			body,
			links: [],
			options,
			default: options[0]?.value ?? ACCEPT.value,
		};
		groups.set(proposal.header, [...(groups.get(proposal.header) ?? []), card]);
	}
	const archive = scope === "archive";
	return {
		slug: archive ? `refine-journal-archive-${today}` : `refine-journal-${today}`,
		title:
			archive && archiveMonth !== null
				? `Refine calendar journal (archive ${archiveMonth})`
				: "Refine calendar journal",
		intro: `${count} proposed ${count === 1 ? "rewrite" : "rewrites"} of journal entries. Pick an option per card; add a note to edit the proposed text. Keep as written records the rejection so it never comes back.`,
		groups: [...groups].map(([heading, items]) => (
		{
			heading,
			items,
		})),
	};
}

function shellQuote(text: string): string
{
	return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function updateOp(proposal: RefineJournalProposal, after: string): string
{
	return `./bin/run.js node update --id ${proposal.nodeId} --name ${shellQuote(after)} --expect-name ${shellQuote(proposal.before)}`;
}

/** The proposed After with its leading emoji swapped for `emoji`, or `emoji` prepended when it has none. */
function withEmoji(after: string, emoji: string): string
{
	const current = leadingEmoji(after);
	return current === undefined ? `${emoji} ${after}` : `${emoji}${after.slice(current.length)}`;
}

type Resolution =
	|
	  {
			kind: "apply";
			ops: string[];
	  }
	|
	  {
			kind: "decline";
	  }
	|
	  {
			kind: "follow-up";
			reason: string;
	  };

const NO_TEXT = "The chosen option stages no text; confirm the exact wording and build the op with --expect-name";

function resolveOption(proposal: RefineJournalProposal, index: number, option: AmbiguityOption): Resolution
{
	if (option.applyOps !== undefined)
	{
		return option.applyOps.length > 0
			?
				{
					kind: "apply",
					ops: option.applyOps,
				}
			:
				{
					kind: "decline",
				};
	}
	if (SKIP_LIKE.test(option.label))
	{
		return {
			kind: "decline",
		};
	}
	if (index === 0 && proposal.applyOps !== undefined && proposal.applyOps.length > 0)
	{
		return {
			kind: "apply",
			ops: proposal.applyOps,
		};
	}
	if (option.after !== undefined)
	{
		return {
			kind: "apply",
			ops: [updateOp(proposal, option.after)],
		};
	}
	const emoji = optionEmoji(option);
	if (emoji !== undefined)
	{
		return {
			kind: "apply",
			ops: [updateOp(proposal, withEmoji(proposal.after, emoji))],
		};
	}
	return {
		kind: "follow-up",
		reason: NO_TEXT,
	};
}

function resolveChoice(proposal: RefineJournalProposal, choice: string): Resolution
{
	if (choice === KEEP.value)
	{
		return {
			kind: "decline",
		};
	}
	if (choice === ACCEPT.value && proposal.ambiguity === undefined)
	{
		return {
			kind: "apply",
			ops: proposal.applyOps ?? [],
		};
	}
	const index = Number(/^opt(\d+)$/u.exec(choice)?.[1]);
	const option = proposal.ambiguity?.options[index];
	if (option === undefined)
	{
		return {
			kind: "follow-up",
			reason: `Unknown choice "${choice}" for this card`,
		};
	}
	return resolveOption(proposal, index, optionObject(option));
}

function choiceLabel(proposal: RefineJournalProposal, choice: string): string
{
	return cardOptions(proposal).find((option) => option.value === choice)?.label ?? choice;
}

export function resolveRefineJournalAnswers({
	proposals,
	answers,
	ids,
	now,
}: {
	proposals: readonly RefineJournalProposal[];
	answers: Readonly<Record<string, unknown>>;
	ids: readonly string[];
	now: string;
})
{
	const apply:
	{
		id: string;
		header: string;
		ops: string[];
	}[] = [];
	const declined:
	{
		nodeId: string;
		before: string;
		after: string;
		declinedAt: string;
	}[] = [];
	const followUp:
	{
		id: string;
		header: string;
		choice: string;
		note: string;
		reason: string;
	}[] = [];
	const unanswered:
	{
		id: string;
		header: string;
	}[] = [];

	for (const id of ids)
	{
		const proposal = proposals[Number(/^p(\d+)$/u.exec(id)?.[1])];
		if (proposal === undefined)
		{
			throw new Error(`Card ${id} matches no staged proposal; re-stage the page from the current proposals`);
		}
		const answer = readAnswer(answers[id]);
		if (answer.choice === null)
		{
			unanswered.push(
				{
					id,
					header: proposal.header,
				},
			);
			continue;
		}
		const choice = choiceLabel(proposal, answer.choice);
		if (answer.note.trim() !== "")
		{
			followUp.push(
				{
					id,
					header: proposal.header,
					choice,
					note: answer.note,
					reason: "The answer carries a note; apply it as Accept with note or a vocabulary explanation",
				},
			);
			continue;
		}
		const resolution = resolveChoice(proposal, answer.choice);
		if (resolution.kind === "apply")
		{
			apply.push(
				{
					id,
					header: proposal.header,
					ops: resolution.ops,
				},
			);
		}
		else if (resolution.kind === "decline")
		{
			declined.push(
				{
					nodeId: proposal.nodeId,
					before: proposal.before,
					after: proposal.after,
					declinedAt: now,
				},
			);
		}
		else
		{
			followUp.push(
				{
					id,
					header: proposal.header,
					choice,
					note: answer.note,
					reason: resolution.reason,
				},
			);
		}
	}
	return {
		apply,
		declined,
		followUp,
		unanswered,
	};
}

function readAnswer(value: unknown): Answer
{
	if (!isObject(value))
	{
		return {
			choice: null,
			note: "",
		};
	}
	return {
		choice: stringField(value, "choice") ?? null,
		note: stringField(value, "note") ?? "",
	};
}

function pad(value: number): string
{
	return String(value).padStart(2, "0");
}

/** The current local time as ISO-8601 with its UTC offset, the shape the decline ledger stores. */
function localNowISO(): string
{
	const now = new Date();
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const hours = pad(Math.floor(Math.abs(offset) / 60));
	const minutes = pad(Math.abs(offset) % 60);
	return `${localTodayISO()}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hours}:${minutes}`;
}

function fail(message: string): never
{
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function readStaged(path: string): JsonObject
{
	const staged = expectObject(readJsonFile(path), path);
	const status = stringField(staged, "status");
	if (status !== "ready")
	{
		fail(`refine-journal proposals are "${status}", not "ready"; nothing to stage`);
	}
	return staged;
}

function stagedProposals(staged: JsonObject): RefineJournalProposal[]
{
	// The validator (validate-proposal.mts) owns the shape check; this only narrows for the type system.
	return arrayField(staged, "proposals").filter((proposal): proposal is RefineJournalProposal => isObject(proposal));
}

function pageIds(path: string): string[]
{
	const page = expectObject(readJsonFile(path), path);
	return arrayField(page, "groups").flatMap((group) =>
		(isObject(group) ? arrayField(group, "items") : []).flatMap((item) =>
		{
			const id = isObject(item) ? stringField(item, "id") : undefined;
			return id === undefined ? [] : [id];
		}),
	);
}

function main(argv: string[]): void
{
	const [command, ...rest] = argv.slice(2);
	let scope: Scope = "recent";
	let proposalsPath = ".llm/gtd/review/proposals/refine-journal.json";
	let decisionsDir = ".llm/gtd/review/decisions";
	let today = localTodayISO();
	let now = localNowISO();
	let slug: string | null = null;
	const argIterator = rest[Symbol.iterator]();
	for (const arg of argIterator)
	{
		if (arg === "--scope")
		{
			const value = takeValue(argIterator, arg);
			if (value !== "recent" && value !== "archive")
			{
				fail(`--scope must be recent or archive, got ${value}`);
			}
			scope = value;
		}
		else if (arg === "--proposals")
		{
			proposalsPath = takeValue(argIterator, arg);
		}
		else if (arg === "--decisions-dir")
		{
			decisionsDir = takeValue(argIterator, arg);
		}
		else if (arg === "--today")
		{
			today = takeValue(argIterator, arg);
		}
		else if (arg === "--now")
		{
			now = takeValue(argIterator, arg);
		}
		else if (arg === "--slug")
		{
			slug = takeValue(argIterator, arg);
		}
		else
		{
			fail(`Unknown argument ${arg}`);
		}
	}

	if (command === "stage")
	{
		const staged = readStaged(proposalsPath);
		const summary = isObject(staged.summary) ? staged.summary : {};
		const page = buildRefineJournalPage(
			{
				proposals: stagedProposals(staged),
				scope,
				today,
				archiveMonth: stringField(summary, "archiveMonth") ?? null,
			},
		);
		mkdirSync(
			decisionsDir,
			{
				recursive: true,
			},
		);
		writeFileSync(join(decisionsDir, `${page.slug}.json`), `${JSON.stringify(page, null, 2)}\n`);
		const ids = page.groups.flatMap((group) => group.items.map((item) => item.id));
		process.stdout.write(
			`${JSON.stringify(
				{
					slug: page.slug,
					ids,
				},
			)}\n`,
		);
		return;
	}
	if (command === "resolve" && slug !== null)
	{
		const answersPath = join(decisionsDir, `${slug}.answers.json`);
		if (!existsSync(answersPath))
		{
			fail(`No answers saved for decision page ${slug} (${answersPath})`);
		}
		const result = resolveRefineJournalAnswers(
			{
				proposals: stagedProposals(readStaged(proposalsPath)),
				answers: expectObject(readJsonFile(answersPath), answersPath),
				ids: pageIds(join(decisionsDir, `${slug}.json`)),
				now,
			},
		);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	process.stderr.write(
		"Usage: stage-refine-journal-page.mts stage [--scope recent|archive] ... | resolve --slug <slug> ...\n",
	);
	process.exit(2);
}

if (isMain(import.meta.url))
{
	main(process.argv);
}
