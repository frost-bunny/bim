interface TilesetDocument {
  asset?: {
    version?: string
    generator?: string
  }
  root?: TilesetTile
  extensionsRequired?: string[]
  extensionsUsed?: string[]
}

interface TilesetTile {
  boundingVolume?: unknown
  geometricError?: number
  content?: {
    uri?: string
    url?: string
  }
  children?: TilesetTile[]
}

export interface TilesetStandardReport {
  url: string
  assetVersion: string
  generator: string
  contentCount: number
  gltfContentCount: number
  missingContentUris: string[]
  usesGltfContentExtension: boolean
  hasRootBoundingVolume: boolean
  hasRootGeometricError: boolean
  isDeclared3DTiles11: boolean
  isCompletePackage: boolean
  isStandard3DTiles11: boolean
  message: string
}

export async function validateTilesetStandard(tilesetUrl: string): Promise<TilesetStandardReport> {
  const response = await fetch(tilesetUrl)

  if (!response.ok) {
    throw new Error(`Failed to load tileset report: ${response.status} ${response.statusText}`)
  }

  const tileset = (await response.json()) as TilesetDocument
  const baseUrl = new URL(tilesetUrl, window.location.href)
  const contentUris = collectContentUris(tileset.root)
  const missingContentUris = await getMissingContentUris(contentUris, baseUrl)
  const assetVersion = tileset.asset?.version ?? ''
  const usesGltfContentExtension = [
    ...(tileset.extensionsRequired ?? []),
    ...(tileset.extensionsUsed ?? [])
  ].includes('3DTILES_content_gltf')
  const gltfContentCount = contentUris.filter((uri) => /\.(glb|gltf)(?:[?#].*)?$/i.test(uri)).length
  const hasRootBoundingVolume = Boolean(tileset.root?.boundingVolume)
  const hasRootGeometricError = typeof tileset.root?.geometricError === 'number'
  const isDeclared3DTiles11 = assetVersion === '1.1'
  const isCompletePackage = missingContentUris.length === 0
  const isStandard3DTiles11 =
    isDeclared3DTiles11 &&
    hasRootBoundingVolume &&
    hasRootGeometricError &&
    contentUris.length > 0 &&
    gltfContentCount === contentUris.length &&
    isCompletePackage

  return {
    url: tilesetUrl,
    assetVersion,
    generator: tileset.asset?.generator ?? '',
    contentCount: contentUris.length,
    gltfContentCount,
    missingContentUris,
    usesGltfContentExtension,
    hasRootBoundingVolume,
    hasRootGeometricError,
    isDeclared3DTiles11,
    isCompletePackage,
    isStandard3DTiles11,
    message: createReportMessage({
      isDeclared3DTiles11,
      isCompletePackage,
      contentCount: contentUris.length,
      gltfContentCount,
      missingContentUris
    })
  }
}

function collectContentUris(tile: TilesetTile | undefined): string[] {
  if (!tile) {
    return []
  }

  const contentUri = tile.content?.uri ?? tile.content?.url
  const uris = contentUri ? [contentUri] : []

  tile.children?.forEach((child) => {
    uris.push(...collectContentUris(child))
  })

  return uris
}

async function getMissingContentUris(contentUris: string[], baseUrl: URL): Promise<string[]> {
  const checks = await Promise.all(
    contentUris.map(async (uri) => {
      try {
        const response = await fetch(new URL(uri, baseUrl))

        if (!response.ok) {
          return uri
        }

        return isExpectedContentMagic(uri, await response.arrayBuffer()) ? '' : uri
      } catch {
        return uri
      }
    })
  )

  return checks.filter(Boolean)
}

function isExpectedContentMagic(uri: string, buffer: ArrayBuffer): boolean {
  const magic = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 0, 4))

  if (/\.glb(?:[?#].*)?$/i.test(uri)) {
    return magic === 'glTF'
  }

  if (/\.b3dm(?:[?#].*)?$/i.test(uri)) {
    return magic === 'b3dm'
  }

  if (/\.cmpt(?:[?#].*)?$/i.test(uri)) {
    return magic === 'cmpt'
  }

  if (/\.gltf(?:[?#].*)?$/i.test(uri)) {
    return magic.trim().startsWith('{')
  }

  return true
}

function createReportMessage(report: {
  isDeclared3DTiles11: boolean
  isCompletePackage: boolean
  contentCount: number
  gltfContentCount: number
  missingContentUris: string[]
}): string {
  if (!report.isDeclared3DTiles11) {
    return '\u672a\u58f0\u660e\u4e3a 3D Tiles 1.1'
  }

  if (report.gltfContentCount !== report.contentCount) {
    return '\u58f0\u660e\u4e3a 3D Tiles 1.1\uff0c\u4f46\u5b58\u5728\u975e glTF/GLB content'
  }

  if (!report.isCompletePackage) {
    return `\u58f0\u660e\u4e3a 3D Tiles 1.1\uff0c\u4f46\u7f3a\u5931 ${report.missingContentUris.length} \u4e2a content \u6587\u4ef6`
  }

  return '\u6807\u51c6 3D Tiles 1.1 glTF content \u6570\u636e\u96c6'
}
