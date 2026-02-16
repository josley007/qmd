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
import { QMDStore } from './src/qmd.js';
import { Collections } from './src/collections.js';
import { Memoir as MemoirClass } from './src/memory.js';
export class QMD {
    config;
    store;
    collections;
    initialized = false;
    constructor(config = {}) {
        this.config = config;
        this.config.dataDir = this.config.dataDir || './qmd-data';
        this.store = new QMDStore(this.config.dataDir);
        this.collections = new Collections(this.store);
    }
    async initialize() {
        if (this.initialized)
            return;
        this.store.initialize();
        this.initialized = true;
        console.log('[QMD] Initialized at', this.config.dataDir);
    }
    async addCollection(name, path, glob = '**/*.md') {
        await this.collections.add(name, path, glob);
    }
    listCollections() {
        return this.collections.list();
    }
    getCollection(name) {
        return this.collections.get(name);
    }
    async removeCollection(name) {
        await this.collections.remove(name);
    }
    async reindex(options = {}) {
        return this.store.indexAll(options);
    }
    async search(query, options = {}) {
        const limit = options.limit || 10;
        const minScore = options.minScore || 0;
        const useHybrid = options.useHybrid !== false; // 默认使用混合搜索
        let results;
        if (useHybrid && this.store.isEmbeddingModelLoaded()) {
            // 使用混合搜索
            try {
                const embedding = await this.store.embedQuery(query);
                results = await this.store.searchHybrid(query, embedding, options.collection, limit);
            }
            catch (err) {
                console.warn('[QMD] Hybrid search failed, fallback to BM25:', err);
                results = this.store.searchBM25(query, options.collection, limit);
            }
        }
        else {
            // 使用 BM25
            results = this.store.searchBM25(query, options.collection, limit);
        }
        return results
            .map(r => ({
            id: r.docId,
            path: r.path,
            title: r.title || '',
            content: r.content?.substring(0, 500) || '',
            score: Math.abs(r.score || 0),
            type: (r.source === 'vec' ? 'vector' : r.source === 'bm25' ? 'bm25' : 'hybrid')
        }))
            .filter(r => r.score >= minScore);
    }
    /**
     * Vector semantic search
     * @param embedding - Pre-computed query embedding vector
     */
    async vsearch(embedding, options = {}) {
        const limit = options.limit || 10;
        const minScore = options.minScore || 0;
        const results = await this.store.searchVec(embedding, options.collection, limit);
        return results
            .map(r => ({
            id: r.docId,
            path: r.path,
            title: r.title || '',
            content: r.content?.substring(0, 500) || '',
            score: r.score || 0,
            type: 'vector'
        }))
            .filter(r => r.score >= minScore);
    }
    /**
     * Hybrid search: BM25 + Vector
     * @param query - Text query for BM25
     * @param embedding - Pre-computed query embedding vector (optional)
     */
    async query(query, embedding, options = {}) {
        const limit = options.limit || 10;
        const minScore = options.minScore || 0;
        const results = await this.store.searchHybrid(query, embedding ?? null, options.collection, limit, {
            rerank: options.rerank,
            weights: options.weights
        });
        return results
            .map(r => ({
            id: r.docId,
            path: r.path,
            title: r.title || '',
            content: r.content?.substring(0, 500) || '',
            score: r.score || 0,
            type: (r.source === 'vec' ? 'vector' : r.source === 'bm25' ? 'bm25' : 'hybrid')
        }))
            .filter(r => r.score >= minScore);
    }
    /**
     * Get documents that need embeddings
     */
    getHashesForEmbedding() {
        return this.store.getHashesForEmbedding();
    }
    /**
     * Insert an embedding for a document chunk
     */
    async insertEmbedding(hash, seq, pos, embedding) {
        await this.store.insertEmbedding(hash, seq, pos, embedding);
    }
    /**
     * Clear all embeddings (force re-index)
     */
    clearAllEmbeddings() {
        this.store.clearAllEmbeddings();
    }
    /**
     * Generate embedding for query text
     */
    async embedQuery(query) {
        return this.store.embedQuery(query);
    }
    /**
     * Generate embedding for document text
     */
    async embedDocument(text) {
        return this.store.embedDocument(text);
    }
    /**
     * Batch embed multiple texts
     */
    async embedBatch(texts, isQuery = false) {
        return this.store.embedBatch(texts, isQuery);
    }
    /**
     * Embed all documents that need embedding
     */
    async embedAll(options) {
        return this.store.embedAll(options);
    }
    /**
     * Set embedding model
     */
    setEmbeddingModel(model, dimension = 768) {
        this.store.setEmbeddingModel(model, dimension);
    }
    /**
     * Get current embedding model
     */
    getEmbeddingModel() {
        return this.store.getEmbeddingModel();
    }
    /**
     * Get embedding dimension
     */
    getEmbeddingDimension() {
        return this.store.getEmbeddingDimension();
    }
    /**
     * Start auto-embedding - watches collections for file changes and automatically embeds new/modified documents
     */
    startAutoEmbed(options) {
        this.store.startAutoEmbed(options);
    }
    /**
     * Stop auto-embedding
     */
    stopAutoEmbed() {
        this.store.stopAutoEmbed();
    }
    /**
     * Check if auto-embed is running
     */
    isAutoEmbedRunning() {
        return this.store.isAutoEmbedRunning();
    }
    /**
     * Preload embedding model (call before first embedding to avoid delay)
     */
    async preloadEmbeddingModel() {
        await this.store.preloadEmbeddingModel();
    }
    /**
     * Check if embedding model is loaded
     */
    isEmbeddingModelLoaded() {
        return this.store.isEmbeddingModelLoaded();
    }
    /**
     * Unload embedding model (free memory)
     */
    async unloadEmbeddingModel() {
        await this.store.unloadEmbeddingModel();
    }
    /**
     * Get embedding status
     */
    getEmbeddingStatus() {
        return this.store.getEmbeddingStatus();
    }
    /**
     * Log embedding status
     */
    logEmbeddingStatus() {
        this.store.logEmbeddingStatus();
    }
    /**
     * Preload rerank model
     */
    async preloadRerankModel() {
        await this.store.preloadRerankModel();
    }
    /**
     * Get rerank model loaded status
     */
    isRerankModelLoaded() {
        return this.store.isRerankModelLoaded();
    }
    async get(docPath) {
        return this.store.getDocument(docPath);
    }
    async close() {
        await this.store.close();
        this.initialized = false;
    }
}
export { MemoirClass as Memoir };
export default QMD;
//# sourceMappingURL=index.js.map