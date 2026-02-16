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

import { QMDStore } from './src/qmd.js'
import { Collections } from './src/collections.js'
import { Memoir as MemoirClass } from './src/memory.js'

export interface QMDConfig {
  dataDir?: string
}

export interface SearchResult {
  id: string
  path: string
  title: string
  content: string
  score: number
  type: 'bm25' | 'vector' | 'hybrid'
}

export interface CollectionInfo {
  name: string
  path: string
  documentCount: number
}

export class QMD {
  private store: QMDStore
  private collections: Collections
  private initialized: boolean = false

  constructor(private config: QMDConfig = {}) {
    this.config.dataDir = this.config.dataDir || './qmd-data'
    
    this.store = new QMDStore(this.config.dataDir)
    this.collections = new Collections(this.store)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    
    this.store.initialize()
    this.initialized = true
    console.log('[QMD] Initialized at', this.config.dataDir)
  }

  async addCollection(name: string, path: string, glob: string = '**/*.md'): Promise<void> {
    await this.collections.add(name, path, glob)
  }

  listCollections(): CollectionInfo[] {
    return this.collections.list()
  }

  getCollection(name: string): { name: string; path: string; glob: string } | null {
    return this.collections.get(name)
  }

  async removeCollection(name: string): Promise<void> {
    await this.collections.remove(name)
  }

  async reindex(options: { incremental?: boolean } = {}): Promise<{ indexed: number; skipped: number; failed: number }> {
    return this.store.indexAll(options)
  }

  async search(query: string, options: {
    collection?: string
    limit?: number
    minScore?: number
    useHybrid?: boolean  // 是否使用混合搜索 (默认 true)
  } = {}): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const minScore = options.minScore || 0
    const useHybrid = options.useHybrid !== false  // 默认使用混合搜索
    
    let results
    
    if (useHybrid && this.store.isEmbeddingModelLoaded()) {
      // 使用混合搜索
      try {
        const embedding = await this.store.embedQuery(query)
        results = await this.store.searchHybrid(query, embedding, options.collection, limit)
      } catch (err) {
        console.warn('[QMD] Hybrid search failed, fallback to BM25:', err)
        results = this.store.searchBM25(query, options.collection, limit)
      }
    } else {
      // 使用 BM25
      results = this.store.searchBM25(query, options.collection, limit)
    }
    
    return results
      .map(r => ({
        id: r.docId,
        path: r.path,
        title: r.title || '',
        content: r.content?.substring(0, 500) || '',
        score: Math.abs(r.score || 0),
        type: (r.source === 'vec' ? 'vector' : r.source === 'bm25' ? 'bm25' : 'hybrid') as 'bm25' | 'vector' | 'hybrid'
      }))
      .filter(r => r.score >= minScore)
  }

  /**
   * Vector semantic search
   * @param embedding - Pre-computed query embedding vector
   */
  async vsearch(embedding: number[], options: {
    collection?: string
    limit?: number
    minScore?: number
  } = {}): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const minScore = options.minScore || 0
    
    const results = await this.store.searchVec(embedding, options.collection, limit)
    
    return results
      .map(r => ({
        id: r.docId,
        path: r.path,
        title: r.title || '',
        content: r.content?.substring(0, 500) || '',
        score: r.score || 0,
        type: 'vector' as const
      }))
      .filter(r => r.score >= minScore)
  }

  /**
   * Hybrid search: BM25 + Vector
   * @param query - Text query for BM25
   * @param embedding - Pre-computed query embedding vector (optional)
   */
  async query(query: string, embedding?: number[], options: {
    collection?: string
    limit?: number
    minScore?: number
    rerank?: (query: string, documents: { path: string; content: string }[]) => Promise<{ path: string; score: number }[]>
    weights?: { bm25: number; vec: number }
  } = {}): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const minScore = options.minScore || 0
    
    const results = await this.store.searchHybrid(
      query, 
      embedding ?? null, 
      options.collection, 
      limit,
      {
        rerank: options.rerank,
        weights: options.weights
      }
    )
    
    return results
      .map(r => ({
        id: r.docId,
        path: r.path,
        title: r.title || '',
        content: r.content?.substring(0, 500) || '',
        score: r.score || 0,
        type: (r.source === 'vec' ? 'vector' : r.source === 'bm25' ? 'bm25' : 'hybrid') as 'bm25' | 'vector' | 'hybrid'
      }))
      .filter(r => r.score >= minScore)
  }

  /**
   * Get documents that need embeddings
   */
  getHashesForEmbedding(): { hash: string; body: string; path: string }[] {
    return this.store.getHashesForEmbedding()
  }

  /**
   * Insert an embedding for a document chunk
   */
  async insertEmbedding(hash: string, seq: number, pos: number, embedding: number[]): Promise<void> {
    await this.store.insertEmbedding(hash, seq, pos, embedding)
  }

  /**
   * Clear all embeddings (force re-index)
   */
  clearAllEmbeddings(): void {
    this.store.clearAllEmbeddings()
  }

  /**
   * Generate embedding for query text
   */
  async embedQuery(query: string): Promise<number[] | null> {
    return this.store.embedQuery(query)
  }

  /**
   * Generate embedding for document text
   */
  async embedDocument(text: string): Promise<number[] | null> {
    return this.store.embedDocument(text)
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[], isQuery: boolean = false): Promise<(number[] | null)[]> {
    return this.store.embedBatch(texts, isQuery)
  }

  /**
   * Embed all documents that need embedding
   */
  async embedAll(options?: {
    progress?: (current: number, total: number) => void
  }): Promise<number> {
    return this.store.embedAll(options)
  }

  /**
   * Set embedding model
   */
  setEmbeddingModel(model: string, dimension: number = 768): void {
    this.store.setEmbeddingModel(model, dimension)
  }

  /**
   * Get current embedding model
   */
  getEmbeddingModel(): string {
    return this.store.getEmbeddingModel()
  }

  /**
   * Get embedding dimension
   */
  getEmbeddingDimension(): number {
    return this.store.getEmbeddingDimension()
  }

  /**
   * Start auto-embedding - watches collections for file changes and automatically embeds new/modified documents
   */
  startAutoEmbed(options?: {
    interval?: number
    onChange?: (event: 'add' | 'change' | 'unlink', path: string) => void
    debounce?: number
  }): void {
    this.store.startAutoEmbed(options)
  }

  /**
   * Stop auto-embedding
   */
  stopAutoEmbed(): void {
    this.store.stopAutoEmbed()
  }

  /**
   * Check if auto-embed is running
   */
  isAutoEmbedRunning(): boolean {
    return this.store.isAutoEmbedRunning()
  }

  /**
   * Preload embedding model (call before first embedding to avoid delay)
   */
  async preloadEmbeddingModel(): Promise<void> {
    await this.store.preloadEmbeddingModel()
  }

  /**
   * Check if embedding model is loaded
   */
  isEmbeddingModelLoaded(): boolean {
    return this.store.isEmbeddingModelLoaded()
  }

  /**
   * Unload embedding model (free memory)
   */
  async unloadEmbeddingModel(): Promise<void> {
    await this.store.unloadEmbeddingModel()
  }

  /**
   * Get embedding status
   */
  getEmbeddingStatus(): { total: number; embedded: number; pending: number } {
    return this.store.getEmbeddingStatus()
  }

  /**
   * Log embedding status
   */
  logEmbeddingStatus(): void {
    this.store.logEmbeddingStatus()
  }

  /**
   * Preload rerank model
   */
  async preloadRerankModel(): Promise<void> {
    await this.store.preloadRerankModel()
  }

  /**
   * Get rerank model loaded status
   */
  isRerankModelLoaded(): boolean {
    return this.store.isRerankModelLoaded()
  }

  async get(docPath: string): Promise<{ path: string; content: string; frontmatter: Record<string, unknown> } | null> {
    return this.store.getDocument(docPath)
  }

  async close(): Promise<void> {
    await this.store.close()
    this.initialized = false
  }
}

export { MemoirClass as Memoir }

export default QMD
