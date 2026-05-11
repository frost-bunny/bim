<template>
  <main class="app-shell">
    <aside class="left-panel">
      <div class="brand-block">
        <div class="brand-mark">DT</div>
        <div>
          <h1>BIM &#25968;&#23383;&#23418;&#29983;</h1>
          <p>CesiumJS &#26500;&#20214;&#32852;&#21160; Demo</p>
        </div>
      </div>

      <div class="metric-strip">
        <div>
          <strong>{{ materialGroups.length }}</strong>
          <span>&#26448;&#36136;&#20998;&#32452;</span>
        </div>
        <div>
          <strong>{{ allNodes.length }}</strong>
          <span>&#27169;&#22411;&#26500;&#20214;</span>
        </div>
      </div>

      <ModelTree
        :groups="materialGroups"
        :selected-node-id="selectedNodeId"
        :hovered-node-id="hoverHighlightEnabled ? hoveredNodeId : null"
        :hidden-node-ids="hiddenNodeIds"
        :loading="isMetadataLoading"
        @select-node="selectNode"
        @toggle-node-visibility="toggleNodeVisibility"
      />
    </aside>

    <section class="viewer-panel">
      <TwinViewer
        :model-url="modelUrl"
        :nodes="allNodes"
        :selected-node-id="selectedNodeId"
        :hovered-node-id="hoveredNodeId"
        :hover-highlight-enabled="hoverHighlightEnabled"
        :hidden-node-ids="hiddenNodeIds"
        @select-node="selectNode"
        @hover-node="setHoveredNode"
        @ready="isViewerReady = true"
        @error="viewerError = $event"
      />

      <div class="scene-status" :class="{ ready: isViewerReady }">
        <span class="status-dot"></span>
        <span>{{ sceneStatusText }}</span>
      </div>
    </section>

    <aside class="right-panel">
      <section class="info-card selected-card">
        <div class="panel-heading">
          <span>&#26500;&#20214;&#20449;&#24687;</span>
          <button type="button" class="ghost-button" :disabled="!selectedInfo" @click="clearSelection">
            &#28165;&#38500;
          </button>
        </div>

        <div v-if="selectedInfo" class="detail-list">
          <div>
            <span>&#33410;&#28857;&#21517;&#31216;</span>
            <strong>{{ selectedInfo.name }}</strong>
          </div>
          <div>
            <span>&#33410;&#28857;&#32034;&#24341;</span>
            <strong>{{ selectedInfo.nodeIndex }}</strong>
          </div>
          <div>
            <span>Mesh Index</span>
            <strong>{{ selectedInfo.meshIndex }}</strong>
          </div>
          <div>
            <span>&#26448;&#36136;&#20998;&#32452;</span>
            <strong>{{ selectedInfo.materialName }}</strong>
          </div>
          <div>
            <span>Primitive &#25968;&#37327;</span>
            <strong>{{ selectedInfo.primitiveCount }}</strong>
          </div>
        </div>

        <div v-else class="empty-state">
          <div class="empty-ring"></div>
          <p>&#20174;&#24038;&#20391;&#30446;&#24405;&#25110;&#19977;&#32500;&#27169;&#22411;&#20013;&#36873;&#25321;&#19968;&#20010;&#26500;&#20214;</p>
        </div>
      </section>

      <section class="info-card">
        <div class="panel-heading">
          <span>&#27169;&#22411;&#27010;&#20917;</span>
        </div>

        <div class="summary-grid">
          <div>
            <span>&#25991;&#20214;</span>
            <strong>t.glb</strong>
          </div>
          <div>
            <span>&#33410;&#28857;</span>
            <strong>{{ allNodes.length }}</strong>
          </div>
          <div>
            <span>&#26448;&#36136;</span>
            <strong>{{ materialGroups.length }}</strong>
          </div>
          <div>
            <span>&#39640;&#20142;&#27169;&#24335;</span>
            <strong>&#20960;&#20309;&#25342;&#21462;</strong>
          </div>
        </div>
      </section>

      <section class="info-card">
        <div class="panel-heading">
          <span>&#20132;&#20114;&#37197;&#32622;</span>
        </div>

        <label class="setting-row">
          <span>
            <strong>&#24748;&#28014;&#39640;&#20142;</strong>
            <small>&#40736;&#26631;&#31227;&#20837;&#26500;&#20214;&#26102;&#20020;&#26102;&#39640;&#20142;</small>
          </span>
          <input v-model="hoverHighlightEnabled" type="checkbox" />
        </label>
      </section>

      <section v-if="metadataError || viewerError" class="info-card error-card">
        <div class="panel-heading">
          <span>&#36816;&#34892;&#25552;&#31034;</span>
        </div>
        <p>{{ metadataError || viewerError }}</p>
      </section>
    </aside>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ModelTree from './components/ModelTree.vue'
import TwinViewer from './components/TwinViewer.vue'
import type { MaterialGroup, ModelNodeItem } from './types/model'
import { loadModelGroups } from './utils/gltf'

const modelUrl = '/models/t.glb'

const materialGroups = ref<MaterialGroup[]>([])
const selectedNodeId = ref<string | null>(null)
const hoveredNodeId = ref<string | null>(null)
const hoverHighlightEnabled = ref(false)
const hiddenNodeIds = ref<Set<string>>(new Set())
const isMetadataLoading = ref(true)
const isViewerReady = ref(false)
const metadataError = ref('')
const viewerError = ref('')

const allNodes = computed(() => materialGroups.value.flatMap((group) => group.children))

const selectedInfo = computed<ModelNodeItem | null>(() => {
  if (!selectedNodeId.value) {
    return null
  }

  return allNodes.value.find((node) => node.id === selectedNodeId.value) ?? null
})

const hoveredInfo = computed<ModelNodeItem | null>(() => {
  if (!hoveredNodeId.value) {
    return null
  }

  return allNodes.value.find((node) => node.id === hoveredNodeId.value) ?? null
})

const sceneStatusText = computed(() => {
  if (viewerError.value) {
    return '\u573a\u666f\u52a0\u8f7d\u5f02\u5e38'
  }

  if (!isViewerReady.value || isMetadataLoading.value) {
    return '\u6a21\u578b\u52a0\u8f7d\u4e2d'
  }

  if (hoverHighlightEnabled.value && hoveredInfo.value) {
    return `\u60ac\u6d6e ${hoveredInfo.value.name}`
  }

  return selectedInfo.value ? `\u5df2\u9009\u4e2d ${selectedInfo.value.name}` : '\u6a21\u578b\u5df2\u5c31\u7eea'
})

function selectNode(nodeId: string): void {
  hoveredNodeId.value = null
  selectedNodeId.value = nodeId
}

function clearSelection(): void {
  hoveredNodeId.value = null
  selectedNodeId.value = null
}

function toggleNodeVisibility(nodeId: string): void {
  const next = new Set(hiddenNodeIds.value)

  if (next.has(nodeId)) {
    next.delete(nodeId)
  } else {
    next.add(nodeId)
  }

  hiddenNodeIds.value = next
}

function setHoveredNode(nodeId: string | null): void {
  hoveredNodeId.value = hoverHighlightEnabled.value ? nodeId : null
}

watch(hoverHighlightEnabled, (enabled) => {
  if (!enabled) {
    hoveredNodeId.value = null
  }
})

onMounted(async () => {
  try {
    materialGroups.value = await loadModelGroups(modelUrl)
  } catch (error) {
    metadataError.value = error instanceof Error ? error.message : '\u6a21\u578b\u76ee\u5f55\u89e3\u6790\u5931\u8d25'
  } finally {
    isMetadataLoading.value = false
  }
})
</script>
