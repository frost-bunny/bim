export interface ModelNodeItem {
  id: string
  name: string
  runtimeName: string
  nodeIndex: number
  meshIndex: number
  materialIndex: number
  materialName: string
  groupId: string
  primitiveCount: number
  center: [number, number, number]
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
}

export interface MaterialGroup {
  id: string
  name: string
  materialIndex: number
  children: ModelNodeItem[]
}

export type SelectedModelInfo = ModelNodeItem | null
