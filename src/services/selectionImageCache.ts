import type { CapturedSelection, SelectionImage } from '../types'
import { createIndexedDatabase } from './indexedDatabase.js'

const archive = createIndexedDatabase('raid-selection-images-v1', { images: undefined })
type ArchivedImage = { full: Blob; thumbnail: Blob }
const archiveImage = (id: string, value: ArchivedImage) => archive.request('images', 'readwrite', (store) => store.put(value, id))
const archivedImage = async (id: string) => await archive.request<ArchivedImage | undefined>('images', 'readonly', (store) => store.get(id)) || null

export async function retainSelectionImages(selections: CapturedSelection[]) {
  const attachments: Array<{ id: string; page: number }> = []
  const nativeItems: Array<{ id: string; preview: string }> = []
  for (const selection of selections) for (const [index, image] of selection.images.entries()) {
    const page = selection.regions[index]?.page || selection.page
    if (image.cacheId && window.readingAssistant?.retainSelectionImages) {
      nativeItems.push({ id: image.cacheId, preview: image.preview })
      attachments.push({ id: image.cacheId, page })
    } else {
      const id = crypto.randomUUID()
      const full = await fetch(await resolveSelectionImage(image)).then((response) => response.blob())
      const thumbnail = image.preview ? await fetch(image.preview).then((response) => response.blob()) : full
      await archiveImage(id, { full, thumbnail })
      attachments.push({ id, page })
    }
  }
  if (nativeItems.length) await window.readingAssistant!.retainSelectionImages!(nativeItems)
  return attachments
}

export async function loadStoredSelectionImage(id: string, thumbnail = false): Promise<Blob> {
  if (window.readingAssistant?.readSelectionImage) {
    const value = await window.readingAssistant.readSelectionImage(id, thumbnail)
    if (!value) throw new Error('选区图片已被删除')
    return new Blob([value.data as BlobPart], { type: value.mime })
  }
  const value = await archivedImage(id)
  if (!value) throw new Error('选区图片已被删除')
  return thumbnail ? value.thumbnail : value.full
}

export async function deleteStoredSelectionImages(ids: string[]) {
  const unique = [...new Set(ids)]
  if (!unique.length) return
  if (window.readingAssistant?.deleteStoredSelectionImages) { await window.readingAssistant.deleteStoredSelectionImages(unique); return }
  await archive.transaction<void>('images', 'readwrite', (transaction) => {
    for (const id of unique) transaction.objectStore('images').delete(id)
  })
}

const canvasBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码选区图像')), 'image/jpeg', quality)
})

const blobDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(reader.error || new Error('无法读取选区图像'))
  reader.readAsDataURL(blob)
})

export async function cacheSelectionCanvas(canvas: HTMLCanvasElement): Promise<SelectionImage> {
  const previewScale = Math.min(1, 280 / Math.max(canvas.width, canvas.height))
  const previewCanvas = document.createElement('canvas')
  previewCanvas.width = Math.max(1, Math.round(canvas.width * previewScale))
  previewCanvas.height = Math.max(1, Math.round(canvas.height * previewScale))
  previewCanvas.getContext('2d')?.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height)
  const preview = previewCanvas.toDataURL('image/jpeg', .68)
  previewCanvas.width = 0; previewCanvas.height = 0

  const blob = await canvasBlob(canvas, .9)
  if (window.readingAssistant?.storeSelectionImage) {
    const stored = await window.readingAssistant.storeSelectionImage({ data: await blob.arrayBuffer(), mime: 'image/jpeg' })
    return { preview, cacheId: stored.id, byteLength: stored.byteLength }
  }
  return { preview, dataUrl: await blobDataUrl(blob), byteLength: blob.size }
}

export async function resolveSelectionImage(image: SelectionImage) {
  if (image.dataUrl) return image.dataUrl
  if (!image.cacheId || !window.readingAssistant?.readSelectionImage) throw new Error('选区图像缓存已失效')
  const cached = await window.readingAssistant.readSelectionImage(image.cacheId)
  if (!cached) throw new Error('选区图像缓存已失效')
  return blobDataUrl(new Blob([cached.data as BlobPart], { type: cached.mime }))
}

export function disposeSelectionImages(selections: Pick<CapturedSelection, 'images'>[]) {
  const ids = selections.flatMap((selection) => selection.images.flatMap((image) => image.cacheId ? [image.cacheId] : []))
  if (ids.length && window.readingAssistant?.deleteSelectionImages) void window.readingAssistant.deleteSelectionImages(ids)
}

// Keep logical selections unlimited while bounding in-memory thumbnail data.
export function boundSelectionPreviews(selections: CapturedSelection[], maximumPreviews = 72) {
  const bounded = selections.map((selection) => ({ ...selection, images: selection.images.map((image) => ({ ...image })) }))
  let remaining = maximumPreviews
  for (let selectionIndex = bounded.length - 1; selectionIndex >= 0; selectionIndex -= 1) {
    const selection = bounded[selectionIndex]
    for (let imageIndex = selection.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      if (remaining > 0) remaining -= 1
      else selection.images[imageIndex].preview = ''
    }
    selection.image = selection.images[0]?.preview || ''
  }
  return bounded
}

// Preserve generated images and transparency across app restarts.
export async function retainGeneratedImages(images: Array<{ name: string; dataUrl: string }>) {
  const attachments: Array<{ id: string; page: number }> = []
  for (const image of images) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(image.dataUrl)) throw new Error('生成图片格式无效')
    const full = await (await fetch(image.dataUrl)).blob()
    const bitmap = await createImageBitmap(full)
    const canvas = document.createElement('canvas')
    try {
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error('生成图片尺寸超过保存预算')
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const thumbnail = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法保存生成图片')), 'image/png'))
      const png = full.type === 'image/png' ? full : await new Promise<Blob>((resolve, reject) => {
        const original = document.createElement('canvas')
        original.width = bitmap.width; original.height = bitmap.height
        original.getContext('2d')?.drawImage(bitmap, 0, 0)
        original.toBlob((blob) => { original.width = 0; original.height = 0; if (blob) resolve(blob); else reject(new Error('无法保存生成图片')) }, 'image/png')
      })
      const id = window.readingAssistant?.storeGeneratedImage
        ? (await window.readingAssistant.storeGeneratedImage({ data: await png.arrayBuffer(), thumbnail: await thumbnail.arrayBuffer() })).id
        : `generated-${crypto.randomUUID()}`
      if (!window.readingAssistant?.storeGeneratedImage) await archiveImage(id, { full: png, thumbnail })
      attachments.push({ id, page: 0 })
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0 }
  }
  return attachments
}
