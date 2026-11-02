declare module "chrono-node-v1"
{
	export interface ParsedComponents
	{
		knownValues: Record<string, number>;
		impliedValues: Record<string, number>;
		get(component: string): number;
		assign(component: string, value: number): void;
		imply(component: string, value: number): void;
		isCertain(component: string): boolean;
		date(): Date;
		clone(): ParsedComponents;
	}

	export interface ParsedResult
	{
		index: number;
		text: string;
		tags: Record<string, boolean>;
		start: ParsedComponents;
		end?: ParsedComponents | null | undefined;
		clone(): ParsedResult;
		date(): Date;
	}

	export class Refiner
	{
		refine: (text: string, results: ParsedResult[], options?: unknown) => ParsedResult[];
	}

	export interface ChronoOption
	{
		parsers: unknown[];
		refiners: (Refiner &
		{
			mergeResult?: unknown;
			isAbleToMerge?: unknown;
		})[];
	}

	export class Chrono
	{
		constructor(option?: ChronoOption);
		parsers: unknown[];
		refiners: (Refiner &
		{
			mergeResult?: unknown;
			isAbleToMerge?: unknown;
		})[];
		parse(
			text: string,
			refDate?: Date,
			options?:
			{
				forwardDate?: boolean;
			},
		): ParsedResult[];
	}

	type OptionFactory = (() => Partial<ChronoOption>) &
	{
		casual?: () => Partial<ChronoOption>;
	};

	export interface ChronoOptions
	{
		mergeOptions(options: (Partial<ChronoOption> | (() => Partial<ChronoOption>))[]): ChronoOption;
		commonPostProcessing: () => Partial<ChronoOption>;
		en:
		{
			casual: () => Partial<ChronoOption>;
		};
		de: (config: {strict: boolean}) => Partial<ChronoOption>;
		es:
		{
			casual: () => Partial<ChronoOption>;
		};
		fr:
		{
			casual: () => Partial<ChronoOption>;
		};
		ja:
		{
			casual: () => Partial<ChronoOption>;
		};
		zh: OptionFactory;
	}

	const chrono:
	{
		Chrono: typeof Chrono;
		Refiner: typeof Refiner;
		options: ChronoOptions;
	};
	export default chrono;
}
