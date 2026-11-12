import type {AriaRole} from "react";

declare module "react"
{
	interface HTMLAttributes<T>
	{
		/** Upstream's row id attribute on every `.project` div. */
		projectid?: string | undefined;
	}
}

export type RowRole = AriaRole;
