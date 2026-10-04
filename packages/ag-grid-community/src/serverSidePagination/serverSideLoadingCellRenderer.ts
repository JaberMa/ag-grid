import type { ILoadingCellRendererComp, ILoadingCellRendererParams } from '../interfaces/iLoadingCellRenderer';
import type { ElementParams } from '../utils/element';
import { _createElement } from '../utils/element';
import { _createIconNoSpan } from '../utils/icon';
import { Component } from '../widgets/component';

const LoadingCellRendererElement: ElementParams = { tag: 'div', cls: 'ag-loading' };

/** Full-width row shown while a server-side block loads: a spinner and "Loading...", or "ERR" if the load failed. */
export class ServerSideLoadingCellRenderer extends Component implements ILoadingCellRendererComp {
    constructor() {
        super(LoadingCellRendererElement);
    }

    public init(params: ILoadingCellRendererParams): void {
        const eGui = this.getGui();
        const translate = this.getLocaleTextFunc();

        if (params.node.failedLoad) {
            eGui.textContent = translate('loadingError', 'ERR');
            return;
        }

        const eIcon = _createIconNoSpan('groupLoading', this.beans, null);
        if (eIcon) {
            const eIconWrapper = _createElement({ tag: 'span', cls: 'ag-loading-icon' });
            eIconWrapper.appendChild(eIcon);
            eGui.appendChild(eIconWrapper);
        }
        eGui.appendChild(
            _createElement({ tag: 'span', cls: 'ag-loading-text', children: translate('loadingOoo', 'Loading...') })
        );
    }

    public refresh(_params: ILoadingCellRendererParams): boolean {
        return false;
    }
}
