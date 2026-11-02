import {z} from "zod";

/** The subset of `node get --json` output that eval setup steps read. */
const NodeJsonSchema = z.looseObject(
	{
		id: z.string().optional(),
		name: z.string().optional(),
		linkTargets: z
			.array(
				z.looseObject(
					{
						id: z.string(),
					},
				),
			)
			.optional(),
		get children()
		{
			return z.array(NodeJsonSchema).optional();
		},
	},
);

export const parseNodeJson = (text: string) => NodeJsonSchema.parse(JSON.parse(text));
