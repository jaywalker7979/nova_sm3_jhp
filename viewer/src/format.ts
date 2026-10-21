import type { CatalogNode, StlFile } from './types'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function stlUrl(relativePath: string): string {
  return `/stl/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

export function collectFiles(nodes: CatalogNode[], acc: StlFile[] = []): StlFile[] {
  for (const node of nodes) {
    if (node.children) {
      collectFiles(node.children, acc)
    } else if (typeof node.size === 'number') {
      acc.push({ name: node.name, path: node.path, size: node.size })
    }
  }
  return acc
}

export function parentPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? '' : relativePath.slice(0, slash)
}
