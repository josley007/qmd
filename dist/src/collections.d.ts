/**
 * Collections - Simplified Node.js version for library use
 */
import { QMDStore } from './qmd.js';
export declare class Collections {
    private store;
    constructor(store: QMDStore);
    add(name: string, collectionPath: string, glob?: string): Promise<void>;
    list(): {
        name: string;
        path: string;
        documentCount: number;
    }[];
    get(name: string): {
        id: number;
        name: string;
        path: string;
        glob: string;
    } | null;
    remove(name: string): Promise<void>;
}
export default Collections;
//# sourceMappingURL=collections.d.ts.map