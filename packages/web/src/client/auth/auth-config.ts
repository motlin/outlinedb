import {useQuery} from "@tanstack/react-query";
import {z} from "zod";

/**
 * `GET /api/auth-config`: the Worker's sign-in settings, or `{hosted: false}` from the Node host, which has no sign-in.
 * No op serves it, so there is no op schema to infer from; the body is parsed here instead.
 */
const authConfigSchema = z.discriminatedUnion("hosted", [
	z.object(
		{
			hosted: z.literal(true),
			turnstileSiteKey: z.string().nullable(),
			providers: z.object(
				{
					google: z.boolean(),
					magicLink: z.boolean(),
				},
			),
			signupMode: z.enum(["closed", "invite", "open"]),
		},
	),
	z.object(
		{
			hosted: z.literal(false),
		},
	),
]);

async function fetchAuthConfig()
{
	const response = await fetch("/api/auth-config");
	if (!response.ok)
	{
		throw new Error(`Failed to load the sign-in settings: ${response.status}`);
	}
	return authConfigSchema.parse(await response.json());
}

/** The sign-in settings, read once per page: they change only with a deploy. */
export function useAuthConfig()
{
	return useQuery(
		{
			queryKey: ["auth-config"],
			queryFn: fetchAuthConfig,
			staleTime: Number.POSITIVE_INFINITY,
		},
	);
}
