import {create} from "zustand";

/** The link a banner carries (upstream's `a.undelete`): running it keeps the banner open. */
export interface BannerAction
{
	label: string;
	run: () => void;
}

interface Banner
{
	kind: "info" | "warn";
	/** An optional bold first line, followed by a line break. */
	title?: string;
	text: string;
	action?: BannerAction;
}

interface BannerState
{
	banner: Banner | null;
}

/** Upstream `WF.GuiBanner`: one banner at a time, with no timeout; the next banner replaces it. */
export const useBannerStore = create<BannerState>(() => (
{
	banner: null,
}));

export function showBanner(
	text: string,
	options:
	{
		kind: "info" | "warn";
		title?: string;
		action?: BannerAction;
	},
): void
{
	useBannerStore.setState(
		{
			banner:
			{
				kind: options.kind,
				text,
				...(options.title === undefined
					? {}
					:
						{
							title: options.title,
						}),
				...(options.action === undefined
					? {}
					:
						{
							action: options.action,
						}),
			},
		},
	);
}

export function hideBanner(): void
{
	useBannerStore.setState(
		{
			banner: null,
		},
	);
}

export function bannerEscapeAction({open, inSearchBox}: {open: boolean; inSearchBox: boolean}): "hide" | "ignore"
{
	return open && !inSearchBox ? "hide" : "ignore";
}
