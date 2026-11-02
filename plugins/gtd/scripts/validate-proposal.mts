#!/usr/bin/env node
// Validate a staged daily-review proposal file against the contract in
// plugins/gtd/skills/review-proposal-staging.md.
//
// Usage: node plugins/gtd/scripts/validate-proposal.mts .llm/gtd/review/proposals/<slug>.json

import {expectObject, isObject, readJsonFile} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {isMain} from "./is-main.mts";

const REQUIRED_TOP_LEVEL = ["task", "generatedAt", "status"];
const KNOWN_STATUSES = new Set(["ready", "needs-interactive", "empty", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A proposal stages exactly one node id: `nodeId`, the node its applyOps mutate. Every other id
// belongs inside an applyOps command string, already bound to its flag. A second bare id field is
// the bug this guards: a consumer reads it as a write target and moves the item under the wrong
// parent. Inert fields (counts, labels, fingerprints) are free to vary per task.
const ID_FIELD = /(?:^|[a-z])(?:Id|ID)$/u;
const DEFAULT_ID_HINT = "a proposal carries only nodeId; put every other id inside an applyOps command";
const ID_HINTS: Record<string, string> =
{
	moveToNodeId:
		"the 📍 Move to: suggestion child is not a destination parent; resolve destinations by path at apply time",
};

const strayIdError = (index: number, field: string): string =>
	`proposals[${index}]: stages a second node id "${field}" — ${ID_HINTS[field] ?? DEFAULT_ID_HINT}`;

// email-calendar apply appends each decision to .llm/gtd/review/email-calendar-decisions.json under
// `key`, and the next prep drops candidates whose key is already there. A proposal staged without
// that field writes a null-keyed ledger row that suppresses nothing, so the same email is
// re-proposed every run with no visible error. Prep once staged the identity as `sourceKey`, which
// is the mismatch this names.
const LEDGER_KEY_TASKS = new Set(["email-calendar"]);
const LEDGER_KEY_ALIASES = ["sourceKey"];

// Render an arbitrary JSON value for an error message.
const describe = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const isNonBlank = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

const validateLedgerKey = (task: unknown, entry: JsonObject, index: number, errors: string[]): void =>
{
	if (typeof task !== "string" || !LEDGER_KEY_TASKS.has(task))
	{
		return;
	}
	if (isNonBlank(entry.key))
	{
		return;
	}
	const alias = LEDGER_KEY_ALIASES.find((field) => entry[field] !== undefined);
	if (alias !== undefined)
	{
		errors.push(
			`proposals[${index}]: ${task} proposal stages its ledger key as "${alias}" — the ledger and apply read "key"; rename it`,
		);
		return;
	}
	errors.push(
		`proposals[${index}]: ${task} proposal has no ledger "key" — apply writes it to ${task}-decisions.json, and a null key never suppresses a re-proposal`,
	);
};

// events_create takes the target calendar as `calendar`. Prep once staged `calendarName` in the
// toolRequest, which the tool silently ignores and so files the event on the default calendar.
const validateCalendarParam = (task: unknown, entry: JsonObject, index: number, errors: string[]): void =>
{
	if (typeof task !== "string" || !LEDGER_KEY_TASKS.has(task))
	{
		return;
	}
	const request = entry.toolRequest;
	if (!isObject(request))
	{
		return;
	}
	const args = isObject(request.arguments) ? request.arguments : request;
	if (args.calendarName !== undefined)
	{
		errors.push(
			`proposals[${index}]: ${task} toolRequest stages "calendarName" — events_create takes "calendar"; rename it`,
		);
	}
};

// "Reject and delete" trashes the source email through the Gmail IMAP MCP, so apply needs the
// exact message coordinates from prep rather than re-searching the inbox for it.
const SOURCE_MESSAGE_FIELDS: Record<string, (value: unknown) => boolean> =
{
	account: isNonBlank,
	mailbox: isNonBlank,
	messageUid: (value) => typeof value === "number" && Number.isInteger(value) && value > 0,
};

const validateSourceMessage = (task: unknown, entry: JsonObject, index: number, errors: string[]): void =>
{
	if (typeof task !== "string" || !LEDGER_KEY_TASKS.has(task))
	{
		return;
	}
	const missing = Object.entries(SOURCE_MESSAGE_FIELDS)
		.filter(([field, isValid]) => !isValid(entry[field]))
		.map(([field]) => field);
	if (missing.length > 0)
	{
		errors.push(
			`proposals[${index}]: ${task} proposal is missing source message field(s) ${missing.join(", ")} — apply needs them to trash the email on "Reject and delete"`,
		);
	}
};

// Apply links each question to the source email (a Gmail rfc822msgid search URL) and to the
// sign-up/RSVP links in its body, so the user can act without hunting for the message.
// messageId is an RFC 822 Message-ID, not a Workflowy node id, so it is exempt from the stray-id check.
const NON_NODE_ID_FIELDS: Record<string, Set<string>> =
{
	"email-calendar": new Set(["messageId"]),
};
const isHttpUrl = (value: unknown): boolean => typeof value === "string" && /^https?:\/\/\S+$/u.test(value);

const validateSourceLinks = (task: unknown, entry: JsonObject, index: number, errors: string[]): void =>
{
	if (typeof task !== "string" || !LEDGER_KEY_TASKS.has(task))
	{
		return;
	}
	if (!isNonBlank(entry.messageId))
	{
		errors.push(
			`proposals[${index}]: ${task} proposal is missing "messageId" (RFC 822 Message-ID) — apply builds the Gmail link to the source email from it`,
		);
	}
	if (!Array.isArray(entry.actionLinks) || !entry.actionLinks.every(isHttpUrl))
	{
		errors.push(
			`proposals[${index}]: ${task} proposal needs "actionLinks" as an array of http(s) URLs (empty when the email has none)`,
		);
	}
};

// Advisory Clef hints from `ai suggest-labels`: verify-pass labels the tagger confirmed against the
// entry text. The walk shows them; a hint is never an apply target.
const HINT_LABEL = /^[@#][\p{L}\p{N}_-]+$/u;
const HINT_KINDS = new Set(["person", "tag"]);
const HINT_SOURCES = new Set(["clef-flash", "clef"]);
const isHint = (hint: unknown): boolean =>
	isObject(hint) &&
	typeof hint.label === "string" &&
	HINT_LABEL.test(hint.label) &&
	typeof hint.kind === "string" &&
	HINT_KINDS.has(hint.kind) &&
	typeof hint.score === "number" &&
	hint.score >= 0 &&
	hint.score <= 1 &&
	typeof hint.source === "string" &&
	HINT_SOURCES.has(hint.source);

const validateHints = (entry: JsonObject, index: number, errors: string[]): void =>
{
	if (entry.hints === undefined)
	{
		return;
	}
	if (!Array.isArray(entry.hints))
	{
		errors.push(`proposals[${index}]: hints must be an array`);
		return;
	}
	for (const [hintIndex, hint] of entry.hints.entries())
	{
		if (!isHint(hint))
		{
			errors.push(
				`proposals[${index}]: hints[${hintIndex}] needs label "@Name" or "#tag", kind person|tag, score 0 to 1 and source clef-flash|clef`,
			);
		}
	}
};

const validateProposalEntry = (task: unknown, entry: JsonObject, index: number, errors: string[]): void =>
{
	validateHints(entry, index, errors);
	validateLedgerKey(task, entry, index, errors);
	validateSourceMessage(task, entry, index, errors);
	validateSourceLinks(task, entry, index, errors);
	validateCalendarParam(task, entry, index, errors);

	const exemptIdFields = (typeof task === "string" ? NON_NODE_ID_FIELDS[task] : undefined) ?? new Set<string>();
	for (const field of Object.keys(entry))
	{
		if (field !== "nodeId" && !exemptIdFields.has(field) && ID_FIELD.test(field))
		{
			errors.push(strayIdError(index, field));
			return;
		}
	}

	if (typeof entry.nodeId === "string" && !UUID.test(entry.nodeId))
	{
		errors.push(`proposals[${index}]: nodeId "${entry.nodeId}" is not a full uuid`);
		return;
	}

	const ops: unknown[] = Array.isArray(entry.applyOps) ? entry.applyOps : [];
	for (const [opIndex, op] of ops.entries())
	{
		// Only an update overwrites an existing name; a `node create --name` has nothing to guard.
		if (
			typeof op === "string" &&
			/\bnode update\b/u.test(op) &&
			op.includes("--name") &&
			!op.includes("--expect-name")
		)
		{
			errors.push(`proposals[${index}]: applyOps[${opIndex}] updates --name without --expect-name`);
			return;
		}
	}
};

export interface ValidationResult
{
	valid: boolean;
	errors: string[];
}

export const validateProposal = (staged: JsonObject): ValidationResult =>
{
	const errors: string[] = [];

	for (const field of REQUIRED_TOP_LEVEL)
	{
		if (staged[field] === undefined)
		{
			errors.push(`missing required field "${field}"`);
		}
	}

	const {status} = staged;
	if (status !== undefined && (typeof status !== "string" || !KNOWN_STATUSES.has(status)))
	{
		errors.push(`unknown status "${describe(status)}"`);
		return {
			valid: false,
			errors,
		};
	}

	const proposals: unknown[] = Array.isArray(staged.proposals) ? staged.proposals : [];
	if (status !== "ready" && proposals.length > 0)
	{
		errors.push(`status "${describe(status)}" must carry an empty proposals[] array`);
		return {
			valid: false,
			errors,
		};
	}

	for (const [index, entry] of proposals.entries())
	{
		validateProposalEntry(staged.task, isObject(entry) ? entry : {}, index, errors);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
};

if (isMain(import.meta.url))
{
	const path = process.argv[2];
	if (path === undefined || path === "")
	{
		console.error("usage: validate-proposal.mts <staged-proposal.json>");
		process.exit(2);
	}

	const {valid, errors} = validateProposal(expectObject(readJsonFile(path), path));
	if (valid)
	{
		console.log(`✓ ${path} matches the staging contract`);
	}
	else
	{
		console.error(`✗ ${path} violates the staging contract:`);
		for (const error of errors)
		{
			console.error(`  - ${error}`);
		}
		process.exit(1);
	}
}
