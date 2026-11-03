// Run: node --test plugins/gtd/scripts/guess-workouts.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {formatEntry, guessWorkouts, parseEntry, predictNext, slotName, titleCase} from "./guess-workouts.mts";
import type {CalendarNode, Session} from "./guess-workouts.mts";
import {validateProposal} from "./validate-proposal.mts";

const TEMPLATE = "💪 {program} [phase {phase}, ][week {week}, ][day {day}, ]{workout} #exercise";
const CALENDAR_ID = "00000000-0000-4000-8000-000000000000";

let nextId = 1;
const uuid = (): string => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;

const timeElement = (iso: string, label: string): string => {
	const [year, month, day] = iso.split("-").map(Number);
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${label}</time> `;
};

const dayNode = (iso: string, label: string, entries: string[], id = uuid()): CalendarNode => ({
	id,
	name: timeElement(iso, label),
	children: entries.map((name) => ({id: uuid(), name})),
});

const calendar = (archived: CalendarNode[], live: CalendarNode[]): CalendarNode => ({
	id: CALENDAR_ID,
	name: "📅 Calendar",
	children: [{id: uuid(), name: "🗃️ Archive", children: [{id: uuid(), name: "2026", children: archived}]}, ...live],
});

const session = (overrides: Partial<Session>): Session => ({
	date: "2026-03-01",
	program: "#ProgramX",
	programKey: "programx",
	phase: 1,
	week: 1,
	day: 1,
	tail: "Push 1",
	...overrides,
});

// One earlier pass of an invented program: phase 1 has two weeks, week 2 ends on a day-4 finisher.
const firstPass = (): CalendarNode[] => [
	dayNode("2026-03-01", "Sun, Mar 1, 2026", ["💪 #ProgramX phase 1, week 1, day 1, Push 1 #exercise"]),
	dayNode("2026-03-02", "Mon, Mar 2, 2026", ["💪 #ProgramX phase 1, week 1, day 2, Legs 1 #exercise"]),
	dayNode("2026-03-03", "Tue, Mar 3, 2026", [
		"💪 #ProgramX phase 1, week 1, day 3, Pull 1, @Alice joined me #exercise",
	]),
	dayNode("2026-03-04", "Wed, Mar 4, 2026", ["💪 #ProgramX phase 1, week 2, day 1, Push 1 #exercise"]),
	dayNode("2026-03-05", "Thu, Mar 5, 2026", ["💪 #ProgramX phase 1, week 2, day 2, Legs 1 #exercise"]),
	dayNode("2026-03-06", "Fri, Mar 6, 2026", ["💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"]),
	dayNode("2026-03-07", "Sat, Mar 7, 2026", [
		"💪 #ProgramX phase 1, week 2, day 4, The Finisher, it was hard #exercise",
	]),
	dayNode("2026-03-08", "Sun, Mar 8, 2026", ["💪 #ProgramX phase 2, week 1, day 1, Push 2 #exercise"]),
	dayNode("2026-03-09", "Mon, Mar 9, 2026", [
		"💪 #ProgramX phase 2, week 1, day 2, Arms, Core, and Calves #exercise",
	]),
];

test("parseEntry reads a canonical entry", () => {
	assert.deepStrictEqual(parseEntry("💪 #ProgramX phase 2, week 1, day 3, Pull 2 #exercise"), {
		program: "#ProgramX",
		programKey: "programx",
		phase: 2,
		week: 1,
		day: 3,
		tail: "Pull 2",
	});
});

test("parseEntry tolerates a raw entry with a colon, lowercase tag, and trailing period", () => {
	assert.deepStrictEqual(parseEntry("#programx phase 2, week 2, day 3: pull 2 #exercise. "), {
		program: "#programx",
		programKey: "programx",
		phase: 2,
		week: 2,
		day: 3,
		tail: "pull 2",
	});
});

test("parseEntry drops an iteration note and keeps commentary in the tail", () => {
	assert.deepStrictEqual(
		parseEntry("💪 #ProgramX week 3, second iteration, day 1, Push 3, @Alice joined me #exercise"),
		{
			program: "#ProgramX",
			programKey: "programx",
			phase: null,
			week: 3,
			day: 1,
			tail: "Push 3, @Alice joined me",
		},
	);
});

test("parseEntry reads spelled-out numbers and a Roman-numeral phase", () => {
	assert.deepStrictEqual(parseEntry("#ProgramX phase II week three day 2 legs #exercise"), {
		program: "#ProgramX",
		programKey: "programx",
		phase: 2,
		week: 3,
		day: 2,
		tail: "legs",
	});
});

test("parseEntry ignores entries that are not program workouts", () => {
	assert.deepStrictEqual(
		[
			parseEntry("🏃 Ran 5k with @Alice #exercise"),
			parseEntry("#ProgramX phase 1, week 1, day 1 notes"),
			parseEntry("💪 #ProgramY week 1, day 1, Push #exercise", ["#ProgramX"]),
		],
		[null, null, null],
	);
});

test("parseEntry accepts a field-less entry for a listed program and uses the listed casing", () => {
	assert.deepStrictEqual(parseEntry("💪 #programx The Finisher, last day #exercise", ["#ProgramX"]), {
		program: "#ProgramX",
		programKey: "programx",
		phase: null,
		week: null,
		day: null,
		tail: "The Finisher, last day",
	});
});

test("titleCase capitalizes words but keeps minor words and acronyms", () => {
	assert.deepStrictEqual(
		[titleCase("arms and calves"), titleCase("the finisher"), titleCase("upper body EMOM"), titleCase("push/pull")],
		["Arms and Calves", "The Finisher", "Upper Body EMOM", "Push/Pull"],
	);
});

test("slotName takes the longest comma prefix every occurrence shares", () => {
	assert.deepStrictEqual(
		[
			slotName(["Arms, Core, and Calves", "Arms, Core, and Calves, @Alice joined", "arms, core, and calves 🦵"]),
			slotName(["The Finisher, it was hard"]),
			slotName(["Legs, @Bob joined", "Legs"]),
			slotName([]),
		],
		["Arms, Core, and Calves", "The Finisher", "Legs", null],
	);
});

test("formatEntry drops an optional segment whose field is missing", () => {
	assert.deepStrictEqual(
		[
			formatEntry(TEMPLATE, {program: "#ProgramX", phase: 2, week: 1, day: 3, workout: "Pull 2"}),
			formatEntry(TEMPLATE, {program: "#ProgramX", phase: null, week: 1, day: 3, workout: "Pull 2"}),
		],
		["💪 #ProgramX phase 2, week 1, day 3, Pull 2 #exercise", "💪 #ProgramX week 1, day 3, Pull 2 #exercise"],
	);
});

test("predictNext picks the most frequent successor from earlier history", () => {
	const history = [
		session({week: 1, day: 1, tail: "Push 1"}),
		session({week: 1, day: 2, tail: "Legs 1"}),
		session({week: 1, day: 1, tail: "Push 1"}),
		session({week: 1, day: 3, tail: "Pull 1"}),
		session({week: 1, day: 1, tail: "Push 1"}),
		session({week: 1, day: 2, tail: "Legs 1"}),
	];

	assert.deepStrictEqual(
		predictNext(history, {programKey: "programx", phase: 1, week: 1, day: 1, workout: "Push 1"}),
		{
			slot: {programKey: "programx", phase: 1, week: 1, day: 2, workout: "Legs 1"},
			basis: "history",
			count: 2,
			total: 3,
		},
	);
});

test("predictNext falls back to the next day index seen in another week", () => {
	const history = [
		session({week: 1, day: 1, tail: "Push 1"}),
		session({week: 1, day: 2, tail: "Legs 1"}),
		session({week: 1, day: 3, tail: "Pull 1"}),
		session({week: 2, day: 1, tail: "Push 1"}),
		session({week: 2, day: 2, tail: "legs 1"}),
	];

	assert.deepStrictEqual(
		predictNext(history, {programKey: "programx", phase: 1, week: 2, day: 2, workout: "Legs 1"}),
		{
			slot: {programKey: "programx", phase: 1, week: 2, day: 3, workout: "Pull 1"},
			basis: "structural",
			count: 0,
			total: 0,
		},
	);
});

test("predictNext falls back to week+1 day 1, then to the next phase", () => {
	const history = [
		session({phase: 1, week: 1, day: 1, tail: "Push 1"}),
		session({phase: 1, week: 2, day: 1, tail: "Push 1"}),
		session({phase: 2, week: 1, day: 1, tail: "Push 2"}),
	];
	const nextPhaseFirst = [session({phase: 2, week: 1, day: 1, tail: "Push 2"}), session({phase: 1, week: 2, day: 1})];
	const nextWeek = [session({week: 2, day: 3, tail: "Pull 1"}), session({week: 1, day: 1, tail: "Push 1"})];

	assert.deepStrictEqual(
		[
			predictNext([session({})], {programKey: "programx", phase: 1, week: 1, day: 1, workout: "Push 1"}),
			predictNext(nextWeek, {programKey: "programx", phase: 1, week: 1, day: 1, workout: "Push 1"}),
			predictNext(nextPhaseFirst, {programKey: "programx", phase: 1, week: 2, day: 1, workout: "Push 1"}),
		],
		[
			null,
			{
				slot: {programKey: "programx", phase: 1, week: 2, day: 1, workout: "Push 1"},
				basis: "structural",
				count: 0,
				total: 0,
			},
			{
				slot: {programKey: "programx", phase: 2, week: 1, day: 1, workout: "Push 2"},
				basis: "structural",
				count: 0,
				total: 0,
			},
		],
	);
	assert.deepStrictEqual(
		predictNext(history, {programKey: "programx", phase: 1, week: 1, day: 1, workout: "Push 1"}),
		{
			slot: {programKey: "programx", phase: 1, week: 2, day: 1, workout: "Push 1"},
			basis: "history",
			count: 1,
			total: 1,
		},
	);
});

test("guessWorkouts proposes today's entry from the earlier pass and creates the missing day node", () => {
	const tree = calendar(firstPass(), [
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["💪 #ProgramX phase 1, week 2, day 2, Legs 1 #exercise"]),
		dayNode("2026-10-21", "Wed, Oct 21, 2026", [
			"Worked from the office",
			"#programx phase 1, week 2, day 3: pull 1 #exercise. ",
		]),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-22",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 7,
		generatedAt: "2026-10-22T07:00:00-04:00",
	});

	const after = "💪 #ProgramX phase 1, week 2, day 4, The Finisher #exercise";
	const time = '<time startYear="2026" startMonth="10" startDay="22">Thu, Oct 22, 2026</time> ';
	assert.deepStrictEqual(staged, {
		task: "workout-guess",
		generatedAt: "2026-10-22T07:00:00-04:00",
		status: "ready",
		presentation: "Guess workout",
		summary: {
			lastLogged: {date: "2026-10-21", text: "#programx phase 1, week 2, day 3: pull 1 #exercise. "},
			daysUnlogged: 1,
			proposalsStaged: 1,
			remainingDays: 0,
		},
		proposals: [
			{
				nodeId: CALENDAR_ID,
				header: "Oct 22",
				date: "2026-10-22",
				dayNode: "create",
				timeElement: time,
				basis: "history",
				before: "",
				after,
				changes: [
					{
						type: "create",
						icon: "💪",
						detail: 'history: after "phase 1, week 2, day 3, Pull 1" came this 1 of 1 times; creates the Thu, Oct 22, 2026 day node',
					},
				],
				applyOps: [
					`./bin/run.js node create --parent-id ${CALENDAR_ID} --json '${JSON.stringify({name: time, children: [{name: after}]})}' --position bottom`,
				],
			},
		],
	});
	assert.deepStrictEqual(validateProposal(staged), {valid: true, errors: []});
});

test("guessWorkouts skips missed days that have any #exercise entry or are recorded rest days", () => {
	const oct20 = uuid();
	const tree = calendar(firstPass(), [
		dayNode("2026-10-18", "Sun, Oct 18, 2026", ["💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"]),
		dayNode("2026-10-19", "Mon, Oct 19, 2026", ["🏃 Ran 5k with @Alice #exercise"]),
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["Worked from home"], oct20),
		dayNode("2026-10-21", "Wed, Oct 21, 2026", ["Rest"]),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-21",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: ["2026-10-21"],
		maxDays: 7,
		generatedAt: "2026-10-21T07:00:00-04:00",
	});

	const finisher = "💪 #ProgramX phase 1, week 2, day 4, The Finisher #exercise";
	assert.deepStrictEqual(staged.summary, {
		lastLogged: {date: "2026-10-18", text: "💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"},
		daysUnlogged: 1,
		proposalsStaged: 1,
		remainingDays: 0,
	});
	assert.deepStrictEqual(staged.proposals, [
		{
			nodeId: oct20,
			header: "Oct 20",
			date: "2026-10-20",
			dayNode: "existing",
			basis: "history",
			before: "",
			after: finisher,
			changes: [
				{
					type: "create",
					icon: "💪",
					detail: 'history: after "phase 1, week 2, day 3, Pull 1" came this 1 of 1 times',
				},
			],
			applyOps: [`./bin/run.js node create --parent-id ${oct20} --name '${finisher}' --position bottom`],
		},
	]);
});

test("guessWorkouts chains each guess off the previous one", () => {
	const oct21 = uuid();
	const oct22 = uuid();
	const tree = calendar(firstPass(), [
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"]),
		dayNode("2026-10-21", "Wed, Oct 21, 2026", [], oct21),
		dayNode("2026-10-22", "Thu, Oct 22, 2026", [], oct22),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-22",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 7,
		generatedAt: "2026-10-22T07:00:00-04:00",
	});

	assert.deepStrictEqual(
		staged.proposals.map(({header, after, changes}) => ({header, after, changes})),
		[
			{
				header: "Oct 21",
				after: "💪 #ProgramX phase 1, week 2, day 4, The Finisher #exercise",
				changes: [
					{
						type: "create",
						icon: "💪",
						detail: 'history: after "phase 1, week 2, day 3, Pull 1" came this 1 of 1 times',
					},
				],
			},
			{
				header: "Oct 22",
				after: "💪 #ProgramX phase 2, week 1, day 1, Push 2 #exercise",
				changes: [
					{
						type: "create",
						icon: "💪",
						detail: 'history: after "phase 1, week 2, day 4, The Finisher" came this 1 of 1 times; chained on the Oct 21 guess',
					},
				],
			},
		],
	);
});

test("guessWorkouts stages an ambiguity when nothing can be predicted, and stops the chain there", () => {
	const oct21 = uuid();
	const tree = calendar(firstPass(), [
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["💪 #ProgramX phase 3, week 1, day 1, Core 3 #exercise"]),
		dayNode("2026-10-21", "Wed, Oct 21, 2026", [], oct21),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-22",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 7,
		generatedAt: "2026-10-22T07:00:00-04:00",
	});

	assert.deepStrictEqual(staged.summary, {
		lastLogged: {date: "2026-10-20", text: "💪 #ProgramX phase 3, week 1, day 1, Core 3 #exercise"},
		daysUnlogged: 2,
		proposalsStaged: 1,
		remainingDays: 1,
	});
	assert.deepStrictEqual(staged.proposals, [
		{
			nodeId: oct21,
			header: "Oct 21",
			date: "2026-10-21",
			dayNode: "existing",
			basis: "none",
			before: "",
			after: "",
			changes: [
				{
					type: "ambiguous",
					icon: "⚠️",
					detail: 'no earlier pass or program structure follows "phase 3, week 1, day 1, Core 3"',
				},
			],
			ambiguity: {
				prompt: 'Which workout did you do on Wed, Oct 21, 2026? The last one logged was "💪 #ProgramX phase 3, week 1, day 1, Core 3 #exercise".',
				options: [{label: "No workout that day", applyOps: []}],
			},
			applyOps: [],
		},
	]);
	assert.deepStrictEqual(validateProposal(staged), {valid: true, errors: []});
});

test("guessWorkouts caps the proposals at maxDays and counts the rest", () => {
	const tree = calendar(firstPass(), [
		dayNode("2026-03-10", "Tue, Mar 10, 2026", ["💪 #ProgramX phase 1, week 1, day 1, Push 1 #exercise"]),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-03-14",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 2,
		generatedAt: "2026-03-14T07:00:00-04:00",
	});

	assert.deepStrictEqual(
		[staged.summary, staged.proposals.map(({date, after}) => ({date, after}))],
		[
			{
				lastLogged: {date: "2026-03-10", text: "💪 #ProgramX phase 1, week 1, day 1, Push 1 #exercise"},
				daysUnlogged: 4,
				proposalsStaged: 2,
				remainingDays: 2,
			},
			[
				{date: "2026-03-11", after: "💪 #ProgramX phase 1, week 1, day 2, Legs 1 #exercise"},
				{date: "2026-03-12", after: "💪 #ProgramX phase 1, week 1, day 3, Pull 1 #exercise"},
			],
		],
	);
});

test("guessWorkouts escapes apostrophes in the staged create op", () => {
	const oct21 = uuid();
	const tree = calendar(
		[
			dayNode("2026-03-01", "Sun, Mar 1, 2026", ["💪 #ProgramX week 1, day 1, Push #exercise"]),
			dayNode("2026-03-02", "Mon, Mar 2, 2026", ["💪 #ProgramX week 1, day 2, Farmer's Carry #exercise"]),
			dayNode("2026-03-03", "Tue, Mar 3, 2026", ["💪 #ProgramX week 1, day 1, Push #exercise"]),
		],
		[dayNode("2026-10-21", "Wed, Oct 21, 2026", [], oct21)],
	);

	const staged = guessWorkouts({
		tree,
		today: "2026-03-04",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 7,
		generatedAt: "2026-03-04T07:00:00-04:00",
	});

	assert.deepStrictEqual(
		staged.proposals.map(({after, applyOps}) => ({after, applyOps})),
		[
			{
				after: "💪 #ProgramX week 1, day 2, Farmer's Carry #exercise",
				applyOps: [
					`./bin/run.js node create --parent-id ${CALENDAR_ID} --json '${JSON.stringify({
						name: '<time startYear="2026" startMonth="3" startDay="4">Wed, Mar 4, 2026</time> ',
						children: [{name: "💪 #ProgramX week 1, day 2, Farmer's Carry #exercise"}],
					}).replaceAll("'", `'"'"'`)}' --position bottom`,
				],
			},
		],
	);
});

test("guessWorkouts is empty when today already has a workout or there is no history", () => {
	const logged = calendar(firstPass(), []);
	const empty = calendar([], [dayNode("2026-10-21", "Wed, Oct 21, 2026", ["Worked from home"])]);
	const options = {template: TEMPLATE, programs: ["#ProgramX"], restDays: [], maxDays: 7, generatedAt: "x"};

	assert.deepStrictEqual(
		[
			guessWorkouts({...options, tree: logged, today: "2026-03-09"}),
			guessWorkouts({...options, tree: empty, today: "2026-10-22"}),
		],
		[
			{
				task: "workout-guess",
				generatedAt: "x",
				status: "empty",
				presentation: "Guess workout",
				summary: {
					lastLogged: {
						date: "2026-03-09",
						text: "💪 #ProgramX phase 2, week 1, day 2, Arms, Core, and Calves #exercise",
					},
					daysUnlogged: 0,
					proposalsStaged: 0,
					remainingDays: 0,
				},
				proposals: [],
			},
			{
				task: "workout-guess",
				generatedAt: "x",
				status: "empty",
				presentation: "Guess workout",
				summary: {lastLogged: null, daysUnlogged: 0, proposalsStaged: 0, remainingDays: 0},
				proposals: [],
			},
		],
	);
});

test("guessWorkouts fills bare program-hashtag stubs in place instead of counting them as logged", () => {
	const stubWithTag = {id: uuid(), name: "💪 #ProgramX #exercise"};
	const bareStub = {id: uuid(), name: "#programx "};
	const oct21 = uuid();
	const oct22 = uuid();
	const tree = calendar(firstPass(), [
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["💪 #ProgramX phase 1, week 2, day 2, Legs 1 #exercise"]),
		{id: oct21, name: timeElement("2026-10-21", "Wed, Oct 21, 2026"), children: [stubWithTag]},
		{
			id: oct22,
			name: timeElement("2026-10-22", "Thu, Oct 22, 2026"),
			children: [{id: uuid(), name: "Took the day off"}, bareStub],
		},
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-22",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		restDays: [],
		maxDays: 7,
		generatedAt: "x",
	});

	const pull = "💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise";
	const finisher = "💪 #ProgramX phase 1, week 2, day 4, The Finisher #exercise";
	assert.deepStrictEqual(staged, {
		task: "workout-guess",
		generatedAt: "x",
		status: "ready",
		presentation: "Guess workout",
		summary: {
			lastLogged: {date: "2026-10-20", text: "💪 #ProgramX phase 1, week 2, day 2, Legs 1 #exercise"},
			daysUnlogged: 2,
			proposalsStaged: 2,
			remainingDays: 0,
		},
		proposals: [
			{
				nodeId: stubWithTag.id,
				header: "Oct 21",
				date: "2026-10-21",
				dayNode: "existing",
				basis: "history",
				before: stubWithTag.name,
				after: pull,
				changes: [
					{
						type: "fill",
						icon: "💪",
						detail: 'history: after "phase 1, week 2, day 2, Legs 1" came this 1 of 1 times; fills the bare stub',
					},
				],
				applyOps: [
					`./bin/run.js node update --id ${stubWithTag.id} --name '${pull}' --expect-name '${stubWithTag.name}'`,
				],
			},
			{
				nodeId: bareStub.id,
				header: "Oct 22",
				date: "2026-10-22",
				dayNode: "existing",
				basis: "history",
				before: bareStub.name,
				after: finisher,
				changes: [
					{
						type: "fill",
						icon: "💪",
						detail: 'history: after "phase 1, week 2, day 3, Pull 1" came this 1 of 1 times; chained on the Oct 21 guess; fills the bare stub',
					},
				],
				applyOps: [
					`./bin/run.js node update --id ${bareStub.id} --name '${finisher}' --expect-name '${bareStub.name}'`,
				],
			},
		],
	});
	assert.deepStrictEqual(validateProposal(staged), {valid: true, errors: []});
});

test("guessWorkouts counts a day with any known exercise hashtag as logged, even without #exercise", () => {
	const oct21 = uuid();
	const tree = calendar(firstPass(), [
		dayNode("2026-10-18", "Sun, Oct 18, 2026", ["💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"]),
		dayNode("2026-10-19", "Mon, Oct 19, 2026", ["#ProgramZ cardio blast"]),
		dayNode("2026-10-20", "Tue, Oct 20, 2026", ["#30dayz "]),
		dayNode("2026-10-21", "Wed, Oct 21, 2026", ["Worked from home"], oct21),
	]);

	const staged = guessWorkouts({
		tree,
		today: "2026-10-21",
		template: TEMPLATE,
		programs: ["#ProgramX"],
		exerciseTags: ["#ProgramX", "#ProgramZ", "#30DayZ"],
		restDays: [],
		maxDays: 7,
		generatedAt: "x",
	});

	const finisher = "💪 #ProgramX phase 1, week 2, day 4, The Finisher #exercise";
	assert.deepStrictEqual(staged.summary, {
		lastLogged: {date: "2026-10-18", text: "💪 #ProgramX phase 1, week 2, day 3, Pull 1 #exercise"},
		daysUnlogged: 1,
		proposalsStaged: 1,
		remainingDays: 0,
	});
	assert.deepStrictEqual(
		staged.proposals.map((proposal) => ({date: proposal.date, nodeId: proposal.nodeId, after: proposal.after})),
		[{date: "2026-10-21", nodeId: oct21, after: finisher}],
	);
});
