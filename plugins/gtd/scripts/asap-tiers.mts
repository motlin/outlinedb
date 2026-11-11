// The priority ladder inside a 📌 Tasks (asap) bucket: ordinal tiers with a halving capacity.
//
// The asap buckets used to be split by category (Coding, Administrative, Docs to write, …). A
// category tells you what a task is, never whether to do it before the other thirty things in the
// bucket, so the buckets grew without bound. Tiers replace categories: the bucket's children are
// `1st`, `2nd`, `3rd`, … and each tier holds at most half of the tier below it -- 2, 4, 8, 16, 32.
// What a task *is* moves onto the task text as a #tag, where it can be searched and combined.
//
// Two rules make the ladder work, and both are easy to get subtly wrong by hand:
//
//   Fixed caps, not relative ones. A cap computed from what the tier below currently holds is
//   unstable from the bottom -- completing two items in 2nd would retroactively force an item out
//   of 1st, punishing progress.
//
//   The bottom tier is the landing zone. Undated sweeps out of the ⏰ bucket and undated Things
//   Anytime tasks arrive there in bulk, so it runs over until a rebalance extends the ladder.
//
// Filing into a tier never moves any other item, even when the tier is full: the tier runs over its
// cap and stays that way until planRebalance reads it. That report is proposals only: which items
// leave an over-cap tier is the user's judgment, made on the ladder page, never a position.

import {readFileSync} from "node:fs";
import {arrayField, isObject, parseJson} from "./json.mts";
import {isMain} from "./is-main.mts";

/** A Workflowy node as `node get --json` emits it; fields the ladder does not read pass through untyped. */
export interface LadderNode {
	readonly id: string;
	readonly name: string;
	readonly completedAt?: string | null;
	readonly children?: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface LadderTier {
	readonly tier: number;
	readonly label: string;
	readonly id: string | null;
	readonly capacity: number;
	readonly items: readonly LadderNode[];
}

export interface Ladder {
	readonly bucketId: string | null;
	readonly tiers: readonly LadderTier[];
	readonly unfiled: readonly LadderNode[];
}

export interface TierRef {
	readonly tier: number;
	readonly label: string;
	readonly id: string | null;
}

export interface Insertion {
	readonly targetTier: number;
	readonly targetId: string | null;
	readonly createTiers: readonly {readonly tier: number; readonly label: string}[];
}

export interface GroupMember {
	readonly nodeId: string;
	readonly name: string | null;
	readonly fromTier: number | null;
}

export interface FilingChoices {
	readonly summary: string;
	readonly bottom: TierRef | null;
	readonly promote: TierRef | null;
}

export function isLadderNode(value: unknown): value is LadderNode {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		(value.completedAt === undefined || value.completedAt === null || typeof value.completedAt === "string") &&
		(value.children === undefined || Array.isArray(value.children))
	);
}

/** The node's children that are well-formed nodes. */
function childNodes(node: unknown): LadderNode[] {
	return isObject(node) ? arrayField(node, "children").filter(isLadderNode) : [];
}

const ORDINAL_SUFFIX: Readonly<Record<number, string>> = {1: "st", 2: "nd", 3: "rd"};

function assertTierRank(tier: number): void {
	if (!Number.isInteger(tier) || tier < 1) {
		throw new Error(`not a tier rank: ${tier}`);
	}
}

export function tierLabel(tier: number): string {
	assertTierRank(tier);
	// 11th/12th/13th are the exceptions every naive ordinal formatter gets wrong.
	const teen = tier % 100 >= 11 && tier % 100 <= 13;
	const suffix = teen ? "th" : (ORDINAL_SUFFIX[tier % 10] ?? "th");
	return `${tier}${suffix}`;
}

export function parseTierLabel(name: string | null | undefined): number | null {
	const match = /^(\d+)(st|nd|rd|th)$/u.exec((name ?? "").trim());
	if (!match) {
		return null;
	}
	const tier = Number(match[1]);
	// Reject `1th` and `3nd`: a mistyped label is a category node, not a tier.
	return tier >= 1 && tierLabel(tier) === match[0] ? tier : null;
}

export function tierCapacity(tier: number): number {
	assertTierRank(tier);
	return 2 ** tier;
}

/** Total capacity of a ladder `tiers` deep: 2 + 4 + … + 2^tiers. */
export function ladderCapacity(tiers: number): number {
	assertTierRank(tiers);
	return 2 ** (tiers + 1) - 2;
}

/** How deep a ladder has to be to hold `count` tasks. Used once, when migrating a bucket. */
export function tiersNeededFor(count: number): number {
	let tiers = 1;
	while (ladderCapacity(tiers) < count) {
		tiers += 1;
	}
	return tiers;
}

/**
 * Split a 📌 bucket's children into the tier ladder and everything else. `unfiled` holds both
 * loose tasks and pre-migration category containers -- telling those two apart is the migration's
 * job, not this function's.
 */
export function readLadder(bucket: unknown): Ladder {
	const tiers: LadderTier[] = [];
	const unfiled: LadderNode[] = [];

	for (const child of childNodes(bucket)) {
		const tier = parseTierLabel(child.name);
		if (tier === null) {
			unfiled.push(child);
			continue;
		}
		tiers.push({
			tier,
			label: tierLabel(tier),
			id: child.id,
			capacity: tierCapacity(tier),
			items: childNodes(child).filter((node) => !node.completedAt),
		});
	}

	tiers.sort((a, b) => a.tier - b.tier);
	const bucketId = isObject(bucket) && typeof bucket.id === "string" ? bucket.id : null;
	return {bucketId, tiers, unfiled};
}

export function bottomTier(ladder: Ladder): LadderTier | null {
	return ladder.tiers.at(-1) ?? null;
}

/**
 * Plan what has to happen for one task to land in `targetTier`: which tiers to create first, and
 * the target tier's id. Filing never moves any other item; a full tier just runs over its cap until
 * the user rebalances it.
 */
export function planInsertion(ladder: Ladder, targetTier: number): Insertion {
	assertTierRank(targetTier);

	const byTier = new Map(ladder.tiers.map((t) => [t.tier, t]));

	// Never leave a hole in the ladder: a `3rd` with no `1st` above it reads as a broken migration.
	const createTiers: {tier: number; label: string}[] = [];
	for (let tier = 1; tier <= targetTier; tier++) {
		if (!byTier.has(tier)) {
			createTiers.push({tier, label: tierLabel(tier)});
		}
	}

	return {targetTier, targetId: byTier.get(targetTier)?.id ?? null, createTiers};
}

/**
 * Plan pulling `memberIds` under one new group node. The group lands in `tier` when given, and
 * otherwise in the highest tier any member held (a 3rd + 5th cluster lands in 3rd). Members are
 * ordered by the tier they held (ladder order within a tier, members not on this ladder last), so
 * moving them under the group in this order keeps their relative rank. The insertion is planned on
 * the ladder with the members already removed: a member leaving a full tier frees the slot the
 * group takes.
 */
export function planGroup(
	ladder: Ladder,
	memberIds: readonly string[],
	tier?: number,
): {members: GroupMember[]; insertion: Insertion} {
	const wanted = new Set(memberIds);
	const found = new Map<string, GroupMember>();
	for (const t of ladder.tiers) {
		for (const node of t.items) {
			if (wanted.has(node.id) && !found.has(node.id)) {
				found.set(node.id, {nodeId: node.id, name: node.name, fromTier: t.tier});
			}
		}
	}

	const onLadder = [...found.values()];
	const offLadder = [...wanted]
		.filter((id) => !found.has(id))
		.map((id): GroupMember => ({nodeId: id, name: null, fromTier: null}));

	const remaining: Ladder = {
		...ladder,
		tiers: ladder.tiers.map((t) => ({...t, items: t.items.filter((node) => !wanted.has(node.id))})),
	};

	const targetTier = tier ?? onLadder[0]?.fromTier ?? 1;
	return {members: [...onLadder, ...offLadder], insertion: planInsertion(remaining, targetTier)};
}

/**
 * Plan rescuing an off-ladder project: moving the whole project node, with its open tasks, onto the
 * ladder so the tasks get ranked instead of sitting out of sight. It lands in `tier` when given and
 * otherwise on the bottom tier -- nothing says a forgotten project outranks what is already filed.
 */
export function planRescue(ladder: Ladder, tier?: number): Insertion {
	return planInsertion(ladder, tier ?? bottomTier(ladder)?.tier ?? 1);
}

/**
 * What the /gtd:inbox walk offers for an item bound for this ladder. A refined item always lands on
 * the bottom tier (Accept); `promote` is the tier directly above it, so moving an item up one rank is a click rather than typed text. `summary` is a
 * one-line occupancy readout for the question, so any other tier the user types is an informed pick.
 */
export function filingChoices(ladder: Ladder): FilingChoices {
	const bottom = bottomTier(ladder);
	if (!bottom) {
		return {summary: "", bottom: null, promote: null};
	}

	const summary = ladder.tiers
		.map((t) =>
			t === bottom ? `${t.label} ${t.items.length} (bottom)` : `${t.label} ${t.items.length}/${t.capacity}`,
		)
		.join(" · ");

	const above = ladder.tiers.at(-2);
	const promote = above ? {tier: above.tier, label: above.label, id: above.id} : null;

	return {summary, bottom: {tier: bottom.tier, label: bottom.label, id: bottom.id}, promote};
}

export interface LadderHomeMatch {
	readonly id: string;
	readonly name: string;
	readonly tier: number;
	readonly label: string;
	readonly shared: readonly string[];
}

const STOP_WORDS = new Set(
	"about after also another before from have into just more need only over some that their then there these this those very what when where which with without would your".split(
		" ",
	),
);

/** Lowercased #tags, @people, and key nouns (4+ letters, not stop words) in a node's text. */
function homeSignals(text: string): {tagsAndPeople: Set<string>; words: Set<string>} {
	const plain = text.replaceAll(/<[^>]*>/gu, " ").toLowerCase();
	const tagsAndPeople = new Set(plain.match(/[#@][\p{L}\p{N}_-]+/gu));
	const words = new Set(
		(plain.replaceAll(/[#@][\p{L}\p{N}_-]+/gu, " ").match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(
			(w) => !STOP_WORDS.has(w),
		),
	);
	return {tagsAndPeople, words};
}

/**
 * Open nodes on the ladder that share a #tag, @person, or key noun with the item text: the
 * existing project or group node the item may belong under instead of a bare tier. Strongest
 * overlap first (tags and people count triple), ladder order breaking ties.
 */
export function matchLadderHomes(ladder: Ladder, itemText: string): LadderHomeMatch[] {
	const item = homeSignals(itemText);
	const scored: {match: LadderHomeMatch; score: number; index: number}[] = [];
	for (const t of ladder.tiers) {
		for (const node of t.items) {
			const signals = homeSignals(node.name);
			const sharedTags = [...item.tagsAndPeople].filter((s) => signals.tagsAndPeople.has(s));
			const sharedWords = [...item.words].filter((w) => signals.words.has(w));
			const shared = [...sharedTags, ...sharedWords];
			if (shared.length > 0) {
				scored.push({
					match: {id: node.id, name: node.name, tier: t.tier, label: t.label, shared},
					score: sharedTags.length * 3 + sharedWords.length,
					index: scored.length,
				});
			}
		}
	}
	return scored.toSorted((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.match);
}

/**
 * Read a ladder that may already be out of shape and report what a rebalance would propose. Every
 * entry is a proposal for the user to confirm; nothing here picks an item. Tiers are numbered
 * 1..deepest, and a tier missing from the bucket counts as empty with `id: null`.
 *
 *   dayPlan   -- tiers 1 and 2, the goals for the day.
 *   pushDowns -- each capped (non-bottom) tier over 2^k, with every occupant and the minimum
 *                number that has to move to the tier below.
 *   pullUps   -- the run of empty tiers starting at 2nd, each to be fed from the first non-empty
 *                tier below the run. 1st is never a pull-up target: it is two things the user
 *                would drop everything else for, or nothing.
 *   extend    -- the bottom tier once it passes 2^k (exactly 2^k + 1 triggers it): a new tier to
 *                create, with every occupant so the user can say which ones move into it.
 */
export function planRebalance(ladder: Ladder) {
	const byTier = new Map(ladder.tiers.map((t) => [t.tier, t]));
	const deepest = bottomTier(ladder)?.tier ?? 0;
	const tierAt = (tier: number): LadderTier =>
		byTier.get(tier) ?? {tier, label: tierLabel(tier), id: null, capacity: tierCapacity(tier), items: []};

	const dayPlan: {tier: number; label: string; id: string | null; items: readonly LadderNode[]}[] = [];
	for (let tier = 1; tier <= Math.min(2, deepest); tier++) {
		const {label, id, items} = tierAt(tier);
		dayPlan.push({tier, label, id, items});
	}

	const pushDowns: {
		tier: number;
		label: string;
		id: string | null;
		count: number;
		capacity: number;
		excess: number;
		toTier: number;
		toId: string | null;
		items: readonly LadderNode[];
	}[] = [];
	for (let tier = 1; tier < deepest; tier++) {
		const {label, id, capacity, items} = tierAt(tier);
		if (items.length <= capacity) {
			continue;
		}
		pushDowns.push({
			tier,
			label,
			id,
			count: items.length,
			capacity,
			excess: items.length - capacity,
			toTier: tier + 1,
			toId: tierAt(tier + 1).id,
			items,
		});
	}

	const pullUps: {
		toTier: number;
		toLabel: string;
		toId: string | null;
		fromTier: number;
		fromLabel: string;
		fromId: string | null;
		candidates: readonly LadderNode[];
	}[] = [];
	if (deepest >= 2 && tierAt(2).items.length === 0) {
		let source = 2;
		while (source <= deepest && tierAt(source).items.length === 0) {
			source += 1;
		}
		if (source <= deepest) {
			const from = tierAt(source);
			for (let tier = 2; tier < source; tier++) {
				const to = tierAt(tier);
				pullUps.push({
					toTier: tier,
					toLabel: to.label,
					toId: to.id,
					fromTier: from.tier,
					fromLabel: from.label,
					fromId: from.id,
					candidates: from.items,
				});
			}
		}
	}

	let extend: {
		tier: number;
		label: string;
		id: string | null;
		count: number;
		capacity: number;
		newTier: number;
		newLabel: string;
		minimumToMove: number;
		items: readonly LadderNode[];
	} | null = null;
	const bottom = bottomTier(ladder);
	if (bottom && bottom.items.length > bottom.capacity) {
		extend = {
			tier: bottom.tier,
			label: bottom.label,
			id: bottom.id,
			count: bottom.items.length,
			capacity: bottom.capacity,
			newTier: bottom.tier + 1,
			newLabel: tierLabel(bottom.tier + 1),
			minimumToMove: bottom.items.length - bottom.capacity,
			items: bottom.items,
		};
	}

	return {dayPlan, pushDowns, pullUps, extend};
}

function main(arguments_: readonly string[]): void {
	const [command, inputPath, memberList, tierArgument] = arguments_.slice(2);
	const commands: Readonly<Record<string, (ladder: Ladder) => unknown>> = {
		rebalance: planRebalance,
		choices: filingChoices,
		match: (ladder) => matchLadderHomes(ladder, memberList ?? ""),
		rescue: (ladder) => planRescue(ladder, memberList === undefined ? undefined : Number(memberList)),
		group: (ladder) =>
			planGroup(
				ladder,
				(memberList ?? "").split(",").filter(Boolean),
				tierArgument === undefined ? undefined : Number(tierArgument),
			),
	};
	const run = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
	if (
		run === undefined ||
		!inputPath ||
		(command === "match" && !memberList) ||
		(command === "group" && !memberList)
	) {
		throw new Error(
			"usage: asap-tiers.mts <rebalance|choices> <bucket.json> | rescue <bucket.json> [tier] | match <bucket.json> <item text> | group <bucket.json> <id,id,...> [tier]  (a 📌 bucket from `node get --depth 2 --json`)",
		);
	}
	const bucket = parseJson(readFileSync(inputPath, "utf8"));
	process.stdout.write(`${JSON.stringify(run(readLadder(bucket)), null, 2)}\n`);
}

if (isMain(import.meta.url)) {
	main(process.argv);
}
