import type { RowNode } from '../entities/rowNode';
import { _addGridCommonParams } from '../gridOptionsUtils';
import { InfiniteRowModel } from '../infiniteRowModel/infiniteRowModel';
import type { ServerSideGroupLevelState } from '../interfaces/IServerSideStore';
import type { IDatasource } from '../interfaces/iDatasource';
import type { RowModelType } from '../interfaces/iRowModel';
import type { IServerSideDatasource, IServerSideGetRowsParams } from '../interfaces/iServerSideDatasource';
import type { RefreshServerSideParams } from '../interfaces/iServerSideRowModel';

/**
 * Flat (non-grouped) server-side row model for `rowModelType: 'serverSide'`.
 *
 * Rows are loaded in blocks of `cacheBlockSize` through the infinite cache, with requests and responses
 * shaped like the Server-Side Row Model: `serverSideDatasource.getRows(params)` receives `params.request`
 * and answers with `params.success({ rowData, rowCount })` or `params.fail()`. Combined with `pagination`
 * the grid only requests the blocks covering the current page.
 */
export class ServerSidePaginationRowModel extends InfiniteRowModel {
    protected override readonly datasourceOption = 'serverSideDatasource';
    protected override readonly stubLoadingRows = true;

    /** Set by `refreshStore`; cleared once every block it reloads has loaded, firing `storeRefreshed`. */
    private refreshPending = false;

    public override postConstruct(): void {
        super.postConstruct();
        if (this.gos.get('rowModelType') !== this.getType()) {
            return;
        }
        this.addManagedEventListeners({ storeUpdated: () => this.checkRefreshComplete() });
    }

    public override getType(): RowModelType {
        return 'serverSide';
    }

    protected override getDatasourceOption(): IDatasource | undefined {
        const datasource = this.gos.get('serverSideDatasource');
        return datasource ? this.adaptDatasource(datasource) : undefined;
    }

    protected override getInitialRowCount(): number {
        return this.gos.get('serverSideInitialRowCount');
    }

    /** Translates the infinite cache's block requests into server-side datasource requests. */
    private adaptDatasource(datasource: IServerSideDatasource): IDatasource {
        return {
            getRows: ({ startRow, endRow, sortModel, filterModel, successCallback, failCallback }) => {
                const params = _addGridCommonParams<IServerSideGetRowsParams>(this.gos, {
                    request: {
                        startRow,
                        endRow,
                        rowGroupCols: [],
                        valueCols: [],
                        pivotCols: [],
                        pivotMode: false,
                        groupKeys: [],
                        filterModel,
                        sortModel,
                    },
                    parentNode: this.rootNode!,
                    needsGrandTotal: false,
                    success: ({ rowData, rowCount }) => successCallback(rowData, rowCount),
                    fail: failCallback,
                });
                datasource.getRows(params);
            },
            destroy: () => datasource.destroy?.(),
        };
    }

    /** With `purge`, rows are replaced by loading rows straight away; otherwise they stay until reloaded. */
    public refreshStore(params?: RefreshServerSideParams): void {
        this.refreshPending = true;
        if (params?.purge) {
            this.purgeCache();
        } else {
            this.refreshCache();
        }
    }

    private checkRefreshComplete(): void {
        if (!this.refreshPending) {
            return;
        }
        // a purge empties the cache before the visible blocks are requested again, so wait for those
        const blocks = this.infiniteCache?.getBlocksInOrder() ?? [];
        const stillLoading = blocks.some((block) => block.state === 'needsLoading' || block.state === 'loading');
        if (!blocks.length || stillLoading) {
            return;
        }
        this.refreshPending = false;
        // `route` is left undefined for the root level, which is the only level of flat data
        this.eventSvc.dispatchEvent({ type: 'storeRefreshed' });
    }

    public retryLoads(): void {
        this.infiniteCache?.retryLoads();
    }

    public getStoreState(): ServerSideGroupLevelState[] {
        const gos = this.gos;
        return [
            {
                route: [],
                rowCount: this.getRowCount(),
                lastRowIndexKnown: this.isLastRowIndexKnown(),
                maxBlocksInCache: gos.get('maxBlocksInCache'),
                cacheBlockSize: gos.get('cacheBlockSize'),
            },
        ];
    }

    public getBlockStates(): { [blockId: string]: any } {
        return this.beans.rowNodeBlockLoader?.getBlockState() ?? {};
    }

    /** Rows are filtered and sorted on the server, so the loaded order is already the display order. */
    public forEachNodeAfterFilterAndSort(callback: (node: RowNode, index: number) => void): void {
        this.forEachNode(callback);
    }
}
