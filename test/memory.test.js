/**
 * Test Memoir (Tree Memory)
 */

import { Memoir } from '../dist/src/memory.js'
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
  console.log('\n=== Memoir (Tree Memory) Test Suite ===\n')

  // Clean up
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true })
  }

  const memory = new Memoir({
    memoryDir: path.join(testDir, 'memory'),
    dataDir: path.join(testDir, 'memoir-data')
  })

  console.log('--- Test 1: Initialize ---\n')
  
  await memory.initialize()
  assert(true, 'Memoir initialized')

  console.log('\n--- Test 2: Set memories ---\n')
  
  await memory.set('life.work.project_a', '这是项目A的笔记', { type: 'archival' })
  assert(true, 'Set life.work.project_a')

  await memory.set('life.work.project_b', '项目B使用 Vue3', { type: 'working' })
  assert(true, 'Set life.work.project_b')

  await memory.set('life.personal.health', '每周运动3次', { type: 'core' })
  assert(true, 'Set life.personal.health')

  await memory.set('skills.programming.javascript', 'JavaScript笔记', { type: 'core' })
  assert(true, 'Set skills.programming.javascript')

  console.log('\n--- Test 3: Get memory ---\n')
  
  const mem = await memory.get('life.work.project_a')
  assert(mem !== null, 'Get returns memory')
  assert(mem?.content.includes('项目A'), 'Content matches')

  const nonExistent = await memory.get('not.exist')
  assert(nonExistent === null, 'Get non-existent returns null')

  console.log('\n--- Test 4: List tree ---\n')
  
  const tree = await memory.list()
  assert(Object.keys(tree).length > 0, 'Tree has entries')
  assert(tree['life.work.project_a'] !== undefined, 'Tree has project_a')

  console.log('\n--- Test 5: Get tree for LLM prompt ---\n')
  
  const promptTree = await memory.getTreeForPrompt()
  assert(promptTree.includes('## 记忆目录'), 'Has header')
  assert(promptTree.includes('life.work'), 'Has life.work')
  assert(promptTree.includes('skills.programming'), 'Has skills.programming')

  console.log('\n--- Test 6: Search ---\n')
  
  const results = await memory.search('JavaScript')
  assert(results.length > 0, 'Search found results')

  console.log('\n--- Test 7: Delete ---\n')
  
  await memory.delete('life.work.project_b')
  const afterDelete = await memory.get('life.work.project_b')
  assert(afterDelete === null, 'Deleted memory not found')

  await memory.close()

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
