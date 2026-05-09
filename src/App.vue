<template>
  <main class="app-shell">
    <aside class="left-panel">
      <div class="brand-block">
        <div class="brand-mark">DT</div>
        <div>
          <h1>BIM 数字孪生</h1>
          <p>CesiumJS 构件联动 Demo</p>
        </div>
      </div>

      <div class="metric-strip">
        <div>
          <strong>{{ materialGroups.length }}</strong>
          <span>材质分组</span>
        </div>
        <div>
          <strong>{{ allNodes.length }}</strong>
          <span>模型构件</span>
        </div>
      </div>

      <ModelTree
        :groups="materialGroups"
        :selected-node-id="selectedNodeId"
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
        :hidden-node-ids="hiddenNodeIds"
        @select-node="selectNode"
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
          <span>构件信息</span>
          <button type="button" class="ghost-button" :disabled="!selectedInfo" @click="clearSelection">
            清除
          </button>
        </div>

        <div v-if="selectedInfo" class="detail-list">
          <div>
            <span>节点名称</span>
            <strong>{{ selectedInfo.name }}</strong>
          </div>
          <div>
            <span>节点索引</span>
            <strong>{{ selectedInfo.nodeIndex }}</strong>
          </div>
          <div>
            <span>Mesh Index</span>
            <strong>{{ selectedInfo.meshIndex }}</strong>
          </div>
          <div>
            <span>材质分组</span>
            <strong>{{ selectedInfo.materialName }}</strong>
          </div>
          <div>
            <span>Primitive 数量</span>
            <strong>{{ selectedInfo.primitiveCount }}</strong>
          </div>
        </div>

        <div v-else class="empty-state">
          <div class="empty-ring"></div>
          <p>从左侧目录或三维模型中选择一个构件</p>
        </div>
      </section>

      <section class="info-card">
        <div class="panel-heading">
          <span>模型概况</span>
        </div>

        <div class="summary-grid">
          <div>
            <span>文件</span>
            <strong>t.glb</strong>
          </div>
          <div>
            <span>节点</span>
            <strong>{{ allNodes.length }}</strong>
          </div>
          <div>
            <span>材质</span>
            <strong>{{ materialGroups.length }}</strong>
          </div>
          <div>
            <span>高亮模式</span>
            <strong>双模型节点</strong>
          </div>
        </div>
      </section>

      <section v-if="metadataError || viewerError" class="info-card error-card">
        <div class="panel-heading">
          <span>运行提示</span>
        </div>
        <p>{{ metadataError || viewerError }}</p>
      </section>
    </aside>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModelTree from './components/ModelTree.vue'
import TwinViewer from './components/TwinViewer.vue'
import type { MaterialGroup, ModelNodeItem } from './types/model'
import { loadModelGroups } from './utils/gltf'

const modelUrl = '/models/t.glb'

const materialGroups = ref<MaterialGroup[]>([])
const selectedNodeId = ref<string | null>(null)
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

const sceneStatusText = computed(() => {
  if (viewerError.value) {
    return '场景加载异常'
  }

  if (!isViewerReady.value || isMetadataLoading.value) {
    return '模型加载中'
  }

  return selectedInfo.value ? `已选中 ${selectedInfo.value.name}` : '模型已就绪'
})

function selectNode(nodeId: string): void {
  selectedNodeId.value = nodeId
}

function clearSelection(): void {
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

onMounted(async () => {
  try {
    materialGroups.value = await loadModelGroups(modelUrl)
  } catch (error) {
    metadataError.value = error instanceof Error ? error.message : '模型目录解析失败'
  } finally {
    isMetadataLoading.value = false
  }
})
</script>
