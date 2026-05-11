<template>
  <div ref="containerRef" class="cesium-host"></div>
</template>

<script setup lang="ts">
import {
  Axis,
  Cartesian2,
  Cartesian3,
  Cesium3DTileFeature,
  Cesium3DTileColorBlendMode,
  Cesium3DTileset,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from 'cesium'
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import type { ModelNodeItem } from '../types/model'

const props = defineProps<{
  tilesetUrl: string
  modelUrl?: string
  nodes: ModelNodeItem[]
  selectedNodeId: string | null
  hoveredNodeId: string | null
  hoverHighlightEnabled: boolean
  hiddenNodeIds: Set<string>
}>()

const emit = defineEmits<{
  (event: 'select-node', nodeId: string): void
  (event: 'hover-node', nodeId: string | null): void
  (event: 'ready'): void
  (event: 'error', message: string): void
}>()

const containerRef = shallowRef<HTMLDivElement | null>(null)
const viewerRef = shallowRef<Viewer | null>(null)
const tilesetRef = shallowRef<Cesium3DTileset | null>(null)
const handlerRef = shallowRef<ScreenSpaceEventHandler | null>(null)

let removeCanvasLeaveListener: (() => void) | null = null
let removeTileVisibleListener: (() => void) | null = null
let removeTileUnloadListener: (() => void) | null = null
let hoverFrameId = 0
let pendingHoverPosition: Cartesian2 | null = null
let emittedHoverNodeId: string | null = null
let lastStableHoverNodeId: string | null = null
let lastStableHoverPosition: Cartesian2 | null = null
let hoverCandidateNodeId: string | null = null
let hoverCandidateFrameCount = 0
let hoverMissCount = 0

const hoverMissClearFrameCount = 2
const hoverSwitchConfirmFrameCount = 2
const hoverSwitchMinPixelDistance = 8
const normalFeatureColor = Color.WHITE
const hoverFeatureColor = Color.fromCssColorString('#fff47a').withAlpha(0.55)
const selectedFeatureColor = Color.fromCssColorString('#18f3ff').withAlpha(0.85)
const hiddenFeatureColor = Color.WHITE.withAlpha(0.12)

const nodeById = new Map<string, ModelNodeItem>()
const nodeIdByRuntimeName = new Map<string, string>()
const nodeIdByName = new Map<string, string>()
const nodeIdByContentKey = new Map<string, string>()
const featureByNodeId = new Map<string, Set<Cesium3DTileFeature>>()
const contentByNodeId = new Map<string, Set<TileContentTarget>>()

interface TileContentTarget {
  url?: string
  innerContents?: unknown[]
  featuresLength?: number
  getFeature?: (batchId: number) => Cesium3DTileFeature
  _model?: {
    show?: boolean
    color?: Color
    silhouetteColor?: Color
    silhouetteSize?: number
  }
}

interface PickedTileObject {
  content?: unknown
  detail?: {
    model?: {
      content?: unknown
    }
  }
}

watch(
  () => props.nodes,
  (nodes) => {
    nodeById.clear()
    nodeIdByRuntimeName.clear()
    nodeIdByName.clear()
    nodeIdByContentKey.clear()

    nodes.forEach((node) => {
      nodeById.set(node.id, node)
      nodeIdByRuntimeName.set(node.runtimeName, node.id)
      nodeIdByName.set(node.name, node.id)
      registerContentKeys(node)
    })

    syncFeatureStyles()
  },
  { immediate: true }
)

watch(
  () => props.hiddenNodeIds,
  () => syncFeatureStyles()
)

watch(
  () => props.selectedNodeId,
  () => syncFeatureStyles()
)

watch(
  () => props.hoveredNodeId,
  () => syncFeatureStyles()
)

watch(
  () => props.hoverHighlightEnabled,
  (enabled) => {
    if (!enabled) {
      clearHoverState()
    }

    syncFeatureStyles()
  }
)

onMounted(async () => {
  if (!containerRef.value) {
    return
  }

  try {
    const viewer = new Viewer(containerRef.value, {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      shouldAnimate: false
    })

    viewerRef.value = viewer
    viewer.resolutionScale = 0.82
    viewer.scene.globe.show = false
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = false
    }
    viewer.scene.backgroundColor = Color.fromCssColorString('#07111f')
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false
    ;(viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none'

    const tilesetModelMatrix = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(116.3913, 39.9075, 30)
    )

    const tileset = await Cesium3DTileset.fromUrl(props.tilesetUrl, {
      maximumScreenSpaceError: 12,
      modelMatrix: tilesetModelMatrix,
      // modelUpAxis: Axis.Z,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 2.0e-4,
      dynamicScreenSpaceErrorFactor: 24,
      skipLevelOfDetail: true,
      baseScreenSpaceError: 1024,
      skipScreenSpaceErrorFactor: 16,
      skipLevels: 1,
      immediatelyLoadDesiredLevelOfDetail: false,
      loadSiblings: false,
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.25,
      foveatedTimeDelay: 0.2,
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 256 * 1024 * 1024,
      featureIdLabel: 'featureId_0',
      enableCollision: true,
      lightColor: new Cartesian3(4.2, 4.2, 4.2)
    })

    tileset.colorBlendMode = Cesium3DTileColorBlendMode.HIGHLIGHT
    tileset.colorBlendAmount = 0.55
    viewer.scene.primitives.add(tileset)
    tilesetRef.value = tileset
    installTileLifecycleHandlers(tileset)
    installPickHandler(viewer)

    await viewer.flyTo(tileset, {
      duration: 0.9,
      offset: new HeadingPitchRange(0.72, -0.58, 0)
    })
    viewer.scene.requestRender()

    emit('ready')
  } catch (error) {
    emit('error', error instanceof Error ? error.message : 'Cesium 3D Tiles scene failed to initialize')
  }
})

onBeforeUnmount(() => {
  removeCanvasLeaveListener?.()
  removeTileVisibleListener?.()
  removeTileUnloadListener?.()
  if (hoverFrameId) {
    cancelAnimationFrame(hoverFrameId)
  }
  handlerRef.value?.destroy()
  viewerRef.value?.destroy()
})

function installPickHandler(viewer: Viewer): void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)

  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const nodeId =
      props.hoverHighlightEnabled && lastStableHoverNodeId
        ? lastStableHoverNodeId
        : pickNode(viewer, movement.position)

    if (nodeId) {
      emit('select-node', nodeId)
    }
  }, ScreenSpaceEventType.LEFT_CLICK)

  handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
    scheduleHoverPick(viewer, movement.endPosition)
  }, ScreenSpaceEventType.MOUSE_MOVE)

  const handleCanvasLeave = () => {
    clearHoverState()
  }

  viewer.scene.canvas.addEventListener('mouseleave', handleCanvasLeave)
  removeCanvasLeaveListener = () => viewer.scene.canvas.removeEventListener('mouseleave', handleCanvasLeave)
  handlerRef.value = handler
}

function installTileLifecycleHandlers(tileset: Cesium3DTileset): void {
  removeTileVisibleListener = tileset.tileVisible.addEventListener((tile) => {
    collectVisibleTileFeatures(tile)
    syncFeatureStyles()
  })

  removeTileUnloadListener = tileset.tileUnload.addEventListener((tile) => {
    removeTileFeatures(tile)
  })
}

function collectVisibleTileFeatures(tile: { content?: unknown }): void {
  collectContentFeatures(tile.content).forEach((feature) => {
    const nodeId = resolveFeatureNodeId(feature)

    if (!nodeId) {
      return
    }

    const features = featureByNodeId.get(nodeId) ?? new Set<Cesium3DTileFeature>()
    features.add(feature)
    featureByNodeId.set(nodeId, features)
  })

  collectContentTargets(tile.content).forEach((content) => {
    const nodeId = resolveContentNodeId(content)

    if (!nodeId) {
      return
    }

    cacheContent(nodeId, content)
  })
}

function removeTileFeatures(tile: { content?: unknown }): void {
  const tileFeatures = new Set(collectContentFeatures(tile.content))
  const tileContents = new Set(collectContentTargets(tile.content))

  featureByNodeId.forEach((features, nodeId) => {
    tileFeatures.forEach((feature) => features.delete(feature))

    if (features.size === 0) {
      featureByNodeId.delete(nodeId)
    }
  })

  contentByNodeId.forEach((contents, nodeId) => {
    tileContents.forEach((content) => contents.delete(content))

    if (contents.size === 0) {
      contentByNodeId.delete(nodeId)
    }
  })
}

function collectContentFeatures(content: unknown): Cesium3DTileFeature[] {
  const tileContent = content as {
    featuresLength?: number
    getFeature?: (batchId: number) => Cesium3DTileFeature
    innerContents?: unknown[]
  } | null

  if (!tileContent) {
    return []
  }

  const features: Cesium3DTileFeature[] = []

  for (let index = 0; index < (tileContent.featuresLength ?? 0); index += 1) {
    const feature = tileContent.getFeature?.(index)

    if (feature) {
      features.push(feature)
    }
  }

  tileContent.innerContents?.forEach((innerContent) => {
    features.push(...collectContentFeatures(innerContent))
  })

  return features
}

function collectContentTargets(content: unknown): TileContentTarget[] {
  const tileContent = content as TileContentTarget | null

  if (!tileContent) {
    return []
  }

  const targets = tileContent._model ? [tileContent] : []

  tileContent.innerContents?.forEach((innerContent) => {
    targets.push(...collectContentTargets(innerContent))
  })

  return targets
}

function pickNode(viewer: Viewer, position: Cartesian2): string | null {
  const picked = viewer.scene.pick(position, 5, 5)

  if (picked instanceof Cesium3DTileFeature) {
    const nodeId = resolveFeatureNodeId(picked)

    if (nodeId && !props.hiddenNodeIds.has(nodeId)) {
      cacheFeature(nodeId, picked)
      return nodeId
    }

    return null
  }

  const content = getPickedContent(picked)
  const nodeId = resolveContentNodeId(content)

  if (nodeId && !props.hiddenNodeIds.has(nodeId)) {
    cacheContent(nodeId, content)
    return nodeId
  }

  return null
}

function getPickedContent(picked: unknown): TileContentTarget | null {
  const pickedTile = picked as PickedTileObject | null

  return (pickedTile?.content ?? pickedTile?.detail?.model?.content ?? null) as TileContentTarget | null
}

function resolveFeatureNodeId(feature: Cesium3DTileFeature): string | null {
  const candidates = [
    getFeatureStringProperty(feature, 'propertiesID'),
    getFeatureStringProperty(feature, 'meshName'),
    getFeatureStringProperty(feature, 'name')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (nodeById.has(candidate)) {
      return candidate
    }

    const runtimeId = nodeIdByRuntimeName.get(candidate)
    if (runtimeId) {
      return runtimeId
    }

    const nameId = nodeIdByName.get(candidate)
    if (nameId) {
      return nameId
    }
  }

  return null
}

function resolveContentNodeId(content: TileContentTarget | null): string | null {
  if (!content) {
    return null
  }

  const contentKey = normalizeContentKey(content.url)

  if (contentKey) {
    const directNodeId = nodeIdByContentKey.get(contentKey)

    if (directNodeId) {
      return directNodeId
    }

    const compositeNodeId = findNodeIdByContentPrefix(contentKey)

    if (compositeNodeId) {
      return compositeNodeId
    }
  }

  return null
}

function getFeatureStringProperty(feature: Cesium3DTileFeature, propertyName: string): string {
  const value = feature.getProperty(propertyName)

  return value === undefined || value === null ? '' : String(value)
}

function cacheFeature(nodeId: string, feature: Cesium3DTileFeature): void {
  const features = featureByNodeId.get(nodeId) ?? new Set<Cesium3DTileFeature>()

  features.add(feature)
  featureByNodeId.set(nodeId, features)
}

function cacheContent(nodeId: string, content: TileContentTarget | null): void {
  if (!content?._model) {
    return
  }

  const contents = contentByNodeId.get(nodeId) ?? new Set<TileContentTarget>()

  contents.add(content)
  contentByNodeId.set(nodeId, contents)
}

function registerContentKeys(node: ModelNodeItem): void {
  const keys = new Set<string>()
  const runtimeContentKey = getRuntimeContentKey(node.runtimeName)

  if (runtimeContentKey) {
    keys.add(runtimeContentKey)
  }

  const normalizedRuntimeName = normalizeContentKey(node.runtimeName)

  if (normalizedRuntimeName) {
    keys.add(normalizedRuntimeName)
  }

  keys.forEach((key) => {
    if (!nodeIdByContentKey.has(key)) {
      nodeIdByContentKey.set(key, node.id)
    }
  })
}

function getRuntimeContentKey(runtimeName: string): string {
  const match = runtimeName.match(/^(.+\.(?:b3dm|cmpt|glb)(?:#\d+)?):\d+$/i)

  return match ? match[1] : ''
}

function findNodeIdByContentPrefix(contentKey: string): string | null {
  for (const [runtimeName, nodeId] of nodeIdByRuntimeName) {
    if (runtimeName.startsWith(`${contentKey}:`) || runtimeName.startsWith(`${contentKey}#`)) {
      return nodeId
    }
  }

  return null
}

function normalizeContentKey(value: string | undefined): string {
  if (!value) {
    return ''
  }

  const withoutQuery = value.split('?')[0].split('#')[0]
  const name = withoutQuery.split('/').pop()?.split('\\').pop() ?? ''

  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function scheduleHoverPick(viewer: Viewer, position: Cartesian2): void {
  if (!props.hoverHighlightEnabled) {
    clearHoverState()
    return
  }

  pendingHoverPosition = Cartesian2.clone(position, pendingHoverPosition ?? new Cartesian2())

  if (hoverFrameId) {
    return
  }

  hoverFrameId = requestAnimationFrame(() => {
    hoverFrameId = 0

    if (!pendingHoverPosition) {
      return
    }

    updateStableHoverNode(pickNode(viewer, pendingHoverPosition), pendingHoverPosition)
  })
}

function updateStableHoverNode(candidateNodeId: string | null, position: Cartesian2): void {
  if (!candidateNodeId) {
    hoverCandidateNodeId = null
    hoverCandidateFrameCount = 0
    hoverMissCount += 1

    if (hoverMissCount >= hoverMissClearFrameCount) {
      setStableHoverNode(null, position)
    }

    return
  }

  hoverMissCount = 0

  if (!lastStableHoverNodeId || candidateNodeId === lastStableHoverNodeId) {
    hoverCandidateNodeId = null
    hoverCandidateFrameCount = 0
    setStableHoverNode(candidateNodeId, position)
    return
  }

  if (isWithinHoverSwitchDeadZone(position)) {
    return
  }

  if (candidateNodeId === hoverCandidateNodeId) {
    hoverCandidateFrameCount += 1
  } else {
    hoverCandidateNodeId = candidateNodeId
    hoverCandidateFrameCount = 1
  }

  if (hoverCandidateFrameCount >= hoverSwitchConfirmFrameCount) {
    setStableHoverNode(candidateNodeId, position)
  }
}

function isWithinHoverSwitchDeadZone(position: Cartesian2): boolean {
  if (!lastStableHoverPosition) {
    return false
  }

  return Cartesian2.distance(position, lastStableHoverPosition) < hoverSwitchMinPixelDistance
}

function setStableHoverNode(nodeId: string | null, position: Cartesian2 | null): void {
  lastStableHoverNodeId = nodeId
  lastStableHoverPosition = position
    ? Cartesian2.clone(position, lastStableHoverPosition ?? new Cartesian2())
    : null
  hoverCandidateNodeId = null
  hoverCandidateFrameCount = 0
  hoverMissCount = 0
  updateHoverNode(nodeId)
}

function clearHoverState(): void {
  lastStableHoverNodeId = null
  lastStableHoverPosition = null
  hoverCandidateNodeId = null
  hoverCandidateFrameCount = 0
  hoverMissCount = 0
  pendingHoverPosition = null
  updateHoverNode(null)
}

function updateHoverNode(nodeId: string | null): void {
  if (emittedHoverNodeId === nodeId) {
    return
  }

  emittedHoverNodeId = nodeId

  if (viewerRef.value) {
    viewerRef.value.scene.canvas.style.cursor = nodeId ? 'pointer' : ''
  }

  emit('hover-node', nodeId)
}

function syncFeatureStyles(): void {
  featureByNodeId.forEach((features, nodeId) => {
    features.forEach((feature) => {
      applyFeatureStyle(feature, nodeId)
    })
  })

  contentByNodeId.forEach((contents, nodeId) => {
    contents.forEach((content) => {
      applyContentStyle(content, nodeId)
    })
  })

  tilesetRef.value?.makeStyleDirty()
  viewerRef.value?.scene.requestRender()
}

function applyFeatureStyle(feature: Cesium3DTileFeature, nodeId: string): void {
  feature.show = true
  feature.color = normalFeatureColor

  if (props.hiddenNodeIds.has(nodeId)) {
    // feature.show = false
    feature.color = hiddenFeatureColor
    return
  }

  if (nodeId === props.selectedNodeId) {
    feature.color = selectedFeatureColor
    return
  }

  if (props.hoverHighlightEnabled && nodeId === props.hoveredNodeId) {
    feature.color = hoverFeatureColor
  }
}

function applyContentStyle(content: TileContentTarget, nodeId: string): void {
  const model = content._model

  if (!model) {
    return
  }

  model.show = true
  model.color = normalFeatureColor
  model.silhouetteSize = 0

  if (props.hiddenNodeIds.has(nodeId)) {
    // model.show = false
    model.color = hiddenFeatureColor
    return
  }

  if (nodeId === props.selectedNodeId) {
    model.color = selectedFeatureColor
    model.silhouetteColor = selectedFeatureColor
    model.silhouetteSize = 1.6
    return
  }

  if (props.hoverHighlightEnabled && nodeId === props.hoveredNodeId) {
    model.color = hoverFeatureColor
    model.silhouetteColor = hoverFeatureColor
    model.silhouetteSize = 0.9
  }
}
</script>
