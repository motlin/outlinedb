import type {z} from "zod";
import {accountGet} from "./account.js";
import {calendarOps} from "./calendar.js";
import {changesList} from "./changes.js";
import {customTreeGet} from "./custom-tree.js";
import {expansionGet, expansionLeftBarGet, expansionLeftBarPatch, expansionPatch} from "./expansion.js";
import {filesSignedUrl} from "./files.js";
import {featuresGet, featuresSet} from "./features.js";
import {ladderOps} from "./ladder.js";
import {
	homeGet,
	nodesAncestors,
	nodesBacklinks,
	nodesChanges,
	nodesChildren,
	nodesExportTree,
	nodesFoundDates,
	nodesGet,
	nodesList,
	nodesMirrors,
	nodesSubtreeIds,
	nodesVerify,
	nodesView,
} from "./nodes.js";
import {nodesDetachMirror, nodesMirror, nodesSwapMirrorOrigin} from "./nodes-mirror.js";
import {
	nodesComplete,
	nodesCreate,
	nodesDelete,
	nodesRestore,
	nodesSetHome,
	nodesUncomplete,
	nodesUpdate,
} from "./nodes-write.js";
import {nodesDuplicate, nodesMove, nodesMoveOne, nodesTrees} from "./nodes-tree.js";
import {preferencesGet, preferencesPatch} from "./preferences.js";
import {relatedFind} from "./related.js";
import {searchHelpers, searchLocations, searchSwitcher, searchText, searchTree} from "./search.js";
import {starsList, starsOrder, starsRemove, starsRename, starsSet} from "./stars.js";
import {tagIndexAutocomplete} from "./tag-index.js";
import {tagsClear, tagsList, tagsSet} from "./tags.js";
import type {Json, OpDefinition, OpResult} from "./define.js";

/** The operation registry; routers move into it one at a time. */
export const Ops = {
	"account.get": accountGet,
	...calendarOps,
	"changes.list": changesList,
	"customTree.get": customTreeGet,
	"expansion.get": expansionGet,
	"expansion.leftBarGet": expansionLeftBarGet,
	"expansion.leftBarPatch": expansionLeftBarPatch,
	"expansion.patch": expansionPatch,
	"files.signedUrl": filesSignedUrl,
	"features.get": featuresGet,
	"features.set": featuresSet,
	"home.get": homeGet,
	...ladderOps,
	"nodes.ancestors": nodesAncestors,
	"nodes.backlinks": nodesBacklinks,
	"nodes.changes": nodesChanges,
	"nodes.children": nodesChildren,
	"nodes.duplicate": nodesDuplicate,
	"nodes.exportTree": nodesExportTree,
	"nodes.foundDates": nodesFoundDates,
	"nodes.get": nodesGet,
	"nodes.list": nodesList,
	"nodes.verify": nodesVerify,
	"nodes.complete": nodesComplete,
	"nodes.create": nodesCreate,
	"nodes.delete": nodesDelete,
	"nodes.restore": nodesRestore,
	"nodes.setHome": nodesSetHome,
	"nodes.uncomplete": nodesUncomplete,
	"nodes.update": nodesUpdate,
	"nodes.detachMirror": nodesDetachMirror,
	"nodes.mirror": nodesMirror,
	"nodes.mirrors": nodesMirrors,
	"nodes.move": nodesMove,
	"nodes.moveOne": nodesMoveOne,
	"nodes.subtreeIds": nodesSubtreeIds,
	"nodes.swapMirrorOrigin": nodesSwapMirrorOrigin,
	"nodes.trees": nodesTrees,
	"nodes.view": nodesView,
	"preferences.get": preferencesGet,
	"preferences.patch": preferencesPatch,
	"related.find": relatedFind,
	"search.helpers": searchHelpers,
	"search.locations": searchLocations,
	"search.switcher": searchSwitcher,
	"search.text": searchText,
	"search.tree": searchTree,
	"stars.list": starsList,
	"stars.order": starsOrder,
	"stars.remove": starsRemove,
	"stars.rename": starsRename,
	"stars.set": starsSet,
	"tagIndex.autocomplete": tagIndexAutocomplete,
	"tags.clear": tagsClear,
	"tags.list": tagsList,
	"tags.set": tagsSet,
} satisfies Record<string, OpDefinition<z.ZodType, Json>>;

export type OpRegistry = typeof Ops;
export type OpName = keyof OpRegistry;
export type OpInput<K extends OpName> = z.input<OpRegistry[K]["input"]>;
export type OpOutput<K extends OpName> =
	OpRegistry[K] extends OpDefinition<z.ZodType, infer T>
		? OpResult<T> extends OpResult<infer V>
			? V
			: never
		: never;
