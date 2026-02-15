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
    [key: string]: unknown;
}
export declare class Memoir {
    private qmd;
    private memoryDir;
    constructor(options?: {
        memoryDir?: string;
        dataDir?: string;
    });
    /**
     * 初始化记忆系统
     */
    initialize(): Promise<void>;
    /**
     * 解析 key 为路径
     * life.work.project-a -> life/work/project-a.md
     */
    private keyToPath;
    /**
     * 从文件路径解析 key
     */
    private pathToKey;
    /**
     * 添加或更新记忆
     */
    set(key: string, content: string, metadata?: MemoryMetadata): Promise<{
        key: string;
        file: string;
    }>;
    /**
     * 获取记忆
     */
    get(key: string): Promise<MemoryEntry | null>;
    /**
     * 删除记忆
     */
    delete(key: string): Promise<boolean>;
    /**
     * 列出所有记忆（树状结构）
     */
    list(): Promise<Record<string, MemoryTreeNode>>;
    /**
     * 获取记忆树（用于 LLM 提示词嵌入）
     */
    getTreeForPrompt(): Promise<string>;
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