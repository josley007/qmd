/**
 * Memoir - Tree-structured memory system with full-text search
 *
 * A lightweight search engine for markdown documents with tree-based memory organization.
 *
 * Usage:
 * import { QMD, Memoir } from '@violoop/memoir'
 *
 * // Low-level search
 * const qmd = new QMD({ dataDir: './data' })
 * await qmd.initialize()
 * await qmd.addCollection('docs', './docs')
 * const results = await qmd.search('query')
 *
 * // High-level memory
 * const memory = new Memoir({ memoryDir: './memory', dataDir: './memoir-data' })
 * await memory.initialize()
 * await memory.set('life.work.project', 'Content...')
 * const tree = await memory.getTreeForPrompt()
 */
import { Memoir as MemoirClass } from './src/memory.js';
export interface QMDConfig {
    dataDir?: string;
}
export interface SearchResult {
    id: string;
    path: string;
    title: string;
    content: string;
    score: number;
    type: 'bm25' | 'vector' | 'hybrid';
}
export interface CollectionInfo {
    name: string;
    path: string;
    documentCount: number;
}
export declare class QMD {
    private config;
    private store;
    private collections;
    private initialized;
    constructor(config?: QMDConfig);
    initialize(): Promise<void>;
    addCollection(name: string, path: string, glob?: string): Promise<void>;
    listCollections(): CollectionInfo[];
    getCollection(name: string): {
        name: string;
        path: string;
        glob: string;
    } | null;
    removeCollection(name: string): Promise<void>;
    reindex(options?: {
        incremental?: boolean;
    }): Promise<{
        indexed: number;
        skipped: number;
        failed: number;
    }>;
    search(query: string, options?: {
        collection?: string;
        limit?: number;
        minScore?: number;
    }): Promise<SearchResult[]>;
    /**
     * Vector semantic search
     * @param embedding - Pre-computed query embedding vector
     */
    vsearch(embedding: number[], options?: {
        collection?: string;
        limit?: number;
        minScore?: number;
    }): Promise<SearchResult[]>;
    /**
     * Hybrid search: BM25 + Vector
     * @param query - Text query for BM25
     * @param embedding - Pre-computed query embedding vector (optional)
     */
    query(query: string, embedding?: number[], options?: {
        collection?: string;
        limit?: number;
        minScore?: number;
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
    }): Promise<SearchResult[]>;
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
     * Clear all embeddings (force re-index)
     */
    clearAllEmbeddings(): void;
    /**
     * Generate embedding for query text
     */
    embedQuery(query: string): Promise<number[] | null>;
    /**
     * Generate embedding for document text
     */
    embedDocument(text: string): Promise<number[] | null>;
    /**
     * Batch embed multiple texts
     */
    embedBatch(texts: string[], isQuery?: boolean): Promise<(number[] | null)[]>;
    /**
     * Embed all documents that need embedding
     */
    embedAll(options?: {
        progress?: (current: number, total: number) => void;
    }): Promise<number>;
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
     * Start auto-embedding - watches collections for file changes and automatically embeds new/modified documents
     */
    startAutoEmbed(options?: {
        interval?: number;
        onChange?: (event: 'add' | 'change' | 'unlink', path: string) => void;
        debounce?: number;
    }): void;
    /**
     * Stop auto-embedding
     */
    stopAutoEmbed(): void;
    /**
     * Check if auto-embed is running
     */
    isAutoEmbedRunning(): boolean;
    /**
     * Preload embedding model (call before first embedding to avoid delay)
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
    get(docPath: string): Promise<{
        path: string;
        content: string;
        frontmatter: Record<string, unknown>;
    } | null>;
    close(): Promise<void>;
}
export { MemoirClass as Memoir };
export default QMD;
//# sourceMappingURL=index.d.ts.map