import type { MaterialGroup, ModelNodeItem } from '../types/model'

interface GltfMaterial {
  name?: string
}

interface GltfPrimitive {
  material?: number
  attributes?: {
    POSITION?: number
  }
}

interface GltfMesh {
  name?: string
  primitives?: GltfPrimitive[]
}

interface GltfNode {
  name?: string
  mesh?: number
  matrix?: number[]
  rotation?: number[]
  translation?: number[]
  scale?: number[]
}

interface GltfAccessor {
  min?: number[]
  max?: number[]
}

interface GltfDocument {
  accessors?: GltfAccessor[]
  materials?: GltfMaterial[]
  meshes?: GltfMesh[]
  nodes?: GltfNode[]
}

interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK_TYPE = 0x4e4f534a

const decoder = new TextDecoder('utf-8')

export async function loadModelGroups(modelUrl: string): Promise<MaterialGroup[]> {
  const response = await fetch(modelUrl)

  if (!response.ok) {
    throw new Error(`Failed to load model metadata: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const gltf = parseGlbJson(arrayBuffer)

  return buildMaterialGroups(gltf)
}

export function parseGlbJson(buffer: ArrayBuffer): GltfDocument {
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)

  if (magic !== GLB_MAGIC) {
    throw new Error('The selected file is not a valid GLB model')
  }

  const version = view.getUint32(4, true)

  if (version !== 2) {
    throw new Error(`Unsupported glTF version ${version}; expected glTF 2.0`)
  }

  let offset = 12

  while (offset < buffer.byteLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength

    if (chunkType === JSON_CHUNK_TYPE) {
      const text = decoder.decode(new Uint8Array(buffer, chunkStart, chunkLength)).trim()
      return JSON.parse(text) as GltfDocument
    }

    offset = chunkEnd
  }

  throw new Error('Could not find the GLB JSON chunk')
}

function buildMaterialGroups(gltf: GltfDocument): MaterialGroup[] {
  const materials = gltf.materials ?? []
  const meshes = gltf.meshes ?? []
  const nodes = gltf.nodes ?? []
  const accessors = gltf.accessors ?? []
  const groupMap = new Map<number, MaterialGroup>()

  nodes.forEach((node, nodeIndex) => {
    if (typeof node.mesh !== 'number') {
      return
    }

    const mesh = meshes[node.mesh]
    const primitives = mesh?.primitives ?? []
    const materialIndex = primitives[0]?.material ?? -1
    const materialName =
      materialIndex >= 0
        ? normalizeMaterialName(materials[materialIndex]?.name, materialIndex)
        : '未指定材质'
    const group = ensureGroup(groupMap, materialIndex, materialName)
    const runtimeName = node.name || mesh?.name || `Node ${nodeIndex}`
    const name = getDisplayName(runtimeName)
    const localBounds = getPrimitiveBounds(primitives, accessors)
    const bounds = transformBounds(node, localBounds)
    const center = getBoundsCenter(bounds)

    group.children.push({
      id: `node-${nodeIndex}`,
      name,
      runtimeName,
      nodeIndex,
      meshIndex: node.mesh,
      materialIndex,
      materialName,
      groupId: group.id,
      primitiveCount: primitives.length,
      center,
      boundsMin: bounds.min,
      boundsMax: bounds.max
    })
  })

  return Array.from(groupMap.values())
    .map((group) => ({
      ...group,
      children: group.children.sort((a, b) => a.nodeIndex - b.nodeIndex)
    }))
    .sort((a, b) => a.materialIndex - b.materialIndex)
}

function ensureGroup(
  groupMap: Map<number, MaterialGroup>,
  materialIndex: number,
  materialName: string
): MaterialGroup {
  const existing = groupMap.get(materialIndex)

  if (existing) {
    return existing
  }

  const group: MaterialGroup = {
    id: `material-${materialIndex}`,
    name: materialName,
    materialIndex,
    children: []
  }

  groupMap.set(materialIndex, group)
  return group
}

function normalizeMaterialName(name: string | undefined, index: number): string {
  if (!name) {
    return `材质 ${index}`
  }

  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || `材质 ${index}`
}

function getDisplayName(runtimeName: string): string {
  return runtimeName.replace(/__node_\d+$/, '')
}

function getPrimitiveBounds(primitives: GltfPrimitive[], accessors: GltfAccessor[]): Bounds {
  const bounds = primitives.reduce(
    (result, primitive) => {
      const accessorIndex = primitive.attributes?.POSITION
      const accessor = typeof accessorIndex === 'number' ? accessors[accessorIndex] : undefined

      if (!accessor?.min || !accessor.max) {
        return result
      }

      for (let index = 0; index < 3; index += 1) {
        result.min[index] = Math.min(result.min[index], accessor.min[index])
        result.max[index] = Math.max(result.max[index], accessor.max[index])
      }

      result.hasBounds = true
      return result
    },
    {
      hasBounds: false,
      min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    }
  )

  if (!bounds.hasBounds) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0]
    }
  }

  return {
    min: [bounds.min[0], bounds.min[1], bounds.min[2]],
    max: [bounds.max[0], bounds.max[1], bounds.max[2]]
  }
}

function transformBounds(node: GltfNode, bounds: Bounds): Bounds {
  const corners = getBoundsCorners(bounds).map((corner) => applyNodeTransform(node, corner))

  return corners.reduce(
    (result, corner) => {
      for (let index = 0; index < 3; index += 1) {
        result.min[index] = Math.min(result.min[index], corner[index])
        result.max[index] = Math.max(result.max[index], corner[index])
      }

      return result
    },
    {
      min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    } as Bounds
  )
}

function getBoundsCorners(bounds: Bounds): Array<[number, number, number]> {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max

  return [
    [minX, minY, minZ],
    [minX, minY, maxZ],
    [minX, maxY, minZ],
    [minX, maxY, maxZ],
    [maxX, minY, minZ],
    [maxX, minY, maxZ],
    [maxX, maxY, minZ],
    [maxX, maxY, maxZ]
  ]
}

function getBoundsCenter(bounds: Bounds): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ]
}

function applyNodeTransform(node: GltfNode, point: [number, number, number]): [number, number, number] {
  if (node.matrix?.length === 16) {
    const matrix = node.matrix
    const [x, y, z] = point

    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    ]
  }

  const scale = node.scale ?? [1, 1, 1]
  const rotation = node.rotation ?? [0, 0, 0, 1]
  const translation = node.translation ?? [0, 0, 0]
  const scaled: [number, number, number] = [
    point[0] * scale[0],
    point[1] * scale[1],
    point[2] * scale[2]
  ]
  const rotated = rotateByQuaternion(scaled, rotation)

  return [
    rotated[0] + translation[0],
    rotated[1] + translation[1],
    rotated[2] + translation[2]
  ]
}

function rotateByQuaternion(point: [number, number, number], quaternion: number[]): [number, number, number] {
  const [x, y, z] = point
  const [qx, qy, qz, qw] = quaternion
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)

  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx)
  ]
}
