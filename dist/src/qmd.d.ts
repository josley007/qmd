/**
 * QMD - Simplified Node.js version
 *
 * Core database operations for QMD search engine
 * Using better-sqlite3 instead of bun:sqlite
 * Supports BM25 full-text search and vector semantic search
 */
import BetterSqlite3 from 'better-sqlite3';
export interface SearchResult {
    docId: string;
    path: string;
    title: string;
    content: string;
    score: number;
    collection?: string;
    source?: 'bm25' | 'vec' | 'hybrid';
}
export declare class QMDStore {
    private dataDir;
    private db;
    private dbPath;
    private embeddingModel;
    private embeddingDimension;
    private llamaInstance;
    private embeddingModelInstance;
    private embeddingContextInstance;
    private modelLoading;
    constructor(dataDir?: string);
    /**
     * Initialize the database
     */
    initialize(): void;
    /**
     * Load sqlite-vec extension
     */
    private loadVecExtension;
    /**
     * Create database tables
     */
    private createTables;
    /**
     * Ensure vectors_vec table exists with correct dimensions
     */
    private ensureVecTable;
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
     * Vector semantic search
     * @param embedding - Pre-computed embedding vector (or null to skip vector search)
     */
    searchVec(embedding: number[] | null, collectionName?: string, limit?: number): Promise<SearchResult[]>;
    /**
     * Hybrid search: BM25 + Vector with RRF fusion
     * @param embedding - Pre-computed embedding vector (or null to skip vector search)
     * @param options.rerank - Optional reranking function
     */
    searchHybrid(query: string, embedding: number[] | null, collectionName?: string, limit?: number, options?: {
        rerank?: (query: string, documents: {
            path: string;
            content: string;
        }[]) => Promise<{
            path: string;
            score: number;
        }[]>;
        weights?: {
            bm25: number;
            vec: number;
        };
        rrfK?: number;
    }): Promise<SearchResult[]>;
    /**
     * Reciprocal Rank Fusion - combine multiple result lists
     */
    private rrfCombine;
    /**
     * Get documents that need embeddings
     */
    getHashesForEmbedding(): {
        hash: string;
        body: string;
        path: string;
    }[];
    /**
     * Insert an embedding for a document chunk
     */
    insertEmbedding(hash: string, seq: number, pos: number, embedding: number[]): Promise<void>;
    /**
     * Clear all embeddings
     */
    clearAllEmbeddings(): void;
    /**
     * Set embedding model
     */
    setEmbeddingModel(model: string, dimension?: number): void;
    /**
     * Get current embedding model
     */
    getEmbeddingModel(): string;
    /**
     * Get embedding dimension
     */
    getEmbeddingDimension(): number;
    /**
     * Generate embedding for text using node-llama-cpp
     * @param text - Text to embed
     * @param isQuery - Whether this is a query (vs document)
     * @returns Embedding array or null on failure
     */
    embedText(text: string, isQuery?: boolean): Promise<number[] | null>;
    /**
     * Ensure embedding model is loaded (lazy loading with caching)
     */
    private ensureEmbeddingModel;
    /**
     * Load the embedding model
     */
    private loadEmbeddingModel;
    /**
     * Preload embedding model (call this before first embedding to avoid delay)
     */
    preloadEmbeddingModel(): Promise<void>;
    /**
     * Check if embedding model is loaded
     */
    isEmbeddingModelLoaded(): boolean;
    /**
     * Unload embedding model (free memory)
     */
    unloadEmbeddingModel(): Promise<void>;
    /**
     * Generate query embedding
     * @param query - Query text
     * @returns Embedding array or null on failure
     */
    embedQuery(query: string): Promise<number[] | null>;
    /**
     * Generate document embedding
     * @param text - Document text
     * @returns Embedding array or null on failure
     */
    embedDocument(text: string): Promise<number[] | null>;
    /**
     * Batch embed multiple texts
     * @param texts - Array of texts to embed
     * @param isQuery - Whether these are queries (vs documents)
     * @returns Array of embeddings (null for failed embeddings)
     */
    embedBatch(texts: string[], isQuery?: boolean): Promise<(number[] | null)[]>;
    /**
     * Embed all documents that need embedding
     * @param options.progress - Optional callback for progress updates
     * @returns Number of documents embedded
     */
    embedAll(options?: {
        progress?: (current: number, total: number) => void;
    }): Promise<number>;
    private fileWatcher;
    private autoEmbedTimer;
    private isWatching;
    /**
     * Start watching collections for file changes and auto-embed
     * @param options.interval - Scan interval in ms (default: 60000 = 1 minute)
     * @param options.onChange - Callback when files change
     * @param options.debounce - Debounce time in ms (default: 2000)
     */
    startAutoEmbed(options?: {
        interval?: number;
        onChange?: (event: 'add' | 'change' | 'unlink', path: string) => void;
        debounce?: number;
    }): void;
    /**
     * Stop watching and auto-embedding
     */
    stopAutoEmbed(): void;
    /**
     * Check if auto-embed is running
     */
    isAutoEmbedRunning(): boolean;
    /**
     * Close database connection and unload models
     */
    close(): Promise<void>;
}
export default QMDStore;
//# sourceMappingURL=qmd.d.ts.map