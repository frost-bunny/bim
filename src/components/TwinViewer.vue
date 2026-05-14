<template>
  <div ref="containerRef" class="cesium-host">
    <div v-if="selectedModelInfo && modelInfoPopup.visible" class="model-info-popup"
      :style="{ left: `${modelInfoPopup.x}px`, top: `${modelInfoPopup.y}px` }">
      <div class="model-info-popup__title">{{ selectedModelInfo.name }}</div>
      <div class="model-info-popup__grid">
        <span>节点索引</span>
        <strong>{{ selectedModelInfo.nodeIndex }}</strong>
        <span>Mesh Index</span>
        <strong>{{ selectedModelInfo.meshIndex }}</strong>
        <span>图层 / 类型</span>
        <strong>{{ selectedModelInfo.materialName }}</strong>
        <span>Primitive 数量</span>
        <strong>{{ selectedModelInfo.primitiveCount }}</strong>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  Axis,
  BoundingSphere,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cesium3DTileFeature,
  Cesium3DTileColorBlendMode,
  Cesium3DTileset,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  KeyboardEventModifier,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from 'cesium'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ModelNodeItem } from '../types/model'

const props = defineProps<{
  tilesetUrl: string
  modelUrl?: string
  nodes: ModelNodeItem[]
  selectedNodeId: string | null
  hoveredNodeId: string | null
  hoverHighlightEnabled: boolean
  dimUnselectedOnSelect: boolean
  selectedFocusMode: 'highlight' | 'original'
  autoFocusSelectedEnabled: boolean
  showModelInfoEnabled: boolean
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

// Cesium 的事件监听需要手动卸载，组件销毁时会统一调用这些清理函数。
let removeCanvasLeaveListener: (() => void) | null = null
let removeCanvasContextMenuListener: (() => void) | null = null
let removeTileVisibleListener: (() => void) | null = null
let removeTileUnloadListener: (() => void) | null = null
let removePostRenderListener: (() => void) | null = null

// 悬浮拾取做了轻量防抖：鼠标快速扫过构件边界时，先确认几帧再切换高亮目标。
let hoverFrameId = 0
let pendingHoverPosition: Cartesian2 | null = null
let emittedHoverNodeId: string | null = null
let lastStableHoverNodeId: string | null = null
let lastStableHoverPosition: Cartesian2 | null = null

// 信息弹窗优先跟随模型包围球；如果暂时拿不到包围球，就回退到用户点击的屏幕位置。
let selectedPickNodeId: string | null = null
let selectedPickPosition: Cartesian2 | null = null
let hoverCandidateNodeId: string | null = null
let hoverCandidateFrameCount = 0
let hoverMissCount = 0

const hoverMissClearFrameCount = 2
const hoverSwitchConfirmFrameCount = 2
const hoverSwitchMinPixelDistance = 8
const normalFeatureColor = Color.WHITE
const hoverFeatureColor = Color.fromCssColorString('#fff47a').withAlpha(0.55)
const selectedFeatureColor = Color.fromCssColorString('#18f3ff').withAlpha(0.85)
const hiddenFeatureColor = Color.fromCssColorString('#808895').withAlpha(0.12)
const dimmedFeatureColor = Color.fromCssColorString('#808895').withAlpha(0.14)
const popupOffset = 18
const popupEstimatedWidth = 260
const popupEstimatedHeight = 158
const popupScratchPosition = new Cartesian2()

// 这些 Map 是本组件的核心索引层：
// props.nodes 是业务侧元数据，Cesium pick 得到的是 feature/content，需要用这些索引互相转换。
const nodeById = new Map<string, ModelNodeItem>()
const nodeIdByRuntimeName = new Map<string, string>()
const nodeIdByName = new Map<string, string>()
const nodeIdByContentKey = new Map<string, string>()
const featureByNodeId = new Map<string, Set<Cesium3DTileFeature>>()
const contentByNodeId = new Map<string, Set<TileContentTarget>>()

const modelInfoPopup = ref({
  visible: false,
  x: 0,
  y: 0
})

const selectedModelInfo = computed(() => {
  if (!props.selectedNodeId) {
    return null
  }

  return props.nodes.find((node) => node.id === props.selectedNodeId) ?? null
})

interface TileContentTarget {
  url?: string
  innerContents?: unknown[]
  featuresLength?: number
  getFeature?: (batchId: number) => Cesium3DTileFeature
  tile?: {
    boundingSphere?: BoundingSphere
  }
  _model?: {
    show?: boolean
    color?: Color
    silhouetteColor?: Color
    silhouetteSize?: number
    boundingSphere?: BoundingSphere
  }
}

// Cesium 的 3D Tiles 内部对象类型不完全暴露，这里只声明当前代码会读取/写入的字段。
interface PickedTileObject {
  content?: unknown
  detail?: {
    model?: {
      content?: unknown
    }
  }
}

// 节点元数据变化后重建索引。后续拾取、高亮、弹窗都依赖这些索引找到同一个构件。
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

// 交互配置或外部选中状态变化时，统一走 syncFeatureStyles，保证模型样式只有一个出口。
watch(
  () => props.hiddenNodeIds,
  () => syncFeatureStyles()
)

watch(
  () => props.selectedNodeId,
  (nodeId, previousNodeId) => {
    syncFeatureStyles()

    if (nodeId && nodeId !== previousNodeId) {
      focusSelectedNode(nodeId)
    }

    updateSelectedInfoPopup()
  }
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

watch(
  () => props.dimUnselectedOnSelect,
  (enabled) => {
    syncFeatureStyles()

    if (enabled && props.selectedNodeId) {
      focusSelectedNode(props.selectedNodeId)
    }
  }
)

watch(
  () => props.selectedFocusMode,
  () => syncFeatureStyles()
)

watch(
  () => props.autoFocusSelectedEnabled,
  (enabled) => {
    if (enabled && props.selectedNodeId) {
      focusSelectedNode(props.selectedNodeId)
    }
  }
)

watch(
  () => props.showModelInfoEnabled,
  () => updateSelectedInfoPopup()
)

onMounted(async () => {
  if (!containerRef.value) {
    return
  }

  try {
    // 只保留三维模型本身需要的 Cesium 功能，关闭默认 UI，页面上的控制由 Vue 组件负责。
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
    removePostRenderListener = viewer.scene.postRender.addEventListener(updateSelectedInfoPopup)
    viewer.resolutionScale = Math.min(window.devicePixelRatio, 2)
    viewer.scene.globe.show = false
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = false
    }
    viewer.scene.backgroundColor = Color.fromCssColorString('#07111f')
    configureCameraControls(viewer)
      ; (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none'

    // 示例模型没有真实地理定位时，需要给 tileset 一个固定的世界坐标基准。
    const tilesetModelMatrix = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(116.3913, 39.9075, 30)
    )

    const tileset = await Cesium3DTileset.fromUrl(props.tilesetUrl, {
      // 下方参数主要控制 3D Tiles 的加载精度、缓存和渐进加载策略。
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
  removeCanvasContextMenuListener?.()
  removeTileVisibleListener?.()
  removeTileUnloadListener?.()
  removePostRenderListener?.()
  if (hoverFrameId) {
    cancelAnimationFrame(hoverFrameId)
  }
  handlerRef.value?.destroy()
  viewerRef.value?.destroy()
})

function installPickHandler(viewer: Viewer): void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)

  // 点击时把 Cesium 拾取结果转换成业务节点 id，再交给 App.vue 维护选中状态。
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const nodeId =
      props.hoverHighlightEnabled && lastStableHoverNodeId
        ? lastStableHoverNodeId
        : pickNode(viewer, movement.position)

    if (nodeId) {
      selectedPickNodeId = nodeId
      selectedPickPosition = Cartesian2.clone(
        movement.position,
        selectedPickPosition ?? new Cartesian2()
      )
      emit('select-node', nodeId)
    }
  }, ScreenSpaceEventType.LEFT_CLICK)

  // 鼠标移动不直接拾取，而是进入 requestAnimationFrame 队列，降低高频 pick 的开销。
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
    scheduleHoverPick(viewer, movement.endPosition)
  }, ScreenSpaceEventType.MOUSE_MOVE)

  const handleCanvasLeave = () => {
    clearHoverState()
  }

  viewer.scene.canvas.addEventListener('mouseleave', handleCanvasLeave)
  removeCanvasLeaveListener = () => viewer.scene.canvas.removeEventListener('mouseleave', handleCanvasLeave)

  const handleCanvasContextMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  viewer.scene.canvas.addEventListener('contextmenu', handleCanvasContextMenu)
  removeCanvasContextMenuListener = () => viewer.scene.canvas.removeEventListener('contextmenu', handleCanvasContextMenu)
  handlerRef.value = handler
}

function configureCameraControls(viewer: Viewer): void {
  const controller = viewer.scene.screenSpaceCameraController

  controller.enableCollisionDetection = false
  controller.zoomEventTypes = [
    CameraEventType.WHEEL,
    CameraEventType.PINCH
  ]
  controller.tiltEventTypes = [
    CameraEventType.MIDDLE_DRAG,
    CameraEventType.PINCH,
    CameraEventType.RIGHT_DRAG,
    {
      eventType: CameraEventType.LEFT_DRAG,
      modifier: KeyboardEventModifier.CTRL
    },
    {
      eventType: CameraEventType.RIGHT_DRAG,
      modifier: KeyboardEventModifier.CTRL
    }
  ]
}

function installTileLifecycleHandlers(tileset: Cesium3DTileset): void {
  // tileVisible 是缓存 feature/content 的关键时机：只有加载到视野内的 tile 才能被单独改色。
  removeTileVisibleListener = tileset.tileVisible.addEventListener((tile) => {
    collectVisibleTileFeatures(tile)
    syncFeatureStyles()
  })

  removeTileUnloadListener = tileset.tileUnload.addEventListener((tile) => {
    removeTileFeatures(tile)
  })
}

function collectVisibleTileFeatures(tile: { content?: unknown }): void {
  // Feature 级别的 tile 可以逐个设置 Cesium3DTileFeature.color。
  collectContentFeatures(tile.content).forEach((feature) => {
    const nodeId = resolveFeatureNodeId(feature)

    if (!nodeId) {
      return
    }

    const features = featureByNodeId.get(nodeId) ?? new Set<Cesium3DTileFeature>()
    features.add(feature)
    featureByNodeId.set(nodeId, features)
  })

  // 有些 tile 没有 feature 表，只能通过内部 model 对象做整块模型级样式控制。
  collectContentTargets(tile.content).forEach((content) => {
    resolveContentNodeIds(content).forEach((nodeId) => cacheContent(nodeId, content))
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

  // Composite tile 会把子内容放到 innerContents，需要递归展开。
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
  console.log('Picked object:', picked)

  // 优先处理 feature 拾取，它通常能拿到更准确的构件属性。
  if (picked instanceof Cesium3DTileFeature) {
    const nodeId = resolveFeatureNodeId(picked)

    if (nodeId && !props.hiddenNodeIds.has(nodeId)) {
      cacheFeature(nodeId, picked)
      return nodeId
    }

    return null
  }

  // 如果 pick 到的是 tile/model 容器，则退到 content url 和 runtimeName 的映射。
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
  // 不同导出工具写入的属性名可能不同，这里按常见字段依次尝试。
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
  return resolveContentNodeIds(content)[0] ?? null
}

function resolveContentNodeIds(content: TileContentTarget | null): string[] {
  const nodeIds: string[] = []

  if (!content) {
    return nodeIds
  }

  const contentKey = normalizeContentKey(content.url)

  if (contentKey) {
    // 先查精确内容文件名，再查同一个 b3dm/cmpt/glb 下的子构件 runtimeName 前缀。
    const directNodeId = nodeIdByContentKey.get(contentKey)

    if (directNodeId) {
      nodeIds.push(directNodeId)
    }

    for (const [runtimeName, nodeId] of nodeIdByRuntimeName) {
      if (
        (runtimeName.startsWith(`${contentKey}:`) || runtimeName.startsWith(`${contentKey}#`)) &&
        !nodeIds.includes(nodeId)
      ) {
        nodeIds.push(nodeId)
      }
    }
  }

  return nodeIds
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
  // runtimeName 可能是 "xxx.b3dm:0" 这种格式，弹窗/高亮需要回到实际内容文件名。
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
    // 已经有一帧在排队时只更新最新鼠标位置，避免同一帧触发多次 pick。
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
  // 连续几帧都没有拾取到构件后才清空高亮，减少边缘抖动。
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

  // 鼠标还在上一次构件附近的小范围内时，不急着切换目标。
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
  // 所有模型显隐、高亮、选中、置灰都集中在这里刷新，避免多个 watcher 分散改 Cesium 状态。
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
  updateSelectedInfoPopup()
}

function updateSelectedInfoPopup(): void {
  const viewer = viewerRef.value
  const container = containerRef.value
  const nodeId = props.selectedNodeId

  if (!props.showModelInfoEnabled || !nodeId || !viewer || !container) {
    setModelInfoPopupVisible(false)
    return
  }

  // 定位优先级：构件包围球 > 本次点击位置 > 整个 tileset 中心。
  // 这样 tile 尚未缓存完时，开启弹窗也不会完全没有反馈。
  const sphere = getNodeBoundingSphere(nodeId)
  const screenPosition = sphere
    ? SceneTransforms.worldToWindowCoordinates(viewer.scene, sphere.center, popupScratchPosition)
    : getSelectedPickScreenPosition(nodeId) ?? getTilesetScreenPosition(viewer)
  const containerWidth = container.clientWidth
  const containerHeight = container.clientHeight

  if (!screenPosition || containerWidth === 0 || containerHeight === 0) {
    setModelInfoPopupVisible(false)
    return
  }

  if (
    screenPosition.x < -popupEstimatedWidth ||
    screenPosition.x > containerWidth + popupEstimatedWidth ||
    screenPosition.y < -popupEstimatedHeight ||
    screenPosition.y > containerHeight + popupEstimatedHeight
  ) {
    setModelInfoPopupVisible(false)
    return
  }

  // 弹窗靠近屏幕边缘时自动换到另一侧，并限制在 viewer 容器内。
  const placeLeft = screenPosition.x > containerWidth - popupEstimatedWidth - popupOffset
  const placeBelow = screenPosition.y < popupEstimatedHeight + popupOffset
  const rawX = placeLeft
    ? screenPosition.x - popupEstimatedWidth - popupOffset
    : screenPosition.x + popupOffset
  const rawY = placeBelow
    ? screenPosition.y + popupOffset
    : screenPosition.y - popupEstimatedHeight - popupOffset

  setModelInfoPopupPosition(
    clamp(rawX, popupOffset, Math.max(popupOffset, containerWidth - popupEstimatedWidth - popupOffset)),
    clamp(rawY, popupOffset, Math.max(popupOffset, containerHeight - popupEstimatedHeight - popupOffset))
  )
}

function setModelInfoPopupVisible(visible: boolean): void {
  if (modelInfoPopup.value.visible === visible) {
    return
  }

  modelInfoPopup.value = {
    ...modelInfoPopup.value,
    visible
  }
}

function setModelInfoPopupPosition(x: number, y: number): void {
  const current = modelInfoPopup.value

  if (current.visible && Math.abs(current.x - x) < 1 && Math.abs(current.y - y) < 1) {
    return
  }

  modelInfoPopup.value = {
    visible: true,
    x,
    y
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getSelectedPickScreenPosition(nodeId: string): Cartesian2 | null {
  if (selectedPickNodeId !== nodeId || !selectedPickPosition) {
    return null
  }

  return selectedPickPosition
}

function getTilesetScreenPosition(viewer: Viewer): Cartesian2 | undefined {
  const sphere = tilesetRef.value?.boundingSphere

  if (!sphere) {
    return undefined
  }

  return SceneTransforms.worldToWindowCoordinates(viewer.scene, sphere.center, popupScratchPosition)
}

function focusSelectedNode(nodeId: string): void {
  const viewer = viewerRef.value
  const sphere = getNodeBoundingSphere(nodeId)

  if (!viewer || !sphere || !shouldAutoFocusSelectedNode()) {
    return
  }

  // flyToBoundingSphere 会把相机移动到构件包围球附近，实现“选中聚焦”。
  const range = Math.max(sphere.radius * 3.4, 8)

  viewer.camera.cancelFlight()
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 0.65,
    offset: new HeadingPitchRange(0.72, -0.62, range),
    complete: () => viewer.scene.requestRender(),
    cancel: () => viewer.scene.requestRender()
  })
}

function getNodeBoundingSphere(nodeId: string): BoundingSphere | null {
  // 同一个业务节点可能对应多个 feature/content，合并包围球后才能得到稳定的聚焦/弹窗位置。
  const spheres: BoundingSphere[] = []
  const features = featureByNodeId.get(nodeId)
  const contents = contentByNodeId.get(nodeId)

  features?.forEach((feature) => {
    const sphere = getFeatureBoundingSphere(feature)

    if (sphere) {
      spheres.push(sphere)
    }
  })

  contents?.forEach((content) => {
    const sphere = getContentBoundingSphere(content)

    if (sphere) {
      spheres.push(sphere)
    }
  })

  if (spheres.length === 0) {
    return null
  }

  if (spheres.length === 1) {
    return BoundingSphere.clone(spheres[0])
  }

  return BoundingSphere.fromBoundingSpheres(spheres)
}

function getFeatureBoundingSphere(feature: Cesium3DTileFeature): BoundingSphere | null {
  const content = (feature as unknown as { content?: TileContentTarget }).content

  return getContentBoundingSphere(content ?? null)
}

function getContentBoundingSphere(content: TileContentTarget | null): BoundingSphere | null {
  return content?._model?.boundingSphere ?? content?.tile?.boundingSphere ?? null
}

function applyFeatureStyle(feature: Cesium3DTileFeature, nodeId: string): void {
  // Feature 样式只负责 feature 级 tile；content/model 级 tile 由 applyContentStyle 处理。
  feature.show = true
  feature.color = normalFeatureColor

  if (props.hiddenNodeIds.has(nodeId)) {
    // feature.show = false
    feature.color = hiddenFeatureColor
    return
  }

  if (nodeId === props.selectedNodeId) {
    if (shouldKeepSelectedOriginal()) {
      feature.color = normalFeatureColor
      return
    }

    feature.color = selectedFeatureColor
    return
  }

  if (shouldDimUnselectedNode(nodeId)) {
    feature.color = dimmedFeatureColor
    return
  }

  if (props.hoverHighlightEnabled && nodeId === props.hoveredNodeId) {
    feature.color = hoverFeatureColor
  }
}

function applyContentStyle(content: TileContentTarget, nodeId: string): void {
  // Content 样式通过 Cesium 内部 _model 改色和描边，用来覆盖没有 feature 表的 tile。
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
    if (shouldKeepSelectedOriginal()) {
      model.color = normalFeatureColor
      return
    }

    model.color = selectedFeatureColor
    model.silhouetteColor = selectedFeatureColor
    model.silhouetteSize = 1.6
    return
  }

  if (shouldDimUnselectedNode(nodeId)) {
    model.color = dimmedFeatureColor
    return
  }

  if (props.hoverHighlightEnabled && nodeId === props.hoveredNodeId) {
    model.color = hoverFeatureColor
    model.silhouetteColor = hoverFeatureColor
    model.silhouetteSize = 0.9
  }
}

function shouldDimUnselectedNode(nodeId: string): boolean {
  return Boolean(
    props.dimUnselectedOnSelect &&
    props.selectedNodeId &&
    nodeId !== props.selectedNodeId
  )
}

function shouldKeepSelectedOriginal(): boolean {
  return props.dimUnselectedOnSelect && props.selectedFocusMode === 'original'
}

function shouldAutoFocusSelectedNode(): boolean {
  return props.dimUnselectedOnSelect && props.autoFocusSelectedEnabled
}
</script>
