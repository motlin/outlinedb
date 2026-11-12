/**
 * A decision page: a review agent stages questions under a slug, the user
 * answers them here one card at a time, and every change is saved as it
 * happens, so an interrupted walk leaves its partial answers on disk. The page
 * only records choices; the agent reads the answers back and does the writes.
 */

import {diffWordsWithSpace} from "diff";
import {useEffect, useMemo, useRef, useState} from "react";
import type {ReactNode} from "react";
import {useParams} from "react-router-dom";
import type {DecisionItem, DecisionPage, DecisionSubmitResult} from "../../server/decisions.js";
import {bodyTokens} from "../decision-tokens.js";
import "../decisions.css";
import {hideLoadingScreenOnce} from "../loading-screen.js";
import {readJson} from "../read-json.js";
import {fetchThroughRestarts} from "../restart-retry.js";
import type {FetchedText} from "../restart-retry.js";
import {useOutlineStore} from "../stores/outline.js";

const NOTE_DEBOUNCE_MS = 600;

type SaveStatus =
	|
	  {
			kind: "idle";
	  }
	|
	  {
			kind: "saving";
	  }
	|
	  {
			kind: "saved";
	  }
	|
	  {
			kind: "error";
			message: string;
	  };

interface ItemState
{
	choice: string | null;
	note: string;
	/** Whether the server holds an answer for this item. */
	answered: boolean;
	status: SaveStatus;
}

type SubmitState =
	|
	  {
			kind: "idle";
	  }
	|
	  {
			kind: "submitting";
	  }
	|
	  {
			kind: "submitted";
			at: string;
	  }
	|
	  {
			kind: "error";
			message: string;
	  };

/** The outcome of the most recent save, shown in the footer because the card that made it may be gone. */
type LastSave =
{
	card: number;
	error: string | null;
} | null;

type Group = DecisionPage["groups"][number];

/** One card in walk order: an item with the group it belongs to. */
interface Card
{
	group: Group;
	item: Group["items"][number];
}

async function errorOf(response: FetchedText): Promise<string>
{
	try
	{
		return (
			await readJson<
			{
				error: string;
			}>(new Response(response.text))
		).error;
	}
	catch
	{
		return `HTTP ${response.status}`;
	}
}

const STATUS_TEXT: Record<Exclude<SaveStatus["kind"], "error">, string> =
{
	idle: "",
	saving: "Saving…",
	saved: "Saved",
};

function statusText(status: SaveStatus): string
{
	return status.kind === "error" ? `Not saved: ${status.message}` : STATUS_TEXT[status.kind];
}

/** A submission time as the viewer's local clock time. */
function clockTime(iso: string): string
{
	return new Date(iso).toLocaleTimeString(
		[],
		{
			hour: "numeric",
			minute: "2-digit",
		},
	);
}

function messageOf(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}

/** The staged page, or the reason it could not be loaded. */
async function loadPage(
	url: string,
	signal: AbortSignal,
): Promise<
	|
	  {
			page: DecisionPage;
	  }
	|
	  {
			error: string;
	  }
>
{
	try
	{
		const response = await fetchThroughRestarts(
			url,
			{
				signal,
			},
		);
		return response.ok
			?
				{
					page: await readJson<DecisionPage>(new Response(response.text)),
				}
			:
				{
					error: await errorOf(response),
				};
	}
	catch (error)
	{
		return {
			error: messageOf(error),
		};
	}
}

function cardsOf(page: DecisionPage): Card[]
{
	return page.groups.flatMap((group) =>
		group.items.map((item) => (
		{
			group,
			item,
		})),
	);
}

function initialItems(page: DecisionPage): Record<string, ItemState>
{
	return Object.fromEntries(
		cardsOf(page).map(({item}) => [
			item.id,
			{
				choice: item.answer?.choice ?? null,
				note: item.answer?.note ?? "",
				answered: item.answer !== null,
				status:
				{
					kind: "idle",
				},
			},
		]),
	);
}

/**
 * The first unanswered card after `from`, wrapping around to the start, or
 * `from` itself when every other card is answered.
 */
function nextUnanswered(cards: Card[], items: Record<string, ItemState>, from: number): number
{
	for (let step = 1; step < cards.length; step++)
	{
		const index = (from + step) % cards.length;
		const card = cards[index];
		if (card !== undefined && items[card.item.id]?.answered !== true)
		{
			return index;
		}
	}
	return from;
}

/** Where a fresh load starts: the first unanswered card, or the first card when all are answered. */
function resumeIndex(cards: Card[], items: Record<string, ItemState>): number
{
	const index = cards.findIndex((card) => items[card.item.id]?.answered !== true);
	return Math.max(index, 0);
}

/** Whether a key press belongs to a text field rather than to the page's shortcuts. */
function isTyping(target: EventTarget | null): boolean
{
	if (!(target instanceof HTMLElement))
	{
		return false;
	}
	if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
	{
		return true;
	}
	return target instanceof HTMLInputElement && target.type !== "radio" && target.type !== "checkbox";
}

/** The `/decisions/:slug` route. */
export function DecisionsView()
{
	const {slug = ""} = useParams();
	return <DecisionPageView key={slug} slug={slug} />;
}

export function DecisionPageView({slug}: {slug: string})
{
	const base = `/api/v1/decisions/${encodeURIComponent(slug)}`;
	const [page, setPage] = useState<DecisionPage | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [items, setItems] = useState<Record<string, ItemState>>({});
	const [index, setIndex] = useState(0);
	// Mirrors `index` so a save that resolves later sees the card on screen now.
	const indexRef = useRef(0);
	const [lastSave, setLastSave] = useState<LastSave>(null);
	const [submit, setSubmit] = useState<SubmitState>(
		{
			kind: "idle",
		},
	);
	// The All done page, shown in place of the cards once every card is answered.
	const [done, setDone] = useState(false);
	const cards = useMemo(() => (page === null ? [] : cardsOf(page)), [page]);
	// Mirrors `items` so a debounced save sends the choice and note current when it fires.
	const itemsRef = useRef<Record<string, ItemState>>({});
	const noteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	// The latest render's key handler, so the window listener never sees stale state.
	const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});

	useEffect(() =>
	{
		indexRef.current = index;
	}, [index]);

	// Only the outline view dismisses the boot screen; this route never mounts it.
	useEffect(() =>
	{
		hideLoadingScreenOnce();
	}, []);

	useEffect(() =>
	{
		const controller = new AbortController();
		const timers = noteTimers.current;
		void (async () =>
		{
			const result = await loadPage(base, controller.signal);
			if (controller.signal.aborted)
			{
				return;
			}
			if ("error" in result)
			{
				setLoadError(result.error);
				return;
			}
			itemsRef.current = initialItems(result.page);
			setItems(itemsRef.current);
			setIndex(resumeIndex(cardsOf(result.page), itemsRef.current));
			setPage(result.page);
			const {submittedAt} = result.page;
			setSubmit(
				submittedAt === null
					?
						{
							kind: "idle",
						}
					:
						{
							kind: "submitted",
							at: submittedAt,
						},
			);
			setDone(submittedAt !== null && Object.values(itemsRef.current).every((state) => state.answered));
		})();
		return () =>
		{
			controller.abort();
			for (const timer of timers.values())
			{
				clearTimeout(timer);
			}
		};
	}, [base]);

	useEffect(() =>
	{
		function onKey(event: KeyboardEvent): void
		{
			onKeyRef.current(event);
		}
		window.addEventListener("keydown", onKey);
		return () =>
		{
			window.removeEventListener("keydown", onKey);
		};
	}, []);

	function update(id: string, patch: Partial<ItemState>): ItemState
	{
		const current = itemsRef.current[id];
		if (current === undefined)
		{
			throw new Error(`No decision item ${id}`);
		}
		const next =
		{
			...current,
			...patch,
		};
		itemsRef.current =
		{
			...itemsRef.current,
			[id]: next,
		};
		setItems(itemsRef.current);
		return next;
	}

	function cardNumber(id: string): number
	{
		return cards.findIndex((card) => card.item.id === id) + 1;
	}

	/** Saves the item's current choice and note; resolves whether the server kept them. */
	async function save(id: string): Promise<boolean>
	{
		const {choice, note} = update(
			id,
			{
				status:
				{
					kind: "saving",
				},
			},
		);
		let error: string;
		try
		{
			const response = await fetchThroughRestarts(
				`${base}/${encodeURIComponent(id)}`,
				{
					method: "PUT",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							choice,
							note,
						},
					),
				},
			);
			if (response.ok)
			{
				update(
					id,
					{
						answered: true,
						status:
						{
							kind: "saved",
						},
					},
				);
				setLastSave(
					{
						card: cardNumber(id),
						error: null,
					},
				);
				return true;
			}
			error = await errorOf(response);
		}
		catch (caught)
		{
			error = messageOf(caught);
		}
		update(
			id,
			{
				status:
				{
					kind: "error",
					message: error,
				},
			},
		);
		setLastSave(
			{
				card: cardNumber(id),
				error,
			},
		);
		return false;
	}

	async function submitPage(): Promise<void>
	{
		setSubmit(
			{
				kind: "submitting",
			},
		);
		try
		{
			const response = await fetchThroughRestarts(
				`${base}/submit`,
				{
					method: "POST",
				},
			);
			setSubmit(
				response.ok
					?
						{
							kind: "submitted",
							at: (await readJson<DecisionSubmitResult>(new Response(response.text))).submittedAt,
						}
					:
						{
							kind: "error",
							message: await errorOf(response),
						},
			);
		}
		catch (error)
		{
			setSubmit(
				{
					kind: "error",
					message: messageOf(error),
				},
			);
		}
	}

	/**
	 * Moves on to the next unanswered card, unless the user already left the card that was saved.
	 * Saving the last unanswered card submits the page and shows the All done page instead.
	 */
	function advanceFrom(id: string): void
	{
		const from = cardNumber(id) - 1;
		if (indexRef.current !== from)
		{
			return;
		}
		if (Object.values(itemsRef.current).every((state) => state.answered))
		{
			setDone(true);
			void submitPage();
			return;
		}
		setIndex(nextUnanswered(cards, itemsRef.current, from));
	}

	async function saveAndAdvance(id: string): Promise<void>
	{
		if (await save(id))
		{
			advanceFrom(id);
		}
	}

	function cancelNoteSave(id: string): void
	{
		clearTimeout(noteTimers.current.get(id));
		noteTimers.current.delete(id);
	}

	function choose(id: string, choice: string): void
	{
		cancelNoteSave(id);
		update(
			id,
			{
				choice,
			},
		);
		void saveAndAdvance(id);
	}

	function saveNoteAndNext(id: string): void
	{
		cancelNoteSave(id);
		void saveAndAdvance(id);
	}

	function editNote(id: string, note: string): void
	{
		cancelNoteSave(id);
		update(
			id,
			{
				note,
			},
		);
		noteTimers.current.set(
			id,
			setTimeout(() =>
			{
				noteTimers.current.delete(id);
				void save(id);
			}, NOTE_DEBOUNCE_MS),
		);
	}

	function goTo(target: number): void
	{
		setIndex(Math.min(Math.max(target, 0), cards.length - 1));
	}

	const current = cards[index];

	// Runs after every render so the window listener always acts on the card on screen.
	useEffect(() =>
	{
		onKeyRef.current = (event) =>
		{
			if (
				done ||
				current === undefined ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				isTyping(event.target)
			)
			{
				return;
			}
			if (event.key === "ArrowLeft" || event.key === "ArrowRight")
			{
				// A focused video seeks with the arrows.
				if (event.target instanceof HTMLMediaElement)
				{
					return;
				}
				// A focused radio would otherwise move its own selection, which saves an answer.
				event.preventDefault();
				goTo(index + (event.key === "ArrowLeft" ? -1 : 1));
				return;
			}
			const option = /^[1-9]$/u.test(event.key) ? current.item.options[Number(event.key) - 1] : undefined;
			if (option !== undefined)
			{
				event.preventDefault();
				choose(current.item.id, option.value);
			}
		};
	});

	if (loadError !== null)
	{
		return (
			<main className="decisions-page">
				<p className="decisions-error" role="alert">
					{loadError}
				</p>
			</main>
		);
	}
	if (page === null)
	{
		return <main className="decisions-page" aria-busy="true" />;
	}

	const currentState = current === undefined ? undefined : items[current.item.id];
	const answered = cards.filter((card) => items[card.item.id]?.answered === true).length;
	const allAnswered = answered === cards.length;

	return (
		<main className="decisions-page">
			<div className="decisions-wrap">
				<header className="decisions-head">
					<div className="decisions-head-text">
						<h1>{page.title}</h1>
						{page.intro === undefined ? null : <p className="decisions-intro">{page.intro}</p>}
					</div>
					<ThemeToggle />
				</header>
				<div className="decisions-progress-row">
					{done ? null : (
						<p className="decisions-position">
							Card {index + 1} of {cards.length}
						</p>
					)}
					<progress aria-label="Answered" className="decisions-bar" max={cards.length} value={answered} />
				</div>
				{done ? (
					<section aria-live="polite" className="decisions-done">
						<h2>All done</h2>
						<p>All {cards.length} cards answered.</p>
						<p>
							<SubmitLine submit={submit} />
						</p>
						<button
							className="decisions-nav-button"
							onClick={() =>
							{
								setDone(false);
								setIndex(0);
							}}
							type="button"
						>
							Review answers
						</button>
					</section>
				) : current === undefined || currentState === undefined ? null : (
					<section className="decisions-group" key={current.item.id}>
						<DecisionCard
							group={current.group}
							item={current.item}
							onChoose={(choice) =>
							{
								choose(current.item.id, choice);
							}}
							onNote={(note) =>
							{
								editNote(current.item.id, note);
							}}
							state={currentState}
						>
							<div className="decisions-nav">
								<button
									className="decisions-nav-button"
									disabled={index === 0}
									onClick={() =>
									{
										goTo(index - 1);
									}}
									type="button"
								>
									Back
								</button>
								<button
									className="decisions-nav-button decisions-note-next"
									onClick={() =>
									{
										saveNoteAndNext(current.item.id);
									}}
									type="button"
								>
									Save note &amp; next
								</button>
								<button
									className="decisions-nav-button"
									disabled={index === cards.length - 1}
									onClick={() =>
									{
										goTo(index + 1);
									}}
									type="button"
								>
									Next
								</button>
							</div>
						</DecisionCard>
					</section>
				)}
			</div>
			<footer className="decisions-footer">
				<span className="decisions-progress">
					{answered} of {cards.length} answered
				</span>
				<span aria-live="polite" className="decisions-submit-state">
					{allAnswered && submit.kind !== "submitted" ? (
						<span className="decisions-all-answered">All {cards.length} answered. Submit when ready.</span>
					) : null}
					{lastSave === null ? null : (
						<span className="decisions-last-save" data-error={lastSave.error !== null}>
							{lastSave.error === null
								? `Saved card ${lastSave.card}`
								: `Card ${lastSave.card} not saved: ${lastSave.error}`}
						</span>
					)}
					{submit.kind === "submitted" ? (
						<span className="decisions-submitted">{"Submitted. Tell Claude you're done."}</span>
					) : null}
					{submit.kind === "error" ? <span className="decisions-submit-error">{submit.message}</span> : null}
				</span>
				<button
					className="decisions-submit"
					data-ready={allAnswered}
					disabled={submit.kind === "submitting"}
					onClick={() =>
					{
						void submitPage();
					}}
					type="button"
				>
					Submit
				</button>
			</footer>
		</main>
	);
}

/** The All done page's submission line: in flight, when it landed, or why it failed. */
function SubmitLine({submit}: {submit: SubmitState})
{
	if (submit.kind === "submitted")
	{
		return (
			<>
				Submitted at <time dateTime={submit.at}>{clockTime(submit.at)}</time>. Tell Claude you&apos;re done.
			</>
		);
	}
	if (submit.kind === "error")
	{
		return <>Not submitted: {submit.message}. Use Submit below to retry.</>;
	}
	return <>Submitting…</>;
}

interface DecisionCardProps
{
	group: Group;
	item: DecisionItem;
	state: ItemState;
	onChoose: (choice: string) => void;
	onNote: (note: string) => void;
	/** The card's footer: the Back / Next row. */
	children: ReactNode;
}

function DecisionCard({group, item, state, onChoose, onNote, children}: DecisionCardProps)
{
	const noteId = `decision-note-${item.id}`;
	const titleId = `decision-title-${item.id}`;
	return (
		<article className="decisions-card" data-item-id={item.id} data-status={state.status.kind}>
			{/* What the card is about; wide screens set it beside the answer column. */}
			<div className="decisions-card-main">
				<p className="decisions-group-heading">
					{group.link === undefined ? (
						group.heading
					) : (
						<a href={group.link} rel="noopener noreferrer" target="_blank">
							{group.heading}
						</a>
					)}
				</p>
				<h2 className="decisions-card-title" id={titleId}>
					{item.title}
				</h2>
				{item.diff === undefined ? null : <DiffBlock after={item.diff.after} before={item.diff.before} />}
				{(item.images ?? []).length === 0 && (item.videos ?? []).length === 0 ? null : (
					<div className="decisions-images">
						{(item.images ?? []).map((image) =>
						{
							const url = imageUrl(image.src);
							return (
								<a
									href={url}
									key={image.src}
									rel="noopener noreferrer"
									target="_blank"
									title={image.alt}
								>
									<img
										alt={image.alt}
										className="decisions-image"
										decoding="async"
										loading="lazy"
										src={url}
									/>
								</a>
							);
						})}
						{(item.videos ?? []).map((video) => (
							// Staged clips are the user's own phone videos, which come with no caption track.
							// oxlint-disable-next-line jsx-a11y/media-has-caption
							<video
								className="decisions-video"
								controls
								key={video.src}
								playsInline
								poster={video.poster === undefined ? undefined : imageUrl(video.poster)}
								preload="metadata"
								src={mediaUrl(video.src)}
							/>
						))}
					</div>
				)}
				{item.body.length > 0 ? (
					<div className="decisions-body">
						{item.body.map((line, index) => (
							// Body lines are plain text that may repeat, so their position is their identity.
							// oxlint-disable-next-line react/no-array-index-key
							<p className="decisions-body-line" key={index}>
								<BodyLine line={line} />
							</p>
						))}
					</div>
				) : null}
				{item.links.length > 0 ? (
					<ul className="decisions-links">
						{item.links.map((link) => (
							<li key={link.href}>
								<a href={link.href} rel="noopener noreferrer" target="_blank" title={link.label}>
									<LinkIcon href={link.href} />
									<span>{link.label}</span>
								</a>
							</li>
						))}
					</ul>
				) : null}
			</div>
			<div className="decisions-card-side">
				<div aria-labelledby={titleId} className="decisions-options" role="radiogroup">
					{item.options.map((option, index) => (
						<label className="decisions-option" key={option.value}>
							<input
								checked={state.choice === option.value}
								name={`decision-${item.id}`}
								onChange={() =>
								{
									onChoose(option.value);
								}}
								type="radio"
								value={option.value}
							/>
							<span className="decisions-option-text">
								{index < 9 ? (
									<kbd aria-hidden="true" className="decisions-option-key">
										{index + 1}
									</kbd>
								) : null}
								<span className="decisions-option-label">{option.label}</span>
								{item.default === option.value ? (
									<span className="decisions-suggested">suggested</span>
								) : null}
								{option.description === undefined ? null : (
									<span className="decisions-option-description">{option.description}</span>
								)}
							</span>
						</label>
					))}
				</div>
				<label className="decisions-note-label" htmlFor={noteId}>
					Other / note (type it before picking an option to save both)
				</label>
				<textarea
					className="decisions-note"
					id={noteId}
					onChange={(event) =>
					{
						onNote(event.target.value);
					}}
					rows={2}
					value={state.note}
				/>
				<span aria-live="polite" className="decisions-status">
					{statusText(state.status)}
				</span>
				{children}
			</div>
		</article>
	);
}

/** A `src` path encoded one segment at a time. */
function encodePath(src: string): string
{
	return src.split("/").map(encodeURIComponent).join("/");
}

/** Where the server serves an item image. */
function imageUrl(src: string): string
{
	return `/api/v1/decisions/images/${encodePath(src)}`;
}

/** Where the server serves an item video, with the byte ranges players need to seek. */
function mediaUrl(src: string): string
{
	return `/api/v1/decisions/media/${encodePath(src)}`;
}

/** A body line as plain text, with its dates, durations and counts wrapped for color. */
function BodyLine({line}: {line: string})
{
	return bodyTokens(line).map((token, index) =>
		token.kind === null ? (
			token.text
		) : (
			// Tokens are positional slices of one line, so their position is their identity.
			// oxlint-disable-next-line react/no-array-index-key
			<span className="decisions-num" data-kind={token.kind} key={index}>
				{token.text}
			</span>
		),
	);
}

function isWorkflowyLink(href: string): boolean
{
	try
	{
		const {hostname} = new URL(href);
		return hostname === "workflowy.com" || hostname.endsWith(".workflowy.com");
	}
	catch
	{
		return false;
	}
}

const SVG_PROPS =
{
	"aria-hidden": true,
	fill: "none",
	height: 16,
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	strokeWidth: 2,
	viewBox: "0 0 24 24",
	width: 16,
} as const;

/** The app's own favicon for Workflowy links, a generic external-link glyph for every other host. */
function LinkIcon({href}: {href: string})
{
	if (isWorkflowyLink(href))
	{
		return (
			<img
				alt=""
				className="decisions-link-icon"
				data-icon="workflowy"
				height={16}
				src="/favicon.png"
				width={16}
			/>
		);
	}
	return (
		<svg className="decisions-link-icon" data-icon="external" {...SVG_PROPS}>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</svg>
	);
}

const THEME_CHOICES = [
	{
		theme: "default",
		label: "Light",
		icon: (
			<svg {...SVG_PROPS}>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
			</svg>
		),
	},
	{
		theme: "dark",
		label: "Dark",
		icon: (
			<svg {...SVG_PROPS}>
				<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
			</svg>
		),
	},
	{
		theme: "system",
		label: "System",
		icon: (
			<svg {...SVG_PROPS}>
				<rect height="14" rx="2" width="20" x="2" y="3" />
				<path d="M8 21h8M12 17v4" />
			</svg>
		),
	},
] as const;

/**
 * Light / Dark / System, through the app's own theme setting: the same storage key, the same
 * `data-theme` on the root, and the store's live listener for OS changes while on System.
 */
function ThemeToggle()
{
	const theme = useOutlineStore((state) => state.theme);
	const setTheme = useOutlineStore((state) => state.setTheme);
	return (
		<fieldset className="decisions-theme">
			<legend className="decisions-sr-only">Theme</legend>
			{THEME_CHOICES.map((choice) => (
				<button
					aria-label={`${choice.label} theme`}
					aria-pressed={theme === choice.theme}
					key={choice.theme}
					onClick={() =>
					{
						setTheme(choice.theme);
					}}
					title={choice.label}
					type="button"
				>
					{choice.icon}
				</button>
			))}
		</fieldset>
	);
}

interface DiffPart
{
	text: string;
	changed: boolean;
}

/** One side of a word diff: the text shared with the other side, plus the words only this side has, marked. */
function diffSide(before: string, after: string, side: "removed" | "added"): DiffPart[]
{
	const parts: DiffPart[] = [];
	for (const change of diffWordsWithSpace(before, after))
	{
		if (side === "removed" ? change.added : change.removed)
		{
			continue;
		}
		const changed = side === "removed" ? change.removed : change.added;
		const last = parts.at(-1);
		if (last?.changed === changed)
		{
			last.text += change.value;
		}
		else
		{
			parts.push(
				{
					text: change.value,
					changed,
				},
			);
		}
	}
	return parts;
}

/** A proposed rewrite rendered the way code review shows a changed line: `-` before, `+` after, changed words marked. */
function DiffBlock({before, after}: {before: string; after: string}): ReactNode
{
	return (
		<div className="decisions-diff">
			{(["removed", "added"] as const).map((side) => (
				<p className="decisions-diff-line" data-kind={side} key={side}>
					<span aria-hidden="true" className="decisions-diff-sign">
						{side === "removed" ? "-" : "+"}
					</span>
					<span className="decisions-diff-text">
						{diffSide(before, after, side).map((part, index) =>
							// Parts are positional slices of one line, so their position is their identity.
							// oxlint-disable-next-line react/no-array-index-key
							part.changed ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
						)}
					</span>
				</p>
			))}
		</div>
	);
}
