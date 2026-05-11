import {
  Camera,
  Cartesian2,
  Cartesian3,
  Matrix4,
  Ray as CesiumRay
} from 'cesium'
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

type MeshWithNode = THREE.Mesh & {
  userData: {
    modelNodeId?: string
  }
}

interface AxisCandidate {
  name: string
  cesiumToGltf(point: Cartesian3): THREE.Vector3
}

export interface MeshPicker {
  pick(position: Cartesian2, camera: Camera, modelMatrix: Matrix4): string | null
  dispose(): void
}

export interface CreateMeshPickerOptions {
  modelUrl: string
  nodeIdByName: Map<string, string>
}

const axisCandidates: AxisCandidate[] = [
  { name: 'z-up-to-y-up', cesiumToGltf: (point) => new THREE.Vector3(point.x, point.z, -point.y) },
  { name: 'identity', cesiumToGltf: (point) => new THREE.Vector3(point.x, point.y, point.z) },
  { name: 'z-up-to-x-up', cesiumToGltf: (point) => new THREE.Vector3(-point.z, point.y, point.x) }
]

const pickOffsets = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-2, -2],
  [2, -2],
  [-2, 2],
  [2, 2],
  [-3, 0],
  [3, 0],
  [0, -3],
  [0, 3]
] as const

const geometryPrototype = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
  computeBoundsTree?: typeof computeBoundsTree
  disposeBoundsTree?: typeof disposeBoundsTree
}
const meshPrototype = THREE.Mesh.prototype as THREE.Mesh & {
  raycast: typeof acceleratedRaycast
}

geometryPrototype.computeBoundsTree = computeBoundsTree
geometryPrototype.disposeBoundsTree = disposeBoundsTree
meshPrototype.raycast = acceleratedRaycast

export async function createMeshPicker(options: CreateMeshPickerOptions): Promise<MeshPicker> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(options.modelUrl)
  const root = gltf.scene
  const meshes: MeshWithNode[] = []
  const raycaster = new THREE.Raycaster()

  root.updateMatrixWorld(true)
  root.traverse((object) => {
    if (!isMesh(object)) {
      return
    }

    const nodeId = resolveNodeId(object, options.nodeIdByName)

    if (!nodeId) {
      return
    }

    object.userData.modelNodeId = nodeId

    if (object.geometry) {
      object.geometry.computeBoundsTree()
    }

    meshes.push(object)
  })

  return {
    pick(position, camera, modelMatrix) {
      if (meshes.length === 0) {
        return null
      }

      return pickNearestSample(position, camera, modelMatrix, raycaster, meshes)
    },

    dispose() {
      meshes.forEach((mesh) => {
        mesh.geometry?.disposeBoundsTree()
      })
    }
  }
}

function pickNearestNode(
  worldRay: CesiumRay,
  modelMatrix: Matrix4,
  raycaster: THREE.Raycaster,
  meshes: MeshWithNode[]
): string | null {
  return pickNearestHit(worldRay, modelMatrix, raycaster, meshes)?.nodeId ?? null
}

function pickNearestSample(
  position: Cartesian2,
  camera: Camera,
  modelMatrix: Matrix4,
  raycaster: THREE.Raycaster,
  meshes: MeshWithNode[]
): string | null {
  let nearestSample: { nodeId: string; rayDistance: number; pixelDistance: number } | null = null

  for (const [offsetX, offsetY] of pickOffsets) {
    const samplePosition =
      offsetX === 0 && offsetY === 0
        ? position
        : new Cartesian2(position.x + offsetX, position.y + offsetY)
    const worldRay = camera.getPickRay(samplePosition)

    if (!worldRay) {
      continue
    }

    const hit = pickNearestHit(worldRay, modelMatrix, raycaster, meshes)

    if (!hit) {
      continue
    }

    const pixelDistance = Math.hypot(offsetX, offsetY)

    if (
      !nearestSample ||
      pixelDistance < nearestSample.pixelDistance ||
      (pixelDistance === nearestSample.pixelDistance && hit.rayDistance < nearestSample.rayDistance)
    ) {
      nearestSample = {
        nodeId: hit.nodeId,
        rayDistance: hit.rayDistance,
        pixelDistance
      }
    }
  }

  return nearestSample?.nodeId ?? null
}

function pickNearestHit(
  worldRay: CesiumRay,
  modelMatrix: Matrix4,
  raycaster: THREE.Raycaster,
  meshes: MeshWithNode[]
): { nodeId: string; rayDistance: number } | null {
  const inverseModelMatrix = Matrix4.inverseTransformation(modelMatrix, new Matrix4())
  const localOrigin = Matrix4.multiplyByPoint(inverseModelMatrix, worldRay.origin, new Cartesian3())
  const worldEnd = Cartesian3.add(worldRay.origin, worldRay.direction, new Cartesian3())
  const localEnd = Matrix4.multiplyByPoint(inverseModelMatrix, worldEnd, new Cartesian3())
  let nearest: { distance: number; object: MeshWithNode; candidateName: string } | null = null

  for (const candidate of axisCandidates) {
    const gltfOrigin = candidate.cesiumToGltf(localOrigin)
    const gltfEnd = candidate.cesiumToGltf(localEnd)
    const direction = gltfEnd.clone().sub(gltfOrigin)

    if (direction.lengthSq() === 0) {
      continue
    }

    raycaster.set(gltfOrigin, direction.normalize())

    const hit = (raycaster.intersectObjects(meshes, false)[0] as
      | THREE.Intersection<MeshWithNode>
      | undefined) ?? null

    if (!hit) {
      continue
    }

    if (!nearest || hit.distance < nearest.distance) {
      nearest = {
        distance: hit.distance,
        object: hit.object,
        candidateName: candidate.name
      }
    }
  }

  if (!nearest) {
    return null
  }

  const nodeId = nearest.object.userData.modelNodeId

  return nodeId ? { nodeId, rayDistance: nearest.distance } : null
}

function resolveNodeId(object: THREE.Object3D, nodeIdByName: Map<string, string>): string | null {
  let current: THREE.Object3D | null = object

  while (current) {
    const directId = nodeIdByName.get(current.name)

    if (directId) {
      return directId
    }

    const suffixMatch = current.name.match(/^(.*__node_\d+)(?:_\d+)?$/)
    const suffixId = suffixMatch ? nodeIdByName.get(suffixMatch[1]) : undefined

    if (suffixId) {
      return suffixId
    }

    current = current.parent
  }

  return null
}

function isMesh(object: THREE.Object3D): object is MeshWithNode {
  return (object as THREE.Mesh).isMesh === true
}
