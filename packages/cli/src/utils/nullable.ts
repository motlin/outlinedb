/**
 * Widen a value whose library type claims it is always present but that can be
 * null at runtime, such as a Drizzle `one()` relation on non-null columns with no
 * matching row. A plain annotation would be narrowed away by the initializer.
 */
export function nullable<T>(value: T): T | null
{
	return value;
}
