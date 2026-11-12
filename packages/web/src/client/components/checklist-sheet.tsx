/**
 * The `checklist` layout of a decision page: every item on one printable sheet as a checkbox row.
 * Checking a row saves its answer as `did` at once, unchecking saves `skip`, and Submit records
 * `submittedAt` the way the card layout does. The sheet prints on one Letter page.
 */

import {useRef, useState} from "react";
import type {DecisionPage, DecisionSubmitResult} from "../../server/decisions.js";
import "../checklist.css";
import {errorOf, messageOf} from "../decision-fetch.js";
import {readJson} from "../read-json.js";
import {fetchThroughRestarts} from "../restart-retry.js";

const CHECKED = "did";
const UNCHECKED = "skip";

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
	  }
	|
	  {
			kind: "error";
			message: string;
	  };

/** The last save that failed, named by the row's title. */
type SaveError =
{
	title: string;
	message: string;
} | null;

function initialChecked(page: DecisionPage): Record<string, boolean>
{
	return Object.fromEntries(
		page.groups.flatMap((group) => group.items.map((item) => [item.id, item.answer?.choice === CHECKED])),
	);
}

export function ChecklistSheet({page, base}: {page: DecisionPage; base: string})
{
	const [checked, setChecked] = useState(() => initialChecked(page));
	// Mirrors `checked` so a failed save reverts only the row it was for.
	const checkedRef = useRef(checked);
	const [saveError, setSaveError] = useState<SaveError>(null);
	const [submit, setSubmit] = useState<SubmitState>(
		page.submittedAt === null
			?
				{
					kind: "idle",
				}
			:
				{
					kind: "submitted",
				},
	);

	function set(id: string, value: boolean): void
	{
		checkedRef.current =
		{
			...checkedRef.current,
			[id]: value,
		};
		setChecked(checkedRef.current);
	}

	async function toggle(id: string, title: string): Promise<void>
	{
		const value = checkedRef.current[id] !== true;
		set(id, value);
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
							choice: value ? CHECKED : UNCHECKED,
							note: "",
						},
					),
				},
			);
			if (response.ok)
			{
				setSaveError(null);
				return;
			}
			error = await errorOf(response);
		}
		catch (caught)
		{
			error = messageOf(caught);
		}
		set(id, !value);
		setSaveError(
			{
				title,
				message: error,
			},
		);
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
			if (response.ok)
			{
				await readJson<DecisionSubmitResult>(new Response(response.text));
				setSubmit(
					{
						kind: "submitted",
					},
				);
			}
			else
			{
				setSubmit(
					{
						kind: "error",
						message: await errorOf(response),
					},
				);
			}
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

	// Each row's reference number: its position on the whole sheet, counting from 1.
	const numbers = new Map(
		page.groups.flatMap((group) => group.items).map((item, index) => [item.id, index + 1] as const),
	);
	const count = numbers.size;

	return (
		<main className="checklist-page">
			<div className="checklist-sheet">
				<header className="checklist-head">
					<h1>{page.title}</h1>
					<span className="checklist-count">{count === 1 ? "1 item" : `${count} items`}</span>
				</header>
				{page.intro === undefined ? null : <p className="checklist-hint">{page.intro}</p>}
				{page.groups.map((group) => (
					<section className="checklist-section" key={group.heading}>
						<h2>{group.heading}</h2>
						<ul>
							{group.items.map((item) =>
							{
								const subtitle = item.body[0];
								return (
									<li key={item.id}>
										<label
											className="checklist-row"
											data-checked={checked[item.id] === true}
											data-item-id={item.id}
										>
											<input
												checked={checked[item.id] === true}
												className="checklist-input"
												name={`checklist-${item.id}`}
												onChange={() =>
												{
													void toggle(item.id, item.title);
												}}
												type="checkbox"
											/>
											<span aria-hidden="true" className="checklist-box" />
											<span className="checklist-text">
												<span className="checklist-title">{item.title}</span>
												<span className="checklist-number">{numbers.get(item.id)}</span>
												{subtitle === undefined ? null : (
													<span className="checklist-subtitle">{subtitle}</span>
												)}
											</span>
										</label>
									</li>
								);
							})}
						</ul>
					</section>
				))}
				<footer className="checklist-notes">
					<span>Notes</span>
					<span className="checklist-notes-line" />
				</footer>
				<div className="checklist-actions">
					<span aria-live="polite" className="checklist-status">
						{saveError === null ? null : (
							<span className="checklist-error">
								{saveError.title} not saved: {saveError.message}
							</span>
						)}
						{submit.kind === "submitted" ? (
							<span className="checklist-submitted">{"Submitted. Tell Claude you're done."}</span>
						) : null}
						{submit.kind === "error" ? (
							<span className="checklist-error">Not submitted: {submit.message}</span>
						) : null}
					</span>
					<button
						className="checklist-submit"
						disabled={submit.kind === "submitting"}
						onClick={() =>
						{
							void submitPage();
						}}
						type="button"
					>
						Submit
					</button>
				</div>
			</div>
		</main>
	);
}
