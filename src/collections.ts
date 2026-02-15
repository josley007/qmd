/**
 * Collections - Simplified Node.js version for library use
 */

import { QMDStore } from './qmd.js'
import path from 'path'
import fs from 'fs'

export class Collections {
  constructor(private store: QMDStore) {}

  async add(name: string, collectionPath: string, glob: string = '**/*.md'): Promise<void> {
    const absolutePath = path.resolve(collectionPath)
    
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Collection path does not exist: ${absolutePath}`)
    }

    this.store.addCollection(name, absolutePath, glob)
    console.log(`[Collections] Added collection "${name}" at ${absolutePath}`)
  }

  list(): { name: string; path: string; documentCount: number }[] {
    const collections = this.store.listCollections()
    
    return collections.map(c => {
      return {
        name: c.name,
        path: c.path,
        documentCount: 0
      }
    })
  }

  get(name: string): { id: number; name: string; path: string; glob: string } | null {
    return this.store.getCollection(name)
  }

  async remove(name: string): Promise<void> {
    this.store.removeCollection(name)
    console.log(`[Collections] Removed collection "${name}"`)
  }
}

export default Collections
