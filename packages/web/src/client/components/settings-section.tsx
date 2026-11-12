import {createContext, useContext, useEffect} from "react";
import type {ReactNode} from "react";

const HIGHLIGHT_STYLE = `
        @keyframes section-highlight {
          50% {
            background-color: var(--wf-background-tint);
          }
        }
      `;

/** Upstream `MX1`: how a section tells the dialog its title, for the Jump to list. */
export const SettingsSectionRegistry = createContext<(title: string) => () => void>(() => () =>
{
});

export interface SettingsSectionProps
{
	title: string;
	dangerous?: boolean;
	children?: ReactNode;
}

/** Upstream `el4`: a titled, divided block that registers itself for Jump to and can be highlighted. */
export function SettingsSection({title, dangerous = false, children}: SettingsSectionProps)
{
	const register = useContext(SettingsSectionRegistry);
	useEffect(() => register(title), [register, title]);
	return (
		<div>
			<style>{HIGHLIGHT_STYLE}</style>
			<div
				data-section-title={title}
				className={`
          flex flex-col gap-l
          data-[section-highlight]:animate-[section-highlight_0.6s_ease-in_2]
        `}
			>
				<div className="flex flex-col gap-l">
					<div
						className={`
              text-m font-medium
              ${dangerous ? "text-danger" : "text-primary"}`}
					>
						<span>{title}</span>
					</div>
					<div className="w-full border-t border-solid border-primary" />
				</div>
				{children}
			</div>
		</div>
	);
}
