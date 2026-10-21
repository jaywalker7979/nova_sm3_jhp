import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Viewport, type HistoryRequest, type RotateAxis, type SupportRequest } from './components/Viewport'
import { formatSize } from './format'
import type { CatalogNode, StlFile } from './types'
import './App.css'

export default function App() {
  const [catalog, setCatalog] = useState<CatalogNode[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<StlFile | null>(null)
  const [wireframe, setWireframe] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [autoFit, setAutoFit] = useState(true)
  const [fitRequest, setFitRequest] = useState(0)
  const [rotateRequest, setRotateRequest] = useState<{ axis: RotateAxis; sign: 1 | -1; n: number }>({
    axis: 'x',
    sign: 1,
    n: 0,
  })
  const [historyRequest, setHistoryRequest] = useState<HistoryRequest>({ kind: 'undo', n: 0 })
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [supportRequest, setSupportRequest] = useState<SupportRequest>({ kind: 'add', n: 0 })
  const [support, setSupport] = useState({ hasSupports: false, busy: false, note: null as string | null })
  const [loading, setLoading] = useState(false)
  const [triangles, setTriangles] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/catalog', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('목록을 불러오지 못했습니다.')
        return (await response.json()) as CatalogNode[]
      })
      .then((nodes) => {
        setCatalog(nodes)
        setCatalogError(null)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setCatalogError(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      const key = event.key.toLowerCase()
      const undo = key === 'z' && !event.shiftKey
      const redo = key === 'y' || (key === 'z' && event.shiftKey)
      if (!undo && !redo) return
      event.preventDefault()
      setHistoryRequest((current) => ({ kind: undo ? 'undo' : 'redo', n: current.n + 1 }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <Sidebar
        nodes={catalog}
        error={catalogError}
        query={query}
        selectedPath={selected?.path ?? null}
        onQuery={setQuery}
        onSelect={(file) => {
          setSelected(file)
          setTriangles(null)
          setLoadError(null)
          setHistory({ canUndo: false, canRedo: false })
          setSupport({ hasSupports: false, busy: false, note: null })
        }}
      />
      <main className="stage">
        <header className="toolbar">
          <button type="button" onClick={() => setFitRequest((n) => n + 1)} disabled={!selected}>
            카메라 리셋
          </button>
          <button
            type="button"
            className={wireframe ? 'on' : ''}
            onClick={() => setWireframe((v) => !v)}
            disabled={!selected}
          >
            와이어프레임
          </button>
          <button type="button" className={showGrid ? 'on' : ''} onClick={() => setShowGrid((v) => !v)}>
            격자
          </button>
          <button type="button" className={autoFit ? 'on' : ''} onClick={() => setAutoFit((v) => !v)}>
            자동 맞춤
          </button>
          <span className="rotate-group">
            {(
              [
                ['x', -1, 'X−90'],
                ['x', 1, 'X+90'],
                ['y', -1, 'Y−90'],
                ['y', 1, 'Y+90'],
                ['z', -1, 'Z−90'],
                ['z', 1, 'Z+90'],
              ] as const
            ).map(([axis, sign, label]) => (
              <button
                key={label}
                type="button"
                className={`rot-${axis}`}
                disabled={!selected}
                onClick={() => setRotateRequest((current) => ({ axis, sign, n: current.n + 1 }))}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="history-group">
            <button
              type="button"
              title="Ctrl+Z"
              disabled={!selected || !history.canUndo}
              onClick={() => setHistoryRequest((current) => ({ kind: 'undo', n: current.n + 1 }))}
            >
              실행 취소
            </button>
            <button
              type="button"
              title="Ctrl+Y"
              disabled={!selected || !history.canRedo}
              onClick={() => setHistoryRequest((current) => ({ kind: 'redo', n: current.n + 1 }))}
            >
              다시 실행
            </button>
          </span>
          <span className="support-group">
            <button
              type="button"
              className="support-add"
              disabled={!selected || support.busy}
              onClick={() => setSupportRequest((current) => ({ kind: 'add', n: current.n + 1 }))}
            >
              서포트 추가
            </button>
            <button
              type="button"
              disabled={!selected || !support.hasSupports || support.busy}
              onClick={() => setSupportRequest((current) => ({ kind: 'remove', n: current.n + 1 }))}
            >
              서포트 제거
            </button>
            <button
              type="button"
              disabled={!selected || support.busy}
              onClick={() => setSupportRequest((current) => ({ kind: 'save', n: current.n + 1 }))}
            >
              Bambu 서포트 저장
            </button>
          </span>
        </header>
        <Viewport
          file={selected}
          wireframe={wireframe}
          showGrid={showGrid}
          autoFit={autoFit}
          fitRequest={fitRequest}
          rotateRequest={rotateRequest}
          historyRequest={historyRequest}
          supportRequest={supportRequest}
          onHistory={setHistory}
          onSupports={setSupport}
          onStatus={(status) => {
            setLoading(status.loading)
            setTriangles(status.triangles)
            setLoadError(status.error)
          }}
        />
        <footer className="status">
          {selected ? (
            <>
              <span className="status-name" title={selected.path}>
                {selected.name}
              </span>
              <span>{formatSize(selected.size)}</span>
              <span>{loading ? '불러오는 중' : (loadError ?? '준비됨')}</span>
              <span>{triangles === null ? '삼각형 —' : `삼각형 ${triangles.toLocaleString('ko-KR')}`}</span>
              {support.note ? <span>{support.note}</span> : null}
            </>
          ) : (
            <span>파일을 선택하면 이름, 용량, 삼각형 수가 여기에 표시됩니다.</span>
          )}
        </footer>
      </main>
    </div>
  )
}
