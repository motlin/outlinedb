#!/usr/bin/env node
// Guess the workout journal entries the user has not logged yet, from their own calendar history.
//
// The user cycles through structured programs (program hashtag, phase, week, day, workout name).
// History is learned from every #exercise entry in the calendar tree: the next session after the
// most recent one is whatever most often followed that session in earlier passes, falling back to
// the program's structure. Unlogged days between the last workout and today are guessed in order,
// each guess chained on the previous one. The output is a staged proposal file for
// workout-guess-apply (see ../skills/review-proposal-staging.md); this script never writes to
// Workflowy.
//
// Usage:
//   node guess-workouts.mts --tree <calendar.json> --template '<line template>' [--today YYYY-MM-DD]
//     [--programs '#ProgramX,#ProgramY'] [--exercise-tags '#ProgramX,#ProgramZ']
//     [--rest-days <dates.json>] [--max-days 7] [--generated-at <iso>]
//
// The template comes from the personal format spec at runtime: {program}, {phase}, {week}, {day},
// and {workout} placeholders, with [...] marking a segment dropped when any field inside it is empty,
// e.g. '💪 {program} [phase {phase}, ][week {week}, ][day {day}, ]{workout} #exercise'.

import {existsSync} from "node:fs";
import {takeValue} from "./cli-args.mts";
import {buildTimeElement} from "./compute-overdue.mts";
import {expectArray, expectObject, readJsonFile} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface CalendarNode
{
	id?: string;
	name?: string | null;
	children?: CalendarNode[];
}

export interface ParsedEntry
{
	program: string;
	programKey: string;
	phase: number | null;
	week: number | null;
	day: number | null;
	tail: string;
}

export interface Session extends ParsedEntry
{
	date: string;
}

export interface SlotRef
{
	programKey: string;
	phase: number | null;
	week: number | null;
	day: number | null;
	workout: string;
}

export interface Prediction
{
	slot: SlotRef;
	basis: "history" | "structural";
	count: number;
	total: number;
}

export interface EntryFields
{
	program: string;
	phase: number | null;
	week: number | null;
	day: number | null;
	workout: string;
}

const NUMBER_WORDS: Record<string, number> =
{
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
};
const ROMAN: Record<string, number> =
{
	i: 1,
	ii: 2,
	iii: 3,
	iv: 4,
	v: 5,
	vi: 6,
	vii: 7,
	viii: 8,
	ix: 9,
	x: 10,
};
const NUMBER = String.raw`(\d+|${Object.keys(NUMBER_WORDS).join("|")}|[ivx]+)`;
const MINOR_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"but",
	"by",
	"for",
	"in",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
]);
const ITERATION_NOTE = /^(?:(?:first|second|third|fourth|\d+(?:st|nd|rd|th))\s+(?:iteration|time)|iteration\s+\d+)$/iu;
const TIME_ATTRS = /<time\b[^>]*\bstartYear="(\d+)"[^>]*\bstartMonth="(\d+)"[^>]*\bstartDay="(\d+)"[^>]*>/iu;

const stripTags = (html: string): string => html.replaceAll(/<[^>]+>/gu, "");

function readNumber(token: string, allowRoman: boolean): number | null
{
	const lower = token.toLowerCase();
	if (/^\d+$/u.test(lower))
	{
		return Number(lower);
	}
	const word = NUMBER_WORDS[lower];
	if (word !== undefined)
	{
		return word;
	}
	return allowRoman ? (ROMAN[lower] ?? null) : null;
}

interface FieldMatch
{
	value: number;
	end: number;
}

function findField(text: string, label: string, allowRoman: boolean): FieldMatch | null
{
	const match = new RegExp(String.raw`\b${label}\s+${NUMBER}\b`, "iu").exec(text);
	if (match?.[1] === undefined)
	{
		return null;
	}
	const value = readNumber(match[1], allowRoman);
	return value === null
		? null
		:
			{
				value,
				end: match.index + match[0].length,
			};
}

function cleanTail(raw: string): string
{
	// Voice-to-text writes the tag as "hashtag exercise"; it ends the tail the same as #exercise.
	const beforeTag = raw.replace(/(?:#|\bhashtag\s+)exercise\b[\s\S]*$/iu, "");
	const segments = beforeTag
		.replace(/^[\s,:;.\-–—]+/u, "")
		.replace(/[\s,:;.\-–—]+$/u, "")
		.split(",")
		.map((segment) => segment.trim());
	while (segments.length > 1 && ITERATION_NOTE.test(segments[0] ?? ""))
	{
		segments.shift();
	}
	return segments.join(", ").trim();
}

/**
 * Parse one journal entry into a program session, or null when it is not one. A session carries
 * #exercise and a program hashtag, plus at least one phase/week/day field unless the program is
 * listed in `programs` (whose casing then wins). `requireExerciseTag: false` reads an entry whose
 * #exercise tag is missing, such as one dictated as "hashtag exercise".
 */
export function parseEntry(
	name: string,
	programs: readonly string[] = [],
	{
		requireExerciseTag = true,
	}:
	{
		requireExerciseTag?: boolean;
	} = {},
): ParsedEntry | null
{
	const text = stripTags(name).replaceAll(/\s+/gu, " ");
	if (requireExerciseTag && !/#exercise\b/iu.test(text))
	{
		return null;
	}
	const listed = new Map(programs.map((tag) => [tag.replace(/^#/u, "").toLowerCase(), tag]));
	const tags = [...text.matchAll(/#([A-Za-z][\w-]*)/gu)].filter((match) => match[1]?.toLowerCase() !== "exercise");
	const tagMatch = listed.size > 0 ? tags.find((match) => listed.has(match[1]?.toLowerCase() ?? "")) : tags[0];
	if (tagMatch?.[1] === undefined)
	{
		return null;
	}
	const programKey = tagMatch[1].toLowerCase();
	const phase = findField(text, "phase", true);
	const week = findField(text, "week", false);
	const day = findField(text, "day", false);
	if (!listed.has(programKey) && phase === null && week === null && day === null)
	{
		return null;
	}
	const start = Math.max(tagMatch.index + tagMatch[0].length, phase?.end ?? 0, week?.end ?? 0, day?.end ?? 0);
	return {
		program: listed.get(programKey) ?? tagMatch[0],
		programKey,
		phase: phase?.value ?? null,
		week: week?.value ?? null,
		day: day?.value ?? null,
		tail: cleanTail(text.slice(start)),
	};
}

const capitalize = (word: string): string => (word === "" ? word : word.charAt(0).toUpperCase() + word.slice(1));

/** Title Case: capitalize each word except minor words after the first; leave acronyms alone. */
export function titleCase(text: string): string
{
	return text
		.split(" ")
		.map((word, index) =>
		{
			if (index > 0 && MINOR_WORDS.has(word.toLowerCase()))
			{
				return word.toLowerCase();
			}
			return word.split("/").map(capitalize).join("/");
		})
		.join(" ");
}

const normalizeSegment = (segment: string): string =>
	segment
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}\s'/]/gu, "")
		.replaceAll(/\s+/gu, " ")
		.trim();

const displaySegments = (segments: readonly string[]): string =>
	titleCase(
		segments
			.join(", ")
			.replaceAll(/\p{Extended_Pictographic}|️/gu, "")
			.replaceAll(/\s+/gu, " ")
			.replace(/[\s,:;.\-–—]+$/u, "")
			.trim(),
	);

/**
 * The workout name for one slot, from the tails of every session logged in it (oldest first).
 * Commentary follows the name after a comma, so the name is the longest comma prefix shared by the
 * most tails; a slot seen once keeps only its first segment. Display casing follows the newest tail.
 */
export function slotName(tails: readonly string[]): string | null
{
	const split = tails.map((tail) => tail.split(",").map((segment) => segment.trim())).filter((s) => s[0] !== "");
	if (split.length === 0)
	{
		return null;
	}
	const counts = new Map<string, number>();
	for (const segments of split)
	{
		for (let length = 1; length <= segments.length; length++)
		{
			const key = segments.slice(0, length).map(normalizeSegment).join(",");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const maxCount = Math.max(...counts.values());
	let bestKey = "";
	let length = 1;
	if (maxCount > 1)
	{
		length = 0;
		for (const [key, count] of counts)
		{
			const keyLength = key.split(",").length;
			if (count === maxCount && keyLength > length)
			{
				bestKey = key;
				length = keyLength;
			}
		}
	}
	for (const segments of split.toReversed())
	{
		const key = segments.slice(0, length).map(normalizeSegment).join(",");
		if (maxCount === 1 || key === bestKey)
		{
			return displaySegments(segments.slice(0, length));
		}
	}
	return null;
}

const slotKey = (
	slot:
	{
		programKey: string;
		phase: number | null;
		week: number | null;
		day: number | null;
	},
	workout: string,
): string =>
	slot.week === null && slot.day === null
		? `${slot.programKey}|${slot.phase ?? ""}||name:${normalizeSegment(workout)}`
		: `${slot.programKey}|${slot.phase ?? ""}|${slot.week ?? ""}|${slot.day ?? ""}`;

interface History
{
	sessions: readonly Session[];
	keys: string[];
	names: Map<string, string>;
	slots: Map<string, SlotRef>;
}

function buildHistory(sessions: readonly Session[]): History
{
	const firstName = (session: Session): string => session.tail.split(",")[0]?.trim() ?? "";
	const keys = sessions.map((session) => slotKey(session, firstName(session)));
	const tails = new Map<string, string[]>();
	for (const [index, session] of sessions.entries())
	{
		const key = keys[index] ?? "";
		tails.set(key, [...(tails.get(key) ?? []), session.tail]);
	}
	const names = new Map<string, string>();
	for (const [key, list] of tails)
	{
		const name = slotName(list);
		if (name !== null)
		{
			names.set(key, name);
		}
	}
	const slots = new Map<string, SlotRef>();
	for (const [index, session] of sessions.entries())
	{
		const key = keys[index] ?? "";
		const {programKey, phase, week, day} = session;
		slots.set(
			key,
			{
				programKey,
				phase,
				week,
				day,
				workout: names.get(key) ?? "",
			},
		);
	}
	return {
		sessions,
		keys,
		names,
		slots,
	};
}

function fromHistory(history: History, currentKey: string): Prediction | null
{
	const counts = new Map<
		string,
		{
			count: number;
			last: number;
		}
	>();
	let total = 0;
	for (let index = 0; index < history.keys.length - 1; index++)
	{
		if (history.keys[index] !== currentKey)
		{
			continue;
		}
		const next = history.keys[index + 1] ?? "";
		total++;
		counts.set(
			next,
			{
				count: (counts.get(next)?.count ?? 0) + 1,
				last: index,
			},
		);
	}
	let best:
	{
		key: string;
		count: number;
		last: number;
	} | null = null;
	for (const [key, value] of counts)
	{
		if (best === null || value.count > best.count || (value.count === best.count && value.last > best.last))
		{
			best =
			{
				key,
				...value,
			};
		}
	}
	const slot = best === null ? undefined : history.slots.get(best.key);
	if (best === null || slot === undefined || slot.workout === "")
	{
		return null;
	}
	return {
		slot,
		basis: "history",
		count: best.count,
		total,
	};
}

function structural(history: History, current: SlotRef): Prediction | null
{
	if (current.week === null || current.day === null)
	{
		return null;
	}
	const {week, day} = current;
	const program = history.sessions.filter((session) => session.programKey === current.programKey);
	const nameFor = (phase: number | null, slotWeek: number, slotDay: number): string | null =>
	{
		const exact = history.names.get(
			slotKey(
				{
					programKey: current.programKey,
					phase,
					week: slotWeek,
					day: slotDay,
				},
				"",
			),
		);
		if (exact !== undefined)
		{
			return exact;
		}
		const sameDay = program.filter((session) => session.phase === phase && session.day === slotDay);
		const newest = sameDay.at(-1);
		return newest === undefined ? null : slotName(sameDay.filter((s) => s.week === newest.week).map((s) => s.tail));
	};
	const seen = (phase: number | null, slotWeek: number | null, slotDay: number | null): boolean =>
		program.some(
			(session) =>
				session.phase === phase &&
				(slotWeek === null || session.week === slotWeek) &&
				(slotDay === null || session.day === slotDay),
		);
	const candidates: [number | null, number, number, boolean][] = [
		[current.phase, week, day + 1, seen(current.phase, week, day + 1)],
		[current.phase, week + 1, 1, seen(current.phase, week + 1, 1)],
		[current.phase, week, day + 1, seen(current.phase, null, day + 1)],
		[current.phase, week + 1, 1, seen(current.phase, week + 1, null)],
	];
	if (current.phase !== null)
	{
		const nextPhase = current.phase + 1;
		const weeks = program.filter((s) => s.phase === nextPhase && s.week !== null).map((s) => s.week ?? 1);
		candidates.push([nextPhase, weeks.length > 0 ? Math.min(...weeks) : 1, 1, weeks.length > 0]);
	}
	for (const [phase, slotWeek, slotDay, wasSeen] of candidates)
	{
		const workout = wasSeen ? nameFor(phase, slotWeek, slotDay) : null;
		if (workout !== null)
		{
			return {
				slot:
				{
					programKey: current.programKey,
					phase,
					week: slotWeek,
					day: slotDay,
					workout,
				},
				basis: "structural",
				count: 0,
				total: 0,
			};
		}
	}
	return null;
}

/** The session most likely to follow `current`: most frequent earlier successor, else program structure. */
export function predictNext(sessions: readonly Session[], current: SlotRef): Prediction | null
{
	const history = buildHistory(sessions);
	return fromHistory(history, slotKey(current, current.workout)) ?? structural(history, current);
}

/** Fill a line template; a [...] segment drops when any field inside it is empty. */
export function formatEntry(template: string, fields: EntryFields): string
{
	const values: Record<string, string | number | null> =
	{
		...fields,
	};
	const value = (field: string): string =>
	{
		const raw = values[field];
		return raw === null || raw === undefined ? "" : String(raw);
	};
	const fill = (text: string): string => text.replaceAll(/\{(\w+)\}/gu, (_match, field: string) => value(field));
	return template
		.replaceAll(/\[([^\]]*)\]/gu, (_match, segment: string) =>
			[...segment.matchAll(/\{(\w+)\}/gu)].some((match) => value(match[1] ?? "") === "") ? "" : fill(segment),
		)
		.replaceAll(/\{(\w+)\}/gu, (_match, field: string) => value(field))
		.replaceAll(/\s+/gu, " ")
		.trim();
}

const LABEL_TEMPLATE = "[phase {phase}, ][week {week}, ][day {day}, ]{workout}";

interface Calendar
{
	rootId: string;
	sessions: Session[];
	lastText: Map<Session, string>;
	exerciseDates: Set<string>;
	dayNodes: Map<string, string>;
	/** Bare program-hashtag entries ("#ProgramX ") per date: a workout logged without saying which. */
	stubs: Map<
		string,
		{
			id: string;
			name: string;
		}
	>;
}

const isoFromTime = (name: string): string | null =>
{
	const match = TIME_ATTRS.exec(name);
	if (match === null)
	{
		return null;
	}
	const [, year, month, day] = match;
	return `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
};

const isDayNode = (name: string): boolean =>
	isoFromTime(name) !== null &&
	stripTags(name).trim() !== "" &&
	name.replaceAll(/<time\b[^>]*>[^<]*<\/time>/giu, "").trim() === "";

const tagSet = (tags: readonly string[]): Set<string> =>
	new Set(tags.map((tag) => tag.replace(/^#/u, "").toLowerCase()));

const hasTagIn = (name: string, tags: Set<string>): boolean =>
	[...name.matchAll(/#([A-Za-z0-9][\w-]*)/gu)].some((match) => tags.has(match[1]?.toLowerCase() ?? ""));

function readCalendar(tree: CalendarNode, programs: readonly string[], exerciseTags: readonly string[]): Calendar
{
	const sessions:
	{
		session: Session;
		order: number;
	}[] = [];
	const lastText = new Map<Session, string>();
	const exerciseDates = new Set<string>();
	const dayNodes = new Map<string, string>();
	const stubs = new Map<
		string,
		{
			id: string;
			name: string;
		}
	>();
	// A bare program hashtag ("#ProgramX ") is a workout the user logged but did not finish writing up,
	// so its day is guessed and the guess fills the stub in place rather than adding a duplicate.
	const programTags = tagSet(programs);
	const hasProgramTag = (name: string): boolean => hasTagIn(name, programTags);
	// Any exercise hashtag from metadata (an unlisted program, say) logs its day without being a session.
	const knownExerciseTags = tagSet(exerciseTags);
	let order = 0;
	// Breadth-first, so a live day node is found before an archived duplicate of the same date.
	const queue:
	{
		node: CalendarNode;
		date: string | null;
	}[] = [
		{
			node: tree,
			date: null,
		},
	];
	for (let head = 0; head < queue.length; head++)
	{
		const item = queue[head];
		if (item === undefined)
		{
			continue;
		}
		const name = item.node.name ?? "";
		let {date} = item;
		if (isDayNode(name))
		{
			date = isoFromTime(name);
			if (date !== null && item.node.id !== undefined && !dayNodes.has(date))
			{
				dayNodes.set(date, item.node.id);
			}
		}
		else if (date !== null || isoFromTime(name) !== null)
		{
			const entryDate = isoFromTime(name) ?? date;
			if (entryDate === null)
			{
				continue;
			}
			// A program-hashtag entry is a workout even without #exercise; only its detail decides whether it is a stub.
			const parsed = parseEntry(
				name,
				programs,
				{
					requireExerciseTag: !hasProgramTag(name),
				},
			);
			const bare =
				parsed === null ||
				(parsed.phase === null && parsed.week === null && parsed.day === null && parsed.tail === "");
			if (hasProgramTag(name) && bare)
			{
				if (item.node.id !== undefined && !stubs.has(entryDate))
				{
					stubs.set(
						entryDate,
						{
							id: item.node.id,
							name,
						},
					);
				}
				continue;
			}
			if (hasProgramTag(name) || hasTagIn(name, knownExerciseTags))
			{
				exerciseDates.add(entryDate);
			}
			if (/#exercise\b/iu.test(name) || hasProgramTag(name))
			{
				exerciseDates.add(entryDate);
				if (parsed !== null)
				{
					const session =
					{
						...parsed,
						date: entryDate,
					};
					sessions.push(
						{
							session,
							order: order++,
						},
					);
					lastText.set(session, name);
				}
			}
			continue;
		}
		for (const child of item.node.children ?? [])
		{
			queue.push(
				{
					node: child,
					date,
				},
			);
		}
	}
	sessions.sort((a, b) => a.session.date.localeCompare(b.session.date) || a.order - b.order);
	return {
		rootId: tree.id ?? "",
		sessions: sessions.map((s) => s.session),
		lastText,
		exerciseDates,
		dayNodes,
		stubs,
	};
}

const addDays = (iso: string, days: number): string =>
{
	const [year, month, day] = iso.split("-").map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
};

const shortLabel = (iso: string): string =>
{
	const [year, month, day] = iso.split("-").map(Number);
	return new Intl.DateTimeFormat(
		"en-US",
		{
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		},
	).format(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)));
};

const longLabel = (iso: string): string =>
	buildTimeElement(iso)
		.replace(/^<time[^>]*>/u, "")
		.replace(/<\/time> $/u, "");

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export interface GuessOptions
{
	tree: CalendarNode;
	today: string;
	template: string;
	programs: readonly string[];
	/** Every exercise hashtag in metadata; an entry with any of them marks its day logged. */
	exerciseTags?: readonly string[];
	restDays: readonly string[];
	maxDays: number;
	generatedAt: string;
}

export interface WorkoutProposal
{
	nodeId: string;
	header: string;
	date: string;
	dayNode: "existing" | "create";
	timeElement?: string;
	basis: "history" | "structural" | "none";
	before: string;
	after: string;
	changes:
	{
		type: string;
		icon: string;
		detail: string;
	}[];
	ambiguity?:
	{
		prompt: string;
		options:
		{
			label: string;
			applyOps: string[];
		}[];
	};
	applyOps: string[];
}

export interface StagedGuess
{
	[key: string]: unknown;
	task: "workout-guess";
	generatedAt: string;
	status: "ready" | "empty";
	presentation: string;
	summary:
	{
		lastLogged:
		{
			date: string;
			text: string;
		} | null;
		daysUnlogged: number;
		proposalsStaged: number;
		remainingDays: number;
	};
	proposals: WorkoutProposal[];
}

/** Stage one proposal per unlogged day after the last workout, through today. */
export function guessWorkouts(options: GuessOptions): StagedGuess
{
	const calendar = readCalendar(options.tree, options.programs, options.exerciseTags ?? []);
	const last = calendar.sessions.at(-1);
	const staged = (summary: StagedGuess["summary"], proposals: WorkoutProposal[]): StagedGuess => (
	{
		task: "workout-guess",
		generatedAt: options.generatedAt,
		status: proposals.length > 0 ? "ready" : "empty",
		presentation: "Guess workout",
		summary,
		proposals,
	});
	if (last === undefined)
	{
		return staged(
			{
				lastLogged: null,
				daysUnlogged: 0,
				proposalsStaged: 0,
				remainingDays: 0,
			},
			[],
		);
	}

	const rest = new Set(options.restDays);
	const unlogged: string[] = [];
	for (let date = addDays(last.date, 1); date <= options.today; date = addDays(date, 1))
	{
		if (!calendar.exerciseDates.has(date) && !rest.has(date))
		{
			unlogged.push(date);
		}
	}

	const display = new Map<string, string>();
	for (const session of calendar.sessions)
	{
		display.set(session.programKey, session.program);
	}
	const history = buildHistory(calendar.sessions);
	const lastKey = history.keys.at(-1) ?? "";
	let current: SlotRef = history.slots.get(lastKey) ??
	{
		...last,
		workout: last.tail,
	};
	const label = (slot: SlotRef): string =>
		formatEntry(
			LABEL_TEMPLATE,
			{
				...slot,
				program: "",
			},
		);

	const proposals: WorkoutProposal[] = [];
	let previousDate: string | null = null;
	for (const date of unlogged.slice(0, options.maxDays))
	{
		const dayId = calendar.dayNodes.get(date);
		const stub = calendar.stubs.get(date);
		const timeElement = buildTimeElement(date);
		const target =
			stub === undefined
				? dayId === undefined
					?
						{
							nodeId: calendar.rootId,
							dayNode: "create" as const,
							timeElement,
						}
					:
						{
							nodeId: dayId,
							dayNode: "existing" as const,
						}
				:
					{
						nodeId: stub.id,
						dayNode: "existing" as const,
					};
		const prediction = predictNext(calendar.sessions, current);
		if (prediction === null)
		{
			proposals.push(
				{
					nodeId: target.nodeId,
					header: shortLabel(date),
					date,
					dayNode: target.dayNode,
					...(target.dayNode === "create"
						?
							{
								timeElement,
							}
						: {}),
					basis: "none",
					before: "",
					after: "",
					changes: [
						{
							type: "ambiguous",
							icon: "⚠️",
							detail: `no earlier pass or program structure follows "${label(current)}"`,
						},
					],
					ambiguity:
					{
						prompt: `Which workout did you do on ${longLabel(date)}? The last one logged was "${calendar.lastText.get(last) ?? ""}".`,
						options: [
							{
								label: "No workout that day",
								applyOps: [],
							},
						],
					},
					applyOps: [],
				},
			);
			break;
		}
		const {slot} = prediction;
		const after = formatEntry(
			options.template,
			{
				...slot,
				program: display.get(slot.programKey) ?? `#${slot.programKey}`,
			},
		);
		const notes = [
			prediction.basis === "history"
				? `history: after "${label(current)}" came this ${prediction.count} of ${prediction.total} times`
				: `structural: no earlier pass followed "${label(current)}"`,
		];
		if (previousDate !== null)
		{
			notes.push(`chained on the ${shortLabel(previousDate)} guess`);
		}
		if (target.dayNode === "create")
		{
			notes.push(`creates the ${longLabel(date)} day node`);
		}
		if (stub !== undefined)
		{
			notes.push("fills the bare stub");
		}
		const op =
			stub === undefined
				? target.dayNode === "create"
					? `./bin/run.js node create --parent-id ${target.nodeId} --json ${shellQuote(
							JSON.stringify(
								{
									name: timeElement,
									children: [
										{
											name: after,
										},
									],
								},
							),
						)} --position bottom`
					: `./bin/run.js node create --parent-id ${target.nodeId} --name ${shellQuote(after)} --position bottom`
				: `./bin/run.js node update --id ${stub.id} --name ${shellQuote(after)} --expect-name ${shellQuote(stub.name)}`;
		proposals.push(
			{
				nodeId: target.nodeId,
				header: shortLabel(date),
				date,
				dayNode: target.dayNode,
				...(target.dayNode === "create"
					?
						{
							timeElement,
						}
					: {}),
				basis: prediction.basis,
				before: stub?.name ?? "",
				after,
				changes: [
					{
						type: stub === undefined ? "create" : "fill",
						icon: "💪",
						detail: notes.join("; "),
					},
				],
				applyOps: [op],
			},
		);
		current = slot;
		previousDate = date;
	}

	return staged(
		{
			lastLogged:
			{
				date: last.date,
				text: calendar.lastText.get(last) ?? "",
			},
			daysUnlogged: unlogged.length,
			proposalsStaged: proposals.length,
			remainingDays: unlogged.length - proposals.length,
		},
		proposals,
	);
}

const localToday = (): string =>
{
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

if (isMain(import.meta.url))
{
	let treePath = "";
	let template = "";
	let today = localToday();
	let programs: string[] = [];
	let exerciseTags: string[] = [];
	let restDaysPath = "";
	let maxDays = 7;
	let generatedAt = new Date().toISOString();
	const args = process.argv.slice(2)[Symbol.iterator]();
	for (const argument of args)
	{
		switch (argument)
		{
			case "--tree":
			{
				treePath = takeValue(args, argument);
				break;
			}
			case "--template":
			{
				template = takeValue(args, argument);
				break;
			}
			case "--today":
			{
				today = takeValue(args, argument);
				break;
			}
			case "--programs":
			{
				programs = takeValue(args, argument)
					.split(",")
					.map((tag) => tag.trim())
					.filter((tag) => tag !== "");
				break;
			}
			case "--exercise-tags":
			{
				exerciseTags = takeValue(args, argument)
					.split(",")
					.map((tag) => tag.trim())
					.filter((tag) => tag !== "");
				break;
			}
			case "--rest-days":
			{
				restDaysPath = takeValue(args, argument);
				break;
			}
			case "--max-days":
			{
				maxDays = Number(takeValue(args, argument));
				break;
			}
			case "--generated-at":
			{
				generatedAt = takeValue(args, argument);
				break;
			}
			default:
			{
				throw new Error(`unknown option: ${argument}`);
			}
		}
	}
	if (treePath === "" || template === "")
	{
		console.error("usage: guess-workouts.mts --tree <calendar.json> --template '<line template>' [options]");
		process.exit(2);
	}
	const restDays =
		restDaysPath !== "" && existsSync(restDaysPath)
			? expectArray(readJsonFile(restDaysPath), restDaysPath).filter((d): d is string => typeof d === "string")
			: [];
	const tree = expectObject(readJsonFile(treePath), treePath) as CalendarNode;
	console.log(
		JSON.stringify(
			guessWorkouts(
				{
					tree,
					today,
					template,
					programs,
					exerciseTags,
					restDays,
					maxDays,
					generatedAt,
				},
			),
			null,
			"\t",
		),
	);
}
