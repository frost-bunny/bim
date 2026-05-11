import type { MaterialGroup, ModelNodeItem } from '../types/model'

interface TilesetDocument {
  root?: TilesetTile
}

interface TilesetTile {
  content?: {
    uri?: string
    url?: string
  }
  children?: TilesetTile[]
}

interface GltfDocument {
  asset?: {
    version?: string
  }
  bufferViews?: GltfBufferView[]
  extensions?: {
    EXT_structural_metadata?: StructuralMetadata
  }
  materials?: Array<{ name?: string }>
  meshes?: Array<{ name?: string; primitives?: GltfPrimitive[] }>
  nodes?: Array<{ name?: string; mesh?: number }>
}

interface GltfBufferView {
  byteOffset?: number
  byteLength?: number
}

interface GltfPrimitive {
  material?: number
}

interface StructuralMetadata {
  propertyTables?: PropertyTable[]
}

interface PropertyTable {
  count?: number
  properties?: Record<string, PropertyTableProperty>
}

interface PropertyTableProperty {
  values?: number
  stringOffsets?: number
}

interface GlbData {
  json: GltfDocument
  binaryChunk: Uint8Array
}

interface TileFeatureRecord {
  id: string
  name: string
  groupName: string
  nodeIndex: number
  meshIndex: number
  primitiveCount: number
}

const GLB_MAGIC = 'glTF'
const B3DM_MAGIC = 'b3dm'
const CMPT_MAGIC = 'cmpt'
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942
const decoder = new TextDecoder('utf-8')

export async function loadTilesetGroups(tilesetUrl: string): Promise<MaterialGroup[]> {
  const response = await fetch(tilesetUrl)

  if (!response.ok) {
    throw new Error(`Failed to load 3D Tiles metadata: ${response.status} ${response.statusText}`)
  }

  const tileset = (await response.json()) as TilesetDocument
  const contentUrls = collectContentUrls(tileset.root, new URL(tilesetUrl, window.location.href))
  const records = (
    await Promise.all(contentUrls.map((url, tileIndex) => loadTileRecords(url, tileIndex)))
  ).flat()

  return buildGroups(records)
}

function collectContentUrls(tile: TilesetTile | undefined, baseUrl: URL): URL[] {
  if (!tile) {
    return []
  }

  const urls: URL[] = []
  const contentUri = tile.content?.uri ?? tile.content?.url

  if (contentUri) {
    urls.push(new URL(contentUri, baseUrl))
  }

  tile.children?.forEach((child) => {
    urls.push(...collectContentUrls(child, baseUrl))
  })

  return urls
}

async function loadTileRecords(url: URL, tileIndex: number): Promise<TileFeatureRecord[]> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to load tile metadata ${url.pathname}: ${response.status} ${response.statusText}`)
  }

  return parseTileRecords(await response.arrayBuffer(), getTileName(url), tileIndex)
}

function parseTileRecords(buffer: ArrayBuffer, tileName: string, tileIndex: number): TileFeatureRecord[] {
  const bytes = new Uint8Array(buffer)
  const magic = readMagic(bytes, 0)

  if (magic === GLB_MAGIC) {
    return buildGltfRecords(parseGlb(buffer), tileName, tileIndex)
  }

  if (magic === B3DM_MAGIC) {
    return parseB3dmRecords(bytes, tileName, tileIndex)
  }

  if (magic === CMPT_MAGIC) {
    return parseCmptRecords(bytes, tileName, tileIndex)
  }

  return [createFallbackRecord(tileName, tileIndex, 0)]
}

function parseB3dmRecords(bytes: Uint8Array, tileName: string, tileIndex: number): TileFeatureRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const featureTableJsonLength = view.getUint32(12, true)
  const featureTableBinaryLength = view.getUint32(16, true)
  const batchTableJsonLength = view.getUint32(20, true)
  const batchTableBinaryLength = view.getUint32(24, true)
  const batchTableStart = 28 + featureTableJsonLength + featureTableBinaryLength
  const glbStart = batchTableStart + batchTableJsonLength + batchTableBinaryLength
  const batchTableText =
    batchTableJsonLength > 0
      ? decoder.decode(bytes.subarray(batchTableStart, batchTableStart + batchTableJsonLength)).trim()
      : ''
  const batchTable = parseJsonObject(batchTableText)
  const glb = parseGlb(toArrayBuffer(bytes.subarray(glbStart)))

  return buildGltfRecords(glb, tileName, tileIndex, batchTable)
}

function parseCmptRecords(bytes: Uint8Array, tileName: string, tileIndex: number): TileFeatureRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tilesLength = view.getUint32(12, true)
  const records: TileFeatureRecord[] = []
  let offset = 16

  for (let index = 0; index < tilesLength && offset + 12 <= bytes.byteLength; index += 1) {
    const childByteLength = view.getUint32(offset + 8, true)
    const child = bytes.subarray(offset, offset + childByteLength)
    records.push(
      ...parseTileRecords(
        toArrayBuffer(child),
        `${tileName}#${index + 1}`,
        tileIndex + index
      )
    )
    offset += childByteLength
  }

  return records
}

function parseGlb(buffer: ArrayBuffer): GlbData {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  if (readMagic(bytes, 0) !== GLB_MAGIC) {
    throw new Error('The selected tile content is not a valid GLB model')
  }

  let offset = 12
  let json: GltfDocument | null = null
  let binaryChunk = new Uint8Array()

  while (offset < buffer.byteLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength

    if (chunkType === JSON_CHUNK_TYPE) {
      const text = decoder.decode(new Uint8Array(buffer, chunkStart, chunkLength)).trim()
      json = JSON.parse(text) as GltfDocument
    }

    if (chunkType === BIN_CHUNK_TYPE) {
      binaryChunk = new Uint8Array(buffer, chunkStart, chunkLength)
    }

    offset = chunkEnd
  }

  if (!json) {
    throw new Error('Could not find the GLB JSON chunk')
  }

  return { json, binaryChunk }
}

function buildGltfRecords(
  glb: GlbData,
  tileName: string,
  tileIndex: number,
  batchTable?: Record<string, unknown>
): TileFeatureRecord[] {
  const metadataRecords = readStructuralMetadataRecords(glb, tileName, tileIndex)

  if (metadataRecords.length > 0) {
    return metadataRecords
  }

  const batchRecords = readBatchTableRecords(batchTable, tileName, tileIndex)

  if (batchRecords.length > 0) {
    return batchRecords
  }

  const nodes = glb.json.nodes ?? []
  const meshes = glb.json.meshes ?? []
  const materials = glb.json.materials ?? []
  const meshNodes = nodes.filter((node) => typeof node.mesh === 'number')
  const sourceItems = meshNodes.length > 0 ? meshNodes : meshes.map((mesh, index) => ({ name: mesh.name, mesh: index }))

  if (sourceItems.length === 0) {
    return [createFallbackRecord(tileName, tileIndex, 0)]
  }

  return sourceItems.map((item, index) => {
    const mesh = typeof item.mesh === 'number' ? meshes[item.mesh] : undefined
    const material = getPrimaryMaterial(mesh, materials)
    const name = item.name || mesh?.name || material || tileName

    return {
      id: `${tileName}:${index}`,
      name,
      groupName: material || getMaterialGroupFromTileName(tileName),
      nodeIndex: tileIndex,
      meshIndex: index,
      primitiveCount: mesh?.primitives?.length ?? 1
    }
  })
}

function readStructuralMetadataRecords(
  glb: GlbData,
  tileName: string,
  tileIndex: number
): TileFeatureRecord[] {
  const table = glb.json.extensions?.EXT_structural_metadata?.propertyTables?.[0]
  const count = table?.count ?? 0

  if (count === 0) {
    return []
  }

  const properties = table?.properties ?? {}
  const ids = readStringProperty(glb, properties.propertiesID, count)
  const meshNames = readStringProperty(glb, properties.meshName, count)
  const layers = readStringProperty(glb, properties.layer, count)
  const types = readStringProperty(glb, properties.type, count)

  return Array.from({ length: count }, (_, rowIndex) => {
    const fallbackName = meshNames[rowIndex] || `${tileName}-${rowIndex + 1}`
    const id = ids[rowIndex] || fallbackName || `tile-${tileIndex}-feature-${rowIndex}`

    return {
      id,
      name: fallbackName,
      groupName: layers[rowIndex] || types[rowIndex] || getMaterialGroupFromTileName(tileName),
      nodeIndex: rowIndex,
      meshIndex: rowIndex,
      primitiveCount: 1
    }
  })
}

function readBatchTableRecords(
  batchTable: Record<string, unknown> | undefined,
  tileName: string,
  tileIndex: number
): TileFeatureRecord[] {
  if (!batchTable) {
    return []
  }

  const firstArray = Object.values(batchTable).find(Array.isArray)

  if (!Array.isArray(firstArray) || firstArray.length === 0) {
    return []
  }

  const ids = getStringArray(batchTable, ['propertiesID', 'id', 'ID', 'batchId'])
  const names = getStringArray(batchTable, ['meshName', 'name', 'Name'])
  const groups = getStringArray(batchTable, ['layer', 'type', 'material', 'Material'])

  return firstArray.map((_, rowIndex) => {
    const name = names[rowIndex] || ids[rowIndex] || `${tileName}-${rowIndex + 1}`

    return {
      id: ids[rowIndex] || `${tileName}:${rowIndex}`,
      name,
      groupName: groups[rowIndex] || getMaterialGroupFromTileName(tileName),
      nodeIndex: tileIndex,
      meshIndex: rowIndex,
      primitiveCount: 1
    }
  })
}

function readStringProperty(
  glb: GlbData,
  property: PropertyTableProperty | undefined,
  count: number
): string[] {
  if (count === 0 || typeof property?.values !== 'number' || typeof property.stringOffsets !== 'number') {
    return []
  }

  const values = getBufferViewBytes(glb, property.values)
  const offsets = getBufferViewBytes(glb, property.stringOffsets)
  const offsetView = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength)

  return Array.from({ length: count }, (_, index) => {
    const start = offsetView.getUint32(index * 4, true)
    const end = offsetView.getUint32((index + 1) * 4, true)

    return decoder.decode(values.subarray(start, end))
  })
}

function getBufferViewBytes(glb: GlbData, bufferViewIndex: number): Uint8Array {
  const bufferView = glb.json.bufferViews?.[bufferViewIndex]

  if (!bufferView) {
    return new Uint8Array()
  }

  const byteOffset = bufferView.byteOffset ?? 0
  const byteLength = bufferView.byteLength ?? 0

  return glb.binaryChunk.subarray(byteOffset, byteOffset + byteLength)
}

function buildGroups(records: TileFeatureRecord[]): MaterialGroup[] {
  const groupMap = new Map<string, MaterialGroup>()
  const usedIds = new Set<string>()

  records.forEach((record, index) => {
    const group = ensureGroup(groupMap, record.groupName || '未分组')
    const uniqueId = ensureUniqueId(record.id, usedIds, index)

    group.children.push({
      id: uniqueId,
      name: record.name,
      runtimeName: record.id,
      nodeIndex: record.nodeIndex,
      meshIndex: record.meshIndex,
      materialIndex: group.materialIndex,
      materialName: group.name,
      groupId: group.id,
      primitiveCount: record.primitiveCount,
      center: [0, 0, 0],
      boundsMin: [0, 0, 0],
      boundsMax: [0, 0, 0]
    })
  })

  return Array.from(groupMap.values())
    .map((group) => ({
      ...group,
      children: group.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function ensureGroup(groupMap: Map<string, MaterialGroup>, name: string): MaterialGroup {
  const existing = groupMap.get(name)

  if (existing) {
    return existing
  }

  const materialIndex = groupMap.size
  const group: MaterialGroup = {
    id: `tiles-${materialIndex}`,
    name,
    materialIndex,
    children: []
  }

  groupMap.set(name, group)
  return group
}

function getPrimaryMaterial(
  mesh: { primitives?: GltfPrimitive[] } | undefined,
  materials: Array<{ name?: string }>
): string {
  const materialIndex = mesh?.primitives?.find((primitive) => typeof primitive.material === 'number')?.material

  if (typeof materialIndex !== 'number') {
    return ''
  }

  return normalizeName(materials[materialIndex]?.name ?? '')
}

function getMaterialGroupFromTileName(tileName: string): string {
  const match = tileName.match(/material([^_#]+)/i)

  return match ? `material ${match[1]}` : '未分组'
}

function getStringArray(batchTable: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = batchTable[key]

    if (Array.isArray(value)) {
      return value.map((item) => String(item ?? ''))
    }
  }

  return []
}

function createFallbackRecord(tileName: string, tileIndex: number, meshIndex: number): TileFeatureRecord {
  return {
    id: `${tileName}:${meshIndex}`,
    name: tileName,
    groupName: getMaterialGroupFromTileName(tileName),
    nodeIndex: tileIndex,
    meshIndex,
    primitiveCount: 1
  }
}

function ensureUniqueId(id: string, usedIds: Set<string>, index: number): string {
  if (!usedIds.has(id)) {
    usedIds.add(id)
    return id
  }

  const nextId = `${id}#${index}`
  usedIds.add(nextId)
  return nextId
}

function normalizeName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readMagic(bytes: Uint8Array, offset: number): string {
  return decoder.decode(bytes.subarray(offset, offset + 4))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function getTileName(url: URL): string {
  return decodeURIComponent(url.pathname.split('/').pop() ?? 'tile')
}
