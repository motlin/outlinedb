import {useState} from "react";
import {Button} from "./button.js";
import {FaIcon} from "./fa-icons.js";
import {IconButton} from "./icon-button.js";
import {LEVELS, MOVE_NODES_CONFIRM, capitalize, layoutWarningLevels} from "../calendar-layout-model.js";
import type {CalendarLayout} from "../../node-types.js";
import type {LayoutLevels} from "../calendar-layout-model.js";

interface CalendarLayoutViewProps
{
	layout: CalendarLayout;
	onCancel: () => void;
	/** Update Layout, after any confirm: the checked levels, with day always on. */
	onUpdate: (
		levels: LayoutLevels &
		{
			day: true;
		},
	) => Promise<void> | void;
	/** The header's Date format button (upstream opens Settings > Dates). */
	onDateFormat?: () => void;
	/** Upstream's confirm dialog; the browser's by default. */
	confirm?: (message: string) => boolean;
}

/** The browser's confirm, standing in for upstream's dialog. */
function browserConfirm(message: string): boolean
{
	return globalThis.confirm(message);
}

/** Upstream `W10` / `WF.DomKit.Checkbox` (`E24`). */
function Checkbox({
	name,
	text,
	checked,
	onChange,
}: {
	name: string;
	text: string;
	checked: boolean;
	onChange: () => void;
})
{
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup; the sr-only input is the keyboard path
		<div className="flex flex-col gap-xs text-base cursor-pointer  " onClick={onChange}>
			<div className="flex gap-m">
				<span className="inline-flex relative w-l h-l">
					<FaIcon
						icon={checked ? "fad:square-check" : "fal:square"}
						className="relative w-full h-full text-tertiary hover:text-tint [--fa-primary-color:var(--wf-text-on-color)] [--fa-secondary-color:var(--wf-text-tint)] [--fa-secondary-opacity:1]"
					/>
					<input type="checkbox" name={name} checked={checked} onChange={onChange} className="sr-only peer" />
				</span>
				{text}
			</div>
		</div>
	);
}

/** Upstream `E10`: the warning that turning these levels off deletes their custom text. */
function CustomTextWarning({levels}: {levels: readonly string[]})
{
	return (
		<span className="mt-s flex gap-m text-s px-m py-s border-2 border-solid border-warning rounded-s leading-s">
			<FaIcon icon="fal:triangle-exclamation" />
			<p>
				Some <strong>{levels.map(capitalize).join(", ")}</strong> nodes include custom text or notes that will
				be deleted if turned off.
			</p>
		</span>
	);
}

/**
 * Upstream `P10`, the strip picker's Calendar Layout view: a checkbox per level above day, a warning when an
 * unchecked level has custom text, and Cancel / Update Layout. Update Layout first confirms moving dated nodes when
 * the root holds any, then hands the levels (day always on) to `onUpdate`, showing a spinner until it settles.
 */
export function CalendarLayoutView({
	layout,
	onCancel,
	onUpdate,
	onDateFormat,
	confirm = browserConfirm,
}: CalendarLayoutViewProps)
{
	const [checked, setChecked] = useState<LayoutLevels>(layout.levels);
	const [loading, setLoading] = useState(false);
	const warning = layoutWarningLevels(layout.customLevels, checked);
	const update = async () =>
	{
		if (layout.needsConfirm && !confirm(MOVE_NODES_CONFIRM))
		{
			return;
		}
		setLoading(true);
		await Promise.resolve(
			onUpdate(
				{
					...checked,
					day: true,
				},
			),
		).finally(() =>
		{
			setLoading(false);
		});
	};
	return (
		<div className="flex flex-col gap-xs p-ml text-primary desktop:w-[220px]" data-calendar-layout>
			<header className="flex justify-between gap-l items-center">
				<h1 className="font-medium">Calendar Layout</h1>
				<IconButton size="md" shape="square" tooltip="Date format" onClick={onDateFormat}>
					<FaIcon icon="fal:calendar-lines-pen" size="sm" />
				</IconButton>
			</header>
			<p className="text-tertiary text-s leading-xs mb-xs">Choose which calendar levels are shown.</p>
			<p className="text-tertiary text-s leading-xs mb-m">
				Note: Bullets with date tags will be automatically organized.
			</p>
			<div className="flex flex-col gap-ml">
				{LEVELS.map((level) => (
					<Checkbox
						key={level}
						name={`calendar-layout-${level}`}
						text={capitalize(level)}
						checked={checked[level] === true}
						onChange={() =>
						{
							setChecked((previous) => (
							{
								...previous,
								[level]: previous[level] !== true,
							}));
						}}
					/>
				))}
				{warning.length > 0 && <CustomTextWarning levels={warning} />}
			</div>
			<div className="flex flex-row gap-m mt-l justify-end">
				<Button variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="primary"
					loading={loading}
					onClick={() =>
					{
						void update();
					}}
				>
					Update Layout
				</Button>
			</div>
		</div>
	);
}
