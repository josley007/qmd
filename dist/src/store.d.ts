/**
 * QMD Store - Simplified Node.js version
 *
 * Core database operations for QMD search engine
 * Using better-sqlite3 instead of bun:sqlite
 */
import BetterSqlite3 from 'better-sqlite3';
export interface SearchResult {
    docId: string;
    path: string;
    title: string;
    content: string;
    score: number;
    collection?: string;
}
export declare class QMDStore {
    private dataDir;
    private db;
    private dbPath;
    constructor(dataDir?: string);
    /**
     * Initialize the database
     */
    initialize(): void;
    /**
     * Create database tables
     */
    private createTables;
    /**
     * Get database instance
     */
    getDb(): BetterSqlite3.Database;
    /**
     * Add a collection
     */
    addCollection(name: string, collectionPath: string, glob?: string): void;
    /**
     * Get collection by name
     */
    getCollection(name: string): {
        id: number;
        name: string;
        path: string;
        glob: string;
    } | null;
    /**
     * List collections
     */
    listCollections(): {
        id: number;
        name: string;
        path: string;
        glob: string;
    }[];
    /**
     * Remove collection
     */
    removeCollection(name: string): void;
    /**
     * Generate document ID from hash
     */
    private getDocid;
    /**
     * Add or update a document
     */
    upsertDocument(collectionId: number, docPath: string, title: string, content: string, frontmatter: Record<string, unknown>): string;
    /**
     * Get document by path
     */
    getDocument(docPath: string): {
        path: string;
        content: string;
        frontmatter: Record<string, unknown>;
    } | null;
    /**
     * BM25 full-text search
     */
    searchBM25(query: string, collectionName?: string, limit?: number): SearchResult[];
    /**
     * Index all collections
     */
    indexAll(options?: {
        incremental?: boolean;
    }): Promise<{
        indexed: number;
        skipped: number;
        failed: number;
    }>;
    /**
     * Find markdown files matching glob pattern
     * Simple implementation without external glob dependency
     */
    private findMarkdownFiles;
    /**
     * Close database connection
     */
    close(): void;
}
export default QMDStore;
//# sourceMappingURL=store.d.ts.map