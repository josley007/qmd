/**
 * Collections - Simplified Node.js version
 */
import { QMDStore } from './store.js';
export declare class Collections {
    private store;
    constructor(store: QMDStore);
    /**
     * Add a new collection
     */
    add(name: string, collectionPath: string, glob?: string): Promise<void>;
    /**
     * List all collections
     */
    list(): {
        name: string;
        path: string;
        documentCount: number;
    }[];
    /**
     * Get collection info
     */
    get(name: string): {
        id: number;
        name: string;
        path: string;
        glob: string;
    } | null;
    /**
     * Remove a collection
     */
    remove(name: string): Promise<void>;
}
export default Collections;
//# sourceMappingURL=collections.d.ts.map