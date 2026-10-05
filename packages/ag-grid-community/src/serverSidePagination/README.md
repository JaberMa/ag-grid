# Server-Side Pagination (community)

`ServerSidePaginationModule` adds `rowModelType: 'serverSide'` to `ag-grid-community`. The grid asks your server for one block of rows at a time and shows them one page at a time. The options, datasource and API follow AG Grid's enterprise [SSRM pagination](https://www.ag-grid.com/react-data-grid/server-side-model-pagination/), for flat (non-grouped) data.

## Setup

This module only exists in this fork. Build and use the fork's `ag-grid-community` package, not the one from npm.

Register the module alongside the community modules:

```ts
import { AllCommunityModule, ModuleRegistry, ServerSidePaginationModule } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule, ServerSidePaginationModule]);
```

- `AllCommunityModule` does **not** include it; register it explicitly.
- It already includes `PaginationModule` and row selection for this row model.
- Do **not** register it together with the enterprise `ServerSideRowModelModule`: both provide `rowModelType: 'serverSide'`.

## Quick start (React)

```tsx
import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, IServerSideDatasource } from 'ag-grid-community';

interface Athlete {
    id: string;
    name: string;
    age: number;
}

export function AthleteGrid() {
    const columnDefs = useMemo<ColDef<Athlete>[]>(
        () => [{ field: 'name', filter: 'agTextColumnFilter' }, { field: 'age' }],
        []
    );

    // Keep the datasource stable: giving the grid a new object reloads every row.
    const datasource = useMemo<IServerSideDatasource<Athlete>>(
        () => ({
            getRows: (params) => {
                fetch('/api/athletes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(params.request),
                })
                    .then((res) => res.json())
                    .then(({ rows, totalCount }) => params.success({ rowData: rows, rowCount: totalCount }))
                    .catch(() => params.fail());
            },
        }),
        []
    );

    return (
        <div style={{ height: 600 }}>
            <AgGridReact<Athlete>
                columnDefs={columnDefs}
                rowModelType="serverSide"
                serverSideDatasource={datasource}
                pagination={true}
                paginationPageSize={20}
                paginationPageSizeSelector={[20, 50, 100]}
                cacheBlockSize={20}
                getRowId={(params) => params.data.id}
            />
        </div>
    );
}
```

## The datasource

The grid calls `getRows(params)` for each block of rows it needs.

### `params.request`

| Field | Description |
| --- | --- |
| `startRow` | Index of the first row requested. |
| `endRow` | Index after the last row requested (`endRow - startRow === cacheBlockSize`). |
| `sortModel` | Current sort, e.g. `[{ colId: 'age', sort: 'desc' }]`. Empty when unsorted. |
| `filterModel` | Current column filters, keyed by column id. `{}` when there are no filters. |
| `rowGroupCols`, `valueCols`, `pivotCols`, `groupKeys` | Always empty (no grouping or pivoting). |
| `pivotMode` | Always `false`. |

`params.request` is plain data. Send it to your server as JSON.

### Responding

- **Success:** call `params.success({ rowData, rowCount })`.
  - `rowData`: the rows from `startRow` to `endRow`, or fewer if that is the end of the data.
  - `rowCount`: the **total** number of rows matching the current filters. The pagination panel uses it to show the page count.
- **Unknown total:** omit `rowCount` (or pass `undefined`). The grid keeps offering a next page until a response includes `rowCount`. Send it once you reach the last block.
- **Failure:** call `params.fail()`. The affected rows show `ERR` until you call `api.retryServerSideLoads()`.

You may respond asynchronously; the grid ignores responses for requests it no longer needs, such as after a sort change.

### Server side

Your endpoint applies the filters and sort, then returns the requested slice and the total count. For example with Express and SQL:

```js
app.post('/api/athletes', async (req, res) => {
    const { startRow, endRow, sortModel, filterModel } = req.body;
    const where = buildWhere(filterModel); // your mapping of AG Grid filter models to SQL
    const orderBy = sortModel.map((s) => `${s.colId} ${s.sort}`).join(', ') || 'id';

    const rows = await db.query(
        `SELECT * FROM athletes ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...where.params, endRow - startRow, startRow]
    );
    const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM athletes ${where.sql}`, where.params);

    res.json({ rows, totalCount: total });
});
```

Validate `colId` values against your known columns before putting them into SQL.

## Grid options

| Option | Default | Description |
| --- | --- | --- |
| `rowModelType` | | Set to `'serverSide'`. |
| `serverSideDatasource` | | The datasource above. Setting a new one (e.g. `api.setGridOption('serverSideDatasource', ds)`) reloads all rows. |
| `pagination` | `false` | Show rows one page at a time. |
| `paginationPageSize` | `100` | Rows per page. |
| `paginationPageSizeSelector` | | Page sizes the user can pick, or `false` to hide the picker. |
| `paginationAutoPageSize` | `false` | Fit the page size to the grid's height. |
| `cacheBlockSize` | `100` | Rows per request. |
| `serverSideInitialRowCount` | `1` | Rows assumed to exist before the first response. |
| `maxBlocksInCache` | no limit | Blocks kept in memory; older ones are dropped and reloaded when revisited. |
| `maxConcurrentDatasourceRequests` | `2` | Requests allowed in flight at once. |
| `blockLoadDebounceMillis` | `0` | Wait before requesting a block, e.g. while paging quickly. |
| `getRowId` | | Recommended. Row ids keep selection stable across sorting, filtering and refreshes. |
| `suppressServerSideFullWidthLoadingRow` | `false` | Show skeleton cells instead of a full-width loading row. |

### Choosing `cacheBlockSize`

- **Equal to `paginationPageSize`:** one request per page. This is the simplest choice.
- **Smaller than the page size:** several requests fill one page, e.g. 20 rows per page with blocks of 10 means two requests per page.
- **Larger than the page size:** one request serves several pages, e.g. blocks of 100 cover five 20-row pages.

The grid only requests the blocks for the page being shown. When the user changes page, sort or filter, it requests what the new view needs.

## Loading and errors

- Rows whose block has not arrived yet show a full-width row with a spinner and "Loading...".
- With `suppressServerSideFullWidthLoadingRow: true`, each cell shows a skeleton placeholder instead.
- If the datasource calls `params.fail()`, those rows show `ERR`. `api.retryServerSideLoads()` requests every failed block again.

## Refreshing data

```ts
// Reload the loaded blocks, keeping the current rows on screen until new data arrives
api.refreshServerSide();

// Drop the loaded rows straight away (loading rows appear), then reload
api.refreshServerSide({ purge: true });
```

The `storeRefreshed` event fires once every reloaded block has arrived:

```tsx
<AgGridReact onStoreRefreshed={() => console.log('refresh finished')} /* ... */ />
```

It does not fire if a reload fails.

Changing sort or filters reloads from the first page automatically; you do not need to refresh.

## Row selection

Enable it with the normal `rowSelection` option:

```tsx
<AgGridReact rowSelection={{ mode: 'multiRow' }} getRowId={(params) => params.data.id} /* ... */ />
```

Most rows are never loaded, so selection is kept as a rule rather than a list of rows:

```ts
{ selectAll: boolean, toggledNodes: string[] }
```

- `selectAll: false`: only the rows listed in `toggledNodes` are selected.
- `selectAll: true`: every row is selected **except** those in `toggledNodes`, including rows on pages that have not loaded yet.

```ts
api.selectAll(); // { selectAll: true, toggledNodes: [] }
api.getRowNode('25')?.setSelected(false); // { selectAll: true, toggledNodes: ['25'] }

api.getServerSideSelectionState(); // read the rule, e.g. to send to your server
api.setServerSideSelectionState({ selectAll: false, toggledNodes: ['1', '30'] });

api.deselectAll();
```

- `api.selectAll('currentPage')` / `api.deselectAll('currentPage')` affect only the rows on the current page.
- `api.getSelectedNodes()` and `api.getSelectedRows()` return only **loaded** selected rows. Use `getServerSideSelectionState()` when the user may have selected all rows.
- The `selectionChanged` event includes the rule as `event.serverSideState`.
- `toggledNodes` holds row ids. Without `getRowId`, row ids are row indexes, and selection is cleared whenever the sort or filters change.

## API reference

| Method | Description |
| --- | --- |
| `refreshServerSide(params?)` | Reload rows; `{ purge: true }` shows loading rows while reloading. |
| `retryServerSideLoads()` | Request failed blocks again. |
| `getServerSideGroupLevelState()` | Returns one entry describing the rows: `rowCount`, `lastRowIndexKnown`, `cacheBlockSize`, `maxBlocksInCache`. |
| `getServerSideSelectionState()` | The selection rule `{ selectAll, toggledNodes }`. |
| `setServerSideSelectionState(state)` | Replace the selection rule. |
| `setRowCount(count, lastRowIndexKnown?)` | Override the total row count. |
| `isLastRowIndexKnown()` | Whether the server has reported the total row count. |
| `getCacheBlockState()` | The state of each block (loading, loaded, failed), for debugging. |
| `pagination*` methods | The usual pagination API, e.g. `paginationGoToPage`, `paginationGetTotalPages`. |

## Not supported

Compared with the enterprise Server-Side Row Model, this module does not support:

- row grouping, tree data, pivoting and aggregation;
- `paginateChildRows`;
- master / detail;
- server-side transactions (`applyServerSideTransaction`, `applyServerSideRowData`);
- group selection (`groupSelects`).
