export interface ArchiveGroup
{
	name: string;
	inputPaths: string[][];
	outputPaths: string[][];
}

export interface ArchiveConfig
{
	groups: ArchiveGroup[];
}

export type DataSource = "api" | "cache" | "auto";

export interface WorkflowyConfig
{
	archiveGroups?: ArchiveGroup[];
	dataSource?: DataSource;
}
