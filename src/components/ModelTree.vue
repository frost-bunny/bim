<template>
  <section class="tree-panel">
    <label class="search-box">
      <span>搜索</span>
      <input v-model.trim="keyword" type="search" placeholder="构件 ID / 材质名称" />
    </label>

    <div v-if="loading" class="tree-loading">
      <span></span>
      正在解析模型目录
    </div>

    <div v-else class="tree-scroll">
      <div v-for="group in filteredGroups" :key="group.id" class="tree-group">
        <button type="button" class="group-row" @click="toggleGroup(group.id)">
          <span class="chevron" :class="{ expanded: expandedGroupIds.has(group.id) }"></span>
          <span class="group-name">{{ group.name }}</span>
          <span class="group-count">{{ group.children.length }}</span>
        </button>

        <div v-show="expandedGroupIds.has(group.id)" class="node-list">
          <div
            v-for="node in group.children"
            :key="node.id"
            role="button"
            tabindex="0"
            class="node-row"
            :ref="(element) => setNodeRowRef(node.id, element)"
            :class="{
              active: node.id === selectedNodeId,
              hovered: node.id === hoveredNodeId,
              hidden: hiddenNodeIds.has(node.id)
            }"
            @click="$emit('select-node', node.id)"
            @keydown.enter="$emit('select-node', node.id)"
            @keydown.space.prevent="$emit('select-node', node.id)"
          >
            <span class="node-dot"></span>
            <span class="node-name">{{ node.name }}</span>
            <button
              type="button"
              class="visibility-button"
              :class="{ off: hiddenNodeIds.has(node.id) }"
              :title="hiddenNodeIds.has(node.id) ? '显示构件' : '隐藏为透明'"
              :aria-label="hiddenNodeIds.has(node.id) ? '显示构件' : '隐藏为透明'"
              @click.stop="$emit('toggle-node-visibility', node.id)"
            >
              <svg v-if="!hiddenNodeIds.has(node.id)" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.2 12s3.6-6.4 9.8-6.4S21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path d="m3 3 18 18" />
                <path d="M10.6 5.8A9.7 9.7 0 0 1 12 5.7c6.2 0 9.8 6.3 9.8 6.3a17.2 17.2 0 0 1-3.2 3.9" />
                <path d="M6.4 6.7A17 17 0 0 0 2.2 12S5.8 18.4 12 18.4a9.8 9.8 0 0 0 3.3-.6" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
            </button>
            <span class="node-index">#{{ node.nodeIndex }}</span>
          </div>
        </div>
      </div>

      <div v-if="filteredGroups.length === 0" class="tree-empty">没有匹配的构件</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { MaterialGroup } from '../types/model'

const props = defineProps<{
  groups: MaterialGroup[]
  selectedNodeId: string | null
  hoveredNodeId: string | null
  hiddenNodeIds: Set<string>
  loading: boolean
}>()

defineEmits<{
  (event: 'select-node', nodeId: string): void
  (event: 'toggle-node-visibility', nodeId: string): void
}>()

const keyword = ref('')
const expandedGroupIds = ref<Set<string>>(new Set())
const nodeRowRefs = new Map<string, HTMLElement>()

const filteredGroups = computed(() => {
  const query = keyword.value.toLowerCase()

  if (!query) {
    return props.groups
  }

  return props.groups
    .map((group) => ({
      ...group,
      children: group.children.filter(
        (node) =>
          node.name.toLowerCase().includes(query) ||
          String(node.nodeIndex).includes(query) ||
          group.name.toLowerCase().includes(query)
      )
    }))
    .filter((group) => group.children.length > 0)
})

watch(
  () => props.groups,
  (groups) => {
    expandedGroupIds.value = new Set(groups.slice(0, 4).map((group) => group.id))
  },
  { immediate: true }
)

watch(
  () => props.selectedNodeId,
  async (nodeId) => {
    if (!nodeId) {
      return
    }

    const group = props.groups.find((item) => item.children.some((node) => node.id === nodeId))

    if (group) {
      const next = new Set(expandedGroupIds.value)
      next.add(group.id)
      expandedGroupIds.value = next
    }

    if (keyword.value && !isNodeInFilteredGroups(nodeId)) {
      keyword.value = ''
    }

    await nextTick()
    scrollSelectedNodeIntoView(nodeId)
  }
)

watch(keyword, () => {
  if (keyword.value) {
    expandedGroupIds.value = new Set(filteredGroups.value.map((group) => group.id))
  }
})

function toggleGroup(groupId: string): void {
  const next = new Set(expandedGroupIds.value)

  if (next.has(groupId)) {
    next.delete(groupId)
  } else {
    next.add(groupId)
  }

  expandedGroupIds.value = next
}

function setNodeRowRef(
  nodeId: string,
  element: Element | ComponentPublicInstance | null
): void {
  if (element instanceof HTMLElement) {
    nodeRowRefs.set(nodeId, element)
    return
  }

  nodeRowRefs.delete(nodeId)
}

function scrollSelectedNodeIntoView(nodeId: string): void {
  const element = nodeRowRefs.get(nodeId)

  if (!element) {
    return
  }

  element.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'smooth'
  })
}

function isNodeInFilteredGroups(nodeId: string): boolean {
  return filteredGroups.value.some((group) => group.children.some((node) => node.id === nodeId))
}
</script>
