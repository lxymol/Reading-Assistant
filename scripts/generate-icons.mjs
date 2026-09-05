import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const sourcePath = path.join(root, 'public', 'app-icon.svg')
const outputDirectory = path.join(root, 'electron')
const source = await loadImage(sourcePath)
const render = (size) => {
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').drawImage(source, 0, 0, size, size)
  return canvas.toBuffer('image/png')
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(path.join(outputDirectory, 'app-icon.png'), render(512))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(render)
const headerSize = 6 + images.length * 16
const header = Buffer.alloc(headerSize)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

let offset = headerSize
images.forEach((image, index) => {
  const size = sizes[index]
  const entry = 6 + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entry)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1)
  header.writeUInt8(0, entry + 2)
  header.writeUInt8(0, entry + 3)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += image.length
})

await writeFile(path.join(outputDirectory, 'app-icon.ico'), Buffer.concat([header, ...images]))
