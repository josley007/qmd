/**
 * QMD - Simplified Node.js version
 * 
 * Core database operations for QMD search engine
 * Using better-sqlite3 instead of bun:sqlite
 * Supports BM25 full-text search and vector semantic search
 */

import BetterSqlite3 from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import matter from 'gray-matter'
import * as sqliteVec from 'sqlite-vec'

export interface SearchResult {
  docId: string
  path: string
  title: string
  content: string
  score: number
  collection?: string
  source?: 'bm25' | 'vec' | 'hybrid'
}

export class QMDStore {
  private db: BetterSqlite3.Database | null = null
  private dbPath: string
  private embeddingModel: string = 'embeddinggemma'
  private embeddingDimension: number = 1536
  
  // Model caching
  private llamaInstance: any = null
  private embeddingModelInstance: any = null
  private embeddingContextInstance: any = null
  private modelLoading: Promise<any> | null = null

  constructor(private dataDir: string = './qmd-data') {
    this.dbPath = path.join(dataDir, 'index.sqlite')
  }

  /**
   * Initialize the database
   */
  initialize(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }

    this.db = new BetterSqlite3(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.loadVecExtension()
    this.createTables()
    console.log('[QMD] Initialized at', this.dbPath)
  }

  /**
   * Load sqlite-vec extension
   */
  private loadVecExtension(): void {
    if (!this.db) return
    try {
      sqliteVec.load(this.db)
      console.log('[QMD] sqlite-vec extension loaded')
    } catch (err) {
      console.warn('[QMD] Failed to load sqlite-vec:', err)
    }
  }

  /**
   * Create database tables
   */
  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized')

    // Collections table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        path TEXT NOT NULL,
        glob TEXT DEFAULT '**/*.md',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Documents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        title TEXT,
        content TEXT,
        hash TEXT,
        frontmatter TEXT,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(collection_id, path)
      )
    `)

    // Content table (separated for FTS)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        title TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Content vectors table (chunk-level embeddings)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_vectors (
        hash TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        pos INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (hash, seq)
      )
    `)

    // Indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_hash ON content(hash)`)

    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts 
      USING fts5(
        title,
        doc,
        content=documents,
        content_rowid=rowid,
        tokenize='porter unicode61'
      )
    `)

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, title, doc) 
        VALUES (NEW.rowid, NEW.title, NEW.content);
      END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, doc) 
        VALUES('delete', OLD.rowid, OLD.title, OLD.content);
      END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, doc) 
        VALUES('delete', OLD.rowid, OLD.title, OLD.content);
        INSERT INTO documents_fts(rowid, title, doc) 
        VALUES (NEW.rowid, NEW.title, NEW.content);
      END
    `)

    // Create vectors_vec table for similarity search
    this.ensureVecTable(this.embeddingDimension)
  }

  /**
   * Ensure vectors_vec table exists with correct dimensions
   */
  private ensureVecTable(dimensions: number): void {
    if (!this.db) return
    
    try {
      const tableInfo = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null
      
      if (tableInfo) {
        const match = tableInfo.sql?.match(/float\[(\d+)\]/)
        const existingDims = match?.[1] ? parseInt(match[1], 10) : null
        if (existingDims === dimensions) return
        
        this.db.exec("DROP TABLE IF EXISTS vectors_vec")
      }
      
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`)
      console.log(`[QMD] Created vectors_vec table with ${dimensions} dimensions`)
    } catch (err) {
      console.warn('[QMD] Failed to create vectors_vec table:', err)
    }
  }

  /**
   * Get database instance
   */
  getDb(): BetterSqlite3.Database {
    if (!this.db) throw new Error('Database not initialized')
    return this.db
  }

  /**
   * Add a collection
   */
  addCollection(name: string, collectionPath: string, glob: string = '**/*.md'): void {
    const db = this.getDb()
    const stmt = db.prepare(`INSERT OR IGNORE INTO collections (name, path, glob) VALUES (?, ?, ?)`)
    stmt.run(name, collectionPath, glob)
  }

  /**
   * Get collection by name
   */
  getCollection(name: string): { id: number; name: string; path: string; glob: string } | null {
    const db = this.getDb()
    const stmt = db.prepare('SELECT * FROM collections WHERE name = ?')
    return stmt.get(name) as any
  }

  /**
   * List collections
   */
  listCollections(): { id: number; name: string; path: string; glob: string }[] {
    const db = this.getDb()
    const stmt = db.prepare('SELECT * FROM collections')
    return stmt.all() as any[]
  }

  /**
   * Remove collection
   */
  removeCollection(name: string): void {
    const db = this.getDb()
    const stmt = db.prepare('DELETE FROM collections WHERE name = ?')
    stmt.run(name)
  }

  /**
   * Generate document ID from hash
   */
  private getDocid(hash: string): string {
    return hash.substring(0, 6)
  }

  /**
   * Add or update a document
   */
  upsertDocument(collectionId: number, docPath: string, title: string, content: string, frontmatter: Record<string, unknown>): string {
    const db = this.getDb()
    const hash = crypto.createHash('md5').update(content).digest('hex')
    const id = this.getDocid(hash)

    // Check if document exists
    const existing = db.prepare('SELECT id FROM documents WHERE collection_id = ? AND path = ?').get(collectionId, docPath)

    if (existing) {
      // Update
      db.prepare(`
        UPDATE documents 
        SET title = ?, content = ?, hash = ?, frontmatter = ?, updated_at = CURRENT_TIMESTAMP
        WHERE collection_id = ? AND path = ?
      `).run(title, content, hash, JSON.stringify(frontmatter), collectionId, docPath)
    } else {
      // Insert
      db.prepare(`
        INSERT INTO documents (id, collection_id, path, title, content, hash, frontmatter)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, collectionId, docPath, title, content, hash, JSON.stringify(frontmatter))
    }

    // Upsert content
    db.prepare(`
      INSERT OR REPLACE INTO content (hash, doc, title, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(hash, content, title)

    // Also insert into FTS directly (for when triggers don't work)
    try {
      db.prepare(`
        INSERT OR REPLACE INTO documents_fts(rowid, title, doc)
        SELECT d.rowid, d.title, d.content FROM documents d WHERE d.hash = ?
      `).run(hash)
    } catch (e) {
      // Ignore FTS errors
    }

    return id
  }

  /**
   * Get document by path
   */
  getDocument(docPath: string): { path: string; content: string; frontmatter: Record<string, unknown> } | null {
    const db = this.getDb()
    const stmt = db.prepare('SELECT path, content, frontmatter FROM documents WHERE path = ?')
    const row = stmt.get(docPath) as any
    
    if (!row) return null
    
    return {
      path: row.path,
      content: row.content,
      frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : {}
    }
  }

  /**
   * BM25 full-text search
   */
  searchBM25(query: string, collectionName?: string, limit: number = 10): SearchResult[] {
    const db = this.getDb()

    // Build FTS query
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0)
    if (terms.length === 0) return []

    const ftsQuery = terms.map(t => `"${t}"*`).join(' AND ')

    let sql = `
      SELECT
        d.id,
        d.path,
        d.title,
        c.doc as content,
        d.hash,
        bm25(documents_fts) as bm25_score
      FROM documents_fts f
      JOIN documents d ON d.rowid = f.rowid
      JOIN content c ON c.hash = d.hash
      WHERE documents_fts MATCH ? AND d.active = 1
    `
    const params: any[] = [ftsQuery]

    if (collectionName) {
      sql += ` AND d.collection_id = (SELECT id FROM collections WHERE name = ?)`
      params.push(collectionName)
    }

    sql += ` ORDER BY bm25_score ASC LIMIT ?`
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as any[]

    return rows.map(row => {
      // Convert BM25 score to [0..1] where higher is better
      const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score))
      
      return {
        docId: row.id,
        path: row.path,
        title: row.title,
        content: row.content?.substring(0, 500) || '',
        score,
        collection: collectionName
      }
    })
  }

  /**
   * Index all collections
   */
  async indexAll(options: { incremental?: boolean } = {}): Promise<{ indexed: number; skipped: number; failed: number }> {
    const result = { indexed: 0, skipped: 0, failed: 0 }
    const collections = this.listCollections()

    for (const collection of collections) {
      console.log(`[Store] Indexing collection "${collection.name}"`)

      // Find all markdown files in the collection path
      const files = this.findMarkdownFiles(collection.path, collection.glob)

      for (const filePath of files) {
        try {
          const relativePath = path.relative(collection.path, filePath)
          const content = fs.readFileSync(filePath, 'utf-8')
          const parsed = matter(content)
          
          const title = parsed.data.title || path.basename(filePath, '.md')
          
          this.upsertDocument(
            collection.id,
            relativePath,
            title,
            parsed.content,
            parsed.data
          )

          result.indexed++
        } catch (err) {
          console.error(`[Store] Failed to index ${filePath}:`, err)
          result.failed++
        }
      }
    }

    console.log(`[Store] Indexed: ${result.indexed}, Failed: ${result.failed}`)
    return result
  }

  /**
   * Find markdown files matching glob pattern
   * Simple implementation without external glob dependency
   */
  private findMarkdownFiles(basePath: string, globPattern: string): string[] {
    const files: string[] = []
    
    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return
      
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        
        if (entry.isDirectory()) {
          scanDir(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath)
        }
      }
    }
    
    try {
      scanDir(basePath)
      return files
    } catch (err) {
      console.error('[Store] Error finding files:', err)
      return []
    }
  }

  // =============================================================================
  // Vector Search
  // =============================================================================

  /**
   * Vector semantic search
   * @param embedding - Pre-computed embedding vector (or null to skip vector search)
   */
  async searchVec(embedding: number[] | null, collectionName?: string, limit: number = 10): Promise<SearchResult[]> {
    const db = this.getDb()
    
    if (!embedding || embedding.length === 0) {
      return []
    }
    
    // Check if vectors_vec table exists
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get()
    if (!tableExists) {
      console.warn('[QMD] vectors_vec table does not exist')
      return []
    }

    // Step 1: Get vector matches from sqlite-vec
    const vecResults = db.prepare(`
      SELECT hash_seq, distance
      FROM vectors_vec
      WHERE embedding MATCH ? AND k = ?
    `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[]

    if (vecResults.length === 0) return []

    // Step 2: Get document data
    const hashSeqs = vecResults.map(r => r.hash_seq)
    const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]))

    const placeholders = hashSeqs.map(() => '?').join(',')
    let docSql = `
      SELECT
        cv.hash || '_' || cv.seq as hash_seq,
        cv.hash,
        cv.pos,
        d.collection_id,
        c.name as collection_name,
        d.path,
        d.title,
        content.doc as body
      FROM content_vectors cv
      JOIN documents d ON d.hash = cv.hash AND d.active = 1
      JOIN collections c ON c.id = d.collection_id
      JOIN content ON content.hash = d.hash
      WHERE cv.hash || '_' || cv.seq IN (${placeholders})
    `
    const params: any[] = [...hashSeqs]

    if (collectionName) {
      docSql += ` AND c.name = ?`
      params.push(collectionName)
    }

    const docRows = db.prepare(docSql).all(...params) as any[]

    // Combine with distances and dedupe by filepath
    const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>()
    for (const row of docRows) {
      const distance = distanceMap.get(row.hash_seq) ?? 1
      const key = `${row.collection_name}/${row.path}`
      const existing = seen.get(key)
      if (!existing || distance < existing.bestDist) {
        seen.set(key, { row, bestDist: distance })
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => a.bestDist - b.bestDist)
      .slice(0, limit)
      .map(({ row, bestDist }) => ({
        docId: row.hash.substring(0, 6),
        path: row.path,
        title: row.title,
        content: row.body?.substring(0, 500) || '',
        score: 1 - bestDist,
        collection: row.collection_name,
        source: 'vec' as const
      }))
  }

  /**
   * Hybrid search: BM25 + Vector with RRF fusion
   * @param embedding - Pre-computed embedding vector (or null to skip vector search)
   * @param options.rerank - Optional reranking function
   */
  async searchHybrid(
    query: string, 
    embedding: number[] | null, 
    collectionName?: string, 
    limit: number = 10,
    options?: {
      rerank?: (query: string, documents: { path: string; content: string }[]) => Promise<{ path: string; score: number }[]>
      weights?: { bm25: number; vec: number }
      rrfK?: number
    }
  ): Promise<SearchResult[]> {
    const weights = options?.weights || { bm25: 1.0, vec: 1.0 }
    const rrfK = options?.rrfK || 60
    
    // Run BM25 and Vector searches in parallel
    const [bm25Results, vecResults] = await Promise.all([
      this.searchBM25(query, collectionName, limit * 3),
      this.searchVec(embedding, collectionName, limit * 3).catch(() => [])
    ])

    // If no reranking, use simple RRF
    if (!options?.rerank) {
      return this.rrfCombine(bm25Results, vecResults, weights, rrfK, limit)
    }

    // RRF fusion first to get candidates for reranking
    const candidates = this.rrfCombine(bm25Results, vecResults, weights, rrfK, limit * 3)
    
    // Prepare documents for reranking
    const rerankDocs = candidates.map(c => ({
      path: c.path,
      content: c.content || ''
    }))

    // Call reranking function
    const reranked = await options.rerank(query, rerankDocs)
    const rerankScoreMap = new Map(reranked.map(r => [r.path, r.score]))

    // Blend RRF score with reranker score
    const rrfScoreMap = new Map(candidates.map((c, i) => [c.path, 1 / (rrfK + i + 1)]))
    
    return candidates.map(c => {
      const rrfScore = rrfScoreMap.get(c.path) || 0
      const rerankScore = rerankScoreMap.get(c.path) || 0
      
      // Blend: 40% RRF position, 60% reranker score
      const blendedScore = 0.4 * rrfScore + 0.6 * rerankScore
      
      return {
        ...c,
        score: blendedScore,
        source: 'hybrid' as const
      }
    }).sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Reciprocal Rank Fusion - combine multiple result lists
   */
  private rrfCombine(
    bm25Results: SearchResult[], 
    vecResults: SearchResult[],
    weights: { bm25: number; vec: number },
    k: number,
    limit: number
  ): SearchResult[] {
    const scores = new Map<string, { result: SearchResult; rrfScore: number }>()
    
    // BM25 results
    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i]
      if (!r) continue
      const rrfScore = weights.bm25 * (1 / (k + i + 1))
      const existing = scores.get(r.path)
      if (!existing) {
        scores.set(r.path, { result: r, rrfScore })
      } else {
        existing.rrfScore += rrfScore
      }
    }
    
    // Vector results  
    for (let i = 0; i < vecResults.length; i++) {
      const r = vecResults[i]
      if (!r) continue
      const rrfScore = weights.vec * (1 / (k + i + 1))
      const existing = scores.get(r.path)
      if (!existing) {
        scores.set(r.path, { result: r, rrfScore })
      } else {
        existing.rrfScore += rrfScore
        // Update score
        existing.result.score = (existing.result.score + r.score) / 2
      }
    }
    
    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(({ result, rrfScore }) => ({
        ...result,
        score: rrfScore,
        source: (bm25Results.length > 0 && vecResults.length > 0) ? 'hybrid' as const : result.source
      }))
  }

  /**
   * Get documents that need embeddings
   */
  getHashesForEmbedding(): { hash: string; body: string; path: string }[] {
    const db = this.getDb()
    return db.prepare(`
      SELECT d.hash, c.doc as body, MIN(d.path) as path
      FROM documents d
      JOIN content c ON d.hash = c.hash
      LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
      WHERE d.active = 1 AND v.hash IS NULL
      GROUP BY d.hash
    `).all() as { hash: string; body: string; path: string }[]
  }

  /**
   * Insert an embedding for a document chunk
   */
  async insertEmbedding(hash: string, seq: number, pos: number, embedding: number[]): Promise<void> {
    const db = this.getDb()
    const hashSeq = `${hash}_${seq}`
    const embeddedAt = new Date().toISOString()

    try {
      db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
        .run(hashSeq, new Float32Array(embedding))
      
      db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`)
        .run(hash, seq, pos, this.embeddingModel, embeddedAt)
    } catch (err) {
      console.error('[QMD] Failed to insert embedding:', err)
    }
  }

  /**
   * Clear all embeddings
   */
  clearAllEmbeddings(): void {
    const db = this.getDb()
    db.exec(`DELETE FROM content_vectors`)
    db.exec(`DROP TABLE IF EXISTS vectors_vec`)
    this.ensureVecTable(this.embeddingDimension)
  }

  /**
   * Set embedding model
   */
  setEmbeddingModel(model: string, dimension: number = 1536): void {
    this.embeddingModel = model
    this.embeddingDimension = dimension
    this.ensureVecTable(dimension)
  }

  /**
   * Get current embedding model
   */
  getEmbeddingModel(): string {
    return this.embeddingModel
  }

  /**
   * Get embedding dimension
   */
  getEmbeddingDimension(): number {
    return this.embeddingDimension
  }

  /**
   * Generate embedding for text using node-llama-cpp
   * @param text - Text to embed
   * @param isQuery - Whether this is a query (vs document)
   * @returns Embedding array or null on failure
   */
  async embedText(text: string, isQuery: boolean = false): Promise<number[] | null> {
    try {
      // Ensure model is loaded
      await this.ensureEmbeddingModel()
      
      if (!this.embeddingContextInstance) {
        console.error('[QMD] Embedding context not available')
        return null
      }
      
      // Format text for embedding
      const formattedText = isQuery 
        ? `task: search result | query: ${text}`
        : `title: none | text: ${text}`
      
      const embedding = await this.embeddingContextInstance.getEmbeddingFor(formattedText)
      
      return Array.from(embedding.vector)
    } catch (err) {
      console.error('[QMD] Failed to generate embedding:', err)
      return null
    }
  }

  /**
   * Ensure embedding model is loaded (lazy loading with caching)
   */
  private async ensureEmbeddingModel(): Promise<void> {
    // If already loaded, skip
    if (this.embeddingContextInstance) {
      return
    }
    
    // If loading in progress, wait for it
    if (this.modelLoading) {
      await this.modelLoading
      return
    }
    
    // Start loading
    this.modelLoading = this.loadEmbeddingModel()
    await this.modelLoading
    this.modelLoading = null
  }

  /**
   * Load the embedding model
   */
  private async loadEmbeddingModel(): Promise<void> {
    console.log(`[QMD] Loading embedding model: ${this.embeddingModel}...`)
    
    try {
      const { getLlama } = await import('node-llama-cpp')
      
      this.llamaInstance = await getLlama()
      console.log('[QMD] Llama instance ready')
      
      this.embeddingModelInstance = await this.llamaInstance.loadModel({
        modelPath: this.embeddingModel,
      })
      console.log('[QMD] Embedding model loaded:', this.embeddingModel)
      
      this.embeddingContextInstance = await this.embeddingModelInstance.createEmbeddingContext()
      console.log('[QMD] Embedding context ready, dimension:', this.embeddingDimension)
      
    } catch (err) {
      console.error('[QMD] Failed to load embedding model:', err)
      this.llamaInstance = null
      this.embeddingModelInstance = null
      this.embeddingContextInstance = null
      throw err
    }
  }

  /**
   * Preload embedding model (call this before first embedding to avoid delay)
   */
  async preloadEmbeddingModel(): Promise<void> {
    console.log('[QMD] Preloading embedding model...')
    await this.ensureEmbeddingModel()
    console.log('[QMD] Embedding model preloaded')
  }

  /**
   * Check if embedding model is loaded
   */
  isEmbeddingModelLoaded(): boolean {
    return this.embeddingContextInstance !== null
  }

  /**
   * Unload embedding model (free memory)
   */
  async unloadEmbeddingModel(): Promise<void> {
    if (this.embeddingContextInstance) {
      await this.embeddingContextInstance.dispose?.()
      this.embeddingContextInstance = null
    }
    if (this.embeddingModelInstance) {
      await this.embeddingModelInstance.dispose?.()
      this.embeddingModelInstance = null
    }
    // Note: we keep llamaInstance as it's shared
    console.log('[QMD] Embedding model unloaded')
  }

  /**
   * Generate query embedding
   * @param query - Query text
   * @returns Embedding array or null on failure
   */
  async embedQuery(query: string): Promise<number[] | null> {
    return this.embedText(query, true)
  }

  /**
   * Generate document embedding
   * @param text - Document text
   * @returns Embedding array or null on failure
   */
  async embedDocument(text: string): Promise<number[] | null> {
    return this.embedText(text, false)
  }

  /**
   * Batch embed multiple texts
   * @param texts - Array of texts to embed
   * @param isQuery - Whether these are queries (vs documents)
   * @returns Array of embeddings (null for failed embeddings)
   */
  async embedBatch(texts: string[], isQuery: boolean = false): Promise<(number[] | null)[]> {
    try {
      // Ensure model is loaded
      await this.ensureEmbeddingModel()
      
      if (!this.embeddingContextInstance) {
        console.error('[QMD] Embedding context not available')
        return texts.map(() => null)
      }
      
      const results: (number[] | null)[] = []
      
      for (const text of texts) {
        try {
          const formattedText = isQuery 
            ? `task: search result | query: ${text}`
            : `title: none | text: ${text}`
          
          const embedding = await this.embeddingContextInstance.getEmbeddingFor(formattedText)
          results.push(Array.from(embedding.vector))
        } catch (err) {
          console.error('[QMD] Embedding error for text:', err)
          results.push(null)
        }
      }
      
      return results
    } catch (err) {
      console.error('[QMD] Batch embedding failed:', err)
      return texts.map(() => null)
    }
  }

  /**
   * Embed all documents that need embedding
   * @param options.progress - Optional callback for progress updates
   * @returns Number of documents embedded
   */
  async embedAll(options?: {
    progress?: (current: number, total: number) => void
  }): Promise<number> {
    const hashes = this.getHashesForEmbedding()
    
    if (hashes.length === 0) {
      console.log('[QMD] No documents need embedding')
      return 0
    }
    
    console.log(`[QMD] Embedding ${hashes.length} documents...`)
    
    let embedded = 0
    
    for (let i = 0; i < hashes.length; i++) {
      const { hash, body } = hashes[i]
      
      options?.progress?.(i + 1, hashes.length)
      
      // Generate embedding for document
      const embedding = await this.embedDocument(body)
      
      if (embedding) {
        await this.insertEmbedding(hash, 0, 0, embedding)
        embedded++
      }
      
      // Log progress every 10 documents
      if ((i + 1) % 10 === 0) {
        console.log(`[QMD] Embedded ${i + 1}/${hashes.length} documents`)
      }
    }
    
    console.log(`[QMD] Embedded ${embedded}/${hashes.length} documents`)
    return embedded
  }

  // =============================================================================
  // Auto-watcher: Watch for file changes and auto-embed
  // =============================================================================

  private fileWatcher: any = null
  private autoEmbedTimer: NodeJS.Timeout | null = null
  private isWatching: boolean = false

  /**
   * Start watching collections for file changes and auto-embed
   * @param options.interval - Scan interval in ms (default: 60000 = 1 minute)
   * @param options.onChange - Callback when files change
   * @param options.debounce - Debounce time in ms (default: 2000)
   */
  startAutoEmbed(options?: {
    interval?: number
    onChange?: (event: 'add' | 'change' | 'unlink', path: string) => void
    debounce?: number
  }): void {
    if (this.isWatching) {
      console.warn('[QMD] Auto-embed already running')
      return
    }

    const interval = options?.interval ?? 60000
    const debounce = options?.debounce ?? 2000
    const pendingChanges = new Map<string, NodeJS.Timeout>()

    // Get all collection paths
    const getCollectionPaths = (): string[] => {
      const db = this.getDb()
      const rows = db.prepare('SELECT path FROM collections').all() as { path: string }[]
      return rows.map(r => r.path)
    }

    // Check for changes and embed
    const scanAndEmbed = async () => {
      try {
        const hashes = this.getHashesForEmbedding()
        
        if (hashes.length > 0) {
          console.log(`[QMD] Auto-embed: Found ${hashes.length} documents needing embedding`)
          
          for (const { hash, body } of hashes) {
            const embedding = await this.embedDocument(body)
            if (embedding) {
              await this.insertEmbedding(hash, 0, 0, embedding)
            }
          }
          
          console.log(`[QMD] Auto-embed: Processed ${hashes.length} documents`)
        }
      } catch (err) {
        console.error('[QMD] Auto-embed error:', err)
      }
    }

    // Use fs.watch for simplicity (or chokidar if available)
    const startWatching = async () => {
      const paths = getCollectionPaths()
      if (paths.length === 0) {
        console.log('[QMD] No collections to watch')
        return
      }

      // Dynamic import chokidar for better file watching
      let watcher: any = null
      try {
        const chokidar = await import('chokidar')
        watcher = chokidar.default || chokidar
      } catch {
        console.warn('[QMD] chokidar not available, using fs.watch')
      }

      if (watcher) {
        this.fileWatcher = watcher.watch(paths, {
          persistent: true,
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 1000,
            pollInterval: 100
          }
        })

        this.fileWatcher.on('add', (path: string) => {
          console.log(`[QMD] File added: ${path}`)
          options?.onChange?.('add', path)
          
          // Debounce embedding
          const key = `add:${path}`
          pendingChanges.set(key, setTimeout(() => {
            pendingChanges.delete(key)
            scanAndEmbed()
          }, debounce))
        })

        this.fileWatcher.on('change', (path: string) => {
          console.log(`[QMD] File changed: ${path}`)
          options?.onChange?.('change', path)
          
          const key = `change:${path}`
          pendingChanges.set(key, setTimeout(() => {
            pendingChanges.delete(key)
            scanAndEmbed()
          }, debounce))
        })

        this.fileWatcher.on('unlink', (path: string) => {
          console.log(`[QMD] File removed: ${path}`)
          options?.onChange?.('unlink', path)
        })
      } else {
        // Fallback: use setInterval for periodic scanning
        console.log('[QMD] Using periodic scanning (no file watcher)')
      }

      // Start periodic scan
      this.autoEmbedTimer = setInterval(scanAndEmbed, interval)
      this.isWatching = true
      
      console.log(`[QMD] Auto-embed started (interval: ${interval}ms)`)
    }

    startWatching()
  }

  /**
   * Stop watching and auto-embedding
   */
  stopAutoEmbed(): void {
    if (this.autoEmbedTimer) {
      clearInterval(this.autoEmbedTimer)
      this.autoEmbedTimer = null
    }

    if (this.fileWatcher) {
      this.fileWatcher.close?.()
      this.fileWatcher = null
    }

    this.isWatching = false
    console.log('[QMD] Auto-embed stopped')
  }

  /**
   * Check if auto-embed is running
   */
  isAutoEmbedRunning(): boolean {
    return this.isWatching
  }

  /**
   * Close database connection and unload models
   */
  async close(): Promise<void> {
    // Stop auto-embed first
    this.stopAutoEmbed()
    
    // Unload embedding model
    await this.unloadEmbeddingModel()
    
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export default QMDStore
