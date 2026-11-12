/**
 * The asap ladder, drag-and-drop, writing straight through to Workflowy.
 *
 * The published-artifact version of this page had to queue every move into a
 * localStorage draft and apply the batch later, because an artifact cannot call
 * out to anything. That draft is what silently emptied a tier the user never
 * touched. Here a drop is a POST: there is no draft to go stale, and the server
 * broadcasts each write so every open tab (and any Claude session watching the
 * socket) sees it immediately.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {parseLadderEvent} from "../../server/ladder-events.js";
import {undoHistory} from "../undo-history.js";
import type {LadderEvent} from "../../server/ladder-events.js";
import {tierLabel} from "../../server/ladder-model.js";
import type {LadderItem, LadderTier} from "../../server/ladder-model.js";
import
{
	applyLadderEvent,
	ladderMoveSelection,
	moveWithin,
	removeRow,
	restoreRow,
	selectLadderRange,
	stepBeforeId,
	tierOf,
} from "../ladder-state.js";
import type {Ladders} from "../ladder-state.js";
import {autoScrollBy, isDragGesture, dropAtPoint} from "../pointer-drag.js";
import type {LadderDropTarget, Point} from "../pointer-drag.js";
import {LadderTree} from "./ladder-tree.js";
import "../ladder.css";
import type {LadderEventEnvelope, LadderFailure, LaddersResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";

const VERDICT: Record<LadderTier["state"], (tier: LadderTier) => string> =
{
	room: (tier) => `room for ${tier.capacity - tier.items.length}`,
	exact: () => "at cap",
	over: (tier) => `over by ${tier.items.length - tier.capacity}`,
};

interface Preview
{
	item: LadderItem;
	left: number;
	top: number;
}

/** Nested lists, one per level, so the preview keeps the outline's shape. */
function previewList(items: LadderItem[]): React.ReactNode
{
	return (
		<ul>
			{items.map((child) => (
				<li key={child.id}>
					<span className="ladder-preview-name">{child.name}</span>
					{child.children.length > 0 ? previewList(child.children) : null}
					{child.children.length === 0 && child.hasChildren ? (
						<span className="ladder-child-more">…</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

/** The server answered and refused the write, so the page knows it did not land. */
class WriteRejected extends Error
{
}

function errorMessage(cause: unknown): string
{
	return cause instanceof Error ? cause.message : String(cause);
}

async function fetchLadders(): Promise<Ladders>
{
	const response = await fetch("/api/v1/ladder");
	if (!response.ok)
	{
		throw new Error(`ladder request failed: ${response.status}`);
	}
	const body = await readJson<LaddersResponse>(response);
	return body.ladders;
}

type LadderWriteResult =
	|
	  {
			kind: "saved";
			event: LadderEvent;
	  }
	|
	  {
			kind: "reconcile";
			error: string;
	  };

/** POSTs one ladder write; throws WriteRejected when the server refuses it without asking to reconcile. */
async function postLadderWrite(path: string, body: Record<string, string>): Promise<LadderWriteResult>
{
	const response = await fetch(
		path,
		{
			method: "POST",
			headers:
			{
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	if (!response.ok)
	{
		const failure = await readJson<Partial<LadderFailure>>(response);
		if (failure.reconcile)
		{
			return {
				kind: "reconcile",
				error: failure.error ?? "Move failed",
			};
		}
		throw new WriteRejected(failure.error ?? `write failed: ${response.status}`);
	}
	const {event} = await readJson<LadderEventEnvelope>(response);
	return {
		kind: "saved",
		event,
	};
}

/** Creates the next tier at the top of `bucketId`, then rereads the ladder; `onCreated` runs between the two. */
async function addTierAndRefresh(bucketId: string, tier: number, onCreated: () => void): Promise<Ladders>
{
	const response = await fetch(
		"/api/v1/nodes",
		{
			method: "POST",
			headers:
			{
				"content-type": "application/json",
			},
			body: JSON.stringify(
				{
					parent_id: bucketId,
					name: tierLabel(tier),
					position: 0,
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error(`Could not add a tier: ${response.status}`);
	}
	onCreated();
	const refreshed = await fetch("/api/v1/ladder");
	if (!refreshed.ok)
	{
		throw new Error(`Tier created; could not refresh ladder: ${refreshed.status}. Reload before adding another.`);
	}
	const body = await readJson<LaddersResponse>(refreshed);
	return body.ladders;
}

export function LadderView()
{
	const [ladders, setLadders] = useState<Ladders>();
	const [root, setRoot] = useState("personal");
	const [error, setError] = useState<string>();
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	const [live, setLive] = useState(false);
	const [dragging, setDragging] = useState<string>();
	const [dropTarget, setDropTarget] = useState<LadderDropTarget>();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const anchor = useRef<string>(undefined);
	const busy = useRef(false);
	const [saving, setSaving] = useState(false);
	const [needsReload, setNeedsReload] = useState(false);
	const [pending, setPending] = useState<Set<string>>(new Set());
	// Rows with a write in flight. Only these rows lock; a slow write must not freeze the page.
	const inFlight = useRef(new Set<string>());
	const claim = useCallback((ids: string[]) =>
	{
		for (const id of ids)
		{
			inFlight.current.add(id);
		}
		setPending(new Set(inFlight.current));
	}, []);
	const release = useCallback((ids: string[]) =>
	{
		for (const id of ids)
		{
			inFlight.current.delete(id);
		}
		setPending(new Set(inFlight.current));
	}, []);
	const receivedWrites = useRef(new Map<string, LadderEvent>());
	// Callbacks read the latest ladder here; every setLadders call writes it first.
	const laddersRef = useRef<Ladders | undefined>(undefined);
	const updateLadders = useCallback((update: (current: Ladders) => Ladders) =>
	{
		if (!laddersRef.current)
		{
			return;
		}
		laddersRef.current = update(laddersRef.current);
		setLadders(laddersRef.current);
	}, []);

	useEffect(() =>
	{
		const load = async () =>
		{
			try
			{
				const loaded = await fetchLadders();
				laddersRef.current = loaded;
				setLadders(loaded);
			}
			catch (cause)
			{
				setError(errorMessage(cause));
			}
		};
		void load();
	}, []);

	// Every write, from this tab or any other, arrives here as one frame.
	useEffect(() =>
	{
		const protocol = globalThis.location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(`${protocol}://${globalThis.location.host}/api/v1/ladder/events`);
		socket.addEventListener("open", () =>
		{
			setLive(true);
		});
		socket.addEventListener("close", () =>
		{
			setLive(false);
		});
		socket.addEventListener("message", (message: MessageEvent<string>) =>
		{
			const event = parseLadderEvent(message.data);
			if (!event)
			{
				return;
			}
			receivedWrites.current.set(event.nodeId, event);
			updateLadders((current) => applyLadderEvent(current, event));
			// The outline changed under the undo history, so its inverses no longer apply.
			undoHistory.clear();
		});
		return () =>
		{
			socket.close();
		};
	}, [updateLadders]);

	/** Replace the page with the server's ladder; false when even that fails. */
	const reread = useCallback(async () =>
	{
		try
		{
			const refreshed = await fetch("/api/v1/ladder");
			if (refreshed.ok)
			{
				const body = await readJson<LaddersResponse>(refreshed);
				updateLadders(() => body.ladders);
				return true;
			}
		}
		catch
		{
			// Fall through to the reload banner.
		}
		setNeedsReload(true);
		setError("Could not refresh after the failed move. Reload before moving more rows.");
		return false;
	}, [updateLadders]);

	const write = useCallback(
		async (
			path: string,
			body: Record<string, string> &
			{
				node_id: string;
			},
			optimistic: (current: Ladders) => Ladders,
		) =>
		{
			const before = laddersRef.current;
			if (!before)
			{
				return false;
			}
			const nodeId = body.node_id;
			const lastReceived = receivedWrites.current.get(nodeId);
			setRowErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== nodeId)));
			updateLadders(optimistic);
			try
			{
				const result = await postLadderWrite(path, body);
				if (result.kind === "reconcile")
				{
					setRowErrors((current) => (
					{
						...current,
						[nodeId]: result.error,
					}));
					await reread();
					return false;
				}
				const {event} = result;
				if (receivedWrites.current.get(nodeId) === lastReceived)
				{
					updateLadders((current) => applyLadderEvent(current, event));
				}
				return true;
			}
			catch (cause)
			{
				// A received write is authoritative even if its HTTP response was lost.
				if (receivedWrites.current.get(nodeId) !== lastReceived)
				{
					return true;
				}
				// A dropped connection may have outlived a write that landed, so ask rather than guess.
				if (!(cause instanceof WriteRejected))
				{
					await reread();
					return false;
				}
				updateLadders((current) => restoreRow(current, before, nodeId));
				setRowErrors((current) => (
				{
					...current,
					[nodeId]: errorMessage(cause),
				}));
				return false;
			}
		},
		[updateLadders, reread],
	);

	const move = useCallback(
		(
			nodeId: string,
			toTier: string,
			placement?:
				| string
				|
				  {
						step: "up" | "down";
				  },
		) =>
		{
			const ladder = laddersRef.current?.[root];
			if (busy.current || needsReload || !ladder)
			{
				return;
			}
			const ids = ladderMoveSelection(ladder, selected, nodeId).filter((id) => !inFlight.current.has(id));
			if (ids.length === 0)
			{
				return;
			}
			const stepping = typeof placement === "object";
			const beforeNodeId = stepping ? stepBeforeId(ladder, toTier, placement.step, ids) : placement;
			claim(ids);
			const moveEach = async () =>
			{
				for (const id of ids)
				{
					const current = laddersRef.current;
					const alreadyThere = current && tierOf(current, root, id) === toTier;
					if (!current || (alreadyThere && (stepping || beforeNodeId === undefined)))
					{
						continue;
					}
					const saved = await write(
						"/api/v1/ladder/move",
						{
							root,
							node_id: id,
							to_tier: toTier,
							...(beforeNodeId === undefined
								? {}
								:
									{
										before_id: beforeNodeId,
									}),
						},
						(state) => moveWithin(state, root, id, toTier, beforeNodeId),
					);
					if (!saved)
					{
						break;
					}
				}
			};
			void moveEach().finally(() =>
			{
				release(ids);
			});
		},
		[root, selected, write, needsReload, claim, release],
	);

	const gesture = useRef<
	{
		nodeId: string;
		origin: Point;
		started: boolean;
		moving: Set<string>;
	}>(undefined);
	const suppressClick = useRef(false);
	const [ghost, setGhost] = useState<
	{
		x: number;
		y: number;
		name: string;
	}>();
	const page = useRef<HTMLDivElement>(null);
	const dragPoint = useRef<Point>(undefined);

	const cancelDrag = useCallback(() =>
	{
		gesture.current = undefined;
		dragPoint.current = undefined;
		setGhost(undefined);
		setDragging(undefined);
		setDropTarget(undefined);
	}, []);

	useEffect(() =>
	{
		if (!dragging)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		let frame: number;
		const scroll = () =>
		{
			const at = dragPoint.current;
			const container = page.current;
			if (at && container && gesture.current)
			{
				const bounds = container.getBoundingClientRect();
				container.scrollBy(0, autoScrollBy(at.y - bounds.top, bounds.height));
				setDropTarget(dropAtPoint(at.x, at.y, gesture.current.moving));
			}
			frame = requestAnimationFrame(scroll);
		};
		frame = requestAnimationFrame(scroll);
		return () =>
		{
			cancelAnimationFrame(frame);
		};
	}, [dragging]);

	const onGripDown = useCallback(
		(
			event: React.PointerEvent,
			item:
			{
				id: string;
				name: string;
			},
		) =>
		{
			if (busy.current || event.button !== 0 || !event.isPrimary)
			{
				return;
			}
			const target = event.target;
			if (!(target instanceof Element) || target.closest("button, a, input, select"))
			{
				return;
			}
			suppressClick.current = false;
			if (target.closest(".ladder-text"))
			{
				if (event.shiftKey)
				{
					event.preventDefault();
				}
				return;
			}
			// Touch scrolling remains available outside the grip.
			if (event.pointerType === "touch" && !target.closest(".grip"))
			{
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			const ladder = laddersRef.current?.[root];
			if (!ladder)
			{
				return;
			}
			gesture.current =
			{
				nodeId: item.id,
				origin:
				{
					x: event.clientX,
					y: event.clientY,
				},
				started: false,
				moving: new Set(ladderMoveSelection(ladder, selected, item.id)),
			};
		},
		[root, selected],
	);

	const onGripMove = useCallback((event: React.PointerEvent, name: string) =>
	{
		const active = gesture.current;
		if (!active)
		{
			return;
		}
		const at =
		{
			x: event.clientX,
			y: event.clientY,
		};
		if (!active.started)
		{
			if (!isDragGesture(active.origin, at))
			{
				return;
			}
			active.started = true;
			suppressClick.current = true;
			setDragging(active.nodeId);
		}
		dragPoint.current = at;
		setGhost(
			{
				x: at.x,
				y: at.y,
				name: active.moving.size > 1 ? `${active.moving.size} selected rows` : name,
			},
		);
		setDropTarget(dropAtPoint(at.x, at.y, active.moving));
	}, []);

	const onGripUp = useCallback(
		(event: React.PointerEvent) =>
		{
			const active = gesture.current;
			const target = active?.started ? dropAtPoint(event.clientX, event.clientY, active.moving) : undefined;
			cancelDrag();
			if (active?.started && target)
			{
				move(active.nodeId, target.tier, target.beforeNodeId);
			}
		},
		[move, cancelDrag],
	);

	const select = (nodeId: string, range: boolean, additive = false) =>
	{
		if (busy.current)
		{
			return;
		}
		const ladder = laddersRef.current?.[root];
		if (!ladder)
		{
			return;
		}
		if (range && anchor.current)
		{
			const rangeIds = selectLadderRange(ladder, anchor.current, nodeId);
			setSelected((current) => (additive ? new Set([...current, ...rangeIds]) : rangeIds));
		}
		else
		{
			anchor.current = nodeId;
			setSelected((current) =>
			{
				const next = additive ? new Set(current) : new Set<string>();
				if (next.has(nodeId))
				{
					next.delete(nodeId);
				}
				else
				{
					next.add(nodeId);
				}
				return next;
			});
		}
	};
	const onRowClick = (event: React.MouseEvent, nodeId: string) =>
	{
		if (!(event.target instanceof Element) || event.target.closest("button, a, input, select"))
		{
			return;
		}
		if (suppressClick.current)
		{
			suppressClick.current = false;
			return;
		}
		if (
			!event.shiftKey &&
			event.target.closest(".ladder-text") &&
			globalThis.getSelection()?.isCollapsed === false
		)
		{
			return;
		}
		select(nodeId, event.shiftKey, event.metaKey || event.ctrlKey);
	};

	const complete = useCallback(
		(nodeId: string) =>
		{
			if (busy.current || inFlight.current.has(nodeId))
			{
				return;
			}
			claim([nodeId]);
			const saved = write(
				"/api/v1/ladder/complete",
				{
					root,
					node_id: nodeId,
				},
				(current) => removeRow(current, nodeId),
			);
			void saved.finally(() =>
			{
				release([nodeId]);
			});
		},
		[root, write, claim, release],
	);

	const addTier = async () =>
	{
		const ladder = laddersRef.current?.[root];
		if (!ladder || busy.current)
		{
			return;
		}
		busy.current = true;
		setSaving(true);
		setError(undefined);
		try
		{
			const refreshed = await addTierAndRefresh(ladder.bucketId, (ladder.tiers.at(-1)?.tier ?? 0) + 1, () =>
			{
				setNeedsReload(true);
			});
			laddersRef.current = refreshed;
			setLadders(refreshed);
			setNeedsReload(false);
		}
		catch (cause)
		{
			setError(errorMessage(cause));
		}
		busy.current = false;
		setSaving(false);
	};

	const roots = useMemo(() => Object.keys(ladders ?? {}), [ladders]);
	const ladder = ladders?.[root];
	const [treeItem, setTreeItem] = useState<
	{
		id: string;
		name: string;
	}>();
	const [preview, setPreview] = useState<Preview>();
	const showPreview = useCallback(
		(
			item: LadderItem,
			position:
			{
				left: number;
				bottom: number;
			},
		) =>
		{
			setPreview(
				{
					item,
					left: position.left,
					top: position.bottom + 4,
				},
			);
		},
		[],
	);
	const hidePreview = useCallback(() =>
	{
		setPreview(undefined);
	}, []);

	return (
		<div
			className="ladder-page"
			data-dragging={dragging ? "" : undefined}
			ref={page}
			onScroll={preview ? hidePreview : undefined}
		>
			<div className="ladder-wrap">
				<header className="ladder-head">
					<h1>Asap ladder</h1>
					<p className="ladder-dek">
						Drag a row to place it anywhere in a tier. Each tier holds 2<sup>k</sup>, fixed, so finishing
						work never pushes anything out of a tier above.
					</p>
					<p className="ladder-live" data-live={live ? "on" : "off"}>
						{live
							? "Live — every write is broadcast as it lands"
							: "Write stream disconnected — reload to reconnect"}
					</p>
				</header>

				<p className="ladder-dek">
					Select rows to move together; shift-click selects a range. Moves and Done save immediately.
				</p>
				{error ? <div className="ladder-error">{error}</div> : null}

				<nav className="ladder-rootnav">
					{roots.map((name) => (
						<button
							aria-pressed={name === root}
							key={name}
							disabled={saving}
							onClick={() =>
							{
								setRoot(name);
								setSelected(new Set());
								anchor.current = undefined;
							}}
							type="button"
						>
							{name}
						</button>
					))}
				</nav>

				{ladder ? (
					<div className="ladder-queue">
						{ladder.tiers.map((tier, index) => (
							<Tier
								dropping={dropTarget?.tier === tier.label}
								beforeNodeId={dropTarget?.tier === tier.label ? dropTarget.beforeNodeId : undefined}
								onRowClick={onRowClick}
								onGripCancel={cancelDrag}
								key={tier.id}
								nextTier={ladder.tiers[index + 1]?.label}
								onStep={move}
								previousTier={ladder.tiers[index - 1]?.label}
								onOpenTree={(item) =>
								{
									hidePreview();
									setTreeItem(item);
								}}
								onPreview={showPreview}
								onPreviewEnd={hidePreview}
								onComplete={complete}
								onGripDown={onGripDown}
								onGripMove={onGripMove}
								onGripUp={onGripUp}
								pending={pending}
								rowErrors={rowErrors}
								selected={selected}
								onSelect={select}
								saving={saving || needsReload}
								tier={tier}
								dragging={dragging}
							/>
						))}
						<button type="button" disabled={saving || needsReload} onClick={() => void addTier()}>
							Add bottom tier
						</button>
					</div>
				) : (
					<p className="ladder-dek">{error ? "Could not load the ladder." : "Loading…"}</p>
				)}
			</div>
			{treeItem ? (
				<LadderTree
					key={treeItem.id}
					item={treeItem}
					onClose={() =>
					{
						setTreeItem(undefined);
					}}
				/>
			) : null}
			{preview && !dragging ? (
				<div
					className="ladder-preview"
					id="ladder-preview"
					role="tooltip"
					style={
					{
						left: preview.left,
						top: preview.top,
					}}
				>
					{previewList(preview.item.children)}
				</div>
			) : null}
			{ghost ? (
				<div
					className="ladder-ghost"
					style={
					{
						left: ghost.x,
						top: ghost.y,
					}}
				>
					{ghost.name}
				</div>
			) : null}
		</div>
	);
}

interface TierProps
{
	tier: LadderTier;
	dragging: string | undefined;
	dropping: boolean;
	beforeNodeId: string | undefined;
	onRowClick: (event: React.MouseEvent, nodeId: string) => void;
	onGripCancel: () => void;
	pending: Set<string>;
	rowErrors: Record<string, string>;
	selected: Set<string>;
	onSelect: (nodeId: string, range: boolean, additive?: boolean) => void;
	saving: boolean;
	/** Neighbouring tier labels, so the step buttons know where up and down are. */
	previousTier: string | undefined;
	nextTier: string | undefined;
	onOpenTree: (item: {id: string; name: string}) => void;
	/** Only the Tree button opens the subtree preview, and it floats above the list. */
	onPreview: (
		item: LadderItem,
		anchor:
		{
			left: number;
			bottom: number;
		},
	) => void;
	onPreviewEnd: () => void;
	onComplete: (nodeId: string) => void;
	onStep: (
		nodeId: string,
		toTier: string,
		placement:
		{
			step: "up" | "down";
		},
	) => void;
	onGripDown: (
		event: React.PointerEvent,
		item:
		{
			id: string;
			name: string;
		},
	) => void;
	onGripMove: (event: React.PointerEvent, name: string) => void;
	onGripUp: (event: React.PointerEvent) => void;
}

function Tier({
	tier,
	dragging,
	dropping,
	beforeNodeId,
	onRowClick,
	onGripCancel,
	pending,
	rowErrors,
	selected,
	onSelect,
	saving,
	previousTier,
	nextTier,
	onComplete,
	onOpenTree,
	onPreview,
	onPreviewEnd,
	onStep,
	onGripDown,
	onGripMove,
	onGripUp,
}: TierProps)
{
	const free = tier.capacity - tier.items.length;
	return (
		<>
			{/*
			 * The separator carries data-tier too. It is sticky, so on a phone it
			 * covers the top of its own zone -- a drop aimed just below a tier name
			 * would otherwise land on nothing and be silently discarded.
			 */}
			<div className={`ladder-sep ${tier.state}${dropping ? " dropping" : ""}`} data-tier={tier.label}>
				<span className="tname">{tier.label}</span>
				<span className="gauge">
					{tier.items.length}/{tier.capacity}
				</span>
				<span className="verdict">{VERDICT[tier.state](tier)}</span>
				{tier.tier <= 2 ? <span className="goal">today&rsquo;s goals</span> : null}
			</div>
			<div
				className={`ladder-zone ${tier.state}${dropping ? " dropping" : ""}${beforeNodeId === "" ? " drop-end" : ""}`}
				data-tier={tier.label}
			>
				{tier.items.map((item, index) => (
					// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a row is a labelled group of controls with a Space-to-select focus stop; option/row roles cannot hold its buttons
					<div
						className={[
							"ladder-row",
							selected.has(item.id) ? "selected" : "",
							dragging === item.id || (dragging && selected.has(dragging) && selected.has(item.id))
								? "dragging"
								: "",
							pending.has(item.id) ? "pending" : "",
							index >= tier.capacity ? "excess" : "",
							beforeNodeId === item.id ? "drop-before" : "",
						]
							.filter(Boolean)
							.join(" ")}
						key={item.id}
						data-node-id={item.id}
						// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a fieldset would bring form semantics and UA styling to a list row
						role="group"
						aria-label={`${item.name}${selected.has(item.id) ? ", selected" : ""}`}
						tabIndex={saving ? -1 : 0}
						onKeyDown={(event) =>
						{
							if (event.target !== event.currentTarget || event.key !== " " || saving)
							{
								return;
							}
							event.preventDefault();
							onSelect(item.id, event.shiftKey, event.metaKey || event.ctrlKey);
						}}
						onClick={(event) =>
						{
							onRowClick(event, item.id);
						}}
						onPointerCancel={onGripCancel}
						onLostPointerCapture={onGripCancel}
						onPointerDown={(event) =>
						{
							onGripDown(event, item);
						}}
						onPointerMove={(event) =>
						{
							onGripMove(event, item.name);
						}}
						onPointerUp={onGripUp}
					>
						<span className="grip" role="presentation">
							&#10303;
						</span>
						<span className="rank">{index + 1}</span>
						<span className="txt">
							<span className="ladder-text">{item.name}</span>
							{item.descendantCount > 0 ? (
								<span
									className="ladder-child-count"
									aria-label={`${item.descendantCount} open ${item.descendantCount === 1 ? "item" : "items"} below`}
								>
									{item.descendantCount}
								</span>
							) : null}
							{item.hasChildren ? (
								<button
									className="ladder-tree-button"
									type="button"
									aria-label={`View tree for ${item.name}`}
									aria-haspopup="dialog"
									onClick={() =>
									{
										onOpenTree(item);
									}}
									onMouseEnter={(event) =>
									{
										onPreview(item, event.currentTarget.getBoundingClientRect());
									}}
									onFocus={(event) =>
									{
										onPreview(item, event.currentTarget.getBoundingClientRect());
									}}
									onMouseLeave={onPreviewEnd}
									onBlur={onPreviewEnd}
									onKeyDown={(event) =>
									{
										if (event.key === "Escape")
										{
											onPreviewEnd();
										}
									}}
								>
									Tree ▸
								</button>
							) : null}
							{rowErrors[item.id] ? (
								<span className="ladder-row-error" role="alert">
									{rowErrors[item.id]} — retry this row.
								</span>
							) : null}
						</span>
						<span className="step">
							<button
								aria-label={`Move to ${previousTier ?? "the tier above"}`}
								disabled={saving || pending.has(item.id) || !previousTier}
								onClick={() =>
								{
									if (previousTier)
									{
										onStep(
											item.id,
											previousTier,
											{
												step: "up",
											},
										);
									}
								}}
								type="button"
							>
								&#9650;
							</button>
							<button
								aria-label={`Move to ${nextTier ?? "the tier below"}`}
								disabled={saving || pending.has(item.id) || !nextTier}
								onClick={() =>
								{
									if (nextTier)
									{
										onStep(
											item.id,
											nextTier,
											{
												step: "down",
											},
										);
									}
								}}
								type="button"
							>
								&#9660;
							</button>
						</span>
						<button
							className="done"
							disabled={saving || pending.has(item.id)}
							onClick={() =>
							{
								onComplete(item.id);
							}}
							type="button"
						>
							Done
						</button>
					</div>
				))}
				{free > 0 ? (
					<div className="ladder-slot">
						{free} open {free === 1 ? "slot" : "slots"}
					</div>
				) : null}
			</div>
		</>
	);
}
