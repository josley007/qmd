/**
 * Collections - Simplified Node.js version for library use
 */
import path from 'path';
import fs from 'fs';
export class Collections {
    store;
    constructor(store) {
        this.store = store;
    }
    async add(name, collectionPath, glob = '**/*.md') {
        const absolutePath = path.resolve(collectionPath);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`Collection path does not exist: ${absolutePath}`);
        }
        this.store.addCollection(name, absolutePath, glob);
        console.log(`[Collections] Added collection "${name}" at ${absolutePath}`);
    }
    list() {
        const collections = this.store.listCollections();
        return collections.map(c => {
            return {
                name: c.name,
                path: c.path,
                documentCount: 0
            };
        });
    }
    get(name) {
        return this.store.getCollection(name);
    }
    async remove(name) {
        this.store.removeCollection(name);
        console.log(`[Collections] Removed collection "${name}"`);
    }
}
export default Collections;
//# sourceMappingURL=collections.js.map