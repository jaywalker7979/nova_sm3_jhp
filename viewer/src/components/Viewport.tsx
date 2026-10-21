import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { formatSize, stlUrl } from '../format'
import { disposeModel, loadModel } from '../loadModel'
import { buildSupportGeometry } from '../supports'
import type { StlFile } from '../types'
import './Viewport.css'

export type ViewStatus = {
  loading: boolean
  triangles: number | null
  error: string | null
}

export type RotateAxis = 'x' | 'y' | 'z'

export type RotateRequest = {
  axis: RotateAxis
  sign: 1 | -1
  n: number
}

export type HistoryRequest = {
  kind: 'undo' | 'redo'
  n: number
}

export type HistoryState = {
  canUndo: boolean
  canRedo: boolean
}

export type SupportRequest = {
  kind: 'add' | 'remove' | 'save'
  n: number
}

export type SupportState = {
  hasSupports: boolean
  busy: boolean
  note: string | null
}

type Pose = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

type Props = {
  file: StlFile | null
  wireframe: boolean
  showGrid: boolean
  autoFit: boolean
  fitRequest: number
  rotateRequest: RotateRequest
  historyRequest: HistoryRequest
  supportRequest: SupportRequest
  onHistory: (state: HistoryState) => void
  onSupports: (state: SupportState) => void
  onStatus: (status: ViewStatus) => void
}

type SceneBundle = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  grid: THREE.GridHelper
  axes: THREE.AxesHelper
  mesh: THREE.Object3D | null
  material: THREE.MeshStandardMaterial
  supportMaterial: THREE.MeshStandardMaterial
}

const idleStatus: ViewStatus = { loading: false, triangles: null, error: null }
const SUPPORT_NAME = 'print-support'

function partMeshes(object: THREE.Object3D | null): THREE.Mesh[] {
  if (!object) return []
  const meshes: THREE.Mesh[] = []
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.name !== SUPPORT_NAME) meshes.push(child)
  })
  return meshes
}

function supportMeshes(object: THREE.Object3D | null): THREE.Mesh[] {
  if (!object) return []
  const meshes: THREE.Mesh[] = []
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.name === SUPPORT_NAME) meshes.push(child)
  })
  return meshes
}

function disposeSupport(mesh: THREE.Object3D | null) {
  for (const support of supportMeshes(mesh)) {
    support.removeFromParent()
    support.geometry.dispose()
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

async function saveBambuSupport(mesh: THREE.Mesh, fileName: string) {
  const geometry = mesh.geometry.clone()
  mesh.updateWorldMatrix(true, false)
  geometry.applyMatrix4(mesh.matrixWorld)
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2))
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) {
    geometry.dispose()
    throw new Error('경계를 계산하지 못했습니다.')
  }
  // A2L bed is 330 x 320 mm. Place the part on the bed center.
  geometry.translate(165 - (box.min.x + box.max.x) / 2, 160 - (box.min.y + box.max.y) / 2, -box.min.z)
  const exportMesh = new THREE.Mesh(geometry)
  const parsed = new STLExporter().parse(exportMesh, { binary: true })
  geometry.dispose()
  const response = await fetch('/api/bambu-3mf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(fileName),
    },
    body: parsed as BlobPart,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? '3MF를 만들지 못했습니다.')
  }
  const blob = await response.blob()
  downloadBlob(blob, fileName.replace(/\.(stl|3mf)$/i, '') + '_ams_support.3mf')
}


function placeHelpers(bundle: SceneBundle, box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3)
  bundle.grid.scale.setScalar((maxDim * 2.4) / 10)
  bundle.grid.position.set(center.x, box.min.y, center.z)
  bundle.axes.position.copy(center)
  bundle.axes.scale.setScalar(maxDim * 0.22)
  return { center, maxDim }
}

function fitCamera(bundle: SceneBundle) {
  const mesh = bundle.mesh
  if (!mesh) return
  const box = new THREE.Box3().setFromObject(mesh)
  if (box.isEmpty()) return

  const { center, maxDim } = placeHelpers(bundle, box)
  const fov = (bundle.camera.fov * Math.PI) / 180
  const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.6
  const direction = new THREE.Vector3(0.85, 0.55, 1).normalize()

  bundle.camera.position.copy(center).add(direction.multiplyScalar(distance))
  bundle.camera.near = Math.max(distance / 200, 0.01)
  bundle.camera.far = distance * 40
  bundle.camera.updateProjectionMatrix()
  bundle.controls.target.copy(center)
  bundle.controls.update()
}

const worldAxis: Record<RotateAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

function rotateMesh(bundle: SceneBundle, axisName: RotateAxis, sign: 1 | -1) {
  const mesh = bundle.mesh
  if (!mesh) return
  const box = new THREE.Box3().setFromObject(mesh)
  if (box.isEmpty()) return

  const center = box.getCenter(new THREE.Vector3())
  const axis = worldAxis[axisName]
  const angle = THREE.MathUtils.degToRad(90 * sign)
  mesh.position.sub(center)
  mesh.rotateOnWorldAxis(axis, angle)
  mesh.position.applyAxisAngle(axis, angle)
  mesh.position.add(center)

  const next = new THREE.Box3().setFromObject(mesh)
  if (!next.isEmpty()) placeHelpers(bundle, next)
}

function capturePose(mesh: THREE.Object3D): Pose {
  return {
    position: mesh.position.clone(),
    quaternion: mesh.quaternion.clone(),
  }
}

function applyPose(bundle: SceneBundle, pose: Pose) {
  const mesh = bundle.mesh
  if (!mesh) return
  mesh.position.copy(pose.position)
  mesh.quaternion.copy(pose.quaternion)
  const box = new THREE.Box3().setFromObject(mesh)
  if (!box.isEmpty()) placeHelpers(bundle, box)
}

export function Viewport({
  file,
  wireframe,
  showGrid,
  autoFit,
  fitRequest,
  rotateRequest,
  historyRequest,
  supportRequest,
  onHistory,
  onSupports,
  onStatus,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bundleRef = useRef<SceneBundle | null>(null)
  const pastRef = useRef<Pose[]>([])
  const futureRef = useRef<Pose[]>([])
  const onStatusRef = useRef(onStatus)
  const onHistoryRef = useRef(onHistory)
  const onSupportsRef = useRef(onSupports)
  const autoFitRef = useRef(autoFit)
  const wireframeRef = useRef(wireframe)
  const fileNameRef = useRef(file?.name ?? 'model.stl')
  const [overlay, setOverlay] = useState<ViewStatus>(idleStatus)
  const [analyzing, setAnalyzing] = useState(false)
  onStatusRef.current = onStatus
  onHistoryRef.current = onHistory
  onSupportsRef.current = onSupports
  autoFitRef.current = autoFit
  wireframeRef.current = wireframe
  fileNameRef.current = file?.name ?? 'model.stl'

  const syncHistory = () => {
    onHistoryRef.current({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    })
  }

  const clearHistory = () => {
    pastRef.current = []
    futureRef.current = []
    syncHistory()
  }

  const report = (status: ViewStatus) => {
    setOverlay(status)
    onStatusRef.current(status)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x0e1318)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    camera.position.set(120, 80, 140)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.15)
    key.position.set(80, 140, 90)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xb7c9dc, 0.45)
    fill.position.set(-90, 40, -70)
    scene.add(fill)

    const grid = new THREE.GridHelper(10, 10, 0x5d7388, 0x2a3846)
    const axes = new THREE.AxesHelper(1)
    scene.add(grid, axes)

    const material = new THREE.MeshStandardMaterial({
      color: 0x9aa3ad,
      metalness: 0.55,
      roughness: 0.42,
    })
    const supportMaterial = new THREE.MeshStandardMaterial({
      color: 0xe07a2f,
      metalness: 0.12,
      roughness: 0.68,
    })

    const bundle: SceneBundle = {
      renderer,
      scene,
      camera,
      controls,
      grid,
      axes,
      mesh: null,
      material,
      supportMaterial,
    }
    bundleRef.current = bundle

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const width = parent.clientWidth
      const height = parent.clientHeight
      renderer.setSize(width, height, false)
      camera.aspect = width / Math.max(height, 1)
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    if (canvas.parentElement) observer.observe(canvas.parentElement)

    let frame = 0
    const loop = () => {
      frame = requestAnimationFrame(loop)
      controls.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      disposeSupport(bundle.mesh)
      disposeModel(bundle.mesh, [bundle.material, bundle.supportMaterial])
      material.dispose()
      supportMaterial.dispose()
      controls.dispose()
      renderer.dispose()
      bundleRef.current = null
    }
  }, [])

  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle) return
    bundle.material.wireframe = wireframe
  }, [wireframe])

  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle) return
    bundle.grid.visible = showGrid
  }, [showGrid])

  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle) return
    fitCamera(bundle)
  }, [fitRequest])

  useEffect(() => {
    if (rotateRequest.n === 0) return
    const bundle = bundleRef.current
    const mesh = bundle?.mesh
    if (!bundle || !mesh) return
    pastRef.current.push(capturePose(mesh))
    futureRef.current = []
    rotateMesh(bundle, rotateRequest.axis, rotateRequest.sign)
    syncHistory()
  }, [rotateRequest])

  useEffect(() => {
    if (historyRequest.n === 0) return
    const bundle = bundleRef.current
    const mesh = bundle?.mesh
    if (!bundle || !mesh) return
    const from = historyRequest.kind === 'undo' ? pastRef : futureRef
    const to = historyRequest.kind === 'undo' ? futureRef : pastRef
    const pose = from.current.pop()
    if (!pose) {
      syncHistory()
      return
    }
    to.current.push(capturePose(mesh))
    applyPose(bundle, pose)
    syncHistory()
  }, [historyRequest])

  useEffect(() => {
    if (supportRequest.n === 0) return
    const bundle = bundleRef.current
    const mesh = bundle?.mesh
    if (!bundle || !mesh) return

    if (supportRequest.kind === 'remove') {
      disposeSupport(mesh)
      onSupportsRef.current({ hasSupports: false, busy: false, note: null })
      return
    }

    const targets = partMeshes(mesh)
    if (targets.length === 0) {
      onSupportsRef.current({
        hasSupports: false,
        busy: false,
        note: '서포트를 붙일 파트가 없습니다.',
      })
      return
    }

    if (supportRequest.kind === 'save') {
      if (targets.length !== 1) {
        onSupportsRef.current({
          hasSupports: supportMeshes(mesh).length > 0,
          busy: false,
          note: 'Bambu 저장은 파트가 하나인 STL에서 할 수 있습니다.',
        })
        return
      }
      const hasSupports = supportMeshes(mesh).length > 0
      onSupportsRef.current({ hasSupports, busy: true, note: null })
      void saveBambuSupport(targets[0], fileNameRef.current).then(
        () => onSupportsRef.current({ hasSupports, busy: false, note: 'Bambu 서포트 파일을 저장했습니다.' }),
        (error: unknown) => onSupportsRef.current({
          hasSupports,
          busy: false,
          note: error instanceof Error ? error.message : 'Bambu 파일 저장에 실패했습니다.',
        }),
      )
      return
    }

    let cancelled = false
    setAnalyzing(true)
    onSupportsRef.current({ hasSupports: false, busy: true, note: null })
    let index = 0
    let pillars = 0
    let skipped = 0
    disposeSupport(mesh)

    const step = () => {
      if (cancelled || bundle.mesh !== mesh) {
        setAnalyzing(false)
        return
      }
      if (index >= targets.length) {
        setAnalyzing(false)
        if (pillars === 0 && skipped === 0) {
          onSupportsRef.current({ hasSupports: false, busy: false, note: '지지가 필요한 구간이 없습니다.' })
          return
        }
        if (pillars === 0) {
          onSupportsRef.current({ hasSupports: false, busy: false, note: '좁아서 서포트를 넣지 않았습니다.' })
          return
        }
        const pillarNote = `서포트 기둥 ${pillars.toLocaleString('ko-KR')}개`
        onSupportsRef.current({
          hasSupports: true,
          busy: false,
          note: skipped > 0
            ? `${pillarNote}, 좁아서 생략 ${skipped.toLocaleString('ko-KR')}곳`
            : pillarNote,
        })
        return
      }
      const target = targets[index]
      index += 1
      const built = buildSupportGeometry(target)
      if (built?.geometry) {
        target.updateWorldMatrix(true, false)
        built.geometry.applyMatrix4(target.matrixWorld.clone().invert())
        const support = new THREE.Mesh(built.geometry, bundle.supportMaterial)
        support.name = SUPPORT_NAME
        target.add(support)
        pillars += built.pillars
      }
      if (built) skipped += built.skipped
      timer = window.setTimeout(step, 0)
    }
    let timer = window.setTimeout(step, 30)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [supportRequest])

  useEffect(() => {
    const bundle = bundleRef.current
    if (!bundle) return
    const controller = new AbortController()
    let cancelled = false

    const clearMesh = () => {
      if (!bundle.mesh) return
      disposeSupport(bundle.mesh)
      bundle.scene.remove(bundle.mesh)
      disposeModel(bundle.mesh, [bundle.material, bundle.supportMaterial])
      bundle.mesh = null
    }

    clearHistory()
    onSupportsRef.current({ hasSupports: false, busy: false, note: null })

    if (!file) {
      clearMesh()
      report(idleStatus)
      return () => {
        cancelled = true
        controller.abort()
      }
    }

    report({ loading: true, triangles: null, error: null })

    fetch(stlUrl(file.path), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('파일을 읽지 못했습니다.')
        return response.arrayBuffer()
      })
      .then((buffer) => new Promise<ArrayBuffer>((resolve) => {
        window.setTimeout(() => resolve(buffer), 0)
      }))
      .then((buffer) => {
        if (cancelled) return
        const loaded = loadModel(buffer, file.name, bundle.material)
        if (cancelled) {
          disposeModel(loaded.object, [bundle.material, bundle.supportMaterial])
          return
        }
        clearMesh()
        bundle.mesh = loaded.object
        bundle.scene.add(loaded.object)
        bundle.material.wireframe = wireframeRef.current
        if (autoFitRef.current) fitCamera(bundle)
        report({ loading: false, triangles: loaded.triangles, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
        clearMesh()
        const kind = file.name.toLowerCase().endsWith('.3mf') ? '3MF' : 'STL'
        const detail = error instanceof Error ? error.message : ''
        report({
          loading: false,
          triangles: null,
          error: detail && !detail.startsWith('THREE.') ? detail : `${kind}를 해석하지 못했습니다.`,
        })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [file])

  return (
    <div className="viewport">
      <canvas ref={canvasRef} />
      {!file ? <div className="viewport-overlay">왼쪽 목록에서 STL 또는 3MF 파일을 선택하세요.</div> : null}
      {analyzing ? (
        <div className="viewport-overlay">
          <span className="spinner" />
          <span>서포트를 계산하는 중</span>
        </div>
      ) : null}
      {file && overlay.loading && !analyzing ? (
        <div className="viewport-overlay">
          <span className="spinner" />
          <span>
            {file.name} ({formatSize(file.size)}) 불러오는 중
          </span>
        </div>
      ) : null}
      {file && overlay.error ? <div className="viewport-overlay error">{overlay.error}</div> : null}
    </div>
  )
}
