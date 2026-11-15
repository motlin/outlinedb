const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `value` in base 62, at least `width` digits. */
function base62(value: bigint, width: number): string
{
	let digits = "";
	for (let rest = value; rest > 0n; rest /= 62n)
	{
		digits = DIGITS[Number(rest % 62n)] + digits;
	}
	return digits.padStart(width, "0");
}

/**
 * The fractional-indexing integer key of `n` ('a0' is 0, 'az' 61, 'b10' 62, 'Zz' -1), so keys sort like the integers.
 * Tests use it to seed sibling order from a plain number.
 */
export function integerOrderKey(n: number): string
{
	const value = BigInt(n);
	if (value >= 0n)
	{
		const digits = base62(value, 1);
		return String.fromCodePoint(96 + digits.length) + digits;
	}
	let width = 1;
	while (62n ** BigInt(width) < -value)
	{
		width++;
	}
	return String.fromCodePoint(91 - width) + base62(62n ** BigInt(width) + value, width);
}
