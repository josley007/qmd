# @violoop/memoir

Tree-structured memory system with full-text search for AI assistants.

## Features

- **Tree Hierarchy**: Organize memories with dot-separated keys (e.g., `life.work.project`)
- **BM25 Search**: Full-text search using SQLite FTS5
- **Markdown Storage**: Memories stored as `.md` files with frontmatter

## Installation

```bash
npm install @violoop/memoir
```

## Quick Start

```javascript
const { Memoir } = require('@violoop/memoir')

const memory = new Memoir({
  memoryDir: './memory',
  dataDir: './memoir-data'
})

await memory.initialize()

// Add memory
await memory.set('life.work.project_a', 'Project A notes', { type: 'core' })

// Get memory tree for LLM prompt
const tree = await memory.getTreeForPrompt()
// ## 记忆目录
// ### life
//   - life.work: work [core]
//     - life.work.project_a: project_a [core]

// Search
const results = await memory.search('project')

await memory.close()
```

## Key Format

```
life.work.project_a     → memory/life/work/project_a.md
skills.programming.js    → memory/skills/programming/js.md
```

**Important**: Don't use `.` in the last part:

```
✅ core.test-language  → core/test-language.md
❌ core.test.language  → path error
```

## API

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize |
| `set(key, content, metadata)` | Add/update |
| `get(key)` | Get by key |
| `delete(key)` | Delete |
| `list()` | List tree |
| `getTreeForPrompt()` | For LLM |
| `search(query)` | Search |

## Storage

```
memory/
├── core/
│   └── preferences.md
├── life/
│   └── work/
└── skills/

memoir-data/
└── index.sqlite
```

## License

MIT
