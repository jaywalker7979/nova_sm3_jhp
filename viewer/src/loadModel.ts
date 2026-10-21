import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'

export type LoadedModel = {
  object: THREE.Object3D
  triangles: number
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return index.count / 3
  const position = geometry.getAttribute('position')
  return position ? position.count / 3 : 0
}

export function countTriangles(object: THREE.Object3D): number {
  let count = 0
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) count += triangleCount(child.geometry)
  })
  return count
}

export function disposeModel(object: THREE.Object3D | null, shared: THREE.Material | THREE.Material[]) {
  if (!object) return
  const keep = new Set(Array.isArray(shared) ? shared : [shared])
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!keep.has(material)) material.dispose()
    }
  })
}

function useSharedMaterial(root: THREE.Object3D, material: THREE.Material) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const previous = child.material
    child.material = material
    const materials = Array.isArray(previous) ? previous : [previous]
    for (const item of materials) {
      if (item !== material) item.dispose()
    }
    child.geometry.computeVertexNormals()
  })
}

function separateStackedPlates(root: THREE.Object3D) {
  const items = root.children.filter((child) => !new THREE.Box3().setFromObject(child).isEmpty())
  if (items.length < 2) return

  const boxes = items.map((item) => new THREE.Box3().setFromObject(item))
  const union = boxes[0].clone()
  let maxX = 0
  let maxY = 0
  for (const box of boxes) {
    union.union(box)
    const size = box.getSize(new THREE.Vector3())
    maxX = Math.max(maxX, size.x)
    maxY = Math.max(maxY, size.y)
  }
  const unionSize = union.getSize(new THREE.Vector3())
  const stacked = unionSize.x <= maxX * 1.35 && unionSize.y <= maxY * 1.35
  if (!stacked) return

  const gapX = Math.max(maxX * 0.15, 8)
  const gapY = Math.max(maxY * 0.15, 8)
  const cols = Math.ceil(Math.sqrt(items.length))
  items.forEach((item, index) => {
    const center = boxes[index].getCenter(new THREE.Vector3())
    const col = index % cols
    const row = Math.floor(index / cols)
    item.position.x += col * (maxX + gapX) + maxX / 2 - center.x
    item.position.y += row * (maxY + gapY) + maxY / 2 - center.y
  })
}

function loadStl(buffer: ArrayBuffer, material: THREE.Material): LoadedModel {
  const geometry = new STLLoader().parse(buffer)
  geometry.computeVertexNormals()
  const triangles = triangleCount(geometry)
  if (triangles === 0) {
    geometry.dispose()
    throw new Error('삼각형이 없는 STL입니다.')
  }
  return { object: new THREE.Mesh(geometry, material), triangles }
}

function load3mf(buffer: ArrayBuffer, material: THREE.Material): LoadedModel {
  const group = new ThreeMFLoader().parse(buffer)
  const triangles = countTriangles(group)
  if (triangles === 0) {
    disposeModel(group, material)
    throw new Error('메시가 없는 3MF입니다.')
  }
  // Bambu 멀티 플레이트는 파트를 같은 베드 좌표에 둔다. 겹치면 펼쳐서 모두 보이게 한다.
  separateStackedPlates(group)
  useSharedMaterial(group, material)
  // 3MF는 Z가 위이고, 뷰어 격자는 Y가 위다.
  group.rotation.x = -Math.PI / 2
  return { object: group, triangles }
}

export function loadModel(buffer: ArrayBuffer, fileName: string, material: THREE.Material): LoadedModel {
  if (fileName.toLowerCase().endsWith('.3mf')) return load3mf(buffer, material)
  return loadStl(buffer, material)
}
