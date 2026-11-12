import {z} from "zod";

const MirrorWithOriginalIdSchema = z.object(
	{
		originalId: z.string(),
		isMirrorRoot: z.literal(true),
	},
);

const MirrorWithMirrorRootIdsSchema = z.object(
	{
		mirrorRootIds: z.record(z.string(), z.literal(true)),
	},
);

const MirrorWithBacklinkMirrorRootIdsSchema = z.object(
	{
		backlinkMirrorRootIds: z.record(z.string(), z.literal(true)),
	},
);

const EmptyMirrorSchema = z.object({}).strict();

const MirrorSchema = z.union([
	MirrorWithOriginalIdSchema,
	MirrorWithMirrorRootIdsSchema,
	MirrorWithBacklinkMirrorRootIdsSchema,
	EmptyMirrorSchema,
]);

const BacklinkSchema = z
	.object(
		{
			sourceID: z.string(),
			targetID: z.string(),
		},
	)
	.strict();

const ChangesSchema = z
	.object(
		{
			ct: z
				.object(
					{
						by: z.number(),
					},
				)
				.strict()
				.optional(),
			cp: z
				.object(
					{
						by: z.number(),
					},
				)
				.strict()
				.optional(),
			mn: z.record(z.string(), z.string()).optional(),
		},
	)
	.strict();

const AiSchema = z
	.object(
		{
			inChat: z.boolean(),
		},
	)
	.strict();

const S3FileSchema = z
	.object(
		{
			isFile: z.boolean(),
			fileName: z.string(),
			fileType: z.string(),
			objectFolder: z.string().optional(),
			isAnimatedGIF: z.boolean().optional(),
			imageOriginalWidth: z.number().optional(),
			imageOriginalHeight: z.number().optional(),
			imageOriginalPixels: z.number().optional(),
			// Accepted-but-ignored: Workflowy emits this on deleted file attachments, but
			// no consumer reads it yet. Keep declared so S3FileSchema.strict() doesn't reject it.
			isDeleted: z.boolean().optional(),
		},
	)
	.strict();

const CalendarSchema = z
	.object(
		{
			root: z.boolean().optional(),
			level: z.string().optional(),
			levels: z.record(z.string(), z.boolean()).optional(),
			value: z.string().optional(),
			dateId: z.number().optional(),
			timestamp: z.number().optional(),
			found_dates: z.boolean().optional(),
			// Friendly day names: the "Yesterday, / Today, / Tomorrow," prefix on day titles.
			day_prefix: z.boolean().optional(),
		},
	)
	.strict();

const GcalIntegrationSchema = z
	.object(
		{
			etag: z.string().optional(),
			event_id: z.string().optional(),
			timestamp: z.number().optional(),
			is_all_day: z.boolean().optional(),
			calendar_id: z.string().optional(),
			mirror_date: z.string().optional(),
			attr_name: z.string().optional(),
		},
	)
	.strict();

const IntegrationsSchema = z
	.object(
		{
			gcal: GcalIntegrationSchema.optional(),
			provider: z.string().optional(),
			external_id: z.string().optional(),
		},
	)
	.strict();

const TableSchema = z
	.object(
		{
			headers: z.boolean().optional(),
			// Accepted-but-ignored, like `headers`: Workflowy emits this on table
			// nodes whose header row is hidden. Keep declared so TableSchema.strict()
			// doesn't reject backups that contain it.
			skipHeaders: z.boolean().optional(),
		},
	)
	.strict();

const VideoSchema = z
	.object(
		{
			duration: z.number().optional(),
		},
	)
	.strict();

const MetadataSchema = z
	.object(
		{
			layoutMode: z.string().optional(),
			isReferencesRoot: z.boolean().optional(),
			mirror: MirrorSchema.optional(),
			backlink: BacklinkSchema.optional(),
			originalId: z.string().optional(),
			isVirtualRoot: z.boolean().optional(),
			virtualRootIds: z.record(z.string(), z.literal(true)).optional(),
			changes: ChangesSchema.optional(),
			ai: AiSchema.optional(),
			s3File: S3FileSchema.optional(),
			calendar: CalendarSchema.optional(),
			// Accepted-but-ignored: backup files may include this field, but no
			// consumer reads it. Keep declared so MetadataSchema.strict() doesn't reject backups that contain it.
			numbered_start: z.number().optional(),
			restorableUniqueNode: z.boolean().optional(),
			integrations: IntegrationsSchema.optional(),
			// Accepted-but-ignored: Workflowy's "tables" feature emits this on nodes
			// rendered as tables, but no consumer reads it. Keep declared so
			// MetadataSchema.strict() doesn't reject backups that contain it.
			table: TableSchema.optional(),
			// Accepted-but-ignored: a video attachment carries its duration in seconds,
			// but no consumer reads it. Keep declared so MetadataSchema.strict() doesn't
			// reject backups that contain one — a single video anywhere in the tree
			// otherwise aborts the whole import.
			video: VideoSchema.optional(),
		},
	)
	.strict();

const BackupNodeSchema: z.ZodType<BackupNode> = z.object(
	{
		id: z.string(),
		nm: z.string().optional(),
		ct: z.number().optional(),
		lm: z.number().optional(),
		cp: z.number().optional(),
		no: z.string().optional(),
		metadata: MetadataSchema.default({}),
		ch: z.lazy(() => z.array(BackupNodeSchema)).optional(),
	},
);

export interface BackupNode
{
	id: string;
	nm?: string;
	ct?: number;
	lm?: number;
	cp?: number;
	no?: string;
	metadata: z.infer<typeof MetadataSchema>;
	ch?: BackupNode[];
}

export type NodeMetadata = z.infer<typeof MetadataSchema>;

const BackupFileSchema = z.array(BackupNodeSchema);

export {BacklinkSchema, BackupFileSchema, BackupNodeSchema, MetadataSchema, MirrorSchema};
