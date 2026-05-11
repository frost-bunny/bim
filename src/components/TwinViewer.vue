<template>
  <div ref="containerRef" class="cesium-host"></div>
</template>

<script setup lang="ts">
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorBlendMode,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  Matrix4,
  Model,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from 'cesium'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ModelNodeItem } from '../types/model'
import { createMeshPicker, type MeshPicker } from '../utils/meshPicker'

const props = defineProps<{
  modelUrl: string
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

const containerRef = ref<HTMLDivElement | null>(null)
const viewerRef = shallowRef<Viewer | null>(null)
const mainModelRef = shallowRef<Model | null>(null)
const highlightModelRef = shallowRef<Model | null>(null)
const transparentModelRef = shallowRef<Model | null>(null)
const handlerRef = shallowRef<ScreenSpaceEventHandler | null>(null)
const meshPickerRef = shallowRef<MeshPicker | null>(null)
const modelMatrixRef = shallowRef<Matrix4 | null>(null)
let removeCanvasLeaveListener: (() => void) | null = null
let meshPickerPromise: Promise<MeshPicker> | null = null
let hoverFrameId = 0
let pendingHoverPosition: Cartesian2 | null = null
let emittedHoverNodeId: string | null = null
let lastStableHoverNodeId: string | null = null
let lastStableHoverPosition: Cartesian2 | null = null
let hoverCandidateNodeId: string | null = null
let hoverCandidateFrameCount = 0
let hoverMissCount = 0
const visibleHighlightNodeId = ref<string | null>(null)
const hiddenMainNodeId = ref<string | null>(null)
const transparentNodeIds = ref<Set<string>>(new Set())

const hoverMissClearFrameCount = 2
const hoverSwitchConfirmFrameCount = 2
const hoverSwitchMinPixelDistance = 8

const nodeById = new Map<string, ModelNodeItem>()
const nodeIdByName = new Map<string, string>()
const nodeIdByIndex = new Map<number, string>()

watch(
  () => props.nodes,
  (nodes) => {
    nodeById.clear()
    nodeIdByName.clear()
    nodeIdByIndex.clear()

    nodes.forEach((node) => {
      nodeById.set(node.id, node)
      nodeIdByName.set(node.runtimeName, node.id)
      nodeIdByIndex.set(node.nodeIndex, node.id)
    })

    hideAllHighlightNodes()
    hideAllTransparentNodes()
    syncTransparentVisibility()
    syncHighlight(getActiveHighlightNodeId(), getActiveHighlightMode())
    void ensureMeshPicker()
  },
  { immediate: true }
)

watch(
  () => props.hiddenNodeIds,
  () => syncTransparentVisibility()
)

watch(
  () => props.selectedNodeId,
  () => syncHighlight(getActiveHighlightNodeId(), getActiveHighlightMode())
)

watch(
  () => props.hoveredNodeId,
  () => syncHighlight(getActiveHighlightNodeId(), getActiveHighlightMode())
)

watch(
  () => props.hoverHighlightEnabled,
  (enabled) => {
    if (!enabled) {
      clearHoverState()
    }

    syncHighlight(getActiveHighlightNodeId(), getActiveHighlightMode())
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

    const modelMatrix = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(116.3913, 39.9075, 30)
    )
    modelMatrixRef.value = modelMatrix

    const mainModel = await Model.fromGltfAsync({
      url: props.modelUrl,
      modelMatrix,
      allowPicking: true,
      enablePick: true,
      incrementallyLoadTextures: true
    })

    mainModel.lightColor = new Cartesian3(4.2, 4.2, 4.2)

    const highlightModel = await Model.fromGltfAsync({
      url: props.modelUrl,
      modelMatrix: Matrix4.clone(modelMatrix),
      allowPicking: false,
      enablePick: false,
      incrementallyLoadTextures: true
    })

    const transparentModel = await Model.fromGltfAsync({
      url: props.modelUrl,
      modelMatrix: Matrix4.clone(modelMatrix),
      allowPicking: false,
      enablePick: false,
      incrementallyLoadTextures: true
    })

    highlightModel.color = Color.fromCssColorString('#18f3ff').withAlpha(0.88)
    highlightModel.colorBlendMode = ColorBlendMode.REPLACE
    highlightModel.silhouetteColor = Color.fromCssColorString('#fff47a')
    highlightModel.silhouetteSize = 2.5
    highlightModel.lightColor = new Cartesian3(5.5, 5.5, 5.5)
    highlightModel.show = false

    transparentModel.color = Color.fromCssColorString('#bde9ff').withAlpha(0.1)
    transparentModel.colorBlendMode = ColorBlendMode.REPLACE
    transparentModel.silhouetteColor = Color.fromCssColorString('#bde9ff').withAlpha(0.35)
    transparentModel.silhouetteSize = 1.2
    transparentModel.lightColor = new Cartesian3(4.8, 4.8, 4.8)
    transparentModel.show = false

    viewer.scene.primitives.add(mainModel)
    viewer.scene.primitives.add(transparentModel)
    viewer.scene.primitives.add(highlightModel)

    mainModelRef.value = mainModel
    transparentModelRef.value = transparentModel
    highlightModelRef.value = highlightModel

    await Promise.all([
      waitForModelReady(mainModel),
      waitForModelReady(transparentModel),
      waitForModelReady(highlightModel)
    ])

    hideAllHighlightNodes()
    hideAllTransparentNodes()
    syncTransparentVisibility()
    syncHighlight(getActiveHighlightNodeId(), getActiveHighlightMode())
    void ensureMeshPicker()
    installPickHandler(viewer)

    viewer.camera.flyToBoundingSphere(mainModel.boundingSphere, {
      duration: 0.9,
      offset: new HeadingPitchRange(0.72, -0.58, mainModel.boundingSphere.radius * 2.8)
    })
    viewer.scene.requestRender()

    emit('ready')
  } catch (error) {
    emit('error', error instanceof Error ? error.message : 'Cesium 场景初始化失败')
  }
})

onBeforeUnmount(() => {
  removeCanvasLeaveListener?.()
  if (hoverFrameId) {
    cancelAnimationFrame(hoverFrameId)
  }
  meshPickerRef.value?.dispose()
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

function resolvePickedNodeId(picked: unknown): string | null {
  const pickedObject = picked as {
    node?: { name?: string; id?: number | string }
    detail?: {
      node?: {
        name?: string
        id?: number | string
        node?: { name?: string; index?: number }
      }
    }
  }
  const nodeName =
    pickedObject?.node?.name ??
    pickedObject?.detail?.node?.name ??
    pickedObject?.detail?.node?.node?.name
  const nodeIndex =
    pickedObject?.node?.id ??
    pickedObject?.detail?.node?.id ??
    pickedObject?.detail?.node?.node?.index

  if (nodeName && nodeIdByName.has(nodeName)) {
    return nodeIdByName.get(nodeName) ?? null
  }

  if (typeof nodeIndex === 'number' && nodeIdByIndex.has(nodeIndex)) {
    return nodeIdByIndex.get(nodeIndex) ?? null
  }

  if (typeof nodeIndex === 'string') {
    const parsedIndex = Number(nodeIndex)

    if (Number.isFinite(parsedIndex) && nodeIdByIndex.has(parsedIndex)) {
      return nodeIdByIndex.get(parsedIndex) ?? null
    }
  }

  return null
}

function syncHighlight(nodeId: string | null, mode: 'selected' | 'hover'): void {
  const highlightModel = highlightModelRef.value

  if (!highlightModel) {
    return
  }

  if (!nodeId) {
    hideVisibleHighlightNode()
    restoreHiddenMainNode()
    highlightModel.show = false
    return
  }

  const node = nodeById.get(nodeId)

  if (!node) {
    return
  }

  hideVisibleHighlightNode()
  restoreHiddenMainNode()
  applyHighlightStyle(mode)

  const modelNode = safeGetNode(highlightModel, node.runtimeName)

  if (!modelNode) {
    highlightModel.show = false
    return
  }

  modelNode.show = true
  setNodeVisible(transparentModelRef.value, nodeId, false)
  if (mode === 'selected') {
    hideMainNode(nodeId)
  }
  visibleHighlightNodeId.value = nodeId
  highlightModel.show = true
  viewerRef.value?.scene.requestRender()
}

function hideAllHighlightNodes(): void {
  const highlightModel = highlightModelRef.value

  if (!highlightModel) {
    return
  }

  props.nodes.forEach((node) => {
    const modelNode = safeGetNode(highlightModel, node.runtimeName)

    if (modelNode) {
      modelNode.show = false
    }
  })

  visibleHighlightNodeId.value = null
  highlightModel.show = false
  viewerRef.value?.scene.requestRender()
}

async function ensureMeshPicker(): Promise<void> {
  if (meshPickerRef.value || meshPickerPromise || props.nodes.length === 0) {
    return
  }

  meshPickerPromise = createMeshPicker({
    modelUrl: props.modelUrl,
    nodeIdByName: new Map(nodeIdByName)
  })

  try {
    meshPickerRef.value = await meshPickerPromise
  } catch (error) {
    emit(
      'error',
      error instanceof Error
        ? `精准拾取索引加载失败：${error.message}`
        : '精准拾取索引加载失败'
    )
  } finally {
    meshPickerPromise = null
  }
}

function pickNode(viewer: Viewer, position: Cartesian2): string | null {
  return pickPreciseNode(viewer, position) ?? pickGpuNode(viewer, position)
}

function pickPreciseNode(viewer: Viewer, position: Cartesian2): string | null {
  const modelMatrix = modelMatrixRef.value
  const picker = meshPickerRef.value

  if (!modelMatrix || !picker) {
    return null
  }

  return picker.pick(position, viewer.camera, modelMatrix)
}

function pickGpuNode(viewer: Viewer, position: Cartesian2): string | null {
  const offsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 2]
  ] as const

  for (const [offsetX, offsetY] of offsets) {
    const samplePosition =
      offsetX === 0 && offsetY === 0
        ? position
        : new Cartesian2(position.x + offsetX, position.y + offsetY)
    const nodeId = resolvePickedNodeId(viewer.scene.pick(samplePosition))

    if (nodeId) {
      return nodeId
    }
  }

  return null
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

    updateStableHoverNode(pickHoverNode(viewer, pendingHoverPosition), pendingHoverPosition)
  })
}

function pickHoverNode(viewer: Viewer, position: Cartesian2): string | null {
  return pickPreciseNode(viewer, position) ?? pickGpuNode(viewer, position)
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

function getActiveHighlightNodeId(): string | null {
  return props.hoverHighlightEnabled ? props.hoveredNodeId ?? props.selectedNodeId : props.selectedNodeId
}

function getActiveHighlightMode(): 'selected' | 'hover' {
  return props.hoverHighlightEnabled && props.hoveredNodeId ? 'hover' : 'selected'
}

function applyHighlightStyle(mode: 'selected' | 'hover'): void {
  const highlightModel = highlightModelRef.value

  if (!highlightModel) {
    return
  }

  if (mode === 'hover') {
    highlightModel.color = Color.fromCssColorString('#fff47a').withAlpha(0.2)
    highlightModel.silhouetteColor = Color.fromCssColorString('#18f3ff')
    highlightModel.silhouetteSize = 2.8
    return
  }

  highlightModel.color = Color.fromCssColorString('#18f3ff').withAlpha(0.88)
  highlightModel.silhouetteColor = Color.fromCssColorString('#fff47a')
  highlightModel.silhouetteSize = 2.5
}

function syncTransparentVisibility(): void {
  const mainModel = mainModelRef.value
  const transparentModel = transparentModelRef.value

  if (!mainModel || !transparentModel) {
    return
  }

  const nextTransparentNodeIds = new Set<string>()

  transparentNodeIds.value.forEach((nodeId) => {
    if (!props.hiddenNodeIds.has(nodeId)) {
      setNodeVisible(transparentModel, nodeId, false)

      if (nodeId !== visibleHighlightNodeId.value) {
        setNodeVisible(mainModel, nodeId, true)
      }
    }
  })

  props.hiddenNodeIds.forEach((nodeId) => {
    setNodeVisible(mainModel, nodeId, false)
    setNodeVisible(transparentModel, nodeId, nodeId !== visibleHighlightNodeId.value)
    nextTransparentNodeIds.add(nodeId)
  })

  transparentNodeIds.value = nextTransparentNodeIds
  transparentModel.show = nextTransparentNodeIds.size > 0
  viewerRef.value?.scene.requestRender()
}

function hideAllTransparentNodes(): void {
  const transparentModel = transparentModelRef.value

  if (!transparentModel) {
    return
  }

  props.nodes.forEach((node) => {
    const modelNode = safeGetNode(transparentModel, node.runtimeName)

    if (modelNode) {
      modelNode.show = false
    }
  })

  transparentNodeIds.value = new Set()
  transparentModel.show = false
  viewerRef.value?.scene.requestRender()
}

function hideVisibleHighlightNode(): void {
  const highlightModel = highlightModelRef.value
  const nodeId = visibleHighlightNodeId.value

  if (!highlightModel || !nodeId) {
    return
  }

  const node = nodeById.get(nodeId)
  const modelNode = node ? safeGetNode(highlightModel, node.runtimeName) : null

  if (modelNode) {
    modelNode.show = false
  }

  if (props.hiddenNodeIds.has(nodeId)) {
    setNodeVisible(transparentModelRef.value, nodeId, true)
  }

  visibleHighlightNodeId.value = null
  viewerRef.value?.scene.requestRender()
}

function hideMainNode(nodeId: string): void {
  const mainModel = mainModelRef.value
  const node = nodeById.get(nodeId)

  if (!mainModel || !node) {
    return
  }

  const modelNode = safeGetNode(mainModel, node.runtimeName)

  if (modelNode) {
    modelNode.show = false
    hiddenMainNodeId.value = nodeId
  }

  viewerRef.value?.scene.requestRender()
}

function restoreHiddenMainNode(): void {
  const mainModel = mainModelRef.value
  const nodeId = hiddenMainNodeId.value

  if (!mainModel || !nodeId) {
    return
  }

  const node = nodeById.get(nodeId)
  const modelNode = node ? safeGetNode(mainModel, node.runtimeName) : null

  if (modelNode && !props.hiddenNodeIds.has(nodeId)) {
    modelNode.show = true
  }

  if (props.hiddenNodeIds.has(nodeId)) {
    setNodeVisible(transparentModelRef.value, nodeId, true)
  }

  hiddenMainNodeId.value = null
  viewerRef.value?.scene.requestRender()
}

function setNodeVisible(model: Model | null, nodeId: string, visible: boolean): void {
  const node = nodeById.get(nodeId)
  const modelNode = node && model ? safeGetNode(model, node.runtimeName) : null

  if (modelNode) {
    modelNode.show = visible
  }
}

function safeGetNode(model: Model, nodeName: string) {
  try {
    return model.getNode(nodeName)
  } catch {
    return undefined
  }
}

function waitForModelReady(model: Model): Promise<void> {
  if (model.ready) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const removeListener = model.readyEvent.addEventListener(() => {
      removeListener()
      resolve()
    })
  })
}
</script>
