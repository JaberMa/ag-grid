import type { _ServerSideRowModelGridApi } from '../api/gridApi';
import { SsrmInfiniteSharedApiModule } from '../api/sharedApiModule';
import { RowNodeBlockLoader } from '../infiniteRowModel/rowNodeBlockLoader';
import type { _ModuleWithApi, _ModuleWithoutApi } from '../interfaces/iModule';
import { PaginationModule } from '../pagination/paginationModule';
import { SharedRowSelectionModule } from '../selection/rowSelectionModule';
import { VERSION } from '../version';
import {
    getServerSideGroupLevelState,
    getServerSideSelectionState,
    refreshServerSide,
    retryServerSideLoads,
    setServerSideSelectionState,
} from './serverSidePaginationApi';
import { ServerSidePaginationRowModel } from './serverSidePaginationRowModel';
import { ServerSidePaginationSelectionService } from './serverSidePaginationSelectionService';
import { ServerSideLoadingCellRenderer } from './serverSideLoadingCellRenderer';

/**
 * @internal
 */
const ServerSidePaginationCoreModule: _ModuleWithoutApi = {
    moduleName: 'ServerSidePaginationCore',
    version: VERSION,
    rowModels: ['serverSide'],
    beans: [ServerSidePaginationRowModel, RowNodeBlockLoader, ServerSidePaginationSelectionService],
    userComponents: {
        agLoadingCellRenderer: ServerSideLoadingCellRenderer,
    },
    icons: {
        // loading row spinner
        groupLoading: 'loading',
    },
    dependsOn: [SharedRowSelectionModule],
};

/**
 * Community implementation of `rowModelType: 'serverSide'` for flat data, with pagination and row selection.
 * Rows are requested from `serverSideDatasource` one `cacheBlockSize` block at a time.
 * Do not register together with the enterprise `ServerSideRowModelModule`.
 *
 * @feature Server-Side Row Model
 */
export const ServerSidePaginationModule: _ModuleWithApi<
    Pick<
        _ServerSideRowModelGridApi<any>,
        | 'refreshServerSide'
        | 'retryServerSideLoads'
        | 'getServerSideGroupLevelState'
        | 'getServerSideSelectionState'
        | 'setServerSideSelectionState'
    >
> = {
    moduleName: 'ServerSidePagination',
    version: VERSION,
    apiFunctions: {
        refreshServerSide,
        retryServerSideLoads,
        getServerSideGroupLevelState,
        getServerSideSelectionState,
        setServerSideSelectionState,
    },
    dependsOn: [ServerSidePaginationCoreModule, SsrmInfiniteSharedApiModule, PaginationModule],
};
