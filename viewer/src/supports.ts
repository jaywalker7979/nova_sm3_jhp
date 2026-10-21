import * as THREE from 'three'

const OVERHANG_NORMAL_Y = -0.2
const MIN_GAP = 0.6
const CELL_SIZE = 2
const MAX_CELLS = 220
const Z_GAP = 0.3
const PITCH = 3
const MIN_OPENING = 8
const PILLAR_WIDTH = 1.6
const STEEP_NORMAL_Y = 0.18

export type SupportBuild = {
  geometry: THREE.BufferGeometry | null
  pillars: number
  skipped: number
}

type Sample = {
  y: number
  down: boolean
}

function readVertex(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, target: THREE.Vector3, matrix: THREE.Matrix4) {
  target.fromBufferAttribute(attribute, index).applyMatrix4(matrix)
}

function pushQuad(
  positions: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
) {
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz)
}

function pushBox(positions: number[], cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
  const x0 = cx - hx
  const x1 = cx + hx
  const y0 = cy - hy
  const y1 = cy + hy
  const z0 = cz - hz
  const z1 = cz + hz
  pushQuad(positions, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0)
  pushQuad(positions, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1)
  pushQuad(positions, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1)
  pushQuad(positions, x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0)
  pushQuad(positions, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1)
  pushQuad(positions, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0)
}

type WallSpan = {
  y0: number
  y1: number
}

function blocksSpan(column: Sample[], walls: WallSpan[], y0: number, y1: number, ignoreDown = false) {
  if (column.some((sample) => sample.y > y0 && sample.y < y1 && !(ignoreDown && sample.down))) return true
  return walls.some((span) => span.y0 < y1 && span.y1 > y0)
}

function segmentHitsCell(
  ax: number, az: number,
  bx: number, bz: number,
  x0: number, z0: number,
  x1: number, z1: number,
) {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dz, dz]
  const q = [ax - x0, x1 - ax, az - z0, z1 - az]
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-8) {
      if (q[i] < 0) return false
      continue
    }
    const t = q[i] / p[i]
    if (p[i] < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else if (t < t0) return false
    else if (t < t1) t1 = t
  }
  return true
}

function freeSpan(
  samples: Sample[][],
  walls: WallSpan[][],
  columns: number,
  rows: number,
  ix: number,
  iz: number,
  axis: 'x' | 'z',
  y0: number,
  y1: number,
  cell: number,
) {
  const steps: Array<[number, number]> = axis === 'x' ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]]
  let count = 1
  let open = false
  for (const [dx, dz] of steps) {
    let x = ix + dx
    let z = iz + dz
    while (x >= 0 && z >= 0 && x < columns && z < rows) {
      if (blocksSpan(samples[z * columns + x], walls[z * columns + x], y0, y1, true)) break
      count += 1
      x += dx
      z += dz
    }
    if (x < 0 || z < 0 || x >= columns || z >= rows) open = true
  }
  return { width: count * cell, open }
}

function pointOnTriangle(
  px: number,
  pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number | null {
  const abx = bx - ax
  const abz = bz - az
  const acx = cx - ax
  const acz = cz - az
  const apx = px - ax
  const apz = pz - az
  const denom = abx * acz - abz * acx
  if (Math.abs(denom) < 1e-8) return null
  const u = (apx * acz - apz * acx) / denom
  const v = (abx * apz - abz * apx) / denom
  if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) return null
  return ay + u * (by - ay) + v * (cy - ay)
}

export function buildSupportGeometry(mesh: THREE.Mesh): SupportBuild | null {
  const geometry = mesh.geometry
  const attribute = geometry.getAttribute('position')
  if (!attribute) return null

  mesh.updateWorldMatrix(true, false)
  const matrix = mesh.matrixWorld
  const index = geometry.getIndex()
  const triangleCount = index ? index.count / 3 : attribute.count / 3
  if (triangleCount === 0) return null

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity

  const readTriangle = (triangle: number) => {
    const base = triangle * 3
    const ia = index ? index.getX(base) : base
    const ib = index ? index.getX(base + 1) : base + 1
    const ic = index ? index.getX(base + 2) : base + 2
    readVertex(attribute, ia, a, matrix)
    readVertex(attribute, ib, b, matrix)
    readVertex(attribute, ic, c, matrix)
  }

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    readTriangle(triangle)
    minX = Math.min(minX, a.x, b.x, c.x)
    maxX = Math.max(maxX, a.x, b.x, c.x)
    minY = Math.min(minY, a.y, b.y, c.y)
    minZ = Math.min(minZ, a.z, b.z, c.z)
    maxZ = Math.max(maxZ, a.z, b.z, c.z)
  }

  const spanX = Math.max(maxX - minX, CELL_SIZE)
  const spanZ = Math.max(maxZ - minZ, CELL_SIZE)
  let cell = CELL_SIZE
  let columns = Math.max(1, Math.ceil(spanX / cell))
  let rows = Math.max(1, Math.ceil(spanZ / cell))
  if (columns > MAX_CELLS || rows > MAX_CELLS) {
    cell = Math.max(spanX / MAX_CELLS, spanZ / MAX_CELLS, CELL_SIZE)
    columns = Math.max(1, Math.ceil(spanX / cell))
    rows = Math.max(1, Math.ceil(spanZ / cell))
  }

  const samples: Sample[][] = Array.from({ length: columns * rows }, () => [])
  const walls: WallSpan[][] = Array.from({ length: columns * rows }, () => [])

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    readTriangle(triangle)
    edge1.subVectors(b, a)
    edge2.subVectors(c, a)
    edge1.cross(edge2)
    const length = edge1.length()
    if (length < 1e-8) continue
    const normalY = edge1.y / length
    const down = normalY < OVERHANG_NORMAL_Y
    const steep = Math.abs(normalY) < STEEP_NORMAL_Y

    const x0 = Math.min(a.x, b.x, c.x)
    const x1 = Math.max(a.x, b.x, c.x)
    const z0 = Math.min(a.z, b.z, c.z)
    const z1 = Math.max(a.z, b.z, c.z)
    const ix0 = Math.max(0, Math.floor((x0 - minX) / cell))
    const ix1 = Math.min(columns - 1, Math.floor((x1 - minX) / cell))
    const iz0 = Math.max(0, Math.floor((z0 - minZ) / cell))
    const iz1 = Math.min(rows - 1, Math.floor((z1 - minZ) / cell))
    const triY0 = Math.min(a.y, b.y, c.y)
    const triY1 = Math.max(a.y, b.y, c.y)

    for (let iz = iz0; iz <= iz1; iz += 1) {
      const cz = minZ + (iz + 0.5) * cell
      const cellZ0 = minZ + iz * cell
      const cellZ1 = cellZ0 + cell
      for (let ix = ix0; ix <= ix1; ix += 1) {
        const cx = minX + (ix + 0.5) * cell
        const y = pointOnTriangle(cx, cz, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
        if (y !== null) samples[iz * columns + ix].push({ y, down })
        if (!steep || triY1 - triY0 < 0.2) continue
        const cellX0 = minX + ix * cell
        const cellX1 = cellX0 + cell
        const crosses = segmentHitsCell(a.x, a.z, b.x, b.z, cellX0, cellZ0, cellX1, cellZ1)
          || segmentHitsCell(b.x, b.z, c.x, c.z, cellX0, cellZ0, cellX1, cellZ1)
          || segmentHitsCell(c.x, c.z, a.x, a.z, cellX0, cellZ0, cellX1, cellZ1)
        if (crosses) walls[iz * columns + ix].push({ y0: triY0, y1: triY1 })
      }
    }
  }

  for (const column of samples) {
    column.sort((left, right) => left.y - right.y)
    let write = 0
    for (let read = 0; read < column.length; read += 1) {
      const sample = column[read]
      if (write > 0 && Math.abs(column[write - 1].y - sample.y) < 0.05) {
        column[write - 1].down = column[write - 1].down || sample.down
        continue
      }
      column[write] = sample
      write += 1
    }
    column.length = write
  }

  const positions: number[] = []
  const half = PILLAR_WIDTH / 2
  const lattice = new Map<string, { dist: number, cx: number, cz: number, bottom: number, top: number }>()
  let pillars = 0
  let skipped = 0

  for (let iz = 0; iz < rows; iz += 1) {
    const cz = minZ + (iz + 0.5) * cell
    for (let ix = 0; ix < columns; ix += 1) {
      const column = samples[iz * columns + ix]
      if (column.length === 0) continue
      const cx = minX + (ix + 0.5) * cell
      for (const sample of column) {
        if (!sample.down) continue
        let below = minY
        let onBed = true
        for (const other of column) {
          if (!other.down && other.y < sample.y - 0.2) {
            below = other.y
            onBed = false
          }
        }
        if (sample.y - below <= MIN_GAP) continue
        const top = sample.y - Z_GAP
        const bottom = onBed ? below : below + Z_GAP
        if (top - bottom <= 0.05) continue
        if (blocksSpan(column, [], bottom, top)) continue

        const sideBlocked = (dx: number, dz: number) => {
          const nx = ix + dx
          const nz = iz + dz
          if (nx < 0 || nz < 0 || nx >= columns || nz >= rows) return false
          const neighbor = nz * columns + nx
          return blocksSpan(samples[neighbor], walls[neighbor], bottom, top, true)
        }
        const sandwiched = (sideBlocked(1, 0) && sideBlocked(-1, 0)) || (sideBlocked(0, 1) && sideBlocked(0, -1))

        const spanX = freeSpan(samples, walls, columns, rows, ix, iz, 'x', bottom, top, cell)
        const spanZ = freeSpan(samples, walls, columns, rows, ix, iz, 'z', bottom, top, cell)
        const reachable = spanX.width >= MIN_OPENING || spanZ.width >= MIN_OPENING || spanX.open || spanZ.open
        if (!reachable) {
          skipped += 1
          continue
        }
        if (sandwiched) continue
        const gx = Math.round((cx - minX) / PITCH)
        const gz = Math.round((cz - minZ) / PITCH)
        const dist = Math.hypot(cx - (minX + gx * PITCH), cz - (minZ + gz * PITCH))
        const key = `${gx},${gz},${Math.round(top)}`
        const previous = lattice.get(key)
        if (!previous || dist < previous.dist) lattice.set(key, { dist, cx, cz, bottom, top })
      }
    }
  }

  for (const pillar of lattice.values()) {
    const height = pillar.top - pillar.bottom
    pushBox(positions, pillar.cx, pillar.bottom + height / 2, pillar.cz, half, height / 2, half)
    pillars += 1
  }

  if (pillars === 0 && skipped === 0) return null

  if (pillars === 0) return { geometry: null, pillars, skipped }

  const support = new THREE.BufferGeometry()
  support.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  support.computeVertexNormals()
  return { geometry: support, pillars, skipped }
}
