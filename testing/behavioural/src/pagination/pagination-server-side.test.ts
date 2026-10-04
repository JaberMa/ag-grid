import { waitFor } from '@testing-library/dom';
import { ALL_SEVERITIES, GridRows, TestGridsManager } from 'ag-test-utils';

import type {
    GridApi,
    GridOptions,
    IServerSideDatasource,
    IRowNode,
    IServerSideGetRowsParams,
    IServerSideGetRowsRequest,
} from 'ag-grid-community';
import { ServerSidePaginationModule, enableDevValidations, getGridElement } from 'ag-grid-community';

interface Row {
    id: string;
    name: string;
    value: number;
}

const ROWS: Row[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `Row ${i}`, value: i }));

/** In-memory server recording every request; sorts by `value` and returns the total row count. */
function createServer(rows: Row[] = ROWS) {
    const requests: IServerSideGetRowsRequest[] = [];
    let failuresLeft = 0;

    const datasource: IServerSideDatasource<Row> = {
        getRows: (params) => {
            const { request } = params;
            requests.push(request);
            if (failuresLeft > 0) {
                failuresLeft--;
                params.fail();
                return;
            }
            const sort = request.sortModel[0];
            const sorted = sort ? [...rows].sort((a, b) => (a.value - b.value) * (sort.sort === 'desc' ? -1 : 1)) : rows;
            // copies, as a real server response would be: later edits to `rows` only reach the grid on reload
            const rowData = sorted.slice(request.startRow, request.endRow).map((row) => ({ ...row }));
            params.success({ rowData, rowCount: rows.length });
        },
    };

    return {
        datasource,
        requests,
        ranges: () => requests.map(({ startRow, endRow }) => [startRow, endRow]),
        failNext: (count: number) => (failuresLeft = count),
    };
}

function rowNames(from: number, to: number) {
    return Array.from({ length: to - from }, (_, i) => `Row ${from + i}`);
}

/** The rows on the current page, read through the public api. */
function pageNodes(api: GridApi<Row>) {
    const pageSize = api.paginationGetPageSize();
    const start = api.paginationGetCurrentPage() * pageSize;
    const end = Math.min(start + pageSize, api.getDisplayedRowCount());
    const nodes: IRowNode<Row>[] = [];
    for (let i = start; i < end; i++) {
        nodes.push(api.getDisplayedRowAtIndex(i)!);
    }
    return nodes;
}

function pageRowNames(api: GridApi<Row>) {
    return pageNodes(api).map((node) => node.data?.name);
}

describe('Server-side pagination (community)', () => {
    const gridsManager = new TestGridsManager({
        modules: [ServerSidePaginationModule],
    });

    function createGrid(datasource: IServerSideDatasource<Row>, options: Partial<GridOptions<Row>> = {}) {
        return gridsManager.createGrid<Row>('myGrid', {
            columnDefs: [{ field: 'name' }, { field: 'value' }],
            rowModelType: 'serverSide',
            serverSideDatasource: datasource,
            pagination: true,
            paginationPageSize: 20,
            paginationPageSizeSelector: false,
            cacheBlockSize: 10,
            getRowId: (params) => params.data.id,
            ...options,
        });
    }

    beforeEach(() => {
        gridsManager.reset();
        enableDevValidations({ throwOn: ALL_SEVERITIES });
    });

    afterEach(() => {
        gridsManager.reset();
    });

    test('requests only the blocks covering the first page, with the server-side request shape', async () => {
        const server = createServer();
        const api = createGrid(server.datasource);

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        expect(server.ranges()).toEqual([
            [0, 10],
            [10, 20],
        ]);
        expect(server.requests[0]).toEqual({
            startRow: 0,
            endRow: 10,
            rowGroupCols: [],
            valueCols: [],
            pivotCols: [],
            pivotMode: false,
            groupKeys: [],
            filterModel: {},
            sortModel: [],
        });
        expect(api.paginationGetTotalPages()).toBe(5);
        expect(api.paginationGetRowCount()).toBe(100);
        expect(api.paginationIsLastPageFound()).toBe(true);
    });

    test('changing page requests the blocks of the new page', async () => {
        const server = createServer();
        const api = createGrid(server.datasource);
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        api.paginationGoToPage(3);

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(60, 80)));
        expect(server.ranges()).toEqual([
            [0, 10],
            [10, 20],
            [60, 70],
            [70, 80],
        ]);
    });

    test('a block size larger than the page size serves several pages from one request', async () => {
        const server = createServer();
        const api = createGrid(server.datasource, { cacheBlockSize: 100 });
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        api.paginationGoToNextPage();

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(20, 40)));
        expect(server.ranges()).toEqual([[0, 100]]);
    });

    test('sorting reloads from the server with the sort model', async () => {
        const server = createServer();
        const api = createGrid(server.datasource);
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        api.applyColumnState({ state: [{ colId: 'value', sort: 'desc' }] });

        await waitFor(() => expect(pageRowNames(api)[0]).toBe('Row 99'));
        expect(server.requests.at(-1)?.sortModel).toEqual([{ colId: 'value', sort: 'desc', type: 'default' }]);
        expect(api.paginationGetCurrentPage()).toBe(0);
    });

    test('rowCount can be omitted until the last block is reached', async () => {
        const rows = ROWS.slice(0, 25);
        const datasource: IServerSideDatasource<Row> = {
            getRows: ({ request, success }) => {
                const rowData = rows.slice(request.startRow, request.endRow);
                const isLastBlock = request.endRow! >= rows.length;
                success({ rowData, rowCount: isLastBlock ? rows.length : undefined });
            },
        };
        const api = createGrid(datasource);

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));
        expect(api.paginationIsLastPageFound()).toBe(false);

        api.paginationGoToNextPage();

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(20, 25)));
        expect(api.paginationIsLastPageFound()).toBe(true);
        expect(api.paginationGetTotalPages()).toBe(2);
        // rows rendered before their block loaded are swapped for new nodes, which must stay valid leaf rows
        await new GridRows(api, 'all rows loaded').check(`
            [no root row]
            ├── LEAF id:0 name:"Row 0" value:0
            ├── LEAF id:1 name:"Row 1" value:1
            ├── LEAF id:2 name:"Row 2" value:2
            ├── LEAF id:3 name:"Row 3" value:3
            ├── LEAF id:4 name:"Row 4" value:4
            ├── LEAF id:5 name:"Row 5" value:5
            ├── LEAF id:6 name:"Row 6" value:6
            ├── LEAF id:7 name:"Row 7" value:7
            ├── LEAF id:8 name:"Row 8" value:8
            ├── LEAF id:9 name:"Row 9" value:9
            ├── LEAF id:10 name:"Row 10" value:10
            ├── LEAF id:11 name:"Row 11" value:11
            ├── LEAF id:12 name:"Row 12" value:12
            ├── LEAF id:13 name:"Row 13" value:13
            ├── LEAF id:14 name:"Row 14" value:14
            ├── LEAF id:15 name:"Row 15" value:15
            ├── LEAF id:16 name:"Row 16" value:16
            ├── LEAF id:17 name:"Row 17" value:17
            ├── LEAF id:18 name:"Row 18" value:18
            ├── LEAF id:19 name:"Row 19" value:19
            ├── LEAF id:20 name:"Row 20" value:20
            ├── LEAF id:21 name:"Row 21" value:21
            ├── LEAF id:22 name:"Row 22" value:22
            ├── LEAF id:23 name:"Row 23" value:23
            └── LEAF id:24 name:"Row 24" value:24
        `);
    });

    test('retryServerSideLoads re-requests blocks whose load failed', async () => {
        const server = createServer();
        server.failNext(1);
        const api = createGrid(server.datasource);
        await waitFor(() => expect(server.requests).toHaveLength(1));
        // the row count is unknown until a block loads, so only the initial (empty) row is shown
        expect(pageRowNames(api)).toEqual([undefined]);

        api.retryServerSideLoads();

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));
        expect(server.ranges()).toEqual([
            [0, 10],
            [0, 10],
            [10, 20],
        ]);
    });

    test.each([false, true])('refreshServerSide({ purge: %s }) reloads the page from the server', async (purge) => {
        const rows = ROWS.map((row) => ({ ...row }));
        const server = createServer(rows);
        const api = createGrid(server.datasource);
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        rows[0].name = 'Updated';
        api.refreshServerSide({ purge });

        await waitFor(() =>
            expect(server.ranges().slice(2)).toEqual([
                [0, 10],
                [10, 20],
            ])
        );
        await waitFor(() => expect(pageRowNames(api)).toEqual(['Updated', ...rowNames(1, 20)]));
    });

    test('setting a new serverSideDatasource reloads from it', async () => {
        const first = createServer();
        const api = createGrid(first.datasource);
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        const second = createServer(ROWS.slice(0, 5));
        api.setGridOption('serverSideDatasource', second.datasource);

        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 5)));
        expect(api.paginationGetTotalPages()).toBe(1);
        expect(second.ranges()).toEqual([[0, 10]]);
    });

    test.each([false, true])('storeRefreshed fires once refreshServerSide({ purge: %s }) has reloaded', async (purge) => {
        const rows = ROWS.map((row) => ({ ...row }));
        const server = createServer(rows);
        const api = createGrid(server.datasource);
        await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

        let rowsWhenRefreshed: (string | undefined)[] | undefined;
        const onStoreRefreshed = vitest.fn(() => (rowsWhenRefreshed = pageRowNames(api)));
        api.addEventListener('storeRefreshed', onStoreRefreshed);

        rows[0].name = 'Updated';
        api.refreshServerSide({ purge });

        await waitFor(() => expect(onStoreRefreshed).toHaveBeenCalledTimes(1));
        expect(rowsWhenRefreshed).toEqual(['Updated', ...rowNames(1, 20)]);
    });

    describe('loading rows', () => {
        /** Server that holds every request until the test answers it. */
        function createManualServer() {
            const pending: IServerSideGetRowsParams<Row>[] = [];
            const datasource: IServerSideDatasource<Row> = { getRows: (params) => pending.push(params) };
            return {
                datasource,
                pending,
                respond: () => {
                    for (const params of pending.splice(0)) {
                        const { startRow, endRow } = params.request;
                        params.success({ rowData: ROWS.slice(startRow, endRow), rowCount: ROWS.length });
                    }
                },
                fail: () => {
                    for (const params of pending.splice(0)) {
                        params.fail();
                    }
                },
            };
        }

        const loadingRowTexts = (api: GridApi) =>
            Array.from(getGridElement(api)!.querySelectorAll('.ag-loading'), (el) => el.textContent);

        test('a row shows a full-width loading row until its block loads', async () => {
            const server = createManualServer();
            const api = createGrid(server.datasource);

            await waitFor(() => expect(loadingRowTexts(api)).toEqual(['Loading...']));
            expect(api.getDisplayedRowAtIndex(0)?.stub).toBe(true);

            await waitFor(() => expect(server.pending).toHaveLength(1));
            server.respond();

            await waitFor(() => expect(pageRowNames(api)[0]).toBe('Row 0'));
            expect(api.getDisplayedRowAtIndex(0)?.stub).toBe(false);

            // now the row count is known, the rest of the page (the second block) is loading
            await waitFor(() => expect(loadingRowTexts(api)).toEqual(Array(10).fill('Loading...')));
            await waitFor(() => expect(server.pending).toHaveLength(1));
            server.respond();

            await waitFor(() => expect(loadingRowTexts(api)).toEqual([]));
            expect(pageRowNames(api)).toEqual(rowNames(0, 20));
        });

        test('suppressServerSideFullWidthLoadingRow shows skeleton cells instead', async () => {
            const server = createManualServer();
            const api = createGrid(server.datasource, { suppressServerSideFullWidthLoadingRow: true });

            // one skeleton per column of the single row the grid knows about
            await waitFor(() =>
                expect(getGridElement(api)!.querySelectorAll('.ag-cell .ag-skeleton-effect')).toHaveLength(2)
            );
            expect(loadingRowTexts(api)).toEqual([]);
        });

        test('a failed load shows an error row until retried', async () => {
            const server = createManualServer();
            const api = createGrid(server.datasource);
            await waitFor(() => expect(server.pending).toHaveLength(1));

            server.fail();

            await waitFor(() => expect(loadingRowTexts(api)).toEqual(['ERR']));
            expect(api.getDisplayedRowAtIndex(0)?.failedLoad).toBe(true);

            api.retryServerSideLoads();

            await waitFor(() => expect(loadingRowTexts(api)).toEqual(['Loading...']));
            await waitFor(() => expect(server.pending).toHaveLength(1));
            server.respond();
            await waitFor(() => expect(pageRowNames(api)[0]).toBe('Row 0'));
        });
    });

    describe('row selection', () => {
        const selectedIdsOnPage = (api: GridApi<Row>) =>
            pageNodes(api)
                .filter((node) => node.isSelected())
                .map((node) => node.id);

        function createSelectionGrid() {
            const server = createServer();
            const api = createGrid(server.datasource, { rowSelection: { mode: 'multiRow' } });
            return { server, api };
        }

        test('selectAll also selects rows that have not loaded yet', async () => {
            const { api } = createSelectionGrid();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

            api.selectAll();

            expect(api.getServerSideSelectionState()).toEqual({ selectAll: true, toggledNodes: [] });
            expect(api.getSelectedNodes()).toHaveLength(20);

            api.paginationGoToNextPage();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(20, 40)));
            expect(api.getRowNode('25')?.isSelected()).toBe(true);

            api.getRowNode('25')!.setSelected(false);

            expect(api.getServerSideSelectionState()).toEqual({ selectAll: true, toggledNodes: ['25'] });
            expect(api.getRowNode('25')?.isSelected()).toBe(false);
        });

        test('setServerSideSelectionState applies to loaded rows and to rows loaded later', async () => {
            const { api } = createSelectionGrid();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

            const onSelectionChanged = vitest.fn();
            api.addEventListener('selectionChanged', onSelectionChanged);
            api.setServerSideSelectionState({ selectAll: false, toggledNodes: ['1', '30'] });

            expect(selectedIdsOnPage(api)).toEqual(['1']);
            // grid events reach api listeners asynchronously
            await waitFor(() =>
                expect(onSelectionChanged).toHaveBeenCalledWith(
                    expect.objectContaining({ serverSideState: { selectAll: false, toggledNodes: ['1', '30'] } })
                )
            );

            api.paginationGoToNextPage();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(20, 40)));
            expect(selectedIdsOnPage(api)).toEqual(['30']);
        });

        test('deselectAll clears the selection, including rows not loaded', async () => {
            const { api } = createSelectionGrid();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));
            api.selectAll();

            api.deselectAll();

            expect(api.getServerSideSelectionState()).toEqual({ selectAll: false, toggledNodes: [] });
            expect(api.getSelectedNodes()).toEqual([]);
            api.paginationGoToNextPage();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(20, 40)));
            expect(selectedIdsOnPage(api)).toEqual([]);
        });

        test('selecting a row keeps others selected in multiRow mode', async () => {
            const { api } = createSelectionGrid();
            await waitFor(() => expect(pageRowNames(api)).toEqual(rowNames(0, 20)));

            api.getRowNode('2')!.setSelected(true);
            api.getRowNode('5')!.setSelected(true);

            expect(api.getServerSideSelectionState()).toEqual({ selectAll: false, toggledNodes: ['2', '5'] });
            expect(api.getSelectedRows().map((row) => row.name)).toEqual(['Row 2', 'Row 5']);
        });
    });
});
