import type { CapturedSelection, SelectionImage } from '../types'

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
