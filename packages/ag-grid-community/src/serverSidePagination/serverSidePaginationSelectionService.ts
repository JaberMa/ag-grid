import type { NamedBean } from '../context/bean';
import type { AgColumn } from '../entities/agColumn';
import type { RowSelectionMode, SelectAllMode } from '../entities/gridOptions';
import type { RowNode } from '../entities/rowNode';
import type { SelectionEventSourceType } from '../events';
import {
    _getRowSelectionMode,
    _isMultiRowSelection,
    _isRowSelection,
    _isUsingNewRowSelectionAPI,
} from '../gridOptionsUtils';
import type { ISelectionService, ISetNodesSelectedParams } from '../interfaces/iSelectionService';
import type { ServerSideRowGroupSelectionState, ServerSideRowSelectionState } from '../interfaces/selectionState';
import { _isManualPinnedRow } from '../pinnedRowModel/pinnedRowUtils';
import { BaseSelectionService } from '../selection/baseSelectionService';

/**
 * Row selection for the flat server-side row model.
 *
 * Most rows are never loaded, so selection is held as a rule rather than as row nodes: when `selectAll`
 * is true every row is selected except `toggledNodes`, otherwise only `toggledNodes` are selected. Rows
 * pick up their state from the rule as their block loads. This is the `{ selectAll, toggledNodes }`
 * state exposed by `getServerSideSelectionState()`.
 */
export class ServerSidePaginationSelectionService extends BaseSelectionService implements NamedBean, ISelectionService {
    beanName = 'selectionSvc' as const;

    private selectAll = false;
    private readonly toggledNodes = new Set<string>();
    private mode?: RowSelectionMode;

    public override postConstruct(): void {
        super.postConstruct();
        const gos = this.gos;
        this.mode = _getRowSelectionMode(gos);

        this.addManagedPropertyListener('rowSelection', () => {
            const mode = _getRowSelectionMode(gos);
            if (mode === this.mode) {
                return;
            }
            this.mode = mode;
            this.deselectAllRowNodes({ source: 'api' });
        });
    }

    public handleSelectionEvent(
        event: MouseEvent | KeyboardEvent,
        rowNode: RowNode,
        source: SelectionEventSourceType,
        column?: AgColumn
    ): number {
        if (this.isRowSelectionBlocked(rowNode)) {
            return 0;
        }

        const selection = this.inferNodeSelections(
            rowNode,
            event.shiftKey,
            event.metaKey || event.ctrlKey,
            source,
            column
        );
        if (selection == null) {
            return 0;
        }

        this.selectionCtx.selectAll = false;

        if (!('select' in selection)) {
            return this.setNodesSelected({
                nodes: [selection.node],
                newValue: selection.newValue,
                clearSelection: selection.clearSelection,
                event,
                source,
            });
        }

        // shift-click range selection
        let stateChanged = false;
        let updatedCount = 0;
        if (selection.reset) {
            stateChanged = this.clearSelectionExcept(new Set(), source, event);
        } else {
            updatedCount += this.applySelection(selection.deselect, false, source, event);
        }
        updatedCount += this.applySelection(selection.select, true, source, event);

        if (updatedCount > 0 || stateChanged) {
            this.dispatchSelectionChanged(source);
        }
        return updatedCount;
    }

    public setNodesSelected({
        newValue,
        clearSelection,
        suppressFinishActions,
        nodes,
        event,
        source,
    }: ISetNodesSelectedParams): number {
        const nodesLength = nodes.length;
        if (nodesLength === 0) {
            return 0;
        }

        if (!_isRowSelection(this.gos) && newValue) {
            this.warn(132);
            return 0;
        }

        const isMultiSelect = this.isMultiSelect();
        if (nodesLength > 1 && !isMultiSelect) {
            this.warn(130);
            return 0;
        }

        const updatedCount = this.applySelection(nodes, newValue, source, event);
        if (suppressFinishActions) {
            return updatedCount;
        }

        if (nodesLength === 1 && source === 'api') {
            this.selectionCtx.setRoot(nodes[0].primaryRow);
        }

        let stateChanged = false;
        if (newValue && (clearSelection || !isMultiSelect)) {
            const keepIds = new Set<string>();
            for (let i = 0; i < nodesLength; ++i) {
                const id = nodes[i].primaryRow.id;
                if (id == null) {
                    continue;
                }
                keepIds.add(id);
            }
            stateChanged = this.clearSelectionExcept(keepIds, source, event);
        }

        if (updatedCount > 0 || stateChanged) {
            this.dispatchSelectionChanged(source);
        }
        return updatedCount;
    }

    /** Applies `newValue` to the loaded `nodes` and records it in the rule. Returns how many nodes changed. */
    private applySelection(
        nodes: readonly RowNode[],
        newValue: boolean,
        source: SelectionEventSourceType,
        event?: Event
    ): number {
        let updatedCount = 0;
        for (let i = 0, len = nodes.length; i < len; ++i) {
            const node = nodes[i].primaryRow;

            if (node.rowPinned && !_isManualPinnedRow(node)) {
                this.warn(59);
                continue;
            }

            // rows still loading have no id, so cannot be selected
            const id = node.id;
            if (id === undefined) {
                this.warn(60);
                continue;
            }

            if (newValue && (node.destroyed || !node.selectable)) {
                continue;
            }

            this.setRuleSelected(id, newValue);
            if (this.selectRowNode(node, newValue, event, source)) {
                updatedCount++;
            }
        }
        return updatedCount;
    }

    /** Deselects everything apart from `keepIds`, which must already be selected. Returns whether anything changed. */
    private clearSelectionExcept(keepIds: Set<string>, source: SelectionEventSourceType, event?: Event): boolean {
        const toggledNodes = this.toggledNodes;
        let changed = this.selectAll;
        for (const id of toggledNodes) {
            changed ||= !keepIds.has(id);
        }

        this.selectAll = false;
        toggledNodes.clear();
        for (const id of keepIds) {
            toggledNodes.add(id);
        }

        this.beans.rowModel.forEachNode((node) => {
            if (node.id != null && keepIds.has(node.id)) {
                return;
            }
            changed = this.selectRowNode(node, false, event, source) || changed;
        });
        return changed;
    }

    private setRuleSelected(id: string, selected: boolean): void {
        if (selected === this.selectAll) {
            this.toggledNodes.delete(id);
        } else {
            this.toggledNodes.add(id);
        }
    }

    private isRuleSelected(id: string): boolean {
        return this.selectAll !== this.toggledNodes.has(id);
    }

    /** Re-applies the rule to every loaded row. Returns whether any row changed. */
    private syncLoadedNodes(source: SelectionEventSourceType): boolean {
        let changed = false;
        this.beans.rowModel.forEachNode((node) => {
            const id = node.id;
            if (id == null) {
                return;
            }
            const selected = this.isRuleSelected(id) && node.selectable;
            changed = this.selectRowNode(node, selected, undefined, source) || changed;
        });
        return changed;
    }

    public syncInRowNode(rowNode: RowNode): void {
        const id = rowNode.id;
        // a row's selectable state is calculated after this, so ask the callback directly
        rowNode.__selected = id != null && this.isRuleSelected(id) && (this.isRowSelectable?.(rowNode) ?? true);
    }

    public getSelectedNodes(): RowNode[] {
        const selected: RowNode[] = [];
        this.beans.rowModel.forEachNode((node) => {
            if (!node.isSelected()) {
                return;
            }
            selected.push(node);
        });
        return selected;
    }

    public getSelectedRows(): any[] {
        const selectedNodes = this.getSelectedNodes();
        const rows: any[] = [];
        for (let i = 0, len = selectedNodes.length; i < len; ++i) {
            rows.push(selectedNodes[i].data);
        }
        return rows;
    }

    public getSelectionCount(): number {
        const toggledCount = this.toggledNodes.size;
        return this.selectAll ? Math.max(0, this.beans.rowModel.getRowCount() - toggledCount) : toggledCount;
    }

    public isEmpty(): boolean {
        return !this.selectAll && this.toggledNodes.size === 0;
    }

    protected isSoleSelection(node: RowNode): boolean {
        const toggledNodes = this.toggledNodes;
        return !this.selectAll && toggledNodes.size === 1 && toggledNodes.has(node.id!);
    }

    public reset(source: SelectionEventSourceType): void {
        if (this.isEmpty()) {
            return;
        }
        this.clearSelectionExcept(new Set(), source);
        this.dispatchSelectionChanged(source);
    }

    public getBestCostNodeSelection(): RowNode[] | undefined {
        return undefined;
    }

    public getSelectAllState(selectAll?: SelectAllMode): boolean | null {
        if (selectAll === 'currentPage') {
            let selectedCount = 0;
            let notSelectedCount = 0;
            const nodes = this.getNodesOnPage();
            for (let i = 0, len = nodes.length; i < len; ++i) {
                const node = nodes[i];
                if (node.isSelected()) {
                    selectedCount++;
                } else if (node.selectable) {
                    notSelectedCount++;
                }
            }
            if (selectedCount > 0 && notSelectedCount > 0) {
                return null;
            }
            return selectedCount > 0;
        }

        // rows exist on the server that the grid has never seen, so only the rule can tell
        return this.toggledNodes.size === 0 ? this.selectAll : null;
    }

    public hasNodesToSelect(): boolean {
        return this.beans.rowModel.getRowCount() > 0;
    }

    public selectAllRowNodes({ source, selectAll }: { source: SelectionEventSourceType; selectAll?: SelectAllMode }) {
        if (!this.canSelectMany()) {
            return;
        }

        this.selectionCtx.selectAll = true;

        if (selectAll === 'currentPage') {
            if (this.applySelection(this.getNodesOnPage(), true, source) > 0) {
                this.dispatchSelectionChanged(source);
            }
            return;
        }

        // 'all' and 'filtered' are the same here: the server only returns rows that pass the filter
        this.selectAll = true;
        this.toggledNodes.clear();
        this.syncLoadedNodes(source);
        this.dispatchSelectionChanged(source);
    }

    public deselectAllRowNodes({ source, selectAll }: { source: SelectionEventSourceType; selectAll?: SelectAllMode }) {
        this.selectionCtx.selectAll = false;

        if (selectAll === 'currentPage') {
            if (this.applySelection(this.getNodesOnPage(), false, source) > 0) {
                this.dispatchSelectionChanged(source);
            }
            return;
        }

        if (this.clearSelectionExcept(new Set(), source)) {
            this.dispatchSelectionChanged(source);
        }
    }

    private canSelectMany(): boolean {
        const gos = this.gos;
        if (!_isRowSelection(gos)) {
            this.warn(132);
            return false;
        }
        if (_isUsingNewRowSelectionAPI(gos) && !_isMultiRowSelection(gos)) {
            this.warn(130);
            return false;
        }
        return true;
    }

    private getNodesOnPage(): RowNode[] {
        const { pageBounds, rowModel } = this.beans;
        const nodes: RowNode[] = [];
        for (let i = pageBounds.getFirstRow(), last = pageBounds.getLastRow(); i <= last; ++i) {
            const node = rowModel.getRow(i);
            if (!node) {
                continue;
            }
            nodes.push(node);
        }
        return nodes;
    }

    public getSelectionState(): ServerSideRowSelectionState {
        return { selectAll: this.selectAll, toggledNodes: Array.from(this.toggledNodes) };
    }

    /** Accepts `{ selectAll, toggledNodes }`, a list of selected row ids, or the root of a group selection state. */
    public setSelectionState(
        state: string[] | ServerSideRowSelectionState | ServerSideRowGroupSelectionState | undefined,
        source: SelectionEventSourceType
    ): void {
        const toggledNodes = this.toggledNodes;
        toggledNodes.clear();

        if (Array.isArray(state)) {
            this.selectAll = false;
            for (const id of state) {
                toggledNodes.add(id);
            }
        } else if (state && 'selectAll' in state) {
            this.selectAll = state.selectAll;
            for (const id of state.toggledNodes) {
                toggledNodes.add(id);
            }
        } else {
            // group selection state: flat data only has the root level, whose children are the rows
            this.selectAll = !!state?.selectAllChildren;
            for (const child of state?.toggledNodes ?? []) {
                if (child.nodeId == null) {
                    continue;
                }
                toggledNodes.add(child.nodeId);
            }
        }

        this.syncLoadedNodes(source);
        this.dispatchSelectionChanged(source);
    }

    protected updateSelectable(): void {
        this.beans.rowModel.forEachNode((node) => this.updateRowSelectable(node));
    }

    public updateSelectableAfterGrouping(): void {
        // client-side row model only
    }

    public refreshMasterNodeState(): void {
        // master / detail is not supported by this row model
    }

    public setDetailSelectionState(): void {
        // master / detail is not supported by this row model
    }

    private dispatchSelectionChanged(source: SelectionEventSourceType): void {
        this.eventSvc.dispatchEvent({
            type: 'selectionChanged',
            source,
            selectedNodes: this.getSelectedNodes(),
            serverSideState: this.getSelectionState(),
        });
    }
}
