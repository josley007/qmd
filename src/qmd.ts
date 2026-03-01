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

/**
 * Sanitize a term for FTS5 query to prevent injection.
 * Removes characters that have special meaning in FTS5: " * ^
 */
function sanitizeFtsTerm(term: string): string {
  return term.replace(/["*^\\]/g, '')
}

/**
 * Escape special LIKE wildcard characters (% and _) in a string.
 * Use with `ESCAPE '\'` clause.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export class QMDStore {
  private db: BetterSqlite3.Database | null = null
  private dbPath: string
  private embeddingModel: string = ''  // 需要用户配置完整路径
  private rerankModel: string = ''    // Reranker 模型
  private embeddingDimension: number = 768  // embeddinggemma-300M 默认 768 维
  
  // Model caching
  private llamaInstance: any = null
  private embeddingModelInstance: any = null
  private embeddingContextInstance: any = null
  private rerankModelInstance: any = null
  private rerankContextInstance: any = null
  private embeddingModelLoading: Promise<any> | null = null
  private rerankModelLoading: Promise<any> | null = null

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
    // Use unicode61 for better CJK support (each CJK character becomes a token)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts 
      USING fts5(
        title,
        doc,
        content=documents,
        content_rowid=rowid,
        tokenize='unicode61'
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
        const existingDims = match?.[1] != null ? parseInt(match[1], 10) : null
        if (existingDims !== null && existingDims === dimensions) return
        
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
   * Generate document ID from hash (use path + content to avoid collisions)
   */
  private getDocid(hash: string, path: string): string {
    // Combine hash and path to avoid collisions
    const combined = hash + '|' + path
    return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 12)
  }

  /**
   * Add or update a document
   */
  upsertDocument(collectionId: number, docPath: string, title: string, content: string, frontmatter: Record<string, unknown>): string {
    const db = this.getDb()
    const hash = crypto.createHash('md5').update(content).digest('hex')
    const id = this.getDocid(hash, docPath)

    // Check if document exists
    const existing = db.prepare('SELECT id, hash FROM documents WHERE collection_id = ? AND path = ?').get(collectionId, docPath) as { id: string; hash: string } | undefined

    if (existing) {
      // Clean up orphaned embeddings when content hash changes
      if (existing.hash && existing.hash !== hash) {
        const otherRefs = (db.prepare(
          'SELECT COUNT(*) as count FROM documents WHERE hash = ? AND NOT (collection_id = ? AND path = ?)'
        ).get(existing.hash, collectionId, docPath) as any)?.count || 0
        if (otherRefs === 0) {
          db.prepare('DELETE FROM content_vectors WHERE hash = ?').run(existing.hash)
          db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? ESCAPE '\\'").run(escapeLikePattern(existing.hash) + '\\_%')
          db.prepare('DELETE FROM content WHERE hash = ?').run(existing.hash)
        }
      }
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
      console.warn('[QMD] FTS sync failed:', e)
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

    const ftsQuery = terms.map(t => {
      const sanitized = sanitizeFtsTerm(t)
      return sanitized ? `"${sanitized}"*` : null
    }).filter(Boolean).join(' AND ')
    if (!ftsQuery) return []
    console.log(`[QMD] BM25 search: query="${query}", fts="${ftsQuery}"`)

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
    console.log(`[QMD] BM25 results: ${rows.length}`, rows.map(r => ({ path: r.path, score: r.bm25_score })))

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

    const db = this.getDb()

    for (const collection of collections) {
      console.log(`[Store] Indexing collection "${collection.name}"`)

      // Find all markdown files in the collection path
      const files = this.findMarkdownFiles(collection.path, collection.glob)
      const seenPaths = new Set<string>()

      for (const filePath of files) {
        try {
          const relativePath = path.relative(collection.path, filePath)
          seenPaths.add(relativePath)
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

      // Mark documents that no longer exist on disk as inactive
      const activeDocs = db.prepare(
        'SELECT path FROM documents WHERE collection_id = ? AND active = 1'
      ).all(collection.id) as { path: string }[]

      for (const doc of activeDocs) {
        if (!seenPaths.has(doc.path)) {
          db.prepare('UPDATE documents SET active = 0 WHERE collection_id = ? AND path = ?')
            .run(collection.id, doc.path)
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
   * @param embedding - Pre-computed query embedding vector (or null to skip vector search)
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

    console.log(`[QMD] Vector search: ${vecResults.length} results`, vecResults.slice(0, 3).map(r => ({ hash_seq: r.hash_seq.substring(0, 20), distance: r.distance })))

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
   * Hybrid search: BM25 + Vector with RRF fusion and reranking
   * @param embedding - Pre-computed query embedding vector (optional)
   * @param options.rerank - External reranking function (optional)
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
      enableRerank?: boolean  // 默认开启
    }
  ): Promise<SearchResult[]> {
    const weights = options?.weights || { bm25: 1.0, vec: 1.0 }
    const rrfK = options?.rrfK || 60
    const enableRerank = options?.enableRerank !== false  // 默认开启
    
    // Run BM25 and Vector searches in parallel
    const [bm25Results, vecResults] = await Promise.all([
      this.searchBM25(query, collectionName, limit * 4),
      this.searchVec(embedding, collectionName, limit * 4).catch(() => [])
    ])

    // If only one source has results, return directly with proper scores
    if (bm25Results.length > 0 && vecResults.length === 0) {
      console.log('[QMD] Using BM25 only (no vector results)')
      return bm25Results.slice(0, limit)
    }
    if (bm25Results.length === 0 && vecResults.length > 0) {
      console.log('[QMD] Using vector only (no BM25 results)')
      return vecResults.slice(0, limit)
    }
    if (bm25Results.length === 0 && vecResults.length === 0) {
      console.log('[QMD] No results from either source')
      return []
    }
    
    // Both sources have results - use RRF
    const candidates = this.rrfCombine(bm25Results, vecResults, weights, rrfK, limit * 4)
    console.log(`[QMD] RRF combined: ${candidates.length} candidates`, candidates.slice(0, 5).map(c => ({ path: c.path, score: c.score.toFixed(4) })))
    
    // If no reranking needed, return directly
    if (!enableRerank || (!embedding && !options?.rerank)) {
      return candidates.slice(0, limit)
    }
    
    // Reranking
    let finalResults: SearchResult[] = []
    
    // 优先使用 reranker 模型
    if (this.rerankContextInstance) {
      try {
        console.log('[QMD] Using reranker model for re-ranking...')
        finalResults = await this.rerankWithModel(query, candidates, limit)
      } catch (err) {
        console.warn('[QMD] Reranker failed, fallback to embedding rerank:', err)
        if (embedding && embedding.length > 0) {
          finalResults = await this.rerankWithEmbedding(query, embedding, candidates, limit)
        } else {
          finalResults = this.rerankWithKeywords(query, candidates, limit)
        }
      }
    } else if (options?.rerank) {
      // External reranking function
      const rerankDocs = candidates.map(c => ({
        path: c.path,
        content: c.content || ''
      }))
      const reranked = await options.rerank(query, rerankDocs)
      const rerankScoreMap = new Map(reranked.map(r => [r.path, r.score]))
      const rrfScoreMap = new Map(candidates.map((c, i) => [c.path, 1 / (rrfK + i + 1)]))
      
      finalResults = candidates.map(c => {
        const rrfScore = rrfScoreMap.get(c.path) || 0
        const rerankScore = rerankScoreMap.get(c.path) || 0
        const blendedScore = 0.4 * rrfScore + 0.6 * rerankScore
        return { ...c, score: blendedScore, source: 'hybrid' as const }
      }).sort((a, b) => b.score - a.score).slice(0, limit)
      
    } else if (embedding && embedding.length > 0) {
      // Internal reranking using query embedding
      finalResults = await this.rerankWithEmbedding(query, embedding, candidates, limit)
    } else {
      // No embedding, use keyword-based reranking
      finalResults = this.rerankWithKeywords(query, candidates, limit)
    }
    
    return finalResults
  }

  /**
   * Rerank using reranker model
   */
  private async rerankWithModel(
    query: string, 
    candidates: SearchResult[],
    limit: number
  ): Promise<SearchResult[]> {
    if (!this.rerankContextInstance) {
      throw new Error('Rerank model not loaded')
    }
    
    const texts = candidates.map(c => c.content || '')
    
    // Use ranking context
    const ranked = await this.rerankContextInstance.rankAndSort(query, texts)
    
    // Map back to results
    const scoreMap = new Map<number, number>()
    ranked.forEach((item: { document: string, score: number }, idx: number) => {
      scoreMap.set(idx, item.score)
    })
    
    return candidates.map((c, idx) => ({
      ...c,
      score: scoreMap.get(idx) || c.score,
      source: 'hybrid' as const
    })).sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Internal reranking using query embedding
   */
  private async rerankWithEmbedding(
    query: string, 
    queryEmbedding: number[],
    candidates: SearchResult[],
    limit: number
  ): Promise<SearchResult[]> {
    const db = this.getDb()
    
    // Get embeddings for candidate documents
    const candidateHashes = candidates.map(c => c.docId).filter(Boolean)
    if (candidateHashes.length === 0) {
      return candidates.slice(0, limit)
    }
    
    // Query embeddings from vectors table
    const placeholders = candidateHashes.map(() => '?').join(',')
    const vecRows = db.prepare(`
      SELECT cv.hash, v.embedding
      FROM content_vectors cv
      JOIN vectors_vec v ON v.hash_seq = cv.hash || '_' || cv.seq
      WHERE cv.hash IN (${placeholders})
    `).all(...candidateHashes) as { hash: string; embedding: Float32Array }[]
    
    // Build hash -> embedding map
    const hashEmbeddings = new Map<string, Float32Array>()
    for (const row of vecRows) {
      hashEmbeddings.set(row.hash, row.embedding)
    }
    
    // Calculate similarity scores
    const scored = candidates.map(c => {
      const emb = hashEmbeddings.get(c.docId)
      if (!emb) {
        return { ...c, rerankScore: c.score }
      }
      
      // Cosine similarity
      let dot = 0
      let norm1 = 0
      let norm2 = 0
      for (let i = 0; i < queryEmbedding.length && i < emb.length; i++) {
        dot += queryEmbedding[i] * emb[i]
        norm1 += queryEmbedding[i] * queryEmbedding[i]
        norm2 += emb[i] * emb[i]
      }
      const similarity = norm1 > 0 && norm2 > 0 ? dot / (Math.sqrt(norm1) * Math.sqrt(norm2)) : 0
      
      return { ...c, rerankScore: similarity }
    })
    
    // Sort by rerank score
    return scored.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit).map(r => ({
      ...r,
      score: r.rerankScore,
      source: 'hybrid' as const
    }))
  }

  /**
   * Keyword-based reranking (lightweight fallback)
   */
  private rerankWithKeywords(
    query: string, 
    candidates: SearchResult[], 
    limit: number
  ): SearchResult[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
    if (queryTerms.length === 0) {
      return candidates.slice(0, limit)
    }
    
    const scored = candidates.map(c => {
      const content = (c.title + ' ' + (c.content || '')).toLowerCase()
      let matchScore = 0
      
      for (const term of queryTerms) {
        if (content.includes(term)) {
          matchScore += 1
          // Boost exact matches
          if (content.includes(term + ' ')) {
            matchScore += 0.5
          }
        }
      }
      
      // Combine with original score
      const finalScore = c.score * 0.3 + (matchScore / queryTerms.length) * 0.7
      
      return { ...c, rerankScore: finalScore }
    })
    
    return scored.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit).map(r => ({
      ...r,
      score: r.rerankScore,
      source: 'hybrid' as const
    }))
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

    // Normalize scores to 0-1 range (higher is better)
    const maxScore = Math.max(...Array.from(scores.values()).map(s => s.rrfScore), 0.0001)
    
    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(({ result, rrfScore }) => ({
        ...result,
        score: rrfScore / maxScore,  // Normalize to 0-1
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
   * @param model - 模型路径或模型名称 (会从默认位置查找)
   * @param dimension - 向量维度
   */
  setEmbeddingModel(model: string, dimension: number = 768): void {
    this.embeddingModel = model
    this.embeddingDimension = dimension
    this.ensureVecTable(dimension)
  }

  /**
   * Get current embedding model
   */
  getEmbeddingModel(): string {
    return this.embeddingModel || '未配置'
  }

  /**
   * Set rerank model
   * @param model - 模型路径或 HuggingFace URI
   */
  setRerankModel(model: string): void {
    this.rerankModel = model
  }

  /**
   * Get current rerank model
   */
  getRerankModel(): string {
    return this.rerankModel || '未配置'
  }

  /**
   * Get default model search paths
   */
  private getDefaultModelPaths(): string[] {
    const paths: string[] = []
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA || ''
    
    // violoop 数据目录
    if (appData) {
      paths.push(path.join(appData, 'violoop', 'models'))
    }
    if (home) {
      paths.push(path.join(home, '.violoop', 'models'))
      paths.push(path.join(home, '.cache', 'violoop', 'models'))
    }
    
    // 通用模型目录
    paths.push(path.join(home, 'models'))
    paths.push(path.join(home, '.cache', 'models'))
    
    return paths
  }

  /**
   * Find model file
   */
  private findModelFile(modelName: string): string | null {
    const paths = this.getDefaultModelPaths()
    const extensions = ['', '.gguf', '.bin', '.q4_k_m.gguf', '.Q4_K_M.gguf']
    
    for (const basePath of paths) {
      for (const ext of extensions) {
        const fullPath = path.join(basePath, modelName + ext)
        try {
          if (fs.existsSync(fullPath)) {
            return fullPath
          }
        } catch {}
      }
    }
    
    // 直接检查是否是绝对路径
    if (fs.existsSync(modelName)) {
      return modelName
    }
    
    return null
  }

  /**
   * Resolve model path - auto download if needed
   */
  private async resolveModelPath(): Promise<string | null> {
    // 如果已经配置了模型路径
    if (this.embeddingModel && fs.existsSync(this.embeddingModel)) {
      return this.embeddingModel
    }
    
    try {
      const { resolveModelFile } = await import('node-llama-cpp')
      
      // 默认模型 - 使用 HuggingFace URI 格式
      const defaultModel = this.embeddingModel || 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf'
      
      console.log(`[QMD] Resolving embedding model: ${defaultModel}...`)
      
      // 自动下载模型
      const modelPath = await resolveModelFile(defaultModel)
      
      console.log(`[QMD] Model resolved to: ${modelPath}`)
      
      return modelPath
    } catch (err) {
      console.error('[QMD] Failed to resolve model:', err)
      return null
    }
  }

  /**
   * Resolve rerank model path - auto download if needed
   */
  private async resolveRerankModelPath(): Promise<string | null> {
    if (this.rerankModel && fs.existsSync(this.rerankModel)) {
      return this.rerankModel
    }
    
    try {
      const { resolveModelFile } = await import('node-llama-cpp')
      
      // 默认 reranker 模型 - 使用 HuggingFace URI 格式
      const defaultModel = this.rerankModel || 'hf:ggml-org/Qwen3-Reranker-0.6B-GGUF/qwen3-reranker-0.6b-q8_0.gguf'
      
      console.log(`[QMD] Resolving rerank model: ${defaultModel}...`)
      
      const modelPath = await resolveModelFile(defaultModel)
      
      console.log(`[QMD] Rerank model resolved to: ${modelPath}`)
      
      return modelPath
    } catch (err) {
      console.error('[QMD] Failed to resolve rerank model:', err)
      return null
    }
  }

  /**
   * Ensure rerank model is loaded
   */
  private async ensureRerankModel(): Promise<void> {
    if (this.rerankContextInstance) {
      return
    }

    if (this.rerankModelLoading) {
      await this.rerankModelLoading
      return
    }

    this.rerankModelLoading = this.loadRerankModel()
    await this.rerankModelLoading
    this.rerankModelLoading = null
  }

  /**
   * Load rerank model
   */
  private async loadRerankModel(): Promise<void> {
    const modelPath = await this.resolveRerankModelPath()
    
    if (!modelPath) {
      console.warn('[QMD] No rerank model found, reranking will be skipped')
      return
    }
    
    console.log(`[QMD] Loading rerank model: ${modelPath}...`)
    
    try {
      if (!this.llamaInstance) {
        const { getLlama } = await import('node-llama-cpp')
        this.llamaInstance = await getLlama()
      }
      
      this.rerankModelInstance = await this.llamaInstance.loadModel({
        modelPath: modelPath,
      })
      console.log('[QMD] Rerank model loaded:', modelPath)
      
      this.rerankContextInstance = await this.rerankModelInstance.createRankingContext()
      console.log('[QMD] Rerank context ready')
      
    } catch (err) {
      console.error('[QMD] Failed to load rerank model:', err)
      this.rerankModelInstance = null
      this.rerankContextInstance = null
    }
  }

  /**
   * Check if rerank model is loaded
   */
  isRerankModelLoaded(): boolean {
    return this.rerankContextInstance !== null
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
    if (this.embeddingModelLoading) {
      await this.embeddingModelLoading
      return
    }

    // Start loading
    this.embeddingModelLoading = this.loadEmbeddingModel()
    await this.embeddingModelLoading
    this.embeddingModelLoading = null
  }

  /**
   * Load the embedding model
   */
  private async loadEmbeddingModel(): Promise<void> {
    // 解析模型路径 (自动下载)
    const modelPath = await this.resolveModelPath()
    
    if (!modelPath) {
      const msg = '[QMD] No embedding model found. Please set embedding model path or check network connection.'
      console.warn(msg)
      console.warn('[QMD] You can manually download models from: https://huggingface.co/models?search=embedding')
      throw new Error('No embedding model found')
    }
    
    console.log(`[QMD] Loading embedding model: ${modelPath}...`)
    
    try {
      const { getLlama } = await import('node-llama-cpp')
      
      this.llamaInstance = await getLlama()
      console.log('[QMD] Llama instance ready')
      
      this.embeddingModelInstance = await this.llamaInstance.loadModel({
        modelPath: modelPath,
      })
      console.log('[QMD] Embedding model loaded:', modelPath)
      
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
   * Preload rerank model
   */
  async preloadRerankModel(): Promise<void> {
    console.log('[QMD] Preloading rerank model...')
    await this.ensureRerankModel()
    console.log('[QMD] Rerank model preloaded')
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
    // Check if embedding model is loaded
    if (!this.isEmbeddingModelLoaded()) {
      console.log('[QMD] Embedding model not loaded, skipping embedAll')
      this.logEmbeddingStatus()
      return 0
    }
    
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
  private pendingChanges: Map<string, NodeJS.Timeout> = new Map()

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

    // Get all collection paths
    const getCollectionPaths = (): string[] => {
      const db = this.getDb()
      const rows = db.prepare('SELECT path FROM collections').all() as { path: string }[]
      return rows.map(r => r.path)
    }

    // Check for changes and embed
    const scanAndEmbed = async () => {
      try {
        const status = this.getEmbeddingStatus()
        console.log(`[QMD] Embedding check: ${status.embedded}/${status.total} embedded, ${status.pending} pending`)
        
        const hashes = this.getHashesForEmbedding()
        
        if (hashes.length > 0) {
          console.log(`[QMD] Auto-embed: Generating embeddings for ${hashes.length} documents...`)
          
          let embedded = 0
          for (const { hash, body, path } of hashes) {
            const embedding = await this.embedDocument(body)
            if (embedding) {
              await this.insertEmbedding(hash, 0, 0, embedding)
              embedded++
            }
          }
          
          console.log(`[QMD] Auto-embed: Done! ${embedded}/${hashes.length} documents embedded`)
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

          // Debounce embedding - clear old timer for same key before setting new one
          const key = `add:${path}`
          const oldTimer = this.pendingChanges.get(key)
          if (oldTimer) clearTimeout(oldTimer)
          this.pendingChanges.set(key, setTimeout(() => {
            this.pendingChanges.delete(key)
            scanAndEmbed()
          }, debounce))
        })

        this.fileWatcher.on('change', (path: string) => {
          console.log(`[QMD] File changed: ${path}`)
          options?.onChange?.('change', path)

          const key = `change:${path}`
          const oldTimer = this.pendingChanges.get(key)
          if (oldTimer) clearTimeout(oldTimer)
          this.pendingChanges.set(key, setTimeout(() => {
            this.pendingChanges.delete(key)
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

      // Start periodic scan using setTimeout self-scheduling (backpressure-safe)
      const scheduleNext = () => {
        this.autoEmbedTimer = setTimeout(async () => {
          await scanAndEmbed()
          if (this.isWatching) scheduleNext()
        }, interval)
      }
      this.isWatching = true
      scheduleNext()

      console.log(`[QMD] Auto-embed started (interval: ${interval}ms)`)
    }

    startWatching().catch(err => console.error('[QMD] startWatching failed:', err))
  }

  /**
   * Stop watching and auto-embedding
   */
  stopAutoEmbed(): void {
    if (this.autoEmbedTimer) {
      clearTimeout(this.autoEmbedTimer)
      this.autoEmbedTimer = null
    }

    if (this.fileWatcher) {
      this.fileWatcher.close?.()
      this.fileWatcher = null
    }

    // Clear all pending debounce timers
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer)
    }
    this.pendingChanges.clear()

    this.isWatching = false
    console.log('[QMD] Auto-embed stopped')
  }

  /**
   * Get embedding status - how many documents have embeddings
   */
  getEmbeddingStatus(): { total: number; embedded: number; pending: number } {
    try {
      const db = this.getDb()
      
      // Total documents
      const total = (db.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as any)?.count || 0
      
      // Documents with embeddings (only count active documents)
      const embedded = (db.prepare(
        'SELECT COUNT(DISTINCT cv.hash) as count FROM content_vectors cv JOIN documents d ON d.hash = cv.hash AND d.active = 1'
      ).get() as any)?.count || 0
      
      // Pending
      const pending = total - embedded
      
      return { total, embedded, pending }
    } catch (err) {
      console.warn('[QMD] Failed to get embedding status:', err)
      return { total: 0, embedded: 0, pending: 0 }
    }
  }

  /**
   * Log embedding status
   */
  logEmbeddingStatus(): void {
    const status = this.getEmbeddingStatus()
    console.log(`[QMD] Embedding status: ${status.embedded}/${status.total} embedded, ${status.pending} pending`)
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
