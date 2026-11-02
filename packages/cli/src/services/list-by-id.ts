import type {WorkflowyApiClient} from "@outlinedb/shared/api";
import {NodeTreeReader, systemFromToDate} from "@outlinedb/shared/cache";
import type {NodeTree} from "@outlinedb/shared/cache";
import type {CacheService} from "./cache.js";
import {logger} from "./logger.js";

export interface ListByIdOptions
{
	parentId: string | null;
	dataSource: "auto" | "api" | "cache";
	forceRefresh: boolean;
	depth?: number;
}

export interface ListByIdResult
{
	nodes: NodeTree[];
	fromApi: boolean;
	cacheInfo?:
	{
		age: number;
		sources: string[];
	};
}

export class ListByIdService
{
	constructor(
		private readonly cacheService: CacheService,
		private readonly apiClient: WorkflowyApiClient | null,
	)
	{
	}

	async listNodes(options: ListByIdOptions): Promise<ListByIdResult>
	{
		const {parentId, dataSource, forceRefresh, depth = 0} = options;

		let fromApi = false;
		if (dataSource === "api")
		{
			if (!this.apiClient)
			{
				throw new Error("API client not initialized. Set WORKFLOWY_API_KEY environment variable.");
			}
			await this.fetchAndStore(parentId, this.apiClient);
			fromApi = true;
		}
		else if (dataSource === "auto")
		{
			const hasCachedData = this.cacheService.getChildrenWithMergedData(parentId).length > 0;
			if ((forceRefresh || !hasCachedData) && this.apiClient)
			{
				try
				{
					await this.fetchAndStore(parentId, this.apiClient);
					fromApi = true;
				}
				catch (error)
				{
					logger.debug(
						"API request failed, falling back to cache",
						{
							err: error,
							parentId,
						},
					);
				}
			}
		}

		const nodes = await new NodeTreeReader(this.cacheService).readChildren(
			parentId,
			{
				depth,
			},
		);
		const cacheInfo =
			!fromApi && nodes.length > 0
				?
					{
						age: this.calculateCacheAge(nodes),
						sources: ["cache"],
					}
				: undefined;

		return {
			nodes,
			fromApi,
			cacheInfo,
		};
	}

	private async fetchAndStore(parentId: string | null, apiClient: WorkflowyApiClient): Promise<void>
	{
		const apiNodes = parentId ? await apiClient.getChildNodes(parentId) : await apiClient.getRootNodes();
		this.cacheService.storeApiResponse(apiNodes, parentId);
	}

	/**
	 * Calculate cache age in seconds from the oldest systemFrom timestamp.
	 */
	private calculateCacheAge(
		nodes:
		{
			systemFrom: string;
		}[],
	): number
	{
		const fetchTimes = nodes.map((n) => systemFromToDate(n.systemFrom).getTime());
		const oldestFetch = fetchTimes.length > 0 ? Math.min(...fetchTimes) : undefined;
		return oldestFetch !== undefined && oldestFetch !== 0 ? Math.floor((Date.now() - oldestFetch) / 1000) : 0;
	}
}
