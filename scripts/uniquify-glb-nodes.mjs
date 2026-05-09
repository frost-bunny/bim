import { readFileSync, writeFileSync } from 'node:fs'

const [, , inputPath, outputPath = inputPath] = process.argv

if (!inputPath) {
  throw new Error('Usage: node scripts/uniquify-glb-nodes.mjs <input.glb> [output.glb]')
}

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942

const source = readFileSync(inputPath)
const view = new DataView(source.buffer, source.byteOffset, source.byteLength)

if (view.getUint32(0, true) !== GLB_MAGIC) {
  throw new Error(`${inputPath} is not a GLB file`)
}

const chunks = []
let json = null
let offset = 12

while (offset < source.byteLength) {
  const length = view.getUint32(offset, true)
  const type = view.getUint32(offset + 4, true)
  const start = offset + 8
  const data = source.subarray(start, start + length)

  if (type === JSON_CHUNK_TYPE) {
    json = JSON.parse(Buffer.from(data).toString('utf8').trim())
  } else {
    chunks.push({ type, data })
  }

  offset = start + length
}

if (!json) {
  throw new Error('GLB JSON chunk was not found')
}

json.nodes = (json.nodes ?? []).map((node, index) => {
  const originalName = String(node.name || `Node ${index}`).replace(/__node_\d+$/, '')

  return {
    ...node,
    name: `${originalName}__node_${index}`
  }
})

const jsonBuffer = padChunk(Buffer.from(`${JSON.stringify(json)} `, 'utf8'), 0x20)
const outputChunks = [{ type: JSON_CHUNK_TYPE, data: jsonBuffer }, ...chunks]
const totalLength = 12 + outputChunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0)
const header = Buffer.alloc(12)

header.writeUInt32LE(GLB_MAGIC, 0)
header.writeUInt32LE(2, 4)
header.writeUInt32LE(totalLength, 8)

const parts = [header]

for (const chunk of outputChunks) {
  const data = chunk.type === BIN_CHUNK_TYPE ? padChunk(chunk.data, 0x00) : chunk.data
  const chunkHeader = Buffer.alloc(8)

  chunkHeader.writeUInt32LE(data.length, 0)
  chunkHeader.writeUInt32LE(chunk.type, 4)
  parts.push(chunkHeader, data)
}

writeFileSync(outputPath, Buffer.concat(parts, totalLength))
console.log(`Wrote ${outputPath}`)

function padChunk(buffer, padByte) {
  const padding = (4 - (buffer.length % 4)) % 4

  if (padding === 0) {
    return buffer
  }

  return Buffer.concat([buffer, Buffer.alloc(padding, padByte)])
}
