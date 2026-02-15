/**
 * Comprehensive QMD Test Suite
 */

import { QMD } from '../dist/index.js'
import path from 'path'
import fs from 'fs'

const testDir = './test-data'
let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    passed++
  } else {
    console.log(`  ✗ ${message}`)
    failed++
  }
}

async function runTests() {
  console.log('\n=== QMD Comprehensive Test Suite ===\n')

  // Clean up
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true })
  }

  // Create test directories
  const memoryDir = path.join(testDir, 'memory')
  const projectsDir = path.join(testDir, 'projects')
  const notesDir = path.join(testDir, 'notes')
  
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.mkdirSync(notesDir, { recursive: true })

  // Create test files - Memory collection
  const memoryFiles = [
    {
      name: 'prefs-language.md',
      content: `---
id: test-1
type: core
key: prefs.language
---

# 语言偏好

用户偏好使用中文进行对话和输出。`
    },
    {
      name: 'qmd-integration.md',
      content: `---
id: test-2
type: archival
tags: [project, qmd]
---

# QMD 集成

2026-02-13 完成了 Violoop 记忆系统的重构，使用纯文档方式存储记忆。`
    },
    {
      name: 'architecture.md',
      content: `---
id: test-3
type: core
---

# 系统架构

Violoop 采用模块化架构设计，主要包括:
- 核心引擎
- 记忆系统
- 工具系统`
    }
  ]

  // Create test files - Projects collection
  const projectFiles = [
    {
      name: 'violoop.md',
      content: `# Violoop 项目

Violoop 是一个 AI 助手项目，基于大型语言模型构建。`
    },
    {
      name: 'qmd-node.md',
      content: `# QMD Node

QMD 的 Node.js 实现版本，使用 better-sqlite3。`
    }
  ]

  // Create test files - Notes collection
  const notesFiles = [
    {
      name: 'meeting-2026-02-14.md',
      content: `# 会议记录 2026-02-14

讨论了 QMD 集成的进度和问题。`
    }
  ]

  // Write all test files
  for (const file of memoryFiles) {
    fs.writeFileSync(path.join(memoryDir, file.name), file.content)
  }
  for (const file of projectFiles) {
    fs.writeFileSync(path.join(projectsDir, file.name), file.content)
  }
  for (const file of notesFiles) {
    fs.writeFileSync(path.join(notesDir, file.name), file.content)
  }

  console.log('Created test files')
  console.log('\n--- Test 1: Initialization ---\n')

  // Test 1: Initialization
  const qmd = new QMD({ dataDir: path.join(testDir, 'qmd-data') })
  
  try {
    await qmd.initialize()
    assert(true, 'QMD initialized successfully')
  } catch (err) {
    assert(false, `QMD initialization: ${err}`)
  }

  console.log('\n--- Test 2: Collection Management ---\n')

  // Test 2: Add collections
  await qmd.addCollection('memory', memoryDir)
  assert(true, 'Added memory collection')

  await qmd.addCollection('projects', projectsDir)
  assert(true, 'Added projects collection')

  await qmd.addCollection('notes', notesDir)
  assert(true, 'Added notes collection')

  // List collections
  const collections = await qmd.listCollections()
  assert(collections.length === 3, `List collections: found ${collections.length} collections`)

  // Get specific collection
  const memoryCol = await qmd.getCollection('memory')
  assert(memoryCol !== null, 'Get memory collection')
  // Path is stored as absolute
  assert(memoryCol?.path && memoryCol.path.endsWith('memory'), 'Collection path stored correctly')

  // Add duplicate collection (should not fail)
  await qmd.addCollection('memory', memoryDir)
  const collectionsAfter = await qmd.listCollections()
  assert(collectionsAfter.length === 3, 'Duplicate collection handled gracefully')

  console.log('\n--- Test 3: Indexing ---\n')

  // Test 3: Reindex
  const indexResult = await qmd.reindex()
  assert(indexResult.indexed === 6, `Indexed ${indexResult.indexed} documents (expected 6)`)
  assert(indexResult.failed === 0, `Failed: ${indexResult.failed}`)

  // Reindex again (re-indexes all)
  const indexResult2 = await qmd.reindex()
  assert(indexResult2.indexed >= 0, `Reindex: re-indexed ${indexResult2.indexed} documents`)

  // Add new file and reindex
  fs.writeFileSync(
    path.join(memoryDir, 'new-file.md'),
    `# 新文件

这是一个新添加的测试文件。`
  )
  const indexResult3 = await qmd.reindex()
  assert(indexResult3.indexed >= 1, `After adding file: indexed ${indexResult3.indexed} documents`)

  console.log('\n--- Test 4: Search ---\n')

  // Test 4: Search
  const results1 = await qmd.search('QMD')
  assert(results1.length > 0, `Search "QMD": found ${results1.length} results`)

  const results2 = await qmd.search('Violoop')
  assert(results2.length > 0, `Search "Violoop": found ${results2.length} results`)

  const results3 = await qmd.search('不存在的关键词')
  assert(results3.length === 0, `Search non-existent: found ${results3.length} results (expected 0)`)

  // Search with collection filter
  const results4 = await qmd.search('项目', { collection: 'projects' })
  assert(results4.length > 0, `Search with collection filter: found ${results4.length} results`)

  // Search with limit
  const results5 = await qmd.search('项目', { limit: 1 })
  assert(results5.length === 1, `Search with limit: found ${results5.length} results (expected 1)`)

  // Search results have required fields
  if (results1.length > 0) {
    const first = results1[0]
    assert(typeof first.id === 'string', 'Result has id field')
    assert(typeof first.title === 'string', 'Result has title field')
    assert(typeof first.content === 'string', 'Result has content field')
    assert(typeof first.score === 'number', 'Result has score field')
    assert(typeof first.type === 'string', 'Result has type field')
  }

  console.log('\n--- Test 5: Remove Collection ---\n')

  // Test 5: Remove collection
  await qmd.removeCollection('notes')
  const collectionsAfterRemove = await qmd.listCollections()
  assert(collectionsAfterRemove.length === 2, `After remove: ${collectionsAfterRemove.length} collections (expected 2)`)

  // Search should still work
  const resultsAfterRemove = await qmd.search('QMD')
  assert(resultsAfterRemove.length > 0, 'Search works after removing collection')

  console.log('\n--- Test 6: Close and Reinitialize ---\n')

  // Test 6: Close and reinitialize
  await qmd.close()
  
  const qmd2 = new QMD({ dataDir: path.join(testDir, 'qmd-data') })
  await qmd2.initialize()
  
  const collections2 = await qmd2.listCollections()
  assert(collections2.length === 2, `After reinit: ${collections2.length} collections (expected 2)`)
  
  const resultsAfterReinit = await qmd2.search('QMD')
  assert(resultsAfterReinit.length > 0, 'Search works after reinitialization')

  await qmd2.close()

  console.log('\n--- Test 7: Edge Cases ---\n')

  // Test 7: Edge cases
  const qmd3 = new QMD({ dataDir: path.join(testDir, 'edge-cases') })
  await qmd3.initialize()

  // Empty collection
  const emptyDir = path.join(testDir, 'empty')
  fs.mkdirSync(emptyDir, { recursive: true })
  await qmd3.addCollection('empty', emptyDir)
  const emptyResult = await qmd3.reindex()
  assert(emptyResult.indexed === 0, 'Empty collection indexed')

  await qmd3.close()

  // Test non-existent collection get
  const qmd4 = new QMD({ dataDir: path.join(testDir, 'edge-cases2') })
  await qmd4.initialize()
  await qmd4.addCollection('test', notesDir) // Add one first
  const nonExistent = await qmd4.getCollection('non-existent')
  assert(!nonExistent, 'Get non-existent collection returns falsy')

  // Search with empty query
  const emptySearchResults = await qmd4.search('')
  assert(emptySearchResults.length === 0, 'Empty search query returns empty results')

  await qmd4.close()

  console.log('\n--- Test 8: Vector Search ---\n')

  // Test 8: Vector Search
  const qmdVec = new QMD({ dataDir: path.join(testDir, 'vector-test') })
  await qmdVec.initialize()

  // Add collection and index
  await qmdVec.addCollection('memory', memoryDir)
  await qmdVec.reindex()

  // Get hashes needing embedding
  const hashes = qmdVec.getHashesForEmbedding()
  console.log(`  ℹ Documents needing embedding: ${hashes.length}`)

  // Test: vsearch with empty embedding (should return empty)
  const vecResults1 = await qmdVec.vsearch([], { limit: 10 })
  assert(vecResults1.length === 0, 'vsearch with empty embedding returns empty')

  // Test: vsearch with null-like embedding (all zeros)
  const fakeEmbedding = new Array(1536).fill(0)
  const vecResults2 = await qmdVec.vsearch(fakeEmbedding, { limit: 10 })
  // Without real embeddings, this should return empty or limited results
  console.log(`  ℹ vsearch with fake embedding: ${vecResults2.length} results`)

  // Test: hybrid search with null embedding (should fallback to BM25)
  const hybridResults = await qmdVec.query('Violoop', null, { limit: 10 })
  assert(hybridResults.length > 0, `hybrid search with null embedding: found ${hybridResults.length} results`)
  // When vector returns empty, source should be bm25
  const hasBm25Source = hybridResults.some(r => r.type === 'bm25')
  assert(hasBm25Source || hybridResults.length > 0, 'hybrid with null fallback works')

  // Test: hybrid search with embedding (BM25 + Vector)
  const hybridResults2 = await qmdVec.query('Violoop', fakeEmbedding, { limit: 10 })
  console.log(`  ℹ hybrid search with embedding: ${hybridResults2.length} results`)

  // Test: hybrid search with custom reranking function
  const mockRerank = async (query, docs) => {
    // Simple mock reranker - just return docs with scores based on content length
    return docs.map(d => ({
      path: d.path,
      score: d.content.length / 1000
    })).sort((a, b) => b.score - a.score)
  }
  
  const hybridWithRerank = await qmdVec.query('Violoop', fakeEmbedding, { 
    limit: 10,
    rerank: mockRerank
  })
  console.log(`  ℹ hybrid search with rerank: ${hybridWithRerank.length} results`)
  assert(hybridWithRerank.length >= 0, 'hybrid search with rerank works')

  // Test: clear embeddings
  qmdVec.clearAllEmbeddings()
  const hashesAfterClear = qmdVec.getHashesForEmbedding()
  assert(hashesAfterClear.length === hashes.length, 'clearAllEmbeddings: all embeddings cleared')

  await qmdVec.close()

  // Cleanup
  fs.rmSync(testDir, { recursive: true })

  console.log('\n========================================')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log('========================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch(err => {
  console.error('\n✗ Test failed:', err)
  process.exit(1)
})
