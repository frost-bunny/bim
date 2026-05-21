<template>
    <div ref="cesiumContainer" class="cesium-container"></div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowReactive, shallowRef, unref } from 'vue'
import * as Cesium from "cesium";
import { CesiumConfig } from '../../config/cesium';

// const tilesetUrl = '/models/3d-tiles/tileset.json'
// const tilesetUrl = '/models/bridge.glb' // 3D Tiles 转换后的 glTF 模型
// const tilesetUrl = '/models/bridge/tileset.json'
const tilesetUrl = '/models/gaosu1.glb';
const tilesetHeight = 4400; // 模型的高度偏移，单位为米
const cesiumContainer = shallowRef()
let viewer: Cesium.Viewer;
let handler;

async function createModel(url: string, height: number) {
    Cesium.Ion.defaultAccessToken = CesiumConfig.token;
    const terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
        requestVertexNormals: true,
        requestWaterMask: true
    })
    viewer = new Cesium.Viewer(unref(cesiumContainer), {
        terrainProvider,
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
    });
    // 异步加载真实地形
    // viewer.terrainProvider = new Cesium.TerrainProvider();
    viewer.scene.globe.depthTestAgainstTerrain = true
    configureCameraControls();
    viewer.entities.removeAll();

    const position = Cesium.Cartesian3.fromDegrees(
        97.136143,30.676230,
        height,
    );
    const heading = Cesium.Math.toRadians(135);
    const pitch = 0;
    const roll = 0;
    const hpr = new Cesium.HeadingPitchRoll(heading, pitch, roll);
    const orientation = Cesium.Transforms.headingPitchRollQuaternion(
        position,
        hpr,
    );

    const entity = viewer.entities.add({
        name: url,
        position: position,
        orientation: orientation,
        model: {
            uri: url,
            minimumPixelSize: 128,
            maximumScale: 20000,
        },
    });
    viewer.trackedEntity = entity;
}

function configureCameraControls(): void {
    const { CameraEventType, KeyboardEventModifier } = Cesium;
    const controller = viewer.scene.screenSpaceCameraController

    controller.rotateEventTypes = [
        CameraEventType.RIGHT_DRAG,
        {
            eventType: CameraEventType.LEFT_DRAG,
            modifier: KeyboardEventModifier.SHIFT,
        }
    ]

    controller.lookEventTypes = [
        CameraEventType.LEFT_DRAG,
    ]
}

onMounted(() => {
    createModel(tilesetUrl, tilesetHeight);
})
</script>

<style scoped>
.cesium-container {
    width: 100%;
    height: 100vh;
    overflow: hidden;
}
</style>