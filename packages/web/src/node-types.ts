/**
 * The node wire shapes shared by the server ops that produce them and the client that consumes them. Each is inferred
 * from its output schema in `server/ops/schemas.ts` (or its op's module), so the client type cannot drift from what the ops answer.
 */

import type {z} from "zod";
import type {
	AncestorsResponseSchema,
	BacklinkCrumbSchema,
	BacklinkItemSchema,
	BacklinksResponseSchema,
	CalendarInfoSchema,
	CreatedIdsSchema,
	DetachMirrorResponseSchema,
	ExpansionChangesResponseSchema,
	ExportTreeItemSchema,
	ExportTreeResponseSchema,
	FoundDateItemSchema,
	FoundDatesResponseSchema,
	HomeResponseSchema,
	MirrorLocationSchema,
	MirrorsResponseSchema,
	NodeAttachmentSchema,
	NodeChangesResponseSchema,
	NodeChildrenResponseSchema,
	NodeVerifyResponseSchema,
	NodeEnvelopeSchema,
	NodeListSchema,
	NodeResponseSchema,
	OutlineViewListSchema,
	OutlineViewResponseSchema,
	SaveEffectsSchema,
	SubtreeItemSchema,
	SubtreeItemsResponseSchema,
	SwapMirrorOriginResponseSchema,
	TableMetadataSchema,
	UpdateNodeResponseSchema,
} from "./server/ops/schemas.js";
import type {AccountResponseSchema} from "./server/ops/account.js";
import type {AccountAiResponseSchema} from "./server/ops/account-ai.js";
import type {
	AppliedLayoutSchema,
	CalendarDayResponseSchema,
	CalendarDaysResponseSchema,
	CalendarDotsResponseSchema,
	CalendarEnsureResponseSchema,
	CalendarLayoutPreviewSchema,
	CalendarLayoutSchema,
	CalendarSettingsSchema,
	LayoutStepSchema,
} from "./server/ops/calendar.js";
import type {ChangesSchema} from "./server/ops/changes.js";
import type {CustomTreeResponseSchema} from "./server/ops/custom-tree.js";
import type {FeatureSetResponseSchema, FeaturesResponseSchema} from "./server/ops/features.js";
import type {LadderEventEnvelopeSchema, LadderFailureSchema, LaddersResponseSchema} from "./server/ops/ladder.js";
import type {PreferencesSchema} from "./server/ops/preferences.js";
import type {RelatedResponseSchema} from "./server/ops/related.js";
import type {HelperTagsSchema, LocationResponseSchema} from "./server/ops/search.js";
import type {StarsResponseSchema} from "./server/ops/stars.js";
import type {TagAutocompleteResponseSchema} from "./server/ops/tag-index.js";
import type {TagColorsResponseSchema} from "./server/ops/tags.js";

export type NodeAttachment = z.output<typeof NodeAttachmentSchema>;
export type NodeResponse = z.output<typeof NodeResponseSchema>;
export type NodeListResponse = z.output<typeof NodeListSchema>;
/** One node, as `GET /nodes/:id` and the single-node writes answer it. */
export type NodeEnvelope = z.output<typeof NodeEnvelopeSchema>;
export type NodeChildrenResponse = z.output<typeof NodeChildrenResponseSchema>;
export type NodeVerifyResponse = z.output<typeof NodeVerifyResponseSchema>;
export type AncestorsResponse = z.output<typeof AncestorsResponseSchema>;
export type CreatedIdsResponse = z.output<typeof CreatedIdsSchema>;
export type DetachMirrorResponse = z.output<typeof DetachMirrorResponseSchema>;
export type SwapMirrorOriginResponse = z.output<typeof SwapMirrorOriginResponseSchema>;
export type SubtreeItemsResponse = z.output<typeof SubtreeItemsResponseSchema>;
export type TableMetadata = z.output<typeof TableMetadataSchema>;
export type CalendarInfo = z.output<typeof CalendarInfoSchema>;
export type BacklinkCrumb = z.output<typeof BacklinkCrumbSchema>;
export type BacklinkItem = z.output<typeof BacklinkItemSchema>;
export type BacklinksResponse = z.output<typeof BacklinksResponseSchema>;
export type OutlineViewList = z.output<typeof OutlineViewListSchema>;
export type OutlineViewResponse = z.output<typeof OutlineViewResponseSchema>;
export type NodeChangesResponse = z.output<typeof NodeChangesResponseSchema>;
export type ExpansionChangesResponse = z.output<typeof ExpansionChangesResponseSchema>;
export type SaveEffects = z.output<typeof SaveEffectsSchema>;
export type UpdateNodeResponse = z.output<typeof UpdateNodeResponseSchema>;
export type FoundDateItem = z.output<typeof FoundDateItemSchema>;
export type FoundDatesResponse = z.output<typeof FoundDatesResponseSchema>;
export type MirrorLocation = z.output<typeof MirrorLocationSchema>;
export type MirrorsResponse = z.output<typeof MirrorsResponseSchema>;
export type ExportTreeItem = z.output<typeof ExportTreeItemSchema>;
export type ExportTreeResponse = z.output<typeof ExportTreeResponseSchema>;
export type SubtreeItem = z.output<typeof SubtreeItemSchema>;
export type HomeResponse = z.output<typeof HomeResponseSchema>;
/** A planned restructure step of `POST /api/v1/calendar/layout/preview`. */
export type CalendarLayoutStep = z.output<typeof LayoutStepSchema>;
/** What `POST /api/v1/calendar/layout/preview` plans. */
export type CalendarLayoutPreview = z.output<typeof CalendarLayoutPreviewSchema>;
/** What `PUT /api/v1/calendar/layout` and its undo report. */
export type AppliedCalendarLayout = z.output<typeof AppliedLayoutSchema>;
/** What the Calendar Layout dialog opens with: `GET /api/v1/calendar/layout`. */
export type CalendarLayout = z.output<typeof CalendarLayoutSchema>;
export type AccountResponse = z.output<typeof AccountResponseSchema>;
export type AccountAiResponse = z.output<typeof AccountAiResponseSchema>;
export type CustomTreeResponse = z.output<typeof CustomTreeResponseSchema>;
export type FeaturesResponse = z.output<typeof FeaturesResponseSchema>;
export type FeatureSetResponse = z.output<typeof FeatureSetResponseSchema>;
export type Preferences = z.output<typeof PreferencesSchema>;
export type TagColorsResponse = z.output<typeof TagColorsResponseSchema>;
export type TagAutocompleteResponse = z.output<typeof TagAutocompleteResponseSchema>;
export type StarsResponse = z.output<typeof StarsResponseSchema>;
export type CalendarSettings = z.output<typeof CalendarSettingsSchema>;
export type CalendarDayResponse = z.output<typeof CalendarDayResponseSchema>;
export type CalendarDaysResponse = z.output<typeof CalendarDaysResponseSchema>;
export type CalendarDotsResponse = z.output<typeof CalendarDotsResponseSchema>;
export type CalendarEnsureResponse = z.output<typeof CalendarEnsureResponseSchema>;
export type ChangesResponse = z.output<typeof ChangesSchema>;
export type LaddersResponse = z.output<typeof LaddersResponseSchema>;
export type LadderEventEnvelope = z.output<typeof LadderEventEnvelopeSchema>;
export type LadderFailure = z.output<typeof LadderFailureSchema>;
export type RelatedResponse = z.output<typeof RelatedResponseSchema>;
export type HelperTags = z.output<typeof HelperTagsSchema>;
export type LocationResponse = z.output<typeof LocationResponseSchema>;

/** The body an op answers with when it fails (`fail(status, {error})`). */
export interface OpErrorBody {
	error?: string;
}

/** One tree of a `POST /api/v1/nodes/trees` body. */
export interface BulkTree {
	name: string;
	note?: string | undefined;
	completed?: boolean | undefined;
	layoutMode?: string | undefined;
	numberedStart?: number | undefined;
	children?: BulkTree[] | undefined;
}
