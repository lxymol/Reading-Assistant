import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import { Check, Copy, Highlighter, ImageOff, Languages, LoaderCircle, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import SelectableCanvas from './SelectableCanvas'
import AnnotationLayer from './AnnotationLayer'
import type { AnnotationTool, DocumentAnnotation, DocumentHighlight, DocumentTag, NormalizedRegion, SelectionResult, SourceFile, TextAnnotation } from '../types'
import { loadPdf, type DocumentReference } from '../lib/pdf'
import { useI18n } from '../i18n'

type Props = {
  source: SourceFile
  zoom: number
  currentPage: number
  inverted: boolean
  areaSelectionEnabled: boolean
  tagMode: boolean
  tags: DocumentTag[]
  onCreateTag: (page: number, region: NormalizedRegion) => void
  onMoveTag: (id: string, region: NormalizedRegion) => void
  onPdfReady: (pdf: PDFDocumentProxy) => void
  onSelect: (selection: SelectionResult) => void
  onTextAi: (text: string) => void
  onTextTranslate: (text: string, signal: AbortSignal, onDelta: (delta: string) => void) => Promise<string>
  highlights: DocumentHighlight[]
  onHighlight: (highlight: Omit<DocumentHighlight, 'id'>) => void
  citationFocus: DocumentReference | null
  annotationMode: boolean
  annotationTool: AnnotationTool
  annotationColor: string
  annotations: DocumentAnnotation[]
  onAnnotationsChange: Dispatch<SetStateAction<DocumentAnnotation[]>>
}

type AnnotationPageProps = Pick<Props, 'annotationMode' | 'annotationTool' | 'annotationColor' | 'annotations' | 'onAnnotationsChange'>

function TagPlacementLayer({ active }: { active: boolean }) {
  if (!active) return null
  return <div className="tag-placement-layer" title="点击添加标签" aria-hidden="true" />
}

function TagMarkerLayer({ tags, active, onMove }: { tags: DocumentTag[]; active: boolean; onMove: Props['onMoveTag'] }) {
  const dragRef = useRef<{ id: string; pointerId: number; offsetX: number; offsetY: number; width: number; height: number; region: NormalizedRegion } | null>(null)
  return <div className="document-tag-layer">{tags.map((tag) => <i
    key={tag.id}
    className="document-tag-marker"
    title={tag.label || `第 ${tag.page} 页标签`}
    style={{ left: `${(tag.region.left + tag.region.width / 2) * 100}%`, top: `${(tag.region.top + tag.region.height / 2) * 100}%` }}
    onPointerDown={(event) => {
      if (!active || event.button !== 0) return
      const page = event.currentTarget.closest<HTMLElement>('.selectable-page')
      const bounds = page?.getBoundingClientRect()
      if (!bounds?.width || !bounds.height) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        id: tag.id, pointerId: event.pointerId,
        offsetX: (event.clientX - bounds.left) / bounds.width - tag.region.left - tag.region.width / 2,
        offsetY: (event.clientY - bounds.top) / bounds.height - tag.region.top - tag.region.height / 2,
        width: tag.region.width, height: tag.region.height, region: tag.region,
      }
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId || drag.id !== tag.id) return
      const page = event.currentTarget.closest<HTMLElement>('.selectable-page')
      const bounds = page?.getBoundingClientRect()
      if (!bounds?.width || !bounds.height) return
      event.preventDefault(); event.stopPropagation()
      const centerX = (event.clientX - bounds.left) / bounds.width - drag.offsetX
      const centerY = (event.clientY - bounds.top) / bounds.height - drag.offsetY
      drag.region = {
        left: Math.max(0, Math.min(1 - drag.width, centerX - drag.width / 2)),
        top: Math.max(0, Math.min(1 - drag.height, centerY - drag.height / 2)),
        width: drag.width, height: drag.height,
      }
      event.currentTarget.style.left = `${(drag.region.left + drag.region.width / 2) * 100}%`
      event.currentTarget.style.top = `${(drag.region.top + drag.region.height / 2) * 100}%`
    }}
    onPointerUp={(event) => {
      if (dragRef.current?.pointerId !== event.pointerId) return
      const drag = dragRef.current
      event.preventDefault(); event.stopPropagation(); dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      onMove(tag.id, drag.region)
    }}
    onPointerCancel={(event) => { event.stopPropagation(); dragRef.current = null }}
  >{tag.label && <span>{tag.label}</span>}</i>)}</div>
}

function PdfPage({ pdf, pageNumber, zoom, inverted, textSelectionEnabled, highlights, citationFocus, tagMode, tags, onMoveTag, ...annotationProps }: { pdf: PDFDocumentProxy; pageNumber: number; zoom: number; inverted: boolean; textSelectionEnabled: boolean; highlights: DocumentHighlight[]; citationFocus: DocumentReference | null; tagMode: boolean; tags: DocumentTag[]; onMoveTag: Props['onMoveTag'] } & AnnotationPageProps) {
  const textLayerRef = useRef<HTMLDivElement>(null)
  const citationLayerRef = useRef<HTMLDivElement>(null)
  const render = useCallback(async (canvas: HTMLCanvasElement) => {
    const page = await pdf.getPage(pageNumber)
    const displayViewport = page.getViewport({ scale: 0.82 * zoom })
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.6)
    const viewport = page.getViewport({ scale: 0.82 * zoom * outputScale })
    const context = canvas.getContext('2d')
    if (!context) return
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${displayViewport.width}px`
    canvas.style.height = `${displayViewport.height}px`
    await page.render({ canvasContext: context, viewport, canvas }).promise
  }, [pdf, pageNumber, zoom])

  useEffect(() => {
    const container = textLayerRef.current
    if (!container) return
    container.replaceChildren()
    if (!textSelectionEnabled) return
    let active = true
    let layer: TextLayer | null = null
    void pdf.getPage(pageNumber).then(async (page) => {
      if (!active) return
      const viewport = page.getViewport({ scale: 0.82 * zoom })
      container.style.setProperty('--total-scale-factor', String(0.82 * zoom))
      container.style.setProperty('--scale-round-x', '1px')
      container.style.setProperty('--scale-round-y', '1px')
      layer = new TextLayer({ textContentSource: await page.getTextContent(), container, viewport })
      await layer.render()
      const legacyHighlights = highlights.filter((item) => item.page === pageNumber && !item.regions?.length)
      container.querySelectorAll('span').forEach((span) => {
        const spanText = span.textContent?.trim() || ''
        if (spanText && legacyHighlights.some((item) => item.text.includes(spanText) || spanText.includes(item.text))) span.classList.add('saved-highlight')
      })
    }).catch(() => undefined)
    return () => { active = false; layer?.cancel(); container.replaceChildren() }
  }, [pdf, pageNumber, textSelectionEnabled, zoom, highlights])

  const pageRegions = highlights.flatMap((highlight) => (highlight.regions || []).filter((item) => item.page === pageNumber).map((item) => ({ ...item.region, color: highlight.color })))
  const focusedRegion = citationFocus?.page === pageNumber ? citationFocus.region : null
  useEffect(() => {
    if (!focusedRegion) return
    let active = true
    let frames = 0
    const reveal = () => requestAnimationFrame(() => {
      if (!active) return
      const layer = citationLayerRef.current
      const canvas = layer?.closest('.selectable-page')?.querySelector('canvas')
      const marker = layer?.querySelector('i')
      const reader = layer?.closest('.reader-scroll')
      if (marker && reader && canvas?.width && canvas?.height) {
        const markerBounds = marker.getBoundingClientRect()
        const readerBounds = reader.getBoundingClientRect()
        if (markerBounds.top < readerBounds.top + 30 || markerBounds.bottom > readerBounds.bottom - 30) marker.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      }
      frames += 1
      if (frames < 420) reveal()
    })
    reveal()
    return () => { active = false }
  }, [focusedRegion])
  return <SelectableCanvas pageNumber={pageNumber} initialSize={{ width: 500 * zoom, height: 710 * zoom }} render={render} onSelect={() => undefined} selectionEnabled={false} inverted={inverted} overlay={<><div className="saved-highlight-layer">{pageRegions.map((region, index) => <i key={index} style={{ left: `${region.left * 100}%`, top: `${region.top * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`, background: region.color }} />)}</div>{focusedRegion && <div ref={citationLayerRef} className="citation-focus-layer"><i style={{ left: `${focusedRegion.left * 100}%`, top: `${focusedRegion.top * 100}%`, width: `${focusedRegion.width * 100}%`, height: `${focusedRegion.height * 100}%` }} /></div>}<TagMarkerLayer tags={tags.filter((tag) => tag.page === pageNumber)} active={tagMode} onMove={onMoveTag} /><div ref={textLayerRef} className={`text-layer ${textSelectionEnabled ? 'enabled' : ''}`} /><AnnotationLayer pageNumber={pageNumber} active={annotationProps.annotationMode} tool={annotationProps.annotationTool} color={annotationProps.annotationColor} annotations={annotationProps.annotations} onChange={annotationProps.onAnnotationsChange} /><TagPlacementLayer active={tagMode} /></>} />
}

function ImagePage({ source, zoom, inverted, tagMode, tags, onMoveTag, ...annotationProps }: { source: SourceFile; zoom: number; inverted: boolean; tagMode: boolean; tags: DocumentTag[]; onMoveTag: Props['onMoveTag'] } & AnnotationPageProps) {
  const render = useCallback(async (canvas: HTMLCanvasElement) => {
    const image = new Image()
    image.src = source.url
    await image.decode()
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.style.width = `${Math.min(1100, image.naturalWidth) * zoom}px`
    contextSafe(canvas)?.drawImage(image, 0, 0)
  }, [source.url, zoom])
  return <SelectableCanvas pageNumber={1} className="image-page" render={render} onSelect={() => undefined} selectionEnabled={false} inverted={inverted} overlay={<><TagMarkerLayer tags={tags} active={tagMode} onMove={onMoveTag} /><AnnotationLayer pageNumber={1} active={annotationProps.annotationMode} tool={annotationProps.annotationTool} color={annotationProps.annotationColor} annotations={annotationProps.annotations} onChange={annotationProps.onAnnotationsChange} /><TagPlacementLayer active={tagMode} /></>} />
}

type PdfPageProps = Parameters<typeof PdfPage>[0]

function LazyPdfPage(props: PdfPageProps) {
  const { pageNumber } = props
  const placeholderRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => pageNumber <= 3)

  useEffect(() => {
    if (visible) return
    const placeholder = placeholderRef.current
    if (!placeholder) return
    const root = placeholder.closest<HTMLElement>('.reader-scroll')
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
    }, { root, rootMargin: '900px 0px' })
    observer.observe(placeholder)
    return () => observer.disconnect()
  }, [visible])

  if (visible) return <PdfPage {...props} />
  return <div ref={placeholderRef} className="pdf-page-placeholder" data-page-number={pageNumber} style={{ width: 500 * props.zoom, height: 710 * props.zoom }}><span>{pageNumber}</span></div>
}

const contextSafe = (canvas: HTMLCanvasElement) => canvas.getContext('2d')

type SelectionRect = { left: number; top: number; width: number; height: number }

function drawAnnotationsIntoCrop(context: CanvasRenderingContext2D, pageAnnotations: DocumentAnnotation[], region: SelectionRect, width: number, height: number) {
  const x = (value: number) => (value - region.left) / region.width * width
  const y = (value: number) => (value - region.top) / region.height * height
  context.save()
  context.lineCap = 'round'; context.lineJoin = 'round'
  pageAnnotations.forEach((annotation) => {
    if (annotation.type === 'ink') {
      if (annotation.points.length < 2) return
      context.beginPath()
      annotation.points.forEach((point, index) => index ? context.lineTo(x(point.x), y(point.y)) : context.moveTo(x(point.x), y(point.y)))
      context.strokeStyle = annotation.color
      context.lineWidth = Math.max(2, annotation.strokeWidth / region.width * width)
      context.stroke()
      return
    }
    if (!annotation.text.trim()) return
    const fontSize = Math.max(11, width * .025 / region.width)
    context.font = `600 ${fontSize}px sans-serif`
    context.fillStyle = annotation.color
    context.textBaseline = 'top'
    const maxWidth = annotation.width / region.width * width
    annotation.text.split(/\n/).forEach((line, index) => context.fillText(line, x(annotation.x), y(annotation.y) + index * fontSize * 1.25, maxWidth))
  })
  context.restore()
}

export default function DocumentViewer({ source, zoom, currentPage, inverted, areaSelectionEnabled, tagMode, tags, onCreateTag, onMoveTag, onPdfReady, onSelect, onTextAi, onTextTranslate, highlights, onHighlight, citationFocus, annotationMode, annotationTool, annotationColor, annotations, onAnnotationsChange }: Props) {
  const { t, pack } = useI18n()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const rectRef = useRef<SelectionRect | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const autoScrollFrameRef = useRef<number | null>(null)
  const [textAction, setTextAction] = useState<{ text: string; left: number; top: number; regions: SelectionResult['regions'] } | null>(null)
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  const [copied, setCopied] = useState(false)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const translationControllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (source.kind !== 'pdf') return
    loadPdf(source.url)
      .then((document) => { setPdf(document); onPdfReady(document) })
      .catch((reason) => setError(reason instanceof Error ? reason.message : (pack.code === 'en-US' ? 'Failed to load PDF' : 'PDF 加载失败')))
  }, [source, onPdfReady, pack.code])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      translationControllerRef.current?.abort()
      translationControllerRef.current = null
      setTextAction(null)
      setTranslation('')
      setTranslating(false)
      window.getSelection()?.removeAllRanges()
    })
    return () => cancelAnimationFrame(frame)
  }, [areaSelectionEnabled, annotationMode, tagMode])

  useEffect(() => () => translationControllerRef.current?.abort(), [])

  if (error) return <div className="viewer-state"><ImageOff /><p>{error}</p></div>
  if (source.kind === 'pdf' && !pdf) return <div className="viewer-state"><span className="spinner" /><p>{t('loadingPdf')}</p></div>

  const pointFromClient = (clientX: number, clientY: number) => {
    const stack = stackRef.current
    if (!stack) return { x: 0, y: 0 }
    const bounds = stack.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(bounds.width, clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, clientY - bounds.top)),
    }
  }

  const updateSelection = (clientX: number, clientY: number) => {
    if (!startRef.current) return
    const point = pointFromClient(clientX, clientY)
    const start = startRef.current
    const next = {
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    }
    rectRef.current = next
    setSelectionRect(next)
  }

  const stopAutoScroll = () => {
    if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current)
    autoScrollFrameRef.current = null
  }

  const runAutoScroll = () => {
    stopAutoScroll()
    const step = () => {
      if (!startRef.current || !lastPointerRef.current) return stopAutoScroll()
      const container = stackRef.current?.closest<HTMLElement>('.reader-scroll')
      if (!container) return stopAutoScroll()
      const bounds = container.getBoundingClientRect()
      const edge = 64
      const pointerY = lastPointerRef.current.y
      let speed = 0
      if (pointerY < bounds.top + edge) speed = -Math.min(18, (bounds.top + edge - pointerY) * 0.3)
      if (pointerY > bounds.bottom - edge) speed = Math.min(18, (pointerY - (bounds.bottom - edge)) * 0.3)
      if (speed) {
        container.scrollTop += speed
        updateSelection(lastPointerRef.current.x, lastPointerRef.current.y)
        autoScrollFrameRef.current = requestAnimationFrame(step)
      } else {
        autoScrollFrameRef.current = null
      }
    }
    autoScrollFrameRef.current = requestAnimationFrame(step)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaSelectionEnabled && !annotationMode && textAction && !(event.target as HTMLElement).closest('.text-action-popover')) {
      translationControllerRef.current?.abort(); translationControllerRef.current = null
      setTextAction(null); setTranslation(''); setTranslating(false); window.getSelection()?.removeAllRanges()
    }
    if (annotationMode || tagMode || !areaSelectionEnabled || event.button !== 0 || !(event.target as HTMLElement).closest('.selectable-page')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromClient(event.clientX, event.clientY)
    startRef.current = point
    lastPointerRef.current = { x: event.clientX, y: event.clientY }
    const next = { left: point.x, top: point.y, width: 0, height: 0 }
    rectRef.current = next
    setSelectionRect(next)
  }

  const placeTag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!tagMode || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.document-tag-marker')) return
    const pageElement = target.closest<HTMLElement>('.selectable-page')
    if (!pageElement || !event.currentTarget.contains(pageElement)) return
    const bounds = pageElement.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    event.preventDefault()
    event.stopPropagation()
    const size = .024
    const left = Math.max(0, Math.min(1 - size, (event.clientX - bounds.left) / bounds.width - size / 2))
    const top = Math.max(0, Math.min(1 - size, (event.clientY - bounds.top) / bounds.height - size / 2))
    onCreateTag(Number(pageElement.dataset.pageNumber) || 1, { left, top, width: size, height: size })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaSelectionEnabled || !startRef.current) return
    lastPointerRef.current = { x: event.clientX, y: event.clientY }
    updateSelection(event.clientX, event.clientY)
    runAutoScroll()
  }

  const finishSelection = () => {
    stopAutoScroll()
    const stack = stackRef.current
    const rect = rectRef.current
    startRef.current = null
    lastPointerRef.current = null
    rectRef.current = null
    setSelectionRect(null)
    if (!stack || !rect || rect.width < 8 || rect.height < 8) return

    const stackBounds = stack.getBoundingClientRect()
    const images: string[] = []
    const regions: SelectionResult['regions'] = []
    stack.querySelectorAll<HTMLElement>('.selectable-page').forEach((pageElement) => {
      const canvas = pageElement.querySelector('canvas')
      if (!canvas) return
      const bounds = pageElement.getBoundingClientRect()
      const pageBox = {
        left: bounds.left - stackBounds.left,
        top: bounds.top - stackBounds.top,
        right: bounds.right - stackBounds.left,
        bottom: bounds.bottom - stackBounds.top,
      }
      const intersection = {
        left: Math.max(rect.left, pageBox.left),
        top: Math.max(rect.top, pageBox.top),
        right: Math.min(rect.left + rect.width, pageBox.right),
        bottom: Math.min(rect.top + rect.height, pageBox.bottom),
      }
      if (intersection.right <= intersection.left || intersection.bottom <= intersection.top) return

      const cssWidth = bounds.width
      const cssHeight = bounds.height
      const relative = {
        left: (intersection.left - pageBox.left) / cssWidth,
        top: (intersection.top - pageBox.top) / cssHeight,
        width: (intersection.right - intersection.left) / cssWidth,
        height: (intersection.bottom - intersection.top) / cssHeight,
      }
      const sourceWidth = Math.max(1, Math.round(relative.width * canvas.width))
      const sourceHeight = Math.max(1, Math.round(relative.height * canvas.height))
      const outputScale = Math.min(1, 2600 / Math.max(sourceWidth, sourceHeight))
      const crop = document.createElement('canvas')
      crop.width = Math.max(1, Math.round(sourceWidth * outputScale))
      crop.height = Math.max(1, Math.round(sourceHeight * outputScale))
      crop.getContext('2d')?.drawImage(
        canvas,
        relative.left * canvas.width,
        relative.top * canvas.height,
        sourceWidth,
        sourceHeight,
        0,
        0,
        crop.width,
        crop.height,
      )
      const cropContext = crop.getContext('2d')
      if (cropContext) drawAnnotationsIntoCrop(cropContext, annotations.filter((annotation) => annotation.page === Number(pageElement.dataset.pageNumber)), relative, crop.width, crop.height)
      images.push(crop.toDataURL('image/jpeg', 0.94))
      regions.push({ page: Number(pageElement.dataset.pageNumber), region: relative })
    })
    if (images.length) {
      const annotationTexts = regions.map(({ page, region }) => annotations.filter((annotation): annotation is TextAnnotation => annotation.type === 'text' && annotation.page === page && annotation.x <= region.left + region.width && annotation.x + annotation.width >= region.left && annotation.y <= region.top + region.height && annotation.y + (annotation.height ?? .1) >= region.top).map((annotation) => annotation.text.trim()).filter(Boolean).join('\n'))
      onSelect({ image: images[0], images, page: regions[0].page, regions, annotationTexts })
    }
  }

  const showTextActions = () => {
    setTimeout(() => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return setTextAction(null)
      const range = selection.getRangeAt(0)
      const stack = stackRef.current
      if (!stack?.contains(range.commonAncestorContainer)) return setTextAction(null)
      const text = selection.toString().trim()
      if (!text) return setTextAction(null)
      const bounds = range.getBoundingClientRect()
      const regions: SelectionResult['regions'] = []
      Array.from(range.getClientRects()).forEach((rect) => {
        const pageElement = Array.from(stack.querySelectorAll<HTMLElement>('.selectable-page')).find((candidate) => {
          const pageBounds = candidate.getBoundingClientRect()
          return rect.right > pageBounds.left && rect.left < pageBounds.right && rect.bottom > pageBounds.top && rect.top < pageBounds.bottom
        })
        if (!pageElement) return
        const pageBounds = pageElement.getBoundingClientRect()
        const left = Math.max(0, (rect.left - pageBounds.left) / pageBounds.width)
        const top = Math.max(0, (rect.top - pageBounds.top) / pageBounds.height)
        regions.push({ page: Number(pageElement.dataset.pageNumber), region: { left, top, width: Math.min(1 - left, rect.width / pageBounds.width), height: Math.min(1 - top, rect.height / pageBounds.height) } })
      })
      setTranslation('')
      setCopied(false)
      setTextAction({
        text,
        left: Math.max(12, Math.min(window.innerWidth - 250, bounds.left + bounds.width / 2 - 110)),
        top: Math.max(12, Math.min(window.innerHeight - 150, bounds.bottom + 9)),
        regions,
      })
    }, 0)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.text-action-popover')) return
    if (annotationMode || tagMode) return
    if (areaSelectionEnabled) finishSelection()
    else showTextActions()
  }

  const translateSelectedText = async () => {
    if (!textAction) return
    translationControllerRef.current?.abort()
    const controller = new AbortController()
    translationControllerRef.current = controller
    setTranslating(true)
    setTranslation('')
    try {
      const result = await onTextTranslate(textAction.text, controller.signal, (delta) => {
        if (!controller.signal.aborted) setTranslation((current) => current + delta)
      })
      if (!controller.signal.aborted) setTranslation(result)
    } catch (reason) {
      if (!controller.signal.aborted) setTranslation(reason instanceof Error ? reason.message : t('translatingFailed'))
    } finally {
      if (translationControllerRef.current === controller) {
        translationControllerRef.current = null
        setTranslating(false)
      }
    }
  }

  const closeTextAction = () => {
    translationControllerRef.current?.abort()
    translationControllerRef.current = null
    dragRef.current = null
    setTextAction(null)
    setTranslation('')
    setTranslating(false)
    window.getSelection()?.removeAllRanges()
  }

  const textActionPopover = !areaSelectionEnabled && !annotationMode && !tagMode && textAction ? <div
    className="text-action-popover"
    style={{ left: textAction.left, top: textAction.top }}
    onPointerDown={(event) => {
      event.stopPropagation()
      if (event.button !== 0 || (event.target as HTMLElement).closest('button') || !(event.target as HTMLElement).closest('.text-action-buttons')) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: textAction.left, top: textAction.top }
    }}
    onPointerMove={(event) => {
      const dragging = dragRef.current
      if (!dragging || dragging.pointerId !== event.pointerId) return
      event.stopPropagation()
      setTextAction((item) => item && ({ ...item, left: dragging.left + event.clientX - dragging.x, top: dragging.top + event.clientY - dragging.y }))
    }}
    onPointerUp={(event) => {
      event.stopPropagation()
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={(event) => { event.stopPropagation(); dragRef.current = null }}
  >
    <div className="text-action-buttons">
      <button onClick={async () => { await navigator.clipboard.writeText(textAction.text); setCopied(true) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{t('copy')}</button>
      <button onClick={translateSelectedText} disabled={translating}><Languages size={14} />{t('translate')}</button>
      <button onClick={() => { onHighlight({ page: textAction.regions[0]?.page || currentPage, text: textAction.text, color: '#ffe066', regions: textAction.regions }); closeTextAction() }}><Highlighter size={14} />高亮</button>
      <button onClick={() => { onTextAi(textAction.text); closeTextAction() }}><Sparkles size={14} />AI</button>
      <button className="close-text-action" onClick={closeTextAction}><X size={14} /></button>
    </div>
    {(translating || translation) && <div className="inline-translation">
      {translation ? <div className="inline-translation-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{translation}</ReactMarkdown>{translating && <LoaderCircle className="spin inline-stream-indicator" size={13} />}</div> : <><LoaderCircle className="spin" size={15} /> {pack.code === 'en-US' ? 'Translating…' : '正在翻译…'}</>}
    </div>}
  </div> : null

  return (
    <div className={`document-stack ${tagMode ? 'tag-mode' : annotationMode ? 'annotation-mode' : areaSelectionEnabled ? 'continuous-selection' : 'text-selection-mode'}`} ref={stackRef} onPointerDownCapture={placeTag} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => areaSelectionEnabled && !annotationMode && !tagMode && finishSelection()}>
      {source.kind === 'image'
        ? <ImagePage source={source} zoom={zoom} inverted={inverted} tagMode={tagMode} tags={tags} onMoveTag={onMoveTag} annotationMode={annotationMode} annotationTool={annotationTool} annotationColor={annotationColor} annotations={annotations} onAnnotationsChange={onAnnotationsChange} />
        : pdf && Array.from({ length: pdf.numPages }, (_, index) => {
          const pageNumber = index + 1
          return <LazyPdfPage key={pageNumber} pdf={pdf} pageNumber={pageNumber} zoom={zoom} inverted={inverted} textSelectionEnabled={!areaSelectionEnabled && !annotationMode && !tagMode} highlights={highlights} citationFocus={citationFocus} tagMode={tagMode} tags={tags} onMoveTag={onMoveTag} annotationMode={annotationMode} annotationTool={annotationTool} annotationColor={annotationColor} annotations={annotations} onAnnotationsChange={onAnnotationsChange} />
        })}
      {selectionRect && <div className="document-selection-rect" style={selectionRect} />}
      {textActionPopover && createPortal(textActionPopover, document.body)}
    </div>
  )
}
