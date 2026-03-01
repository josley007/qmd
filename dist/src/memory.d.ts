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
import { QMD } from '../index.js';
export interface MemoryMetadata {
    id?: string;
    key?: string;
    type?: string;
    title?: string;
    tags?: string[];
    [key: string]: unknown;
}
export interface MemoryEntry {
    key: string;
    content: string;
    frontmatter: MemoryMetadata;
}
export interface MemoryTreeNode {
    _type?: 'folder' | 'file';
    title?: string;
    type?: string;
    id?: string;
    updated_at?: string | null;
    half_life_days?: number | null;
    [key: string]: unknown;
}
export interface MemoryTreeItem {
    key: string;
    name: string;
    isFolder: boolean;
    type?: string;
    title?: string;
    updated_at?: string | null;
    half_life_days?: number | null;
    children: MemoryTreeItem[];
}
export interface MemoryZone {
    name: string;
    keyPrefix: string;
    maxItems?: number;
    maxDepth?: number;
    defaultType?: string;
    defaultHalfLife?: number;
}
export declare class Memoir {
    private qmd;
    private memoryDir;
    private zones;
    private keyLocks;
    constructor(options?: {
        memoryDir?: string;
        dataDir?: string;
    });
    /**
     * 初始化记忆系统
     * @param options.autoEmbed - 是否自动生成 embedding (默认 true)
     * @param options.autoRerank - 是否自动加载 reranker 模型 (默认 true)
     */
    initialize(options?: {
        autoEmbed?: boolean;
        autoRerank?: boolean;
    }): Promise<void>;
    /**
     * 定义一个记忆 zone
     */
    defineZone(name: string, options: Omit<MemoryZone, 'name'>): void;
    /**
     * Per-key lock to prevent concurrent set/delete from overwriting each other's metadata
     */
    private withKeyLock;
    /**
     * 查找匹配 key 的 zone
     */
    private findZone;
    /**
     * 统计指定前缀下的文件数
     */
    private countKeysWithPrefix;
    /**
     * 获取各 zone 的条目统计
     */
    getZoneStats(): Promise<Array<{
        zone: string;
        keyPrefix: string;
        count: number;
        maxItems?: number;
    }>>;
    /**
     * 解析 key 为路径
     * life.work.project-a -> life/work/project-a.md
     */
    private keyToPath;
    /**
     * 从文件路径解析 key
     * filePath 可能是绝对路径或相对路径
     */
    private pathToKey;
    /**
     * 添加或更新记忆
     */
    set(key: string, content: string, metadata?: MemoryMetadata): Promise<{
        key: string;
        file: string;
    }>;
    private _setImpl;
    /**
     * 获取记忆
     */
    get(key: string): Promise<MemoryEntry | null>;
    /**
     * 删除记忆
     */
    delete(key: string): Promise<boolean>;
    private _deleteImpl;
    /**
     * 列出所有记忆（树状结构）
     */
    list(): Promise<Record<string, MemoryTreeNode>>;
    /**
     * 列出所有记忆（嵌套树结构）
     * 直接返回前端可渲染的树形数组，无需客户端转换
     */
    listTree(): Promise<MemoryTreeItem[]>;
    /**
     * 获取记忆树（用于 LLM 提示词嵌入）
     */
    getTreeForPrompt(options?: {
        prefix?: string;
    }): Promise<string>;
    /**
     * 获取指定层级的所有记忆（用于记忆注入）
     * @param level - 层级 (1 = 顶层如 "life", 2 = "life.work", 以此类推)
     * @returns 该层级的所有记忆及其内容
     */
    getMemoriesByLevel(level: number, options?: {
        prefix?: string;
    }): Promise<MemoryEntry[]>;
    /**
     * 获取简化记忆树（用于 system prompt）
     * 只包含 key、title、type，不加载内容
     */
    getSimpleTree(options?: {
        prefix?: string;
    }): Promise<{
        tree: Record<string, MemoryTreeNode>;
        flat: {
            key: string;
            title: string;
            type: string;
        }[];
    }>;
    /**
     * 搜索记忆
     */
    search(query: string, options?: {
        limit?: number;
        collection?: string;
    }): Promise<Array<{
        key: string;
        title: string;
        content: string;
        score: number;
        type: string;
    }>>;
    /**
     * 获取底层 QMD 实例（高级用户）
     */
    getQMD(): QMD;
    /**
     * 关闭
     */
    close(): Promise<void>;
}
export default Memoir;
//# sourceMappingURL=memory.d.ts.map