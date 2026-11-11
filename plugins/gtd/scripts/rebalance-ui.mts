// Renders both asap ladders as one drag-and-drop page, and diffs the page's submission back into
// node create / node move ops.
//
// A tier with more occupants than AskUserQuestion can show (4 options) cannot be ranked through a
// question at all -- a partial list is not a ranking question. This is the surface that replaces it.
//
// The layout is ONE continuous list per ladder with tier boundaries drawn inside it, not a stack of
// per-tier boxes. That distinction is load-bearing: when each tier was its own box sized to its
// contents, an empty tier collapsed to an undroppable sliver, which broke the one repair the
// rebalance phase needs most -- pulling an item UP into an empty high tier. As spans between
// boundaries in a single drag context, an empty tier is a valid drop target by construction.

import {readFileSync, writeFileSync} from "node:fs";
import assert from "node:assert/strict";
import {join, resolve} from "node:path";
import {readLadder, tierLabel} from "./asap-tiers.mts";
import {isObject, parseJson} from "./json.mts";
import {webAppUrl} from "./web-app-url.mts";
import {isMain} from "./is-main.mts";

export interface ModelItem {
	readonly id: string;
	readonly shortId: string | null;
	readonly text: string;
}

export interface ModelTier {
	readonly tier: number;
	readonly label: string;
	readonly id: string | null;
	readonly capacity: number;
	readonly items: readonly ModelItem[];
}

export interface LadderModel {
	readonly root: string;
	readonly bucketId: string | null;
	readonly tiers: readonly ModelTier[];
}

interface SubmittedTier {
	readonly tier: number;
	readonly label: string;
	readonly id: string | null;
	readonly isNew: boolean;
	readonly items: readonly string[];
}

interface SubmittedRoot {
	readonly bucketId: string | null;
	readonly tiers: readonly SubmittedTier[];
}

export interface Submission {
	readonly roots: Readonly<Record<string, SubmittedRoot>>;
	readonly completed: readonly string[];
}

export type RebalanceOp =
	| {op: "create"; root: string; bucketId: string | null; label: string; tier: number}
	| {
			op: "move";
			root: string;
			nodeId: string;
			text: string;
			fromLabel: string | null;
			toLabel: string;
			toId: string | null;
			toIsNew: boolean;
	  }
	| {op: "complete"; root: string; nodeId: string};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const TEMPLATE = join(import.meta.dirname, "..", "templates", "ladder-queue.html");

/** Strip Workflowy HTML down to display text, keeping links as their anchor text. */
export function displayText(name: string | null | undefined): string {
	return (name ?? "")
		.replaceAll(/<a[^>]*>(.*?)<\/a>/gu, "$1")
		.replaceAll(/<[^>]+>/gu, "")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.trim();
}

/** One ladder, flattened for the page: every tier present, empty ones included. */
export function buildLadderModel(root: string, bucket: unknown): LadderModel {
	const ladder = readLadder(bucket);
	return {
		root,
		bucketId: ladder.bucketId,
		tiers: ladder.tiers.map((t) => ({
			tier: t.tier,
			label: t.label,
			id: t.id,
			capacity: t.capacity,
			items: t.items.map((n) => ({
				id: n.id,
				shortId: typeof n.shortId === "string" ? n.shortId : null,
				text: displayText(n.name),
			})),
		})),
	};
}

/**
 * Ops to turn the live ladders into what the page submitted: tier creates first (a move needs its
 * destination to exist), then one move per item whose tier actually changed.
 */
export function diffSubmission(models: readonly LadderModel[], input: unknown): RebalanceOp[] {
	const submission = validateSubmission(models, input);
	const ops: RebalanceOp[] = [];
	const moves: RebalanceOp[] = [];

	for (const model of models) {
		// validateSubmission narrowed a root for every model, so this lookup always hits.
		const submitted = submission.roots[model.root];
		assert.ok(submitted, `Submission is missing root ${model.root}`);

		const wasIn = new Map<string, string>();
		for (const tier of model.tiers) {
			for (const item of tier.items) {
				wasIn.set(item.id, tier.label);
			}
		}
		const textOf = new Map<string, string>();
		for (const tier of model.tiers) {
			for (const item of tier.items) {
				textOf.set(item.id, item.text);
			}
		}

		for (const tier of submitted.tiers) {
			if (tier.isNew) {
				ops.push({
					op: "create",
					root: model.root,
					bucketId: submitted.bucketId,
					label: tier.label,
					tier: tier.tier,
				});
			}
			for (const nodeId of tier.items) {
				if (wasIn.get(nodeId) === tier.label) {
					continue;
				}
				moves.push({
					op: "move",
					root: model.root,
					nodeId,
					text: textOf.get(nodeId) ?? nodeId,
					fromLabel: wasIn.get(nodeId) ?? null,
					toLabel: tier.label,
					toId: tier.id,
					toIsNew: tier.isNew,
				});
			}
		}
	}
	const completed = submission.completed.map((nodeId): RebalanceOp => {
		const model = models.find((candidate) =>
			candidate.tiers.some((tier) => tier.items.some((item) => item.id === nodeId)),
		);
		assert.ok(model, "Completed items must be unique current ladder items");
		return {op: "complete", root: model.root, nodeId};
	});
	return [...ops, ...moves, ...completed];
}

function narrowTier(value: unknown): SubmittedTier {
	assert.ok(isObject(value), "Submission tier must be an object");
	const {tier, label, id, isNew, items} = value;
	assert.ok(typeof tier === "number", "Tiers must be ordered and unique");
	assert.ok(typeof label === "string", "Invalid tier label");
	assert.ok(id === null || typeof id === "string", "Submission tier destination changed");
	assert.ok(typeof isNew === "boolean", "Invalid new tier flag");
	assert.ok(isStringArray(items), "Submission items must match current ladder exactly");
	return {tier, label, id, isNew, items};
}

function narrowRoot(value: unknown): SubmittedRoot {
	assert.ok(isObject(value), "Submission root must be an object");
	const {bucketId, tiers} = value;
	assert.ok(bucketId === null || typeof bucketId === "string", "Submission bucket changed");
	assert.ok(Array.isArray(tiers), "Submission dropped a tier");
	return {bucketId, tiers: tiers.map(narrowTier)};
}

/** Reject stale or incomplete arrangements before producing any write proposals. */
export function validateSubmission(models: readonly LadderModel[], input: unknown): Submission {
	assert.ok(isObject(input) && isObject(input.roots), "Submission roots must match the current ladders");
	const inputRoots = input.roots;
	assert.deepEqual(
		Object.keys(inputRoots).toSorted(),
		models.map((model) => model.root).toSorted(),
		"Submission roots must match the current ladders",
	);
	const completed = input.completed ?? [];
	const allIds = new Set(models.flatMap((model) => model.tiers.flatMap((tier) => tier.items.map((item) => item.id))));
	assert.ok(
		isStringArray(completed) &&
			new Set(completed).size === completed.length &&
			completed.every((id) => allIds.has(id)),
		"Completed items must be unique current ladder items",
	);
	const roots: Record<string, SubmittedRoot> = {};
	for (const model of models) {
		const submitted = narrowRoot(inputRoots[model.root]);
		roots[model.root] = submitted;
		assert.equal(submitted.bucketId, model.bucketId, "Submission bucket changed");
		assert.ok(submitted.tiers.length >= model.tiers.length, "Submission dropped a tier");
		const known = new Map(model.tiers.map((tier) => [tier.tier, tier]));
		let previous = 0;
		for (const tier of submitted.tiers) {
			assert.ok(Number.isInteger(tier.tier) && tier.tier > previous, "Tiers must be ordered and unique");
			previous = tier.tier;
			assert.equal(tier.label, tierLabel(tier.tier), "Invalid tier label");
			const current = known.get(tier.tier);
			assert.equal(tier.id, current?.id ?? null, "Submission tier destination changed");
			assert.equal(tier.isNew, !current, "Invalid new tier flag");
		}
		for (const tier of model.tiers) {
			assert.ok(
				submitted.tiers.some((candidate) => candidate.tier === tier.tier),
				"Submission dropped a current tier",
			);
		}
		const expected = model.tiers.flatMap((tier) => tier.items.map((item) => item.id)).toSorted();
		assert.deepEqual(
			submitted.tiers.flatMap((tier) => tier.items).toSorted(),
			expected,
			"Submission items must match current ladder exactly",
		);
	}
	return {roots, completed};
}

const esc = (s: string | number): string =>
	String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function renderLadder(model: LadderModel): string {
	// One running index across every tier: a shift-click range is a slice of this
	// sequence, so it has to cross tier boundaries the way Finder's does.
	let rowIndex = 0;
	const rows = model.tiers
		.map((tier) => {
			const state =
				tier.items.length > tier.capacity ? "over" : tier.items.length === tier.capacity ? "exact" : "room";
			const items = tier.items
				.map(
					(item, i) => `
        <li class="row${i >= tier.capacity ? " excess" : ""}" draggable="true" data-node-id="${esc(item.id)}" data-row-index="${rowIndex++}">
          <span class="handle" aria-hidden="true">⠿</span>
          <span class="row-text">${esc(item.text)}</span>
          <span class="row-nudge">
            <button type="button" class="nudge" data-dir="-1" title="Move up a tier">▲</button>
            <button type="button" class="nudge" data-dir="1" title="Move down a tier">▼</button>
          </span>
        </li>`,
				)
				.join("");
			return `
      <li class="boundary ${state}" data-tier-boundary="${tier.tier}">
        <span class="boundary-label">${esc(tier.label)}</span>
        <span class="meter" data-meter="${tier.tier}"></span>
        <span class="chip" data-chip="${tier.tier}"></span>
      </li>
      <li class="span ${state}" data-state="${state}" data-tier-span="${tier.tier}" data-drop-target="true" data-capacity="${tier.capacity}" data-tier-id="${esc(tier.id ?? "")}" data-is-new="false">
        <ul class="span-items">${items}</ul>
        <div class="slots">${Array.from(
			{length: Math.max(0, tier.capacity - tier.items.length)},
			() => '<div class="slot">free</div>',
		)
			.slice(0, 8)
			.join("")}</div>
        <p class="empty-note">empty — drop here</p>
      </li>`;
		})
		.join("");

	return `
  <section class="ladder" data-root="${esc(model.root)}" data-bucket-id="${esc(model.bucketId ?? "")}">
    <h2>${esc(model.root)}<span class="over-count" data-over-count></span></h2>
    <ul class="ladder-list">${rows}</ul>
    <button type="button" class="add-tier">+ Add next tier</button>
  </section>`;
}

/** Stable fingerprint of the tiers and rows a page renders. */
export function pageSignature(models: readonly LadderModel[]): string {
	const shape = models
		.map((m) => `${m.root}:${m.tiers.map((t) => `${t.label}=${t.items.map((i) => i.id).join(",")}`).join("|")}`)
		.join(";");
	let h = 0;
	for (let i = 0; i < shape.length; i++) {
		// oxlint-disable-next-line unicorn/prefer-math-trunc, unicorn/prefer-code-point -- `| 0` wraps to int32 (Math.trunc would lose precision past 2^53); codePointAt would change the hash for emoji and orphan saved localStorage drafts keyed by it
		h = (Math.imul(31, h) + shape.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

/**
 * The shape the checked-in Queue template reads: one entry per root, each with
 * its bucket id and tiers of {id, shortId, name}. The template renders from this
 * object, so the generator's only job is to produce it correctly.
 */
export function toQueueLadders(models: readonly LadderModel[]) {
	const out: Record<
		string,
		{
			root: string;
			bucketId: string | null;
			tiers: {
				tier: number;
				capacity: number;
				label: string;
				id: string | null;
				items: {id: string; shortId: string | null; name: string}[];
			}[];
		}
	> = {};
	for (const model of models) {
		out[model.root] = {
			root: model.root,
			bucketId: model.bucketId,
			tiers: model.tiers.map((t) => ({
				tier: t.tier,
				capacity: t.capacity,
				label: t.label,
				id: t.id,
				items: t.items.map((i) => ({id: i.id, shortId: i.shortId, name: i.text})),
			})),
		};
	}
	return out;
}

/**
 * Render the page by injecting today's ladders into the Queue template.
 *
 * The UI is a checked-in artifact rather than something this script rebuilds:
 * an earlier attempt reimplemented it from scratch and produced a thinner,
 * different page that lost the typography, root tabs, gauges and per-row
 * controls. Templating keeps the page the user actually uses and leaves the
 * generator responsible only for data.
 */
export function renderFromTemplate(models: readonly LadderModel[], templatePath = TEMPLATE): string {
	const template = readFileSync(templatePath, "utf8");
	// `</script>` anywhere in a task name would close the tag early; \u003c keeps
	// the payload inert while staying valid JSON.
	const payload = JSON.stringify(toQueueLadders(models)).replaceAll("<", String.raw`\u003c`);
	return template.replace("__LADDERS__", () => payload);
}

export function renderPage(models: readonly LadderModel[]): string {
	return `<title>Asap Ladder Rebalance</title>
<style>
  :root {
    --tier-min-drop-height: 44px;
    --bg: #faf9f7; --fg: #1c1b19; --muted: #6b6862; --line: #ddd9d2;
    --card: #ffffff; --accent: #3b6ea5; --over: #b3402f; --ok: #2f7d4f; --land: #8a6d1f;
    /* capacity states: each tier region is painted with one of these, so being
       over cap is visible at a glance rather than only readable as "102/32". */
    --room-bg: #eaf2f8;  --room-edge: #7fa8c9;  --room-ink: #2b5d84;
    --exact-bg: #e6f2ea; --exact-edge: #5f9e79; --exact-ink: #2f6144;
    --over-bg: #fbeadf;  --over-edge: #c9743f;  --over-ink: #a4471b;
    --land-bg: #fdf5e3;  --land-edge: #c9a63f;  --land-ink: #7a5f14;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #17181a; --fg: #e9e7e3; --muted: #9a968f; --line: #33353a;
      --card: #1f2124; --accent: #7aa7d9; --over: #e08472; --ok: #79c295; --land: #d8bb63;
      --room-bg: #16242f;  --room-edge: #4d7fa4;  --room-ink: #8fc0e0;
      --exact-bg: #152a20; --exact-edge: #468a63; --exact-ink: #89cea5;
      --over-bg: #2f1c12;  --over-edge: #b06a3d; --over-ink: #e5946a;
      --land-bg: #2b2412;  --land-edge: #9c8330; --land-ink: #d8bb63;
    }
  }
  :root[data-theme="dark"] {
    --bg: #17181a; --fg: #e9e7e3; --muted: #9a968f; --line: #33353a;
    --card: #1f2124; --accent: #7aa7d9; --over: #e08472; --ok: #79c295; --land: #d8bb63;
    --room-bg: #16242f;  --room-edge: #4d7fa4;  --room-ink: #8fc0e0;
    --exact-bg: #152a20; --exact-edge: #468a63; --exact-ink: #89cea5;
    --over-bg: #2f1c12;  --over-edge: #b06a3d; --over-ink: #e5946a;
    --land-bg: #2b2412;  --land-edge: #9c8330; --land-ink: #d8bb63;
  }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 0 0 96px; }
  header { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; padding: 16px; align-items: start; }
  .ladder h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; display: flex; justify-content: space-between; }
  .ladder-list { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .boundary { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--sep-bg); border-top: 2px solid var(--sep-edge); border-bottom: 1px solid var(--sep-edge); color: var(--sep-ink); font-size: 12px; font-weight: 600; position: sticky; top: 46px; }
  .boundary.room  { --sep-bg: var(--room-bg);  --sep-edge: var(--room-edge);  --sep-ink: var(--room-ink); }
  .boundary.exact { --sep-bg: var(--exact-bg); --sep-edge: var(--exact-edge); --sep-ink: var(--exact-ink); }
  .boundary.over  { --sep-bg: var(--over-bg);  --sep-edge: var(--over-edge);  --sep-ink: var(--over-ink); }
  .boundary.landing { --sep-bg: var(--land-bg); --sep-edge: var(--land-edge); --sep-ink: var(--land-ink); }
  .span.room  { background: var(--room-bg); }
  .span.exact { background: var(--exact-bg); }
  .span.over  { background: var(--over-bg); }
  .span.landing { background: var(--land-bg); }
  .slot { margin: 4px 8px; border: 1.5px dashed var(--room-edge); border-radius: 4px; height: 26px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--room-ink); opacity: .6; }
  .row.excess { border-left: 3px solid var(--over-edge); }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 0 16px 12px; font-size: 12px; color: var(--muted); }
  .legend i { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; border: 1px solid; font-style: normal; }
  .legend i.room  { background: var(--room-bg);  border-color: var(--room-edge);  color: var(--room-ink); }
  .legend i.exact { background: var(--exact-bg); border-color: var(--exact-edge); color: var(--exact-ink); }
  .legend i.over  { background: var(--over-bg);  border-color: var(--over-edge);  color: var(--over-ink); }
  .boundary:first-child { border-top: 0; }
  .boundary-label { min-width: 34px; }
  .meter { flex: 1; height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--accent); }
  .chip { font-size: 11px; font-weight: 500; color: var(--muted); white-space: nowrap; }
  .chip { border: 1px solid currentColor; border-radius: 20px; padding: 1px 8px; background: var(--card); }
  .span { min-height: var(--tier-min-drop-height); padding: 2px 0; }
  .span.drag-over { background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 0 0 0 2px var(--accent); }
  .span-items { list-style: none; margin: 0; padding: 0; }
  .empty-note { display: none; margin: 0; padding: 12px; color: var(--muted); font-style: italic; font-size: 12px; }
  .span[data-empty="true"] .empty-note { display: block; }
  .row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 12px; border-top: 1px solid var(--line); background: var(--card); cursor: grab; }
  .row:first-child { border-top: 0; }
  .row.dragging { opacity: .4; }
  .row.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--card)); box-shadow: inset 3px 0 0 var(--accent); }
  .handle { color: var(--muted); cursor: grab; user-select: none; padding-top: 1px; }
  .row-text { flex: 1; overflow-wrap: anywhere; }
  .row-nudge { display: flex; gap: 2px; }
  .nudge { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 4px; cursor: pointer; font-size: 10px; line-height: 1; padding: 3px 5px; }
  .nudge:hover { color: var(--fg); border-color: var(--accent); }
  .add-tier { margin-top: 8px; background: none; border: 1px dashed var(--line); color: var(--muted); border-radius: 8px; padding: 8px 12px; cursor: pointer; width: 100%; }
  .add-tier:hover { color: var(--fg); border-color: var(--accent); }
  button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 7px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button.ghost { background: none; border: 1px solid var(--line); color: var(--fg); border-radius: 7px; padding: 8px 14px; cursor: pointer; }
  #status { color: var(--muted); font-size: 12px; }
  #fallback { margin: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  #fallback textarea { width: 100%; min-height: 180px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
</style>
<header>
  <h1>Asap Ladder Rebalance</h1>
  <button type="button" class="ghost" id="reset">Reset</button>
  <span id="status">autosave on</span>
</header>
<div class="legend">
  <span><i class="room">room</i> has capacity &mdash; free slots shown</span>
  <span><i class="exact">full</i> exactly at cap</span>
  <span><i class="over">over</i> drag some out</span>
  <span>Click a row to select &middot; <b>shift-click</b> for a range &middot; drag any selected row to move the whole block</span>
</div>
<div class="grid">${models.map(renderLadder).join("")}</div>
<div id="fallback" hidden>
  <p><strong>Could not save to the artifact store.</strong> Copy this and paste it back to Claude:</p>
  <textarea readonly id="fallback-json"></textarea>
</div>
<script>
const INITIAL = ${JSON.stringify(models)};
// The draft is keyed by the ladder's SHAPE, not a bare version string. A draft
// written when Work had six tiers was silently replayed onto a seven-tier page
// and pulled every row out of 7th before the user touched anything, which then
// looked like nine deliberate moves in the submission.
const PAGE_SIGNATURE = ${JSON.stringify(pageSignature(models))};
const DRAFT_KEY = 'asap-rebalance-draft-' + PAGE_SIGNATURE;

/** A draft only applies if it describes the rows this page actually renders. */
function draftMatchesPage(draft) {
  if (!draft || draft.signature !== PAGE_SIGNATURE) return false;
  const here = new Set([...document.querySelectorAll('.row')].map((r) => r.dataset.nodeId));
  const there = Object.values(draft.roots ?? {}).flatMap((r) => (r.tiers ?? []).flatMap((t) => t.items ?? []));
  return there.length === here.size && there.every((id) => here.has(id));
}

function spans(ladder) { return [...ladder.querySelectorAll('.span')]; }

function refresh() {
  for (const ladder of document.querySelectorAll('.ladder')) {
    let over = 0;
    const all = spans(ladder);
    all.forEach((span, idx) => {
      const items = span.querySelectorAll('.row').length;
      const cap = Number(span.dataset.capacity);
      const isBottom = idx === all.length - 1;
      span.dataset.empty = items === 0 ? 'true' : 'false';
      const tier = span.dataset.tierSpan;
      // repaint the capacity state live, so dragging a row out of an over-cap
      // tier turns it green the moment it is within cap
      const state = isBottom && items > cap ? 'landing' : items > cap ? 'over' : items === cap ? 'exact' : 'room';
      span.dataset.state = state;
      span.className = 'span ' + state;
      const bound = ladder.querySelector('[data-tier-boundary="' + tier + '"]');
      if (bound) bound.className = 'boundary ' + state;
      // mark the rows past the cap, and redraw the free slots
      [...span.querySelectorAll('.row')].forEach((r, i) => r.classList.toggle('excess', i >= cap));
      const slots = span.querySelector('.slots');
      if (slots) slots.innerHTML = Array.from({length: Math.min(8, Math.max(0, cap - items))}, () => '<div class="slot">free</div>').join('');
      const meter = ladder.querySelector('[data-meter="' + tier + '"]');
      const chip = ladder.querySelector('[data-chip="' + tier + '"]');
      if (meter) meter.innerHTML = '<i style="width:' + Math.min(100, (items / cap) * 100) + '%"></i>';
      if (chip) {
        chip.className = 'chip';
        if (isBottom && items > cap) { chip.textContent = items + '/' + cap + ' · landing'; chip.classList.add('landing'); }
        else if (items > cap) { chip.textContent = items + '/' + cap + ' · over by ' + (items - cap); chip.classList.add('over'); over++; }
        else if (items === cap) { chip.textContent = items + '/' + cap + ' · exact'; chip.classList.add('exact'); }
        else { chip.textContent = items + '/' + cap + ' · ' + (cap - items) + ' free'; }
      }
    });
    const badge = ladder.querySelector('[data-over-count]');
    if (badge) badge.textContent = over ? over + ' over cap' : 'in shape';
  }
  saveDraft();
  scheduleAutosave();
}

function collect() {
  const roots = {};
  for (const ladder of document.querySelectorAll('.ladder')) {
    roots[ladder.dataset.root] = {
      bucketId: ladder.dataset.bucketId,
      tiers: spans(ladder).map((span) => ({
        tier: Number(span.dataset.tierSpan),
        label: ladder.querySelector('[data-tier-boundary="' + span.dataset.tierSpan + '"] .boundary-label').textContent,
        id: span.dataset.tierId || null,
        isNew: span.dataset.isNew === 'true',
        items: [...span.querySelectorAll('.row')].map((r) => r.dataset.nodeId),
      })),
    };
  }
  return {submittedAt: new Date().toISOString(), roots};
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({...collect(), signature: PAGE_SIGNATURE})); } catch {}
}

function applyArrangement(state) {
  for (const ladder of document.querySelectorAll('.ladder')) {
    const submitted = state.roots?.[ladder.dataset.root];
    if (!submitted) continue;
    const byId = new Map([...ladder.querySelectorAll('.row')].map((r) => [r.dataset.nodeId, r]));
    for (const tier of submitted.tiers) {
      let span = ladder.querySelector('[data-tier-span="' + tier.tier + '"]');
      if (!span) span = addTier(ladder, tier.label, tier.tier);
      const list = span.querySelector('.span-items');
      for (const id of tier.items) { const row = byId.get(id); if (row) list.appendChild(row); }
    }
  }
  refresh();
}

function addTier(ladder, label, tier) {
  const list = ladder.querySelector('.ladder-list');
  const boundary = document.createElement('li');
  boundary.className = 'boundary';
  boundary.dataset.tierBoundary = String(tier);
  boundary.innerHTML = '<span class="boundary-label"></span><span class="meter" data-meter="' + tier + '"></span><span class="chip" data-chip="' + tier + '"></span>';
  boundary.querySelector('.boundary-label').textContent = label;
  const span = document.createElement('li');
  span.className = 'span';
  span.dataset.tierSpan = String(tier);
  span.dataset.dropTarget = 'true';
  span.dataset.isNew = 'true';
  span.dataset.capacity = String(Math.pow(2, tier));
  span.innerHTML = '<ul class="span-items"></ul><p class="empty-note">empty — drop here</p>';
  list.append(boundary, span);
  wireSpan(span);
  return span;
}

let dragging = null;
// Selection model. Click sets the anchor, shift-click takes the contiguous range
// across tier boundaries, and a drag carries every selected row as one block.
let anchorIndex = null;

function allRows(ladder) {
  return [...ladder.querySelectorAll('.row')].sort(
    (a, b) => Number(a.dataset.rowIndex) - Number(b.dataset.rowIndex),
  );
}
function selectedRows(ladder) {
  return allRows(ladder).filter((r) => r.classList.contains('sel'));
}
function clearSelection(ladder) {
  for (const r of ladder.querySelectorAll('.row.sel')) r.classList.remove('sel');
}
function selectRange(ladder, fromIdx, toIdx) {
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  clearSelection(ladder);
  for (const r of allRows(ladder)) {
    const i = Number(r.dataset.rowIndex);
    if (i >= lo && i <= hi) r.classList.add('sel');
  }
}

function wireSpan(span) {
  span.addEventListener('dragover', (e) => { e.preventDefault(); span.classList.add('drag-over'); });
  span.addEventListener('dragleave', () => span.classList.remove('drag-over'));
  span.addEventListener('drop', (e) => {
    e.preventDefault();
    span.classList.remove('drag-over');
    if (!dragging) return;
    const list = span.querySelector('.span-items');
    const ladder = span.closest('.ladder');
    const after = [...list.querySelectorAll('.row:not(.dragging)')].find((r) => e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
    // carrySelection: a drag moves the whole selection when the grabbed row is
    // part of it, so a 70-row push-down is one gesture rather than seventy.
    const carrySelection = dragging.classList.contains('sel') ? selectedRows(ladder) : [dragging];
    for (const row of carrySelection) {
      if (after) list.insertBefore(row, after);
      else list.appendChild(row);
    }
    refresh();
  });
}

function wireRow(row) {
  row.addEventListener('dragstart', () => { dragging = row; row.classList.add('dragging'); });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragging = null; refresh(); });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.nudge')) return;
    const ladder = row.closest('.ladder');
    const idx = Number(row.dataset.rowIndex);
    if (e.shiftKey && anchorIndex !== null) {
      selectRange(ladder, anchorIndex, idx);
      window.getSelection()?.removeAllRanges();
      return;
    }
    const wasOnly = row.classList.contains('sel') && selectedRows(ladder).length === 1;
    clearSelection(ladder);
    if (!wasOnly) row.classList.add('sel');
    anchorIndex = wasOnly ? null : idx;
  });
}

// Tier ids are rendered per ladder in the markup -- deriving them here from a flattened
// INITIAL would hand the second ladder the first ladder's tier ids, sending its moves into
// the wrong bucket.
document.querySelectorAll('.span').forEach(wireSpan);
document.querySelectorAll('.row').forEach(wireRow);

document.addEventListener('click', (e) => {
  const nudge = e.target.closest('.nudge');
  if (nudge) {
    const row = nudge.closest('.row');
    const ladder = row.closest('.ladder');
    const all = spans(ladder);
    const here = all.indexOf(row.closest('.span'));
    const next = all[here + Number(nudge.dataset.dir)];
    if (next) { next.querySelector('.span-items').appendChild(row); refresh(); }
    return;
  }
  const add = e.target.closest('.add-tier');
  if (add) {
    const ladder = add.closest('.ladder');
    const last = spans(ladder).at(-1);
    const tier = Number(last.dataset.tierSpan) + 1;
    const n = tier % 100 >= 11 && tier % 100 <= 13 ? 'th' : ({1:'st',2:'nd',3:'rd'}[tier % 10] ?? 'th');
    addTier(ladder, tier + n, tier);
    refresh();
  }
});

document.getElementById('reset').addEventListener('click', () => {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  location.reload();
});

// autosave: every mutation persists, so nothing waits on a Submit button.
let saveTimer = null;
async function autosave() {
  const status = document.getElementById('status');
  const payload = collect();
  const db = await claude.use('db');
  if (!db) {
    document.getElementById('fallback').hidden = false;
    document.getElementById('fallback-json').value = JSON.stringify(payload, null, 2);
    status.textContent = 'Store unavailable - copy the JSON below.';
    return;
  }
  try {
    await db.doc('rebalance/submission').set(payload);
    status.textContent = 'saved ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('fallback').hidden = false;
    document.getElementById('fallback-json').value = JSON.stringify(payload, null, 2);
    status.textContent = 'save failed (' + (err?.code ?? 'error') + ') - copy the JSON below.';
  }
}
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 600);
}

try {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) {
    const parsed = JSON.parse(draft);
    if (draftMatchesPage(parsed)) applyArrangement(parsed);
    else localStorage.removeItem(DRAFT_KEY);
  }
} catch {}
refresh();
</script>`;
}

export function renderWebAppLauncher(url: URL | string): string {
	const target = new URL("/ladder", url);
	assert.ok(["http:", "https:"].includes(target.protocol), "Web app URL must use HTTP or HTTPS");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Asap ladder</title><body><a href="${esc(target.href)}">Open the local Asap ladder</a><p>Moves and Done apply immediately in the local web app.</p></body></html>`;
}

function main(): void {
	const args = process.argv.slice(2);
	const htmlIndex = args.indexOf("--html");
	const html = htmlIndex !== -1;
	if (html) {
		args.splice(htmlIndex, 1);
	}
	if (!html && args[0] !== "--apply") {
		const outputIndex = args.indexOf("--output");
		const output = outputIndex === -1 ? null : args.splice(outputIndex, 2)[1];
		assert.ok(args.length === 0, "Use --html work.json personal.json for an offline or Artifact page");
		const url = webAppUrl("/ladder");
		const page = renderWebAppLauncher(url);
		if (output) {
			writeFileSync(output, page);
			process.stdout.write(`${resolve(output)}\n`);
		} else {
			process.stdout.write(`${url.href}\n`);
		}
		return;
	}
	const apply = args[0] === "--apply";
	const submissionPath = apply ? args.splice(0, 2)[1] : null;
	const outputIndex = args.indexOf("--output");
	const output = outputIndex === -1 ? null : args.splice(outputIndex, 2)[1];
	assert.equal(
		args.length,
		2,
		"Usage: rebalance-ui.mts [--html | --apply submission.json] work.json personal.json [--output page.html]",
	);
	const models = args.map((file, index) => {
		const parsed = parseJson(readFileSync(file, "utf8"));
		const bucket: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
		assert.ok(
			isObject(bucket) && typeof bucket.id === "string" && bucket.id !== "" && Array.isArray(bucket.children),
			"Expected a bucket with id and children",
		);
		return buildLadderModel(index === 0 ? "work" : "personal", bucket);
	});
	const result = apply
		? `${JSON.stringify(diffSubmission(models, parseJson(readFileSync(submissionPath ?? "", "utf8"))), null, 2)}\n`
		: renderFromTemplate(models);
	if (output) {
		writeFileSync(output, result);
		process.stdout.write(`${resolve(output)}\n`);
	} else {
		process.stdout.write(result);
	}
}

if (isMain(import.meta.url)) {
	main();
}
