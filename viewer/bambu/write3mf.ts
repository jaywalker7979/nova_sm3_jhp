import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const profilePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'profile.json')

const MODEL_OPEN = '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">'

type Mesh = {
  verts: Array<[number, number, number]>
  faces: Array<[number, number, number]>
}

export function supportProjectSettings(): string {
  return fs.readFileSync(profilePath, 'utf8')
}

function parseBinaryStl(data: Buffer): Mesh {
  if (data.length < 84) throw new Error('STL이 너무 짧습니다.')
  const count = data.readUInt32LE(80)
  if (84 + count * 50 !== data.length) throw new Error('바이너리 STL이 아닙니다.')

  const index = new Map<string, number>()
  const verts: Array<[number, number, number]> = []
  const faces: Array<[number, number, number]> = []
  let offset = 84
  for (let triangle = 0; triangle < count; triangle += 1) {
    const face: [number, number, number] = [0, 0, 0]
    for (let corner = 0; corner < 3; corner += 1) {
      const base = offset + 12 + corner * 12
      const x = data.readFloatLE(base)
      const y = data.readFloatLE(base + 4)
      const z = data.readFloatLE(base + 8)
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`
      let id = index.get(key)
      if (id === undefined) {
        id = verts.length
        index.set(key, id)
        verts.push([x, y, z])
      }
      face[corner] = id
    }
    faces.push(face)
    offset += 50
  }
  if (faces.length === 0) throw new Error('삼각형이 없습니다.')
  return { verts, faces }
}

function meshXml(mesh: Mesh): string {
  const vertices = mesh.verts.map(([x, y, z]) => `     <vertex x="${x.toFixed(5)}" y="${y.toFixed(5)}" z="${z.toFixed(5)}"/>`).join('\n')
  const triangles = mesh.faces.map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('\n')
  return `   <mesh>\n    <vertices>\n${vertices}\n    </vertices>\n    <triangles>\n${triangles}\n    </triangles>\n   </mesh>`
}

function modelXml(name: string, mesh: Mesh): string {
  const safeName = name.replace(/[<>&"']/g, '')
  const objectId = 2
  return `<?xml version="1.0" encoding="UTF-8"?>
${MODEL_OPEN}
 <metadata name="Application">BambuStudio-02.06.00.51</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${safeName}</metadata>
 <resources>
  <object id="${objectId}" type="model">
${meshXml(mesh)}
  </object>
 </resources>
 <build>
  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>
`
}

function modelSettingsXml(name: string): string {
  const safeName = name.replace(/[<>&"']/g, '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="${safeName}"/>
    <metadata key="extruder" value="1"/>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="${safeName}"/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
</config>
`
}

function sliceInfoXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.06.00.51"/>
  </header>
</config>
`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`

function zipFiles(files: Array<{ name: string, data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const compressed = deflateRawSync(file.data)
    const checksum = crc32(file.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    parts.push(local, compressed)

    const directory = Buffer.alloc(46 + name.length)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(compressed.length, 20)
    directory.writeUInt32LE(file.data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    name.copy(directory, 46)
    central.push(directory)
    offset += local.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

export function buildBambu3mf(stl: Buffer, name: string): Buffer {
  const mesh = parseBinaryStl(stl)
  const title = name.replace(/\.stl$/i, '') || 'part'
  return zipFiles([
    { name: '3D/3dmodel.model', data: Buffer.from(modelXml(title, mesh)) },
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: '_rels/.rels', data: Buffer.from(RELS) },
    { name: 'Metadata/project_settings.config', data: Buffer.from(supportProjectSettings()) },
    { name: 'Metadata/model_settings.config', data: Buffer.from(modelSettingsXml(title)) },
    { name: 'Metadata/slice_info.config', data: Buffer.from(sliceInfoXml()) },
  ])
}
