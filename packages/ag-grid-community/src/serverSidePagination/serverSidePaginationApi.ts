import type { BeanCollection } from '../context/context';
import type { ServerSideGroupLevelState } from '../interfaces/IServerSideStore';
import type { RefreshServerSideParams } from '../interfaces/iServerSideRowModel';
import type { IServerSideGroupSelectionState, IServerSideSelectionState } from '../interfaces/iServerSideSelection';
import type { ServerSidePaginationRowModel } from './serverSidePaginationRowModel';

function getRowModel(beans: BeanCollection): ServerSidePaginationRowModel | undefined {
    const rowModel = beans.rowModel;
    return rowModel.getType() === 'serverSide' ? (rowModel as ServerSidePaginationRowModel) : undefined;
}

export function refreshServerSide(beans: BeanCollection, params?: RefreshServerSideParams): void {
    getRowModel(beans)?.refreshStore(params);
}

export function retryServerSideLoads(beans: BeanCollection): void {
    getRowModel(beans)?.retryLoads();
}

export function getServerSideGroupLevelState(beans: BeanCollection): ServerSideGroupLevelState[] {
    return getRowModel(beans)?.getStoreState() ?? [];
}

export function getServerSideSelectionState(
    beans: BeanCollection
): IServerSideSelectionState | IServerSideGroupSelectionState | null {
    return (beans.selectionSvc?.getSelectionState() as IServerSideSelectionState | undefined) ?? null;
}

export function setServerSideSelectionState(
    beans: BeanCollection,
    state: IServerSideSelectionState | IServerSideGroupSelectionState
): void {
    beans.selectionSvc?.setSelectionState(state, 'api');
}
