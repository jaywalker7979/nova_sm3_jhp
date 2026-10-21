import { useMemo, useState } from 'react'
import { collectFiles, formatSize, parentPath } from '../format'
import type { CatalogNode, StlFile } from '../types'
import './Sidebar.css'

type Props = {
  nodes: CatalogNode[] | null
  error: string | null
  query: string
  selectedPath: string | null
  onQuery: (value: string) => void
  onSelect: (file: StlFile) => void
}

function catalogSummary(nodes: CatalogNode[]): string {
  const files = collectFiles(nodes)
  const threeMf = files.filter((file) => file.name.toLowerCase().endsWith('.3mf')).length
  const stl = files.length - threeMf
  if (threeMf === 0) return `STL ${stl}개`
  if (stl === 0) return `3MF ${threeMf}개`
  return `STL ${stl} · 3MF ${threeMf}`
}

export function Sidebar({ nodes, error, query, selectedPath, onQuery, onSelect }: Props) {
  const matches = useMemo(() => {
    if (!nodes || !query.trim()) return null
    const needle = query.trim().toLowerCase()
    return collectFiles(nodes).filter((file) => file.name.toLowerCase().includes(needle))
  }, [nodes, query])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div>
          <h1>Nova SM3</h1>
          <p>{nodes ? catalogSummary(nodes) : '목록 불러오는 중'}</p>
        </div>
      </div>
      <label className="search">
        <span className="sr-only">파일명 검색</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="파일명 검색"
          type="search"
        />
      </label>
      <div className="tree-scroll">
        {error ? <p className="sidebar-message">{error}</p> : null}
        {!nodes && !error ? <p className="sidebar-message">폴더를 읽는 중입니다.</p> : null}
        {matches ? (
          matches.length === 0 ? (
            <p className="sidebar-message">일치하는 파일이 없습니다.</p>
          ) : (
            <ul className="tree">
              {matches.map((file) => (
                <FileButton
                  key={file.path}
                  file={file}
                  selected={file.path === selectedPath}
                  detail={parentPath(file.path)}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )
        ) : nodes ? (
          <Tree nodes={nodes} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
        ) : null}
      </div>
    </aside>
  )
}

function Tree({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: CatalogNode[]
  depth: number
  selectedPath: string | null
  onSelect: (file: StlFile) => void
}) {
  return (
    <ul className="tree">
      {nodes.map((node) =>
        node.children ? (
          <Folder key={node.path} node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />
        ) : (
          <FileButton
            key={node.path}
            file={{ name: node.name, path: node.path, size: node.size ?? 0 }}
            selected={node.path === selectedPath}
            onSelect={onSelect}
          />
        ),
      )}
    </ul>
  )
}

function Folder({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: CatalogNode
  depth: number
  selectedPath: string | null
  onSelect: (file: StlFile) => void
}) {
  const [open, setOpen] = useState(depth < 2)

  return (
    <li>
      <button type="button" className="folder" onClick={() => setOpen((value) => !value)}>
        <span className={open ? 'chevron open' : 'chevron'} aria-hidden />
        <span>{node.name}</span>
      </button>
      {open && node.children ? (
        <Tree nodes={node.children} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      ) : null}
    </li>
  )
}

function FileButton({
  file,
  selected,
  detail,
  onSelect,
}: {
  file: StlFile
  selected: boolean
  detail?: string
  onSelect: (file: StlFile) => void
}) {
  return (
    <li>
      <button type="button" className={selected ? 'file active' : 'file'} onClick={() => onSelect(file)}>
        <span className="file-text">
          <span className="file-line">
            <span className="file-name">{file.name}</span>
            {file.name.toLowerCase().endsWith('.3mf') ? <span className="file-kind">3MF</span> : null}
          </span>
          {detail ? <span className="file-detail">{detail}</span> : null}
        </span>
        <span className="file-size">{formatSize(file.size)}</span>
      </button>
    </li>
  )
}
