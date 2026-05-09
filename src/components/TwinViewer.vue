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
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from 'cesium'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ModelNodeItem } from '../types/model'

const props = defineProps<{
  modelUrl: string
  nodes: ModelNodeItem[]
  selectedNodeId: string | null
  hiddenNodeIds: Set<string>
}>()

const emit = defineEmits<{
  (event: 'select-node', nodeId: string): void
  (event: 'ready'): void
  (event: 'error', message: string): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const viewerRef = shallowRef<Viewer | null>(null)
const mainModelRef = shallowRef<Model | null>(null)
const highlightModelRef = shallowRef<Model | null>(null)
const transparentModelRef = shallowRef<Model | null>(null)
const handlerRef = shallowRef<ScreenSpaceEventHandler | null>(null)
const modelMatrixRef = shallowRef<Matrix4 | null>(null)
let removeCanvasClickListener: (() => void) | null = null
const visibleHighlightNodeId = ref<string | null>(null)
const hiddenMainNodeId = ref<string | null>(null)
const transparentNodeIds = ref<Set<string>>(new Set())

const nodeById = new Map<string, ModelNodeItem>()
const nodeIdByName = new Map<string, string>()
const nodeIdByIndex = new Map<number, string>()

interface ProjectedNodeHit {
  nodeId: string
  centerDistance: number
  area: number
  rect: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
}

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
    syncHighlight(props.selectedNodeId)
  },
  { immediate: true }
)

watch(
  () => props.hiddenNodeIds,
  () => syncTransparentVisibility()
)

watch(
  () => props.selectedNodeId,
  (nodeId) => syncHighlight(nodeId)
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

    transparentModel.color = Color.fromCssColorString('#7dd3fc').withAlpha(0.22)
    transparentModel.colorBlendMode = ColorBlendMode.REPLACE
    transparentModel.silhouetteColor = Color.fromCssColorString('#7dd3fc').withAlpha(0.55)
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
    syncHighlight(props.selectedNodeId)
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
  removeCanvasClickListener?.()
  handlerRef.value?.destroy()
  viewerRef.value?.destroy()
})

function installPickHandler(viewer: Viewer): void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)

  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked = viewer.scene.pick(movement.position)
    const nodeId = resolvePickedNodeId(picked) ?? findNearestProjectedNode(viewer, movement.position)

    if (nodeId) {
      emit('select-node', nodeId)
    }
  }, ScreenSpaceEventType.LEFT_CLICK)

  handlerRef.value = handler

  const handleCanvasClick = (event: MouseEvent) => {
    const canvasPosition = new Cartesian2(event.offsetX, event.offsetY)
    const picked = viewer.scene.pick(canvasPosition)
    const nodeId = resolvePickedNodeId(picked) ?? findNearestProjectedNode(viewer, canvasPosition)

    if (nodeId) {
      emit('select-node', nodeId)
    }
  }

  viewer.scene.canvas.addEventListener('click', handleCanvasClick)
  removeCanvasClickListener = () => {
    viewer.scene.canvas.removeEventListener('click', handleCanvasClick)
  }
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

function syncHighlight(nodeId: string | null): void {
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

  const modelNode = safeGetNode(highlightModel, node.runtimeName)

  if (!modelNode) {
    highlightModel.show = false
    return
  }

  modelNode.show = true
  setNodeVisible(transparentModelRef.value, nodeId, false)
  hideMainNode(nodeId)
  visibleHighlightNodeId.value = nodeId
  highlightModel.show = true
  viewerRef.value?.scene.requestRender()
}

function findNearestProjectedNode(viewer: Viewer, clickPosition: Cartesian2): string | null {
  const modelMatrix = modelMatrixRef.value

  if (!modelMatrix || props.nodes.length === 0) {
    return null
  }

  const selectedNode = props.selectedNodeId ? nodeById.get(props.selectedNodeId) : null
  const selectedHit = selectedNode ? projectNodeToScreen(viewer, modelMatrix, selectedNode, clickPosition) : null

  if (selectedHit && isInProjectedRect(selectedHit, clickPosition, 10)) {
    return selectedHit.nodeId
  }

  const hits = props.nodes
    .map((node) => projectNodeToScreen(viewer, modelMatrix, node, clickPosition))
    .filter((hit): hit is ProjectedNodeHit => Boolean(hit))

  const containingHits = hits
    .filter((hit) => isInProjectedRect(hit, clickPosition, 2))
    .sort((a, b) => a.area - b.area || a.centerDistance - b.centerDistance)

  if (containingHits[0]) {
    return containingHits[0].nodeId
  }

  return null
}

function projectNodeToScreen(
  viewer: Viewer,
  modelMatrix: Matrix4,
  node: ModelNodeItem,
  clickPosition: Cartesian2
): ProjectedNodeHit | null {
  const screenPoints = getNodeBoundsCorners(node)
    .map((corner) => Matrix4.multiplyByPoint(modelMatrix, corner, new Cartesian3()))
    .map((worldPoint) => SceneTransforms.worldToWindowCoordinates(viewer.scene, worldPoint))
    .filter((point): point is Cartesian2 => Boolean(point))

  if (screenPoints.length === 0) {
    return null
  }

  const centerPoint = projectPoint(viewer, modelMatrix, node.center)

  if (!centerPoint) {
    return null
  }

  const rect = screenPoints.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  )
  const width = Math.max(12, rect.maxX - rect.minX)
  const height = Math.max(12, rect.maxY - rect.minY)
  const minX = width === 12 ? centerPoint.x - 6 : rect.minX
  const maxX = width === 12 ? centerPoint.x + 6 : rect.maxX
  const minY = height === 12 ? centerPoint.y - 6 : rect.minY
  const maxY = height === 12 ? centerPoint.y + 6 : rect.maxY
  const dx = centerPoint.x - clickPosition.x
  const dy = centerPoint.y - clickPosition.y

  return {
    nodeId: node.id,
    centerDistance: Math.hypot(dx, dy),
    area: width * height,
    rect: { minX, minY, maxX, maxY }
  }
}

function projectPoint(
  viewer: Viewer,
  modelMatrix: Matrix4,
  point: [number, number, number]
): Cartesian2 | undefined {
  const localPoint = Cartesian3.fromElements(point[0], point[1], point[2])
  const worldPoint = Matrix4.multiplyByPoint(modelMatrix, localPoint, new Cartesian3())

  return SceneTransforms.worldToWindowCoordinates(viewer.scene, worldPoint)
}

function getNodeBoundsCorners(node: ModelNodeItem): Cartesian3[] {
  const [minX, minY, minZ] = node.boundsMin
  const [maxX, maxY, maxZ] = node.boundsMax

  return [
    Cartesian3.fromElements(minX, minY, minZ),
    Cartesian3.fromElements(minX, minY, maxZ),
    Cartesian3.fromElements(minX, maxY, minZ),
    Cartesian3.fromElements(minX, maxY, maxZ),
    Cartesian3.fromElements(maxX, minY, minZ),
    Cartesian3.fromElements(maxX, minY, maxZ),
    Cartesian3.fromElements(maxX, maxY, minZ),
    Cartesian3.fromElements(maxX, maxY, maxZ)
  ]
}

function isInProjectedRect(hit: ProjectedNodeHit, clickPosition: Cartesian2, padding: number): boolean {
  return (
    clickPosition.x >= hit.rect.minX - padding &&
    clickPosition.x <= hit.rect.maxX + padding &&
    clickPosition.y >= hit.rect.minY - padding &&
    clickPosition.y <= hit.rect.maxY + padding
  )
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
