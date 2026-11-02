import type {ReactNode} from "react";

/** Upstream `WF.GuiSettings.css` (`gX1`): the class table every Settings row is built from. */
const SETTINGS_CSS =
{
	stack_v: "flex-1 flex flex-col gap-ml",
	stack_h: "flex flex-row gap-m",
	description: "min-w-0 flex-1 flex flex-col justify-center gap-xs",
	label: "text-base leading-s text-primary",
	hint: "text-s    leading-xs text-tertiary",
	control: `
            shrink-0
            [&_.menu>div:first-child>div]:!h-2xl
            [&>.toggle]:!gap-0
            [&>.toggle>div:first-child]:!box-border
            [&>.toggle>div:first-child]:!h-[21px]
            [&>.toggle>div:first-child]:!w-[36px]
            [&>.toggle>div:first-child]:!p-[3px]
            [&>.toggle>div:first-child]:!rounded-pill
            [&>.toggle>div:first-child>div]:!h-[15px]
            [&>.toggle>div:first-child>div]:!w-[15px]
            [&>.toggle.on>div:first-child>div]:!translate-x-[15px]
            [&>.toggle>div:last-child]:hidden
          `,
} as const;

/** The body of a section whose rows are a plain list. */
export function SectionBody({children}: {children?: ReactNode})
{
	return <div className={`${SETTINGS_CSS.stack_v} !gap-xl`}>{children}</div>;
}

function FeatureBadge({title}: {title: "LABS" | "DEV"})
{
	const style =
		title === "LABS"
			?
				{
					color: "var(--wf-gray-0)",
					background: "var(--wf-blue-300)",
				}
			:
				{
					color: "var(--wf-gray-800)",
					background: "var(--wf-gray-300)",
				};
	return (
		<div className="relative -top-2xs ml-s p-xs inline-block text-2xs align-baseline rounded-s" style={style}>
			{title}
		</div>
	);
}

export interface ControlRowProps
{
	label: string;
	badge?: "LABS" | "DEV";
	hint?: string;
	children?: ReactNode;
}

/** A label (with an optional badge and hint) on the left, its control on the right. */
export function ControlRow({label, badge, hint, children}: ControlRowProps)
{
	return (
		<div className={`${SETTINGS_CSS.stack_h} w-full min-h-2xl items-center justify-between !gap-l overflow-hidden`}>
			<div className={SETTINGS_CSS.description}>
				<div className={SETTINGS_CSS.label}>
					{label}
					{badge === undefined ? null : <FeatureBadge title={badge} />}
				</div>
				{hint === undefined ? null : <div className={SETTINGS_CSS.hint}>{hint}</div>}
			</div>
			<div className={SETTINGS_CSS.control}>{children}</div>
		</div>
	);
}

export interface ActionBlockProps
{
	label: string;
	hint?: string;
	danger?: boolean;
	children?: ReactNode;
}

/** A label and hint above a button (or other action). */
export function ActionBlock({label, hint, danger = false, children}: ActionBlockProps)
{
	return (
		<div className="flex flex-col items-start justify-center gap-xs">
			<div className={SETTINGS_CSS.label}>{label}</div>
			{hint === undefined ? null : <div className={SETTINGS_CSS.hint}>{hint}</div>}
			{danger ? (
				<div className="pt-s">
					<div>{children}</div>
				</div>
			) : (
				<div className="pt-xs">{children}</div>
			)}
		</div>
	);
}

export function SettingsButton({
	children,
	danger = false,
	onClick,
}: {
	children?: ReactNode;
	danger?: boolean;
	onClick?: () => void;
})
{
	return (
		<button
			tabIndex={0}
			className={danger ? " hover:no-underline button danger" : " hover:no-underline button"}
			onClick={onClick}
			type="button"
		>
			<span className="">{children}</span>
		</button>
	);
}

/** A read-only value box, as upstream shows the account's email. */
export function ReadOnlyField({label, value}: {label: string; value: string})
{
	return (
		<div className="flex flex-col gap-xs">
			<div className={SETTINGS_CSS.label}>{label}</div>
			<span className="box-border h-2xl min-w-0 flex-1 truncate rounded-xs border border-solid border-primary px-m py-xs text-s leading-xs text-primary">
				{value}
			</span>
		</div>
	);
}
