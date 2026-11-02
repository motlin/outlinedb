/**
 * Account feature flags (upstream `WF.Features`). Once `useFeatures` has loaded the account's enabled
 * dict, that dict answers every `isFeatureOn`. Until then (first paint, or no account data at all) a
 * `localStorage["wf.features.<name>"] === "on"` override applies, then `DEFAULT_FEATURES`.
 */

import {DEFAULT_FEATURES} from "../feature-catalog.js";

export {DEFAULT_FEATURES};

/** The 20 visible codenames (upstream's Settings > Features rows). */
export type FeatureName =
	| "beta_redirect"
	| "open_links_in_desktop"
	| "dates"
	| "full_width_page"
	| "templates"
	| "bdl"
	| "keep_keyboard_on_scroll"
	| "rich_tags"
	| "always_visible_controls"
	| "update_notifications"
	| "conversations"
	| "dashboards"
	| "ai"
	| "present"
	| "nested_search"
	| "markdown_pasting"
	| "calendar_node"
	| "numbered_list"
	| "table"
	| "side_pane";

let accountFeatures: Readonly<Record<string, true>> | null = null;

/** Store the account's enabled dict (null forgets it); `useFeatures` calls this on every successful read. */
export function setAccountFeatures(features: Readonly<Record<string, true>> | null): void
{
	accountFeatures = features;
}

/** Whether the account's enabled dict has been loaded (so a once-per-load reader can cache its answer). */
export function accountFeaturesKnown(): boolean
{
	return accountFeatures !== null;
}

interface FeatureStorage
{
	getItem(key: string): string | null;
}

function browserStorage(): FeatureStorage | null
{
	try
	{
		return typeof localStorage === "undefined" ? null : localStorage;
	}
	catch
	{
		return null;
	}
}

export function isFeatureOn(name: FeatureName, storage: FeatureStorage | null = browserStorage()): boolean
{
	if (accountFeatures !== null)
	{
		return accountFeatures[name] === true;
	}
	try
	{
		if (storage?.getItem(`wf.features.${name}`) === "on")
		{
			return true;
		}
	}
	catch
	{
		// Blocked storage falls through to the defaults.
	}
	return DEFAULT_FEATURES[name] === true;
}

type FeatureWriter = (codename: string, on: boolean) => Promise<void>;

let featureWriter: FeatureWriter = async () => Promise.resolve();

/** The app installs the writer that POSTs a flag to the account (see `setFeature` in hooks/use-features). */
export function setFeatureWriter(writer: FeatureWriter): void
{
	featureWriter = writer;
}

/** Write a flag to the account through the installed writer. */
export async function writeFeature(codename: string, on: boolean): Promise<void>
{
	return featureWriter(codename, on);
}

/** The outline-store fields that mirror account flags, derived from the enabled dict. */
export function featureStoreState(enabled: Readonly<Record<string, true>>):
{
	fullWidthPage: boolean;
	alwaysVisibleControls: boolean;
}
{
	return {
		fullWidthPage: enabled.full_width_page === true,
		alwaysVisibleControls: enabled.always_visible_controls === true,
	};
}
