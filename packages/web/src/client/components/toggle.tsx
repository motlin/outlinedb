/** Upstream `WF.DomKit.Toggle` (`HY2`) without children or secondary text, byte-for-byte class templates. */
export function Toggle({
	on,
	className = "",
	disabled = false,
	onClick,
}: {
	on: boolean;
	className?: string;
	disabled?: boolean;
	onClick?: () => void;
})
{
	return (
		// oxlint-disable-next-line jsx-a11y/label-has-associated-control, jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- verbatim upstream Toggle markup; the menu row carries the text
		<label
			onClick={onClick}
			className={`toggle ${on ? "on" : "off"} inline-flex gap-m mobile:gap-l
        ${className}
        ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
		>
			<div
				className={`inline-flex w-[20px] h-[10px] p-2xs rounded-m mobile:w-[44px] mobile:h-[22px] mobile:rounded-[16px]
        ${on ? "bg-tint" : "bg-tertiary"}`}
			>
				<div
					className={`w-[10px] h-[10px] rounded-circle bg-white transition-transform duration-300
          mobile:w-[22px] mobile:h-[22px] ${on ? "translate-x-[10px] mobile:translate-x-[22px]" : ""}`}
				/>
			</div>
			<div className="inline-flex flex-col gap-xs justify-center flex-1" />
		</label>
	);
}
