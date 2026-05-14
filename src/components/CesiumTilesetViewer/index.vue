<template>
  <div ref="cesiumContainerRef" class="cesium-viewer"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

interface TilesetTransform {
  /**
   * 经度
   */
  longitude?: number

  /**
   * 纬度
   */
  latitude?: number

  /**
   * 高度，单位：米
   */
  height?: number

  /**
   * 绕 X 轴旋转，单位：度
   */
  rotateX?: number

  /**
   * 绕 Y 轴旋转，单位：度
   */
  rotateY?: number

  /**
   * 绕 Z 轴旋转，单位：度
   */
  rotateZ?: number

  /**
   * 缩放比例
   */
  scale?: number
}

interface CesiumTilesetViewerProps {
  /**
   * 3D Tiles 入口地址，一般是 tileset.json
   */
  url: string

  /**
   * Cesium ion token，可选
   */
  accessToken?: string

  /**
   * 是否显示默认底图
   */
  showBaseLayer?: boolean

  /**
   * 是否显示地形
   */
  enableTerrain?: boolean

  /**
   * 是否加载完成后自动飞到模型
   */
  flyTo?: boolean

  /**
   * 模型变换参数
   */
  transform?: TilesetTransform

  /**
   * 是否开启 hover 高亮
   */
  enableHover?: boolean

  /**
   * 是否开启点击选中
   */
  enableClick?: boolean

  /**
   * hover 高亮颜色
   */
  hoverColor?: Cesium.Color

  /**
   * 点击选中颜色
   */
  selectedColor?: Cesium.Color

  /**
   * 背景色
   */
  backgroundColor?: Cesium.Color
}

const props = withDefaults(defineProps<CesiumTilesetViewerProps>(), {
  showBaseLayer: true,
  enableTerrain: false,
  flyTo: true,
  enableHover: true,
  enableClick: true,
  hoverColor: () => Cesium.Color.YELLOW.withAlpha(0.6),
  selectedColor: () => Cesium.Color.CYAN.withAlpha(0.8),
  backgroundColor: () => Cesium.Color.BLACK
})

const emit = defineEmits<{
  loaded: [payload: { viewer: Cesium.Viewer; tileset: Cesium.Cesium3DTileset }]
  error: [error: unknown]
  clickFeature: [feature: Cesium.Cesium3DTileFeature]
  hoverFeature: [feature: Cesium.Cesium3DTileFeature | null]
}>()

const cesiumContainerRef = ref<HTMLDivElement | null>(null)

let viewer: Cesium.Viewer | null = null
let tileset: Cesium.Cesium3DTileset | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null

let hoveredFeature: Cesium.Cesium3DTileFeature | null = null
let selectedFeature: Cesium.Cesium3DTileFeature | null = null

const originalColors = new WeakMap<Cesium.Cesium3DTileFeature, Cesium.Color>()

onMounted(() => {
  initCesium()
})

onBeforeUnmount(() => {
  destroyCesium()
})

watch(
  () => props.url,
  async () => {
    if (!viewer || !props.url) return
    await reloadTileset()
  }
)

watch(
  () => props.transform,
  () => {
    if (!tileset || !props.transform) return
    applyTilesetTransform(tileset, props.transform)
  },
  {
    deep: true
  }
)

async function initCesium() {
  if (!cesiumContainerRef.value) return

  if (props.accessToken) {
    Cesium.Ion.defaultAccessToken = props.accessToken
  }

  viewer = new Cesium.Viewer(cesiumContainerRef.value, {
    animation: false,
    timeline: false,
    fullscreenButton: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    geocoder: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: true,
    baseLayer: props.showBaseLayer
      ? undefined
      : Cesium.ImageryLayer.fromProviderAsync(
          Promise.resolve(new Cesium.TileMapServiceImageryProvider({
            url: Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
          }))
        )
  })

  viewer.scene.backgroundColor = props.backgroundColor
  viewer.scene.globe.depthTestAgainstTerrain = true

  // 提升 3D Tiles 视觉质量
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = true
  viewer.scene.postProcessStages.fxaa.enabled = true

  if (!props.showBaseLayer) {
    viewer.imageryLayers.removeAll()
  }

  if (props.enableTerrain) {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync()
  }

  handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

  bindFeatureEvents()

  await loadTileset()
}

async function loadTileset() {
  if (!viewer) return

  try {
    tileset = await Cesium.Cesium3DTileset.fromUrl(props.url, {
      // 这些参数可根据项目调整
      maximumScreenSpaceError: 8,
      skipLevelOfDetail: true,
      baseScreenSpaceError: 1024,
      skipScreenSpaceErrorFactor: 16,
      skipLevels: 1,
      immediatelyLoadDesiredLevelOfDetail: false,
      loadSiblings: false,
      cullWithChildrenBounds: true
    })

    viewer.scene.primitives.add(tileset)

    if (props.transform) {
      applyTilesetTransform(tileset, props.transform)
    }

    await tileset.readyPromise

    if (props.flyTo) {
      await viewer.flyTo(tileset, {
        duration: 1.5
      })
    }

    emit('loaded', {
      viewer,
      tileset
    })
  } catch (error) {
    emit('error', error)
    console.error('3D Tiles 加载失败：', error)
  }
}

async function reloadTileset() {
  if (!viewer) return

  if (tileset) {
    viewer.scene.primitives.remove(tileset)
    tileset = null
  }

  hoveredFeature = null
  selectedFeature = null
  originalColors.clear?.()

  await loadTileset()
}

function applyTilesetTransform(
  targetTileset: Cesium.Cesium3DTileset,
  transform: TilesetTransform
) {
  const {
    longitude = 0,
    latitude = 0,
    height = 0,
    rotateX = 0,
    rotateY = 0,
    rotateZ = 0,
    scale = 1
  } = transform

  const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, height)

  const heading = Cesium.Math.toRadians(rotateZ)
  const pitch = Cesium.Math.toRadians(rotateY)
  const roll = Cesium.Math.toRadians(rotateX)

  const hpr = new Cesium.HeadingPitchRoll(heading, pitch, roll)

  const matrix = Cesium.Transforms.headingPitchRollToFixedFrame(
    position,
    hpr
  )

  const scaleMatrix = Cesium.Matrix4.fromUniformScale(scale)

  Cesium.Matrix4.multiply(matrix, scaleMatrix, matrix)

  targetTileset.modelMatrix = matrix
}

function bindFeatureEvents() {
  if (!viewer || !handler) return

  if (props.enableHover) {
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!viewer) return

      const picked = viewer.scene.pick(movement.endPosition)

      if (hoveredFeature && hoveredFeature !== selectedFeature) {
        restoreFeatureColor(hoveredFeature)
      }

      if (Cesium.defined(picked) && picked instanceof Cesium.Cesium3DTileFeature) {
        hoveredFeature = picked

        if (hoveredFeature !== selectedFeature) {
          saveOriginalColor(hoveredFeature)
          hoveredFeature.color = props.hoverColor
        }

        emit('hoverFeature', hoveredFeature)
      } else {
        hoveredFeature = null
        emit('hoverFeature', null)
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
  }

  if (props.enableClick) {
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (!viewer) return

      const picked = viewer.scene.pick(movement.position)

      if (selectedFeature) {
        restoreFeatureColor(selectedFeature)
        selectedFeature = null
      }

      if (Cesium.defined(picked) && picked instanceof Cesium.Cesium3DTileFeature) {
        selectedFeature = picked
        saveOriginalColor(selectedFeature)
        selectedFeature.color = props.selectedColor

        emit('clickFeature', selectedFeature)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }
}

function saveOriginalColor(feature: Cesium.Cesium3DTileFeature) {
  if (!originalColors.has(feature)) {
    originalColors.set(feature, Cesium.Color.clone(feature.color))
  }
}

function restoreFeatureColor(feature: Cesium.Cesium3DTileFeature) {
  const originalColor = originalColors.get(feature)

  if (originalColor) {
    feature.color = originalColor
  }
}

function destroyCesium() {
  if (handler) {
    handler.destroy()
    handler = null
  }

  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy()
    viewer = null
  }

  tileset = null
  hoveredFeature = null
  selectedFeature = null
}

function getViewer() {
  return viewer
}

function getTileset() {
  return tileset
}

function flyToTileset() {
  if (viewer && tileset) {
    return viewer.flyTo(tileset)
  }
}

defineExpose({
  getViewer,
  getTileset,
  flyToTileset
})
</script>

<style scoped>
.cesium-viewer {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

:deep(.cesium-widget-credits) {
  display: none !important;
}
</style>