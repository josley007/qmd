/**
 * QMD Store - Simplified Node.js version
 *
 * Core database operations for QMD search engine
 * Using better-sqlite3 instead of bun:sqlite
 */
import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import matter from 'gray-matter';
export class QMDStore {
    dataDir;
    db = null;
    dbPath;
    constructor(dataDir = './qmd-data') {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, 'index.sqlite');
    }
    /**
     * Initialize the database
     */
    initialize() {
        // Ensure directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.db = new BetterSqlite3(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.createTables();
        console.log('[Store] Initialized at', this.dbPath);
    }
    /**
     * Create database tables
     */
    createTables() {
        if (!this.db)
            throw new Error('Database not initialized');
        // Collections table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        path TEXT NOT NULL,
        glob TEXT DEFAULT '**/*.md',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
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
    `);
        // Content table (separated for FTS)
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        title TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // Indexes
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_content_hash ON content(hash)`);
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
    `);
        // Triggers to keep FTS in sync
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, title, doc) 
        VALUES (NEW.rowid, NEW.title, NEW.content);
      END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, doc) 
        VALUES('delete', OLD.rowid, OLD.title, OLD.content);
      END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, doc) 
        VALUES('delete', OLD.rowid, OLD.title, OLD.content);
        INSERT INTO documents_fts(rowid, title, doc) 
        VALUES (NEW.rowid, NEW.title, NEW.content);
      END
    `);
        // Vectors table (for semantic search)
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        doc_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    }
    /**
     * Get database instance
     */
    getDb() {
        if (!this.db)
            throw new Error('Database not initialized');
        return this.db;
    }
    /**
     * Add a collection
     */
    addCollection(name, collectionPath, glob = '**/*.md') {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT OR IGNORE INTO collections (name, path, glob) VALUES (?, ?, ?)`);
        stmt.run(name, collectionPath, glob);
    }
    /**
     * Get collection by name
     */
    getCollection(name) {
        const db = this.getDb();
        const stmt = db.prepare('SELECT * FROM collections WHERE name = ?');
        return stmt.get(name);
    }
    /**
     * List collections
     */
    listCollections() {
        const db = this.getDb();
        const stmt = db.prepare('SELECT * FROM collections');
        return stmt.all();
    }
    /**
     * Remove collection
     */
    removeCollection(name) {
        const db = this.getDb();
        const stmt = db.prepare('DELETE FROM collections WHERE name = ?');
        stmt.run(name);
    }
    /**
     * Generate document ID from hash
     */
    getDocid(hash) {
        return hash.substring(0, 6);
    }
    /**
     * Add or update a document
     */
    upsertDocument(collectionId, docPath, title, content, frontmatter) {
        const db = this.getDb();
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const id = this.getDocid(hash);
        // Check if document exists
        const existing = db.prepare('SELECT id FROM documents WHERE collection_id = ? AND path = ?').get(collectionId, docPath);
        if (existing) {
            // Update
            db.prepare(`
        UPDATE documents 
        SET title = ?, content = ?, hash = ?, frontmatter = ?, updated_at = CURRENT_TIMESTAMP
        WHERE collection_id = ? AND path = ?
      `).run(title, content, hash, JSON.stringify(frontmatter), collectionId, docPath);
        }
        else {
            // Insert
            db.prepare(`
        INSERT INTO documents (id, collection_id, path, title, content, hash, frontmatter)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, collectionId, docPath, title, content, hash, JSON.stringify(frontmatter));
        }
        // Upsert content
        db.prepare(`
      INSERT OR REPLACE INTO content (hash, doc, title, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(hash, content, title);
        // Also insert into FTS directly (for when triggers don't work)
        try {
            db.prepare(`
        INSERT OR REPLACE INTO documents_fts(rowid, title, doc)
        SELECT d.rowid, d.title, d.content FROM documents d WHERE d.hash = ?
      `).run(hash);
        }
        catch (e) {
            // Ignore FTS errors
        }
        return id;
    }
    /**
     * Get document by path
     */
    getDocument(docPath) {
        const db = this.getDb();
        const stmt = db.prepare('SELECT path, content, frontmatter FROM documents WHERE path = ?');
        const row = stmt.get(docPath);
        if (!row)
            return null;
        return {
            path: row.path,
            content: row.content,
            frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : {}
        };
    }
    /**
     * BM25 full-text search
     */
    searchBM25(query, collectionName, limit = 10) {
        const db = this.getDb();
        // Build FTS query
        const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        if (terms.length === 0)
            return [];
        const ftsQuery = terms.map(t => `"${t}"*`).join(' AND ');
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
    `;
        const params = [ftsQuery];
        if (collectionName) {
            sql += ` AND d.collection_id = (SELECT id FROM collections WHERE name = ?)`;
            params.push(collectionName);
        }
        sql += ` ORDER BY bm25_score ASC LIMIT ?`;
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        return rows.map(row => {
            // Convert BM25 score to [0..1] where higher is better
            const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
            return {
                docId: row.id,
                path: row.path,
                title: row.title,
                content: row.content?.substring(0, 500) || '',
                score,
                collection: collectionName
            };
        });
    }
    /**
     * Index all collections
     */
    async indexAll(options = {}) {
        const result = { indexed: 0, skipped: 0, failed: 0 };
        const collections = this.listCollections();
        for (const collection of collections) {
            console.log(`[Store] Indexing collection "${collection.name}"`);
            // Find all markdown files in the collection path
            const files = this.findMarkdownFiles(collection.path, collection.glob);
            for (const filePath of files) {
                try {
                    const relativePath = path.relative(collection.path, filePath);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const parsed = matter(content);
                    const title = parsed.data.title || path.basename(filePath, '.md');
                    this.upsertDocument(collection.id, relativePath, title, parsed.content, parsed.data);
                    result.indexed++;
                }
                catch (err) {
                    console.error(`[Store] Failed to index ${filePath}:`, err);
                    result.failed++;
                }
            }
        }
        console.log(`[Store] Indexed: ${result.indexed}, Failed: ${result.failed}`);
        return result;
    }
    /**
     * Find markdown files matching glob pattern
     */
    findMarkdownFiles(basePath, globPattern) {
        const { globSync } = require('glob');
        try {
            const files = globSync(globPattern, {
                cwd: basePath,
                absolute: false,
                nodir: true
            });
            return files.map((f) => path.join(basePath, f));
        }
        catch (err) {
            console.error('[Store] Error finding files:', err);
            return [];
        }
    }
    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
export default QMDStore;
//# sourceMappingURL=store.js.map