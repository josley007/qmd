/**
 * Memoir Memory - Tree-structured memory system
 *
 * 记忆按层级 key 组织，如: life.work.project-a
 * 支持在 LLM 提示词中嵌入记忆树目录
 *
 * 目录结构:
 * memory/
 * ├── life/
 * │   ├── work/
 * │   │   └── project-a.md
 * │   └── personal/
 * │       └── health.md
 * └── skills/
 *     └── programming/
 *         └── javascript.md
 */
import path from 'path';
import fs from 'fs';
import matter from 'gray-matter';
import { QMD } from '../index.js';
export class Memoir {
    qmd;
    memoryDir;
    constructor(options = {}) {
        this.memoryDir = options.memoryDir || './memory';
        this.qmd = new QMD({ dataDir: options.dataDir || './memoir-data' });
    }
    /**
     * 初始化记忆系统
     * @param options.autoEmbed - 是否自动生成 embedding (默认 true)
     * @param options.autoRerank - 是否自动加载 reranker 模型 (默认 true)
     */
    async initialize(options) {
        const autoEmbed = options?.autoEmbed !== false; // 默认开启
        const autoRerank = options?.autoRerank !== false; // 默认开启
        await fs.promises.mkdir(this.memoryDir, { recursive: true });
        await this.qmd.initialize();
        await this.qmd.addCollection('memory', this.memoryDir);
        await this.qmd.reindex();
        // 后台异步生成 embedding (不阻塞启动)
        if (autoEmbed) {
            console.log('[Memoir] Background: Generating embeddings...');
            this.qmd.preloadEmbeddingModel()
                .then(async () => {
                const count = await this.qmd.embedAll();
                this.qmd.logEmbeddingStatus();
                console.log(`[Memoir] Background: Done! ${count} embeddings generated`);
            })
                .catch((err) => {
                console.warn('[Memoir] Background embed failed:', err?.message || err);
                this.qmd.logEmbeddingStatus();
            });
        }
        // 后台异步加载 reranker 模型 (不阻塞启动)
        if (autoRerank) {
            console.log('[Memoir] Background: Loading reranker model...');
            this.qmd.preloadRerankModel()
                .then(() => {
                console.log('[Memoir] Background: Reranker model loaded');
            })
                .catch((err) => {
                console.warn('[Memoir] Background reranker load failed:', err?.message || err);
            });
        }
    }
    /**
     * 解析 key 为路径
     * life.work.project-a -> life/work/project-a.md
     */
    keyToPath(key) {
        const parts = key.split('.').map(p => p.trim()).filter(p => p);
        const fileName = parts[parts.length - 1] + '.md';
        const dirPath = parts.slice(0, -1).join('/');
        return {
            dir: path.join(this.memoryDir, dirPath),
            file: path.join(this.memoryDir, dirPath, fileName),
            parts
        };
    }
    /**
     * 从文件路径解析 key
     * filePath 可能是绝对路径或相对路径
     */
    pathToKey(filePath) {
        // 如果是相对路径，直接替换
        if (!path.isAbsolute(filePath)) {
            return filePath.replace(/\.md$/, '').replace(/\//g, '.');
        }
        // 如果是绝对路径，计算相对于 memoryDir 的路径
        const relative = path.relative(this.memoryDir, filePath);
        const key = relative
            .replace(/\.md$/, '')
            .replace(/\//g, '.');
        return key;
    }
    /**
     * 添加或更新记忆
     */
    async set(key, content, metadata = {}) {
        const { dir, file } = this.keyToPath(key);
        await fs.promises.mkdir(dir, { recursive: true });
        let existingData = {};
        let existingContent = '';
        try {
            const raw = await fs.promises.readFile(file, 'utf-8');
            const parsed = matter(raw);
            existingData = parsed.data;
            existingContent = parsed.content;
        }
        catch (e) {
            // 文件不存在，创建新的
        }
        // Filter out undefined values from metadata
        const cleanMetadata = {};
        for (const [k, v] of Object.entries(metadata)) {
            if (v !== undefined) {
                cleanMetadata[k] = v;
            }
        }
        const frontmatter = {
            id: String(cleanMetadata.id || key),
            key: key,
            type: String(cleanMetadata.type || 'archival'),
            ...existingData,
            ...cleanMetadata,
            updated_at: new Date().toISOString()
        };
        const raw = matter.stringify(content, frontmatter);
        await fs.promises.writeFile(file, raw, 'utf-8');
        await this.qmd.reindex();
        return { key, file };
    }
    /**
     * 获取记忆
     */
    async get(key) {
        const { file } = this.keyToPath(key);
        try {
            const raw = await fs.promises.readFile(file, 'utf-8');
            const parsed = matter(raw);
            return {
                key,
                content: parsed.content,
                frontmatter: parsed.data
            };
        }
        catch (e) {
            return null;
        }
    }
    /**
     * 删除记忆
     */
    async delete(key) {
        const possiblePaths = [];
        // Standard keyToPath (treats all . as path separators)
        const { file: file1 } = this.keyToPath(key);
        possiblePaths.push(file1);
        // Try treating . as part of filename
        const parts = key.split('.').filter(p => p);
        if (parts.length >= 2) {
            const dir = parts.slice(0, -1).join('/');
            const fileName = parts.slice(1).join('.');
            possiblePaths.push(path.join(this.memoryDir, dir, fileName + '.md'));
        }
        // Try glob-like search in immediate parent directory
        try {
            if (parts.length >= 2) {
                // Search in parent directory (e.g., core/ for key core.test.language)
                const parentDir = path.join(this.memoryDir, parts[0]);
                const searchPattern = parts.slice(1).join('.');
                if (fs.existsSync(parentDir)) {
                    const files = fs.readdirSync(parentDir);
                    const matching = files.filter(f => f.replace(/\.md$/, '').startsWith(searchPattern) ||
                        f.replace(/\.md$/, '').includes(searchPattern));
                    for (const f of matching) {
                        possiblePaths.push(path.join(parentDir, f));
                    }
                }
                // Also try 2-level parent
                if (parts.length >= 3) {
                    const parentDir2 = path.join(this.memoryDir, parts.slice(0, 2).join('/'));
                    const searchPattern2 = parts.slice(2).join('.');
                    if (fs.existsSync(parentDir2)) {
                        const files = fs.readdirSync(parentDir2);
                        const matching = files.filter(f => f.replace(/\.md$/, '').startsWith(searchPattern2));
                        for (const f of matching) {
                            possiblePaths.push(path.join(parentDir2, f));
                        }
                    }
                }
            }
        }
        catch (e) {
            // Ignore glob errors
        }
        // Try each possible path
        for (const file of possiblePaths) {
            try {
                const exists = await fs.promises.access(file).then(() => true).catch(() => false);
                if (exists) {
                    await fs.promises.unlink(file);
                    await this.qmd.reindex();
                    console.log(`[Memoir] Deleted: ${key} (${file})`);
                    return true;
                }
            }
            catch (e) {
                // Continue to next path
            }
        }
        console.warn(`[Memoir] File not found for key "${key}"`);
        return false;
    }
    /**
     * 列出所有记忆（树状结构）
     */
    async list() {
        const tree = {};
        const scanDir = async (dir, prefix = []) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.'))
                    continue;
                const fullPath = path.join(dir, entry.name);
                const currentPath = [...prefix, entry.name];
                if (entry.isDirectory()) {
                    tree[currentPath.join('.')] = { _type: 'folder' };
                    await scanDir(fullPath, currentPath);
                }
                else if (entry.name.endsWith('.md')) {
                    const key = currentPath.join('.').replace(/\.md$/, '');
                    try {
                        const raw = await fs.promises.readFile(fullPath, 'utf-8');
                        const parsed = matter(raw);
                        tree[key] = {
                            _type: 'file',
                            title: parsed.data.title || entry.name.replace('.md', ''),
                            type: parsed.data.type || 'archival',
                            id: parsed.data.id || key
                        };
                    }
                    catch (e) {
                        tree[key] = { _type: 'file', error: String(e) };
                    }
                }
            }
        };
        try {
            await scanDir(this.memoryDir);
        }
        catch (e) {
            // 目录为空或不存在
        }
        return tree;
    }
    /**
     * 获取记忆树（用于 LLM 提示词嵌入）
     */
    async getTreeForPrompt() {
        const tree = await this.list();
        if (Object.keys(tree).length === 0) {
            return '## 记忆目录\n\n(暂无记忆)';
        }
        const lines = ['## 记忆目录', ''];
        const groups = {};
        const roots = new Set();
        for (const [key, value] of Object.entries(tree)) {
            if (key.startsWith('_'))
                continue;
            const parts = key.split('.');
            const root = parts[0];
            roots.add(root);
            if (parts.length === 1) {
                roots.add(key);
            }
            else {
                if (!groups[root])
                    groups[root] = [];
                groups[root].push({ key, value });
            }
        }
        for (const root of Array.from(roots).sort()) {
            lines.push(`### ${root}`);
            const items = groups[root] || [];
            for (const item of items.sort((a, b) => a.key.localeCompare(b.key))) {
                const parts = item.key.split('.');
                const indent = '  '.repeat(parts.length - 1);
                const title = item.value?.title || item.key.split('.').pop();
                const type = item.value?.type || 'archival';
                lines.push(`${indent}- ${item.key}: ${title} [${type}]`);
            }
        }
        return lines.join('\n');
    }
    /**
     * 获取指定层级的所有记忆（用于记忆注入）
     * @param level - 层级 (1 = 顶层如 "life", 2 = "life.work", 以此类推)
     * @returns 该层级的所有记忆及其内容
     */
    async getMemoriesByLevel(level) {
        const tree = await this.list();
        const results = [];
        for (const [key, value] of Object.entries(tree)) {
            if (key.startsWith('_'))
                continue;
            if (value._type !== 'file')
                continue;
            const parts = key.split('.');
            if (parts.length !== level)
                continue;
            const entry = await this.get(key);
            if (entry) {
                results.push(entry);
            }
        }
        return results.sort((a, b) => a.key.localeCompare(b.key));
    }
    /**
     * 获取简化记忆树（用于 system prompt）
     * 只包含 key、title、type，不加载内容
     */
    async getSimpleTree() {
        const tree = await this.list();
        const flat = [];
        for (const [key, value] of Object.entries(tree)) {
            if (key.startsWith('_'))
                continue;
            if (value._type !== 'file')
                continue;
            flat.push({
                key,
                title: value.title || key.split('.').pop() || key,
                type: value.type || 'archival'
            });
        }
        return { tree, flat };
    }
    /**
     * 搜索记忆
     */
    async search(query, options = {}) {
        const results = await this.qmd.search(query, {
            collection: options.collection || 'memory',
            limit: options.limit || 10
        });
        return results.map(r => ({
            key: this.pathToKey(r.path),
            title: r.title,
            content: r.content,
            score: r.score,
            type: r.type
        }));
    }
    /**
     * 获取底层 QMD 实例（高级用户）
     */
    getQMD() {
        return this.qmd;
    }
    /**
     * 关闭
     */
    async close() {
        await this.qmd.close();
    }
}
export default Memoir;
//# sourceMappingURL=memory.js.map