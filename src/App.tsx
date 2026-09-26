import { Fragment, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  BrainCircuit, ChevronLeft, ChevronRight, Combine, FileText, Languages, FolderOpen,
  Eraser, Lightbulb, LoaderCircle, MessageSquareText, Minus, Palette, PenLine,
  Plus, Puzzle, Send, Sparkles, MousePointer2, TextCursorInput, Type, Undo2, X, Square, Tag,
} from 'lucide-react'
import { readAiStream, recentSelectionHistory } from './services/aiResponse'
import ActivityBar from './components/ActivityBar'
import ProjectExplorer from './components/ProjectExplorer'
import TagPanel from './components/TagPanel'
import WorkspacePanel from './components/WorkspacePanel'
import type { DocumentReference } from './lib/pdf'
import type { AiAction, AiConfig, AnnotationTool, CapturedSelection, ChatMessage, Conversation, DocumentAnnotation, DocumentHighlight, DocumentParagraph, DocumentTag, ImportedSkill, IndexState, MemorySettings, NormalizedRegion, PanelId, PanelLayout, ReaderLocation, RuntimeProject, RuntimeProjectFile, SelectionResult, ShortcutAction, ShortcutSettings, SourceFile, TextAnnotation } from './types'
import { getLanguagePacks, registerLanguagePack, useI18n, type AppLanguage, type LanguagePack } from './i18n'
import { parseLanguageImport, parseSkillImport } from './lib/imports'
import { loadAiConfig, loadDarkTheme, loadMemorySettings, loadPanelLayouts, loadShortcutSettings, loadSkills, loadUserMemory } from './lib/preferences'
import { projectRepository } from './services/projectRepository'
import { retrievalService } from './services/retrievalService'
import { createCitationContext, createReferences, validateReference } from './services/citationService'
import { boundSelectionPreviews, deleteStoredSelectionImages, disposeSelectionImages, resolveSelectionImage, retainSelectionImages } from './services/selectionImageCache'
import { NavigationService } from './services/navigationService'
import { ReaderController } from './services/readerController'
import { createTag, tagsWithoutFile } from './services/tagStore'
import { findShortcutAction, shortcutFromKeyboardEvent, shortcutFromMouseEvent } from './services/shortcuts'
import { stableTextHash } from './services/layoutAnalyzer'

const DocumentViewer = lazy(() => import('./components/DocumentViewer'))
const ConversationMessages = lazy(() => import('./components/ConversationMessages'))
const AiSettingsModal = lazy(() => import('./components/AiSettingsModal'))
const aiActions = [['translate', Languages], ['explain', MessageSquareText], ['insight', Lightbulb], ['summarize', FileText]] as const
const documentIndexVersion = 1
const looseFilesId = 'raid-loose-files'
const maximumVisionImages = 8
const maximumVisionBytes = 12 * 1024 * 1024


const makeId = () => crypto.randomUUID()
const currentTimestamp = () => Date.now()
const generatedTextParagraphs = (content: string, projectId: string, fileId: string): DocumentParagraph[] => {
  const chunks = content.match(/[\s\S]{1,1600}/g) || []
  return chunks.map((text, order) => ({
    id: `${fileId}:p1:${order}:${stableTextHash(text)}`, projectId, fileId, page: 1,
    region: { left: 0, top: order / Math.max(1, chunks.length), width: 1, height: 1 / Math.max(1, chunks.length) },
    text, textHash: stableTextHash(text), order,
  }))
}
const coolProject = (project: RuntimeProject): RuntimeProject => ({
  ...project,
  hydrated: false,
  files: project.files.map((file) => ({ ...file, paragraphs: [], source: undefined, pdf: null, sourceLoaded: false, indexLoaded: false })),
  conversations: project.conversations.map((conversation) => ({ ...conversation, history: [], historyLoaded: false })),
})
const nextPanelZ = (items: Record<PanelId, PanelLayout>) => Math.max(40, ...Object.values(items).map((item) => item.z)) + 1
const normalizePanelZ = (items: Record<PanelId, PanelLayout>) => Object.fromEntries(
  (Object.entries(items) as [PanelId, PanelLayout][])
    .sort(([, first], [, second]) => first.z - second.z)
    .map(([id, layout], index) => [id, { ...layout, z: 41 + index }]),
) as Record<PanelId, PanelLayout>

type HighlightRegion = NonNullable<DocumentHighlight['regions']>[number]
const highlightRegionOverlap = (a: HighlightRegion, b: HighlightRegion) => {
  if (a.page !== b.page) return false
  const left = Math.max(a.region.left, b.region.left)
  const top = Math.max(a.region.top, b.region.top)
  const right = Math.min(a.region.left + a.region.width, b.region.left + b.region.width)
  const bottom = Math.min(a.region.top + a.region.height, b.region.top + b.region.height)
  if (right <= left || bottom <= top) return false
  const intersection = (right - left) * (bottom - top)
  const smaller = Math.min(a.region.width * a.region.height, b.region.width * b.region.height)
  return intersection / Math.max(smaller, .000001) >= .35
}

export default function App({ onLanguageChange }: { onLanguageChange: (language: AppLanguage) => void }) {
  const { t, pack } = useI18n()
  const [projects, setProjects] = useState<RuntimeProject[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [source, setSource] = useState<SourceFile | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [selectedText, setSelectedText] = useState('')
  const [selections, setSelections] = useState<CapturedSelection[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [customPrompt, setCustomPrompt] = useState('')
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoomInput, setZoomInput] = useState('100')
  const [areaSelectionEnabled, setAreaSelectionEnabled] = useState(false)
  const [scope, setScope] = useState<'selection' | 'document' | 'combination'>('selection')
  const [dark, setDark] = useState(loadDarkTheme)
  const [leftDockWidth, setLeftDockWidth] = useState(() => Number(localStorage.getItem('reading-assistant-left-width')) || 300)
  const [rightDockWidth, setRightDockWidth] = useState(() => Number(localStorage.getItem('reading-assistant-right-width')) || 390)
  const [promptHeight, setPromptHeight] = useState(78)
  const [selectionSplitRatio, setSelectionSplitRatio] = useState(() => {
    const saved = Number(localStorage.getItem('reading-assistant-selection-split'))
    return Number.isFinite(saved) && saved >= .15 && saved <= .85 ? saved : .46
  })
  const [busy, setBusy] = useState<'ocr' | 'extract' | 'convert' | ''>('')
  const [fileDragActive, setFileDragActive] = useState(false)
  const [aiTasks, setAiTasks] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState('')
  const indexTasksRef = useRef(new Map<string, Promise<{ paragraphs: DocumentParagraph[]; state: IndexState }>>())
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aiConfig, setAiConfig] = useState<AiConfig>(loadAiConfig)
  const [skills, setSkills] = useState<ImportedSkill[]>(loadSkills)
  const [memorySettings, setMemorySettings] = useState<MemorySettings>(loadMemorySettings)
  const [userMemory, setUserMemory] = useState(loadUserMemory)
  const [deepThinking, setDeepThinking] = useState(false)
  const [highlights, setHighlights] = useState<DocumentHighlight[]>([])
  const [citationFocus, setCitationFocus] = useState<DocumentReference | null>(null)
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([])
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('ink')
  const [annotationColor, setAnnotationColor] = useState('#2f6fed')
  const [annotationStrokeWidth, setAnnotationStrokeWidth] = useState(() => Math.max(.001, Math.min(.012, Number(localStorage.getItem('reading-assistant-ink-width')) || .004)))
  const [tagMode, setTagMode] = useState(false)
  const [recentTagId, setRecentTagId] = useState<string | null>(null)
  const [navigationDepth, setNavigationDepth] = useState(0)
  const [panelLayouts, setPanelLayouts] = useState(() => normalizePanelZ(loadPanelLayouts()))
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(['projects', 'tags', 'chat'])
  const [activitySide, setActivitySide] = useState<'left' | 'right'>(() => localStorage.getItem('reading-assistant-activity-side') === 'right' ? 'right' : 'left')
  const [aiFontSize, setAiFontSize] = useState(() => Math.max(10, Math.min(26, Number(localStorage.getItem('reading-assistant-ai-font-size')) || 12)))
  const [createCombinationSignal, setCreateCombinationSignal] = useState(0)
  const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings>(loadShortcutSettings)
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const projectsRef = useRef(projects)
  const currentPageRef = useRef(currentPage)
  const visionAvailable = aiConfig.provider === 'codex' || (aiConfig.visionEnabled && Boolean(aiConfig.visionModel.trim()))
  const hasVisualSelection = visionAvailable && selections.some((item) => item.images.length > 0)
  const selectionReady = Boolean(selectedText || hasVisualSelection)
  const fileImportQueueRef = useRef<Promise<void>>(Promise.resolve())
  const openFilesRef = useRef<(files: File[], targetProjectId?: string | null) => Promise<void>>(async () => undefined)
  const projectsReadyRef = useRef(false)
  const pendingExternalFilesRef = useRef<File[]>([])
  const fileDragDepthRef = useRef(0)
  const resultsEndRef = useRef<HTMLDivElement>(null)
  const panelScrollRef = useRef<HTMLDivElement>(null)
  const chatAutoFollowRef = useRef(true)
  const chatFollowSuspendedRef = useRef(false)
  const chatWasStreamingRef = useRef(false)
  const chatPinnedScrollTopRef = useRef(0)
  const chatLastScrollTopRef = useRef(0)
  const chatSavedScrollTopRef = useRef(0)
  const chatRestorePendingRef = useRef(false)
  const readerScrollRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const zoomPageLockRef = useRef<{ page: number; until: number } | null>(null)
  const resizeRef = useRef<
    | { kind: 'panel'; panel: 'left' | 'right'; startX: number; startWidth: number }
    | { kind: 'dock-split'; first: PanelId; second: PanelId; startY: number; firstSize: number; secondSize: number; containerHeight: number; bottomLocks: HTMLElement[] }
    | { kind: 'prompt'; startY: number; startHeight: number }
    | null
  >(null)
  const selectionBodyRef = useRef<HTMLDivElement>(null)
  const selectionSplitRef = useRef<HTMLDivElement>(null)
  const selectionImagesRef = useRef<HTMLDivElement>(null)
  const selectionTextRef = useRef<HTMLTextAreaElement>(null)
  const selectionSplitRatioRef = useRef(selectionSplitRatio)
  const selectionSplitDragRef = useRef<{ imagesAtBottom: boolean; textAtBottom: boolean } | null>(null)
  const activeProjectIdRef = useRef<string | null>(null)
  const activeFileIdRef = useRef<string | null>(null)
  const activeConversationIdRef = useRef(activeConversationId)
  const selectionsRef = useRef<CapturedSelection[]>([])
  const pendingPageRestoreRef = useRef<number | null>(null)
  const fitWidthPendingRef = useRef<string | null>(null)
  const userMemoryRef = useRef(userMemory)
  const memorySettingsRef = useRef(memorySettings)
  const memoryUpdateQueueRef = useRef<Promise<void>>(Promise.resolve())
  const navigationRef = useRef(new NavigationService())
  const readerControllerRef = useRef(new ReaderController())
  const currentAiTaskKey = activeProjectId ? `${activeProjectId}:${activeConversationId}` : ''
  const currentAiBusy = aiTasks.has(currentAiTaskKey)
  const slashSkillQuery = customPrompt.match(/^\/([^\s]*)$/)?.[1].toLocaleLowerCase()
  const skillSuggestions = slashSkillQuery === undefined ? [] : skills.filter((skill) => skill.command.toLocaleLowerCase().includes(slashSkillQuery) || skill.name.toLocaleLowerCase().includes(slashSkillQuery)).slice(0, 8)

  const clearCapturedSelections = () => {
    disposeSelectionImages(selectionsRef.current)
    selectionsRef.current = []
    setSelections([])
    setSelectedText('')
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize) return
      if (resize.kind === 'panel') {
        const delta = event.clientX - resize.startX
        if (resize.panel === 'left') setLeftDockWidth(Math.max(220, Math.min(680, resize.startWidth + delta)))
        if (resize.panel === 'right') setRightDockWidth(Math.max(220, Math.min(680, resize.startWidth - delta)))
      }
      if (resize.kind === 'prompt') {
        const nextHeight = Math.max(54, Math.min(window.innerHeight * 0.45, resize.startHeight - (event.clientY - resize.startY)))
        setPromptHeight(nextHeight)
        window.requestAnimationFrame(() => {
          const container = panelScrollRef.current
          if (container) container.scrollTop = container.scrollHeight
        })
      }
      if (resize.kind === 'dock-split') {
        const total = resize.firstSize + resize.secondSize
        const delta = (event.clientY - resize.startY) / Math.max(1, resize.containerHeight) * total
        const firstSize = Math.max(.25, resize.firstSize + delta)
        const secondSize = Math.max(.25, resize.secondSize - delta)
        setPanelLayouts((items) => ({ ...items, [resize.first]: { ...items[resize.first], dockSize: firstSize }, [resize.second]: { ...items[resize.second], dockSize: secondSize } }))
        window.requestAnimationFrame(() => resize.bottomLocks.forEach((element) => { element.scrollTop = element.scrollHeight }))
      }
    }
    const stop = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.classList.remove('resizing-panels')
      document.body.classList.remove('resizing-vertical')
      document.body.classList.remove('resizing-dock-split')
      document.body.classList.remove('resizing-selection-split')
      document.body.classList.remove('resizing-prompt')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  const startResize = (panel: 'left' | 'right', startWidth: number, event: ReactPointerEvent) => {
    event.preventDefault()
    resizeRef.current = { kind: 'panel', panel, startX: event.clientX, startWidth }
    document.body.classList.add('resizing-panels')
  }

  const startPromptResize = (event: ReactPointerEvent) => {
    event.preventDefault()
    resizeRef.current = { kind: 'prompt', startY: event.clientY, startHeight: promptHeight }
    document.body.classList.add('resizing-vertical')
    document.body.classList.add('resizing-prompt')
    const container = panelScrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }

  const startDockSplitResize = (first: PanelId, second: PanelId, event: ReactPointerEvent) => {
    const container = event.currentTarget.parentElement
    if (!container) return
    event.preventDefault()
    const panels = [event.currentTarget.previousElementSibling, event.currentTarget.nextElementSibling]
    const bottomLocks = panels.flatMap((panel) => panel ? [panel, ...panel.querySelectorAll<HTMLElement>('*')] : []).filter((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const scrollable = element instanceof HTMLTextAreaElement || /auto|scroll/.test(window.getComputedStyle(element).overflowY)
      return scrollable && element.scrollHeight - element.scrollTop - element.clientHeight <= 16
    })
    resizeRef.current = { kind: 'dock-split', first, second, startY: event.clientY, firstSize: panelLayouts[first].dockSize, secondSize: panelLayouts[second].dockSize, containerHeight: container.clientHeight, bottomLocks }
    document.body.classList.add('resizing-vertical')
    document.body.classList.add('resizing-dock-split')
  }

  const selectionPaneAtBottom = (element: HTMLElement | null) => !element || element.scrollHeight - element.scrollTop - element.clientHeight <= 16
  const startSelectionSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    selectionSplitDragRef.current = { imagesAtBottom: selectionPaneAtBottom(selectionImagesRef.current), textAtBottom: selectionPaneAtBottom(selectionTextRef.current) }
    document.body.classList.add('resizing-selection-split')
  }
  const moveSelectionSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionSplitDragRef.current || !selectionSplitRef.current) return
    const bounds = selectionSplitRef.current.getBoundingClientRect()
    const available = Math.max(1, bounds.height - 7)
    const minimum = Math.min(86, available * .4)
    const imageHeight = Math.max(minimum, Math.min(available - minimum, event.clientY - bounds.top - 3.5))
    const next = imageHeight / available
    selectionSplitRatioRef.current = next
    setSelectionSplitRatio(next)
    window.requestAnimationFrame(() => {
      const dragging = selectionSplitDragRef.current
      if (!dragging) return
      if (dragging.imagesAtBottom && selectionImagesRef.current) selectionImagesRef.current.scrollTop = selectionImagesRef.current.scrollHeight
      if (dragging.textAtBottom && selectionTextRef.current) selectionTextRef.current.scrollTop = selectionTextRef.current.scrollHeight
    })
  }
  const stopSelectionSplit = () => {
    if (!selectionSplitDragRef.current) return
    selectionSplitDragRef.current = null
    document.body.classList.remove('resizing-selection-split')
    localStorage.setItem('reading-assistant-selection-split', String(selectionSplitRatioRef.current))
  }

  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])
  useEffect(() => { projectsRef.current = projects }, [projects])
  useEffect(() => { currentPageRef.current = currentPage }, [currentPage])
  useEffect(() => {
    if (!recentTagId) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest(`[data-tag-id="${CSS.escape(recentTagId)}"]`)) setRecentTagId(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [recentTagId])
  useEffect(() => { activeFileIdRef.current = activeFileId }, [activeFileId])
  useEffect(() => { activeConversationIdRef.current = activeConversationId }, [activeConversationId])
  useEffect(() => { selectionsRef.current = selections }, [selections])
  useEffect(() => { const timer = window.setTimeout(() => setPageInput(String(currentPage)), 0); return () => window.clearTimeout(timer) }, [currentPage])
  useEffect(() => { const timer = window.setTimeout(() => setZoomInput(String(Math.round(zoom * 100))), 0); return () => window.clearTimeout(timer) }, [zoom])

  useEffect(() => {
    const persistentLayouts = Object.fromEntries(Object.entries(panelLayouts).map(([id, layout]) => [id, { ...layout, dockSize: 1 }]))
    localStorage.setItem('reading-assistant-panel-layouts', JSON.stringify(persistentLayouts))
  }, [panelLayouts])
  useEffect(() => { localStorage.setItem('reading-assistant-left-width', String(leftDockWidth)) }, [leftDockWidth])
  useEffect(() => { localStorage.setItem('reading-assistant-right-width', String(rightDockWidth)) }, [rightDockWidth])
  useEffect(() => { localStorage.setItem('reading-assistant-ai-font-size', String(aiFontSize)) }, [aiFontSize])
  useEffect(() => { localStorage.setItem('reading-assistant-activity-side', activitySide) }, [activitySide])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('reading-assistant-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    memorySettingsRef.current = memorySettings
    localStorage.setItem('reading-assistant-memory-settings', JSON.stringify(memorySettings))
  }, [memorySettings])

  useEffect(() => {
    userMemoryRef.current = userMemory
    localStorage.setItem('reading-assistant-user-memory', userMemory)
  }, [userMemory])

  const openSettings = () => {
    setSettingsOpen(true)
  }

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((data) => setConfigured(data.configured)).catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    let active = true
    void projectRepository.list().then(async (records) => {
      const stored = await Promise.all(records.map((record) => projectRepository.get(record.id, true)))
      if (!active) return
      const now = Date.now()
      const next: RuntimeProject[] = stored.flatMap((project) => project ? [coolProject({ ...project, isLoose: project.id === looseFilesId || project.isLoose, files: project.files.map((file) => ({ ...file, sourceLoaded: false })), hydrated: true })] : [])
      if (!next.some((project) => project.id === looseFilesId)) next.unshift({ id: looseFilesId, name: '未分组文件', isLoose: true, files: [], conversations: [], activeConversationId: '', activeFileId: null, tags: [], createdAt: now, updatedAt: now, hydrated: true })
      let ordered = next
      try {
        const order = JSON.parse(localStorage.getItem('reading-assistant-combination-order') || '[]') as string[]
        const positions = new Map(order.map((id, index) => [id, index]))
        ordered = [...next].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER))
      } catch { /* Keep repository order. */ }
      projectsRef.current = ordered
      setProjects(ordered)
      projectsReadyRef.current = true
      const pendingFiles = pendingExternalFilesRef.current.splice(0)
      for (const file of pendingFiles) {
        const task = fileImportQueueRef.current.then(() => openFilesRef.current([file], null))
        fileImportQueueRef.current = task.catch(() => undefined)
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useLayoutEffect(() => {
    const container = panelScrollRef.current
    const wasStreaming = chatWasStreamingRef.current
    chatWasStreamingRef.current = currentAiBusy
    if (!container) return
    if (chatRestorePendingRef.current) {
      container.scrollTop = Math.min(chatSavedScrollTopRef.current, Math.max(0, container.scrollHeight - container.clientHeight))
      chatLastScrollTopRef.current = container.scrollTop
      chatRestorePendingRef.current = false
      return
    }
    if (chatFollowSuspendedRef.current && (currentAiBusy || wasStreaming)) {
      container.scrollTop = Math.min(chatPinnedScrollTopRef.current, Math.max(0, container.scrollHeight - container.clientHeight))
      chatLastScrollTopRef.current = container.scrollTop
      return
    }
    if (currentAiBusy && !chatAutoFollowRef.current) return
    if (!currentAiBusy && wasStreaming && !chatAutoFollowRef.current) return
    container.scrollTop = container.scrollHeight
    chatLastScrollTopRef.current = container.scrollTop
  }, [history, busy, currentAiBusy])

  useEffect(() => {
    if (!panelLayouts.chat.open) return
    window.requestAnimationFrame(() => {
      const container = panelScrollRef.current
      if (container && chatRestorePendingRef.current) {
        container.scrollTop = Math.min(chatSavedScrollTopRef.current, Math.max(0, container.scrollHeight - container.clientHeight))
        chatLastScrollTopRef.current = container.scrollTop
        chatRestorePendingRef.current = false
      }
    })
  }, [panelLayouts.chat.open])

  const stopFollowingOnUpwardWheel = (container: HTMLDivElement, deltaY: number, deltaMode: number) => {
    if (deltaY >= 0) return
    chatFollowSuspendedRef.current = true
    chatAutoFollowRef.current = false
    const multiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? container.clientHeight : 1
    chatPinnedScrollTopRef.current = Math.max(0, container.scrollTop + deltaY * multiplier)
  }

  const trackChatPosition = (container: HTMLDivElement) => {
    const top = container.scrollTop
    chatSavedScrollTopRef.current = top
    const movedUp = top < chatLastScrollTopRef.current - .5
    chatLastScrollTopRef.current = top
    if (chatWasStreamingRef.current && movedUp) {
      chatFollowSuspendedRef.current = true
      chatAutoFollowRef.current = false
    }
    if (chatFollowSuspendedRef.current && chatWasStreamingRef.current) {
      chatPinnedScrollTopRef.current = top
      return
    }
    chatAutoFollowRef.current = container.scrollHeight - top - container.clientHeight <= 24
  }

  const snapshotCurrent = useCallback((): RuntimeProject | null => {
    if (!activeProjectId) return null
    const project = projects.find((item) => item.id === activeProjectId)
    // Lightweight sidebar records intentionally omit indexes and histories.
    // Never promote or persist one as a complete project snapshot.
    if (!project?.hydrated) return null
    const syncedConversations = conversations.map((item) => item.id === activeConversationId ? { ...item, history } : item)
    return {
      ...project,
      files: project.files.map((file) => file.id === activeFileId ? {
        ...file, source: undefined, pdf: null, sourceLoaded: false,
        readingState: { page: currentPage, zoom, scrollTop: readerScrollRef.current?.scrollTop || 0 },
        highlights, annotations, updatedAt: Date.now(),
      } : file),
      conversations: syncedConversations, activeConversationId, activeFileId,
      updatedAt: Date.now(),
    }
  }, [activeProjectId, projects, conversations, activeConversationId, history, activeFileId, currentPage, zoom, highlights, annotations])

  useEffect(() => {
    if (!activeProjectId) return
    const timer = window.setTimeout(() => {
      const snapshot = snapshotCurrent()
      if (snapshot) void projectRepository.save(snapshot).catch(() => undefined)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [activeProjectId, snapshotCurrent])

  const loadProjectFile = (project: RuntimeProject, file: RuntimeProjectFile | null) => {
    if (fitWidthPendingRef.current && fitWidthPendingRef.current !== file?.id) fitWidthPendingRef.current = null
    if (source?.url && source.url !== file?.source?.url && source.url.startsWith('blob:')) URL.revokeObjectURL(source.url)
    setActiveProjectId(project.id); activeProjectIdRef.current = project.id
    setActiveFileId(file?.id || null); activeFileIdRef.current = file?.id || null
    readerControllerRef.current.activate(project.id, file?.id || null)
    setSource(file?.source || null); setPdf(file?.pdf || null)
    clearCapturedSelections()
    const normalizedConversations = project.conversations.map((item) => {
      if (item.ownerType === 'file') return { ...item, contextScope: item.contextScope || 'file' as const }
      return file ? { ...item, ownerType: 'file' as const, fileId: file.id, contextScope: 'combination' as const } : item
    })
    const preferred = normalizedConversations.find((item) => item.id === project.activeConversationId && item.fileId === file?.id)
      || normalizedConversations.find((item) => item.ownerType === 'file' && item.fileId === file?.id)
    setConversations(normalizedConversations); setActiveConversationId(preferred?.id || '')
    activeConversationIdRef.current = preferred?.id || ''
    setHistory(preferred?.history || [])
    setCustomPrompt(''); setZoom(file?.readingState.zoom || 1); setCurrentPage(file?.readingState.page || 1)
    setHighlights(file?.highlights || []); setAnnotations(file?.annotations || [])
    setAnnotationMode(false); setTagMode(false); setCitationFocus(null); setError('')
    pendingPageRestoreRef.current = file?.readingState.page || 1
  }

  const hydrateProject = async (project: RuntimeProject, indexFileId: string | null = null) => {
    const hasRequestedIndexes = indexFileId
      ? project.files.find((file) => file.id === indexFileId)?.indexLoaded !== false
      : project.files.every((file) => file.indexLoaded !== false)
    if (project.hydrated && hasRequestedIndexes) return project
    const stored = await projectRepository.get(project.id, false, indexFileId)
    if (!stored) throw new Error(pack.code === 'en-US' ? 'The combination is missing.' : '组合数据缺失。')
    const withoutLegacyNotes = { ...stored } as typeof stored & { projectNotes?: string; projectNoteAssets?: Record<string, string> }
    delete withoutLegacyNotes.projectNotes
    delete withoutLegacyNotes.projectNoteAssets
    const currentFiles = new Map(project.files.map((file) => [file.id, file]))
    const files = stored.files.map((file) => {
      const current = currentFiles.get(file.id)
      if (!current || !project.hydrated) return { ...file, sourceLoaded: false } as RuntimeProjectFile
      const loaded = (file as RuntimeProjectFile).indexLoaded !== false
      if (indexFileId && file.id !== indexFileId) return { ...file, ...current, paragraphs: [], source: undefined, pdf: null, sourceLoaded: false, indexLoaded: false }
      return { ...file, ...current, paragraphs: loaded ? file.paragraphs : current.paragraphs, indexState: loaded ? file.indexState : current.indexState, indexLoaded: loaded || current.indexLoaded !== false }
    })
    return { ...withoutLegacyNotes, ...(project.hydrated ? project : {}), isLoose: stored.id === looseFilesId || stored.isLoose, files, hydrated: true } as RuntimeProject
  }

  const hydrateProjectFile = async (project: RuntimeProject, fileId: string) => {
    const file = project.files.find((item) => item.id === fileId)
    if (!file) throw new Error(pack.code === 'en-US' ? 'The file no longer exists.' : '文件已被删除或不存在。')
    if (file.sourceLoaded && file.source) return { project, file }
    const blob = await projectRepository.getSource(project.id, file.id, file.type)
    if (!blob) throw new Error(pack.code === 'en-US' ? 'The source file is missing.' : '源文件缺失。')
    const sourceFile = new File([blob], file.name, { type: file.type, lastModified: file.lastModified })
    const hydratedFile: RuntimeProjectFile = { ...file, source: { name: file.name, kind: file.kind, url: URL.createObjectURL(sourceFile), file: sourceFile }, pdf: null, sourceLoaded: true }
    const hydratedProject = { ...project, files: project.files.map((item) => item.id === file.id ? hydratedFile : item), hydrated: true }
    return { project: hydratedProject, file: hydratedFile }
  }

  const openProjectFile = async (projectId: string, fileId: string): Promise<boolean> => {
    const snapshot = snapshotCurrent()
    let project = snapshot?.id === projectId ? snapshot : projects.find((item) => item.id === projectId)
    if (!project) return false
    try {
      if (snapshot?.id === projectId) await projectRepository.save(snapshot)
      project = await hydrateProject(project, fileId)
      const hydrated = await hydrateProjectFile(project, fileId)
      project = { ...hydrated.project, activeFileId: fileId }
      setProjects((items) => items.map((item) => item.id === projectId ? project! : snapshot && item.id === snapshot.id ? coolProject(snapshot) : item))
      if (snapshot && snapshot.id !== projectId) void projectRepository.save(snapshot)
      loadProjectFile(project, hydrated.file)
      return true
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('processFailed')); return false }
  }

  const openProject = async (id: string) => {
    if (id === activeProjectId && activeFileId) return
    const candidate = projects.find((item) => item.id === id)
    if (!candidate) return
    try {
      const fileId = candidate.activeFileId || candidate.files[0]?.id || null
      const project = await hydrateProject(candidate, fileId)
      if (fileId) await openProjectFile(id, fileId)
      else {
        const snapshot = snapshotCurrent()
        if (snapshot) void projectRepository.save(snapshot)
        setProjects((items) => items.map((item) => item.id === id ? project : snapshot && item.id === snapshot.id ? coolProject(snapshot) : item))
        loadProjectFile(project, null)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('processFailed')) }
  }

  const createEmptyProject = (requestedName: string) => {
    const name = requestedName.trim()
    if (!name) return
    const now = Date.now()
    const project: RuntimeProject = { id: makeId(), name, files: [], conversations: [], activeConversationId: '', activeFileId: null, tags: [], createdAt: now, updatedAt: now, hydrated: true }
    const snapshot = snapshotCurrent()
    setProjects((items) => [...items.map((item) => snapshot && item.id === snapshot.id ? snapshot : item), project])
    void projectRepository.save(project)
    return project.id
  }

  const openFiles = async (incomingFiles: File[], targetProjectId: string | null = null) => {
    if (!incomingFiles.length) return
    const destinationId = targetProjectId || looseFilesId
    const snapshot = snapshotCurrent()
    const residentProject = projectsRef.current.find((item) => item.id === destinationId)
    const residentHasNewerFiles = Boolean(snapshot?.id === destinationId && residentProject?.files.some((file) => !snapshot.files.some((item) => item.id === file.id)))
    let project = snapshot?.id === destinationId && !residentHasNewerFiles ? snapshot : residentProject
    if (project && !project.hydrated) project = await hydrateProject(project, project.activeFileId || project.files[0]?.id || null)
    if (!project) {
      const now = Date.now()
      project = { id: looseFilesId, name: '未分组文件', isLoose: true, files: [], conversations: [], activeConversationId: '', activeFileId: null, tags: [], createdAt: now, updatedAt: now, hydrated: true }
    }

    let fileToOpen: RuntimeProjectFile | null = null
    let newFileToOpenId: string | null = null
    for (const file of incomingFiles) {
      let readableFile = file
      const lowerName = file.name.toLocaleLowerCase()
      const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(lowerName)
      if (!isPdf && !isImage) {
        if (!window.readingAssistant) { setError(t('desktopConversionOnly')); continue }
        setBusy('convert'); setProgress(t('convertingDocument')); setError('')
        try {
          const result = await window.readingAssistant.convertDocument({ name: file.name, type: file.type, lastModified: file.lastModified, data: await file.arrayBuffer() })
          if (result.error || !result.data) {
            const message = result.error === 'OFFICE_CONVERTER_UNAVAILABLE' ? t('officeConverterUnavailable')
              : result.error === 'FILE_TOO_LARGE' ? t('fileTooLarge')
                : result.error === 'EMPTY_FILE' ? t('emptyFile') : t('conversionFailed')
            throw new Error(message)
          }
          const convertedBuffer = new ArrayBuffer(result.data.byteLength)
          new Uint8Array(convertedBuffer).set(result.data)
          readableFile = new File([convertedBuffer], file.name, { type: result.type || 'application/pdf', lastModified: file.lastModified })
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : t('conversionFailed'))
          continue
        } finally {
          setBusy(''); setProgress('')
        }
      }

      const duplicate = project.files.find((item) => item.name === readableFile.name && item.size === readableFile.size && item.lastModified === readableFile.lastModified)
      if (duplicate) { fileToOpen = duplicate; newFileToOpenId = null; continue }
      const now = Date.now()
      const fileId = makeId()
      const fileKind = readableFile.type === 'application/pdf' || readableFile.name.toLocaleLowerCase().endsWith('.pdf') ? 'pdf' : 'image'
      const projectFile: RuntimeProjectFile = {
        id: fileId, projectId: project.id, name: readableFile.name, kind: fileKind, type: readableFile.type || (fileKind === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
        size: readableFile.size, lastModified: readableFile.lastModified, createdAt: now, updatedAt: now,
        readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], paragraphs: [],
        indexState: { status: 'pending', version: documentIndexVersion }, indexLoaded: true,
        source: undefined, pdf: null, sourceLoaded: false,
      }
      project = { ...project, files: [...project.files, projectFile], activeConversationId: '', activeFileId: fileId, updatedAt: now, hydrated: true }
      await projectRepository.saveSource(project.id, fileId, readableFile)
      fileToOpen = projectFile
      newFileToOpenId = fileId
    }
    if (!fileToOpen) return

    await projectRepository.save(project)
    if (!fileToOpen.sourceLoaded || !fileToOpen.source) {
      const hydrated = await hydrateProjectFile(project, fileToOpen.id)
      project = hydrated.project
      fileToOpen = hydrated.file
    }
    const openFileId = fileToOpen.id
    fitWidthPendingRef.current = newFileToOpenId
    for (const item of project.files) {
      if (item.id !== openFileId && item.source?.url.startsWith('blob:')) URL.revokeObjectURL(item.source.url)
    }
    project = {
      ...project,
      activeFileId: openFileId,
      files: project.files.map((item) => item.id === openFileId ? item : { ...item, source: undefined, pdf: null, sourceLoaded: false }),
    }
    if (snapshot && snapshot.id !== project.id) void projectRepository.save(snapshot)
    const nextProjects = [...projectsRef.current.filter((item) => item.id !== project.id).map((item) => snapshot && item.id === snapshot.id ? coolProject(snapshot) : item), project]
    projectsRef.current = nextProjects
    setProjects(nextProjects)
    loadProjectFile(project, project.files.find((item) => item.id === openFileId) || fileToOpen)
  }

  useEffect(() => { openFilesRef.current = openFiles })
  const openFile = (file: File, targetProjectId: string | null = null) => {
    const task = fileImportQueueRef.current.then(() => openFilesRef.current([file], targetProjectId))
    fileImportQueueRef.current = task.catch(() => undefined)
    return task
  }
  const openFileBatch = (files: File[], targetProjectId: string | null = null) => {
    const task = fileImportQueueRef.current.then(() => openFilesRef.current(files, targetProjectId))
    fileImportQueueRef.current = task.catch(() => undefined)
    return task
  }

  // File-open IPC is intentionally registered once; openFile uses stable browser APIs and current-state setters.
  useEffect(() => {
    const bridge = window.readingAssistant
    if (!bridge?.takePendingOpenFiles || !bridge.onOpenFile) return
    const accept = (payload: { name: string; type: string; lastModified: number; data: Uint8Array }) => {
      const bytes = Uint8Array.from(payload.data)
      const file = new File([bytes], payload.name, { type: payload.type, lastModified: payload.lastModified })
      if (!projectsReadyRef.current) pendingExternalFilesRef.current.push(file)
      else void openFile(file)
    }
    void bridge.takePendingOpenFiles().then((items) => items.forEach(accept))
    return bridge.onOpenFile(accept)
  }, [])

  const syncCurrentConversation = () => conversations.map((item) => item.id === activeConversationId ? { ...item, history } : item)

  const openConversation = (id: string) => {
    if (id === activeConversationId) return
    const synced = syncCurrentConversation()
    const target = synced.find((item) => item.id === id)
    if (!target) return
    setConversations(synced)
    setActiveConversationId(id)
    activeConversationIdRef.current = id
    setHistory(target.history)
    if (target.contextScope === 'combination' || target.ownerType === 'combination') setScope('combination')
    else {
      const lastMode = [...target.history].reverse().find((message) => message.role === 'user')?.contextMode
      setScope(lastMode === 'document' ? 'document' : 'selection')
    }
    setError('')
  }

  const createConversation = () => {
    if (!activeFileId) return
    setConversations(syncCurrentConversation())
    setActiveConversationId('')
    activeConversationIdRef.current = ''
    setHistory([])
    setCustomPrompt('')
    setError('')
  }

  const forgetConversationAssets = async (conversation: Conversation) => {
    if (conversation.codexThreadId) {
      const response = await fetch('/api/ai/thread/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conversation.codexThreadId }),
      })
      if (!response.ok) throw new Error('无法删除 Codex 对话记录，请重试')
    }
    const imageIds = conversation.history.flatMap((message) => (message.attachments || []).map((image) => image.id))
    if (imageIds.length) await deleteStoredSelectionImages(imageIds)
  }

  const deleteConversation = async (id: string) => {
    const removed = syncCurrentConversation().find((item) => item.id === id)
    abortControllersRef.current.get(`${activeProjectId}:${id}`)?.abort()
    try { if (removed) await forgetConversationAssets(removed) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法删除选区图片'); return }
    const synced = syncCurrentConversation().filter((item) => item.id !== id)
    if (id !== activeConversationId) { setConversations(synced); return }
    const next = synced.at(-1)
    setConversations(synced)
    setActiveConversationId(next?.id || '')
    activeConversationIdRef.current = next?.id || ''
    setHistory(next?.history || [])
    setCitationFocus(null)
    setError('')
  }

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData
      if (!clipboard) return
      const pastedFiles = Array.from(clipboard.files)
      const files = pastedFiles.length ? pastedFiles : Array.from(clipboard.items).flatMap((item) => item.kind === 'file' ? [item.getAsFile()].filter((file): file is File => Boolean(file)) : [])
      if (!files.length) return
      event.preventDefault()
      const imported = files.map((file, index) => {
        const isClipboardImage = file.type.startsWith('image/')
        const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
        return isClipboardImage && (!file.name || file.name === 'image.png')
          ? new File([file], `${t('pastedImage')}-${new Date().toLocaleTimeString().replaceAll(':', '-')}${files.length > 1 ? `-${index + 1}` : ''}.${extension}`, { type: file.type, lastModified: file.lastModified })
          : file
      })
      void openFileBatch(imported)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  })

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      fileDragDepthRef.current += 1
      setFileDragActive(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
      if (!fileDragDepthRef.current) setFileDragActive(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      fileDragDepthRef.current = 0
      setFileDragActive(false)
      const files = Array.from(event.dataTransfer?.files || [])
      if (files.length) void openFileBatch(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  })

  const onPdfReady = useCallback((document: PDFDocumentProxy) => {
    setPdf(document)
    const projectId = activeProjectIdRef.current
    const fileId = activeFileIdRef.current
    if (fileId && fitWidthPendingRef.current === fileId) {
      fitWidthPendingRef.current = null
      void document.getPage(1).then((page) => {
        try {
          if (activeFileIdRef.current !== fileId) return
          const container = readerScrollRef.current
          if (!container) return
          const style = getComputedStyle(container)
          const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12
          const width = page.getViewport({ scale: .82 }).width
          if (availableWidth > 0 && width > 0) setZoom(Math.max(.25, Math.min(5, availableWidth / width)))
        } finally { page.cleanup() }
      }).catch(() => undefined)
    }
    if (projectId && fileId) setProjects((items) => items.map((project) => project.id === projectId ? { ...project, files: project.files.map((file) => file.id === fileId ? { ...file, pdf: document } : file) } : project))
  }, [])

  useEffect(() => {
    if (source?.kind !== 'image' || !activeFileId || fitWidthPendingRef.current !== activeFileId) return
    const fileId = activeFileId
    const image = new Image()
    image.src = source.url
    void image.decode().then(() => {
      if (activeFileIdRef.current !== fileId || fitWidthPendingRef.current !== fileId) return
      const container = readerScrollRef.current
      if (!container) return
      const style = getComputedStyle(container)
      const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12
      const width = Math.min(1100, image.naturalWidth)
      if (availableWidth > 0 && width > 0) setZoom(Math.max(.25, Math.min(5, availableWidth / width)))
      fitWidthPendingRef.current = null
    }).catch(() => undefined).finally(() => { image.src = '' })
    return () => { image.src = '' }
  }, [source, activeFileId])

  useEffect(() => {
    if (source?.kind !== 'pdf' || !pdf || pendingPageRestoreRef.current === null) return
    const pageNumber = pendingPageRestoreRef.current
    const frame = requestAnimationFrame(() => {
      const container = readerScrollRef.current
      const target = container?.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`)
      if (!container || !target) return
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 20
      container.scrollTo({ top })
      setCurrentPage(pageNumber)
      pendingPageRestoreRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [pdf, source?.kind, source?.url])

  const turnPage = (direction: 1 | -1) => {
    if (!pdf) return false
    const nextPage = Math.max(1, Math.min(pdf.numPages, currentPage + direction))
    if (nextPage === currentPage) return false
    const container = readerScrollRef.current
    const target = container?.querySelector<HTMLElement>(`[data-page-number="${nextPage}"]`)
    if (container && target) {
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 20
      container.scrollTo({ top, behavior: 'smooth' })
    }
    setCurrentPage(nextPage)
    return true
  }

  const commitPageInput = () => {
    const value = Number(pageInput)
    if (!Number.isFinite(value) || !pageInput.trim()) return setPageInput(String(currentPage))
    const page = Math.max(1, Math.min(pdf?.numPages || 1, Math.round(value)))
    setPageInput(String(page))
    jumpToPage(page)
  }

  const commitZoomInput = () => {
    const value = Number(zoomInput)
    if (!Number.isFinite(value) || !zoomInput.trim()) return setZoomInput(String(Math.round(zoom * 100)))
    const percentage = Math.max(25, Math.min(500, Math.round(value)))
    setZoomInput(String(percentage))
    setZoom(percentage / 100)
  }

  const onReaderScroll = () => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const container = readerScrollRef.current
      if (!container) return
      const zoomLock = zoomPageLockRef.current
      if (zoomLock && Date.now() < zoomLock.until) {
        if (currentPage !== zoomLock.page) setCurrentPage(zoomLock.page)
        return
      }
      zoomPageLockRef.current = null
      const targetY = container.getBoundingClientRect().top + container.clientHeight * 0.38
      let closestPage = currentPage
      let closestDistance = Number.POSITIVE_INFINITY
      container.querySelectorAll<HTMLElement>('[data-page-number]').forEach((page) => {
        const bounds = page.getBoundingClientRect()
        const distance = targetY < bounds.top ? bounds.top - targetY : targetY > bounds.bottom ? targetY - bounds.bottom : 0
        if (distance < closestDistance) {
          closestDistance = distance
          closestPage = Number(page.dataset.pageNumber)
        }
      })
      if (closestPage !== currentPage) setCurrentPage(closestPage)
    })
  }

  const onReaderWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (source?.kind !== 'pdf' || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    const container = readerScrollRef.current
    const bounds = container?.getBoundingClientRect()
    const previousZoom = zoom
    const nextZoom = Math.max(.25, Math.min(5, previousZoom * Math.exp(-event.deltaY * .0025)))
    if (!container || !bounds || Math.abs(nextZoom - previousZoom) < .001) return
    const lockedPage = currentPage
    const page = container.querySelector<HTMLElement>(`[data-page-number="${lockedPage}"]`)
    const pageBounds = page?.getBoundingClientRect()
    const clientX = event.clientX
    const clientY = event.clientY
    const clampUnit = (value: number) => Math.max(0, Math.min(1, value))
    const relativeX = pageBounds?.width ? clampUnit((clientX - pageBounds.left) / pageBounds.width) : .5
    const relativeY = pageBounds?.height ? clampUnit((clientY - pageBounds.top) / pageBounds.height) : .38
    zoomPageLockRef.current = { page: lockedPage, until: Date.now() + 260 }
    setZoom(nextZoom)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const resizedPage = container.querySelector<HTMLElement>(`[data-page-number="${lockedPage}"]`)
        const resizedBounds = resizedPage?.getBoundingClientRect()
        if (!resizedBounds) return
        container.scrollLeft += resizedBounds.left + resizedBounds.width * relativeX - clientX
        container.scrollTop += resizedBounds.top + resizedBounds.height * relativeY - clientY
        setCurrentPage(lockedPage)
      })
    })
  }

  const onSelect = (result: SelectionResult) => {
    const selectionId = makeId()
    const captured: CapturedSelection = { ...result, id: selectionId, text: '', textParts: result.images.map(() => ''), loading: false }
    setSelections((items) => { const next = boundSelectionPreviews([...items, captured]); selectionsRef.current = next; return next })
    setScope('selection')
    setError('')
  }

  const removeSelectionImage = (selectionId: string, imageIndex: number) => {
    const target = selectionsRef.current.find((item) => item.id === selectionId)
    if (!target) return
    const removedText = target.textParts[imageIndex] || ''
    disposeSelectionImages([{ images: target.images.slice(imageIndex, imageIndex + 1) }])
    const images = target.images.filter((_, index) => index !== imageIndex)
    const regions = target.regions.filter((_, index) => index !== imageIndex)
    const textParts = target.textParts.filter((_, index) => index !== imageIndex)
    const text = textParts.filter(Boolean).join('\n\n')
    const nextSelection = { ...target, image: images[0]?.preview || '', images, regions, textParts, text }
    const nextSelections = images.length || text ? selectionsRef.current.map((item) => item.id === selectionId ? nextSelection : item) : selectionsRef.current.filter((item) => item.id !== selectionId)
    selectionsRef.current = nextSelections
    setSelections(nextSelections)
    if (removedText) setSelectedText((previous) => {
      const index = previous.indexOf(removedText)
      if (index < 0) return previous
      return `${previous.slice(0, index)}${previous.slice(index + removedText.length)}`.replace(/\n{3,}/g, '\n\n').trim()
    })
  }

  const removeCapturedSelection = (selectionId: string) => {
    const target = selectionsRef.current.find((item) => item.id === selectionId)
    if (!target) return
    disposeSelectionImages([target])
    const nextSelections = selectionsRef.current.filter((item) => item.id !== selectionId)
    selectionsRef.current = nextSelections
    setSelections(nextSelections)
    if (target.text) setSelectedText((previous) => {
      const index = previous.indexOf(target.text)
      if (index < 0) return previous
      return `${previous.slice(0, index)}${previous.slice(index + target.text.length)}`.replace(/\n{3,}/g, '\n\n').trim()
    })
  }

  useEffect(() => {
    if (!source || !activeProjectId || !activeFileId || (source.kind === 'pdf' && !pdf)) return
    const project = projectsRef.current.find((item) => item.id === activeProjectId)
    const file = project?.files.find((item) => item.id === activeFileId)
    if (!project || !file || file.indexState.status === 'indexing' || file.indexState.status === 'ready') return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted) return
      const indexing = { ...file, indexState: { status: 'indexing' as const, version: documentIndexVersion } }
      setProjects((items) => items.map((item) => item.id === project.id ? { ...item, files: item.files.map((entry) => entry.id === file.id ? indexing : entry) } : item))
      const task = source.kind === 'pdf' && pdf
        ? import('./services/documentIndexer').then(({ documentIndexer }) => documentIndexer.indexPdf(pdf, project.id, file.id, undefined, { signal: controller.signal, priorityPage: currentPageRef.current }))
        : Promise.resolve({
            paragraphs: [],
            state: { status: 'ready' as const, version: documentIndexVersion, indexedAt: Date.now() },
          })
      const taskKey = `${project.id}:${file.id}`
      indexTasksRef.current.set(taskKey, task)
      void task.then(({ paragraphs, state }) => {
        if (controller.signal.aborted) return
        setProjects((items) => items.map((item) => item.id === project.id ? { ...item, updatedAt: Date.now(), files: item.files.map((entry) => entry.id === file.id ? { ...entry, paragraphs, indexState: state, indexLoaded: true, updatedAt: Date.now() } : entry) } : item))
      }).catch((reason) => {
        const cancelled = reason instanceof DOMException && reason.name === 'AbortError'
        setProjects((items) => items.map((item) => item.id === project.id ? { ...item, files: item.files.map((entry) => entry.id === file.id ? { ...entry, indexState: cancelled ? { status: 'pending', version: documentIndexVersion } : { status: 'error', version: documentIndexVersion, error: reason instanceof Error ? reason.message : String(reason) } } : entry) } : item))
      }).finally(() => { if (indexTasksRef.current.get(taskKey) === task) indexTasksRef.current.delete(taskKey) })
    }, source.kind === 'pdf' && (pdf?.numPages || 0) > 100 ? 1200 : 450)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [source, pdf, activeProjectId, activeFileId])

  const buildProjectContext = async (workspaceId: string, query: string, fileId?: string): Promise<{ context: string; references: ReturnType<typeof createReferences>; documentSource?: { projectId: string; fileIds: string[] } }> => {
    const snapshot = snapshotCurrent()
    let project = snapshot?.id === workspaceId ? snapshot : projectsRef.current.find((item) => item.id === workspaceId)
    if (!project) return { context: '', references: [] }
    if (!fileId) {
      const pendingFiles = project.files.filter((file) => file.kind === 'pdf' && (file.indexState.status !== 'ready' || file.indexState.version !== documentIndexVersion))
      try { for (let index = 0; index < pendingFiles.length; index += 1) {
        const file = pendingFiles[index]
        setProgress(`${pack.code === 'en-US' ? 'Indexing combination' : '正在建立组合索引'} ${index + 1}/${pendingFiles.length} · ${file.name}`)
        const taskKey: string = `${project.id}:${file.id}`
        let indexed: { paragraphs: DocumentParagraph[]; state: IndexState } | undefined = await indexTasksRef.current.get(taskKey)?.catch(() => undefined)
        if (!indexed) {
          const blob = file.id === activeFileId && pdf ? null : await projectRepository.getSource(project.id, file.id, file.type)
          if ((!pdf && !blob) || (file.id !== activeFileId && !blob)) continue
          const temporaryUrl = blob ? URL.createObjectURL(blob) : ''
          const pdfTools = await import('./lib/pdf')
          let temporaryPdf: PDFDocumentProxy | undefined
          try {
            temporaryPdf = file.id === activeFileId && pdf ? pdf : await pdfTools.loadPdf(temporaryUrl)
            const { documentIndexer } = await import('./services/documentIndexer')
            indexed = await documentIndexer.indexPdf(temporaryPdf, project.id, file.id, undefined, { priorityPage: file.readingState.page })
          } finally {
            if (temporaryPdf && temporaryPdf !== pdf) await pdfTools.destroyPdf(temporaryPdf)
            if (temporaryUrl) URL.revokeObjectURL(temporaryUrl)
          }
        }
        if (!indexed) continue
        const indexedAt: number = indexed.state.indexedAt || project.updatedAt
        const updatedFile = { ...file, paragraphs: indexed.paragraphs, indexState: indexed.state, indexLoaded: true, updatedAt: indexedAt }
        const storedProject = { ...project, updatedAt: indexedAt, files: project.files.map((item) => item.id === file.id ? updatedFile : { ...item, paragraphs: [], indexLoaded: false }) }
        await projectRepository.save(storedProject)
        project = { ...project, updatedAt: indexedAt, files: project.files.map((item) => item.id === file.id ? (item.id === activeFileId ? updatedFile : { ...updatedFile, paragraphs: [], indexLoaded: false }) : item) }
      } } finally { setProgress('') }
      projectsRef.current = projectsRef.current.map((item) => item.id === project!.id ? project! : item)
      setProjects(projectsRef.current)
      if (project.hydrated) await projectRepository.save(project)
      if (window.readingAssistant) return { context: '', references: [], documentSource: { projectId: workspaceId, fileIds: project.files.map((file) => file.id) } }
      return buildBrowserDocumentContext(project)
    }
    project = await hydrateProject(project, fileId)
    const targetFiles = fileId ? project.files.filter((file) => file.id === fileId) : project.files

    // A newly opened PDF can be queried before the background index starts.
    // Build its index here instead of sending an empty-context request.
    if (!targetFiles.some((file) => file.paragraphs.length) && pdf && activeFileId && targetFiles.some((file) => file.id === activeFileId)) {
      const { documentIndexer } = await import('./services/documentIndexer')
      const runningIndex = await indexTasksRef.current.get(`${project.id}:${activeFileId}`)?.catch(() => undefined)
      const { paragraphs, state } = runningIndex || await documentIndexer.indexPdf(pdf, project.id, activeFileId, undefined, { priorityPage: currentPageRef.current })
      const indexedAt = state.indexedAt || project.updatedAt
      project = {
        ...project,
        updatedAt: indexedAt,
        files: project.files.map((file) => file.id === activeFileId ? { ...file, paragraphs, indexState: state, updatedAt: indexedAt } : file),
      }
      projectsRef.current = projectsRef.current.map((item) => item.id === project!.id ? project! : item)
      setProjects(projectsRef.current)
      await projectRepository.save(project)
    }
    const strategy = fileId ? 'document' : 'project'
    const result = retrievalService.retrieve(project, query, { strategy, fileId, maxHits: fileId ? 56 : 64, maxCharacters: fileId ? 65000 : 80000 })
    const references = createReferences(project, result.hits, 64)
    await projectRepository.save(project)
    if (window.readingAssistant) return { context: createCitationContext(references), references, documentSource: { projectId: workspaceId, fileIds: fileId ? [fileId] : project.files.map((file) => file.id) } }
    return { ...(await buildBrowserDocumentContext(project, fileId)), references }
  }

  const buildBrowserDocumentContext = async (project: RuntimeProject, fileId?: string) => {
    const blocks: string[] = []
    let characters = 0
    for (const file of project.files.filter((item) => !fileId || item.id === fileId)) {
      const stored = await projectRepository.get(project.id, false, file.id)
      const loaded = stored?.files.find((item) => item.id === file.id)
      const blob = file.kind === 'text' ? await projectRepository.getSource(project.id, file.id, file.type) : null
      if (blob && blob.size > 1200000) throw new Error('全文超过 API 单次附件预算，请使用 Codex 账户模式或拆分文档；未截断文档内容。')
      const text = blob ? await blob.text() : (loaded?.paragraphs || []).map((paragraph) => `[Page ${paragraph.page}]\n${paragraph.text}`).join('\n\n')
      if (!text.trim()) throw new Error(`文档没有可读文字，需要先提取文字或进行 OCR：${file.name}`)
      const block = `File: ${file.name}\n${text}`
      characters += block.length
      if (characters > 300000) throw new Error('全文超过 API 单次附件预算，请使用 Codex 账户模式或拆分文档；未截断文档内容。')
      blocks.push(block)
    }
    return { context: blocks.join('\n\n'), references: [] }
  }

  const updateConversationRoute = (workspaceId: string, conversationId: string, update: (conversation: Conversation) => Conversation) => {
    if (activeProjectIdRef.current === workspaceId) {
      setConversations((items) => items.map((item) => item.id === conversationId ? update(item) : item))
      if (activeConversationIdRef.current === conversationId) {
        setHistory((items) => update({ id: conversationId, title: '', history: items }).history)
      }
      return
    }
    setProjects((items) => items.map((project) => project.id === workspaceId
      ? { ...project, conversations: project.conversations.map((item) => item.id === conversationId ? update(item) : item) }
      : project))
  }

  const importSkillFolder = async () => {
    if (!window.readingAssistant) throw new Error(t('desktopImportOnly'))
    const result = await window.readingAssistant.selectSkillFolder()
    if (result.canceled) return false
    const skill = parseSkillImport(result)
    const next = [...skills.filter((item) => item.sourcePath !== skill.sourcePath && item.command !== skill.command), skill].slice(-12)
    localStorage.setItem('reading-assistant-skills', JSON.stringify(next))
    setSkills(next)
    return true
  }

  const removeSkill = (id: string) => {
    setSkills((items) => {
      const next = items.filter((item) => item.id !== id)
      localStorage.setItem('reading-assistant-skills', JSON.stringify(next))
      return next
    })
  }

  const importLanguageFolder = async () => {
    if (!window.readingAssistant) throw new Error(t('desktopImportOnly'))
    const result = await window.readingAssistant.selectLanguageFolder()
    if (result.canceled) return false
    const languagePack = parseLanguageImport(result)
    let imported: LanguagePack[]
    try {
      const saved = JSON.parse(localStorage.getItem('reading-assistant-language-packs') || '[]')
      imported = Array.isArray(saved) ? saved : []
    } catch { imported = [] }
    const next = [...imported.filter((item) => item.code !== languagePack.code), languagePack]
    localStorage.setItem('reading-assistant-language-packs', JSON.stringify(next))
    registerLanguagePack(languagePack)
    localStorage.setItem('reading-assistant-language', languagePack.code)
    onLanguageChange(languagePack.code)
    return true
  }

  const changeLanguage = (language: AppLanguage) => {
    localStorage.setItem('reading-assistant-language', language)
    onLanguageChange(language)
  }

  const changeMemorySettings = (settings: MemorySettings) => setMemorySettings(settings)
  const changeUserMemory = (value: string) => setUserMemory(value.slice(0, 12000))

  const learnUserMemory = (userRequest: string, assistantResponse: string) => {
    if (!memorySettingsRef.current.userMemoryEnabled) return
    memoryUpdateQueueRef.current = memoryUpdateQueueRef.current.then(async () => {
      if (!memorySettingsRef.current.userMemoryEnabled) return
      const response = await fetch('/api/ai/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aiConfig,
          currentMemory: userMemoryRef.current,
          userRequest,
          assistantResponse,
          responseLanguage: pack.aiLanguage,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!memorySettingsRef.current.userMemoryEnabled || !response.ok || typeof data.memory !== 'string') return
      const nextMemory = data.memory.trim().slice(0, 12000)
      userMemoryRef.current = nextMemory
      setUserMemory(nextMemory)
    }).catch(() => undefined)
  }

  const addGeneratedTextFiles = async (projectId: string, outputs: Array<{ name: string; content: string }>) => {
    const created: RuntimeProjectFile[] = []
    for (const output of outputs.slice(0, 12)) {
      const content = String(output.content || '').slice(0, 1024 * 1024)
      if (!content.trim()) continue
      const rawName = String(output.name || '生成内容.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)
      const name = /\.[a-z0-9]{1,10}$/i.test(rawName) ? rawName : `${rawName}.txt`
      const file = new File([content], name, { type: 'text/plain', lastModified: currentTimestamp() })
      const id = makeId()
      const now = currentTimestamp()
      const entry: RuntimeProjectFile = {
        id, projectId, name, kind: 'text', type: 'text/plain', size: file.size, lastModified: file.lastModified,
        createdAt: now, updatedAt: now, readingState: { page: 1, zoom: 1, scrollTop: 0 },
        highlights: [], annotations: [], paragraphs: generatedTextParagraphs(content, projectId, id),
        indexState: { status: 'ready', version: documentIndexVersion, indexedAt: now }, indexLoaded: true,
      }
      await projectRepository.saveSource(projectId, id, file)
      created.push(entry)
    }
    if (!created.length) return
    const current = projectsRef.current.find((item) => item.id === projectId)
    if (!current) return
    const next = { ...current, files: [...current.files, ...created], updatedAt: currentTimestamp() }
    projectsRef.current = projectsRef.current.map((item) => item.id === projectId ? next : item)
    setProjects(projectsRef.current)
    // The active project is saved by snapshotCurrent after React commits the
    // streamed answer. Saving an older database snapshot here could erase it.
    const stored = activeProjectIdRef.current === projectId ? null : await projectRepository.get(projectId)
    if (stored) {
      const existingIds = new Set(stored.files.map((item) => item.id))
      await projectRepository.save({ ...stored, files: [...stored.files, ...created.filter((item) => !existingIds.has(item.id))], updatedAt: next.updatedAt })
    }
  }

  const runAi = async (action: AiAction, instruction = '') => {
    setError('')
    if (!source || !activeProjectId) return
    let effectiveInstruction = instruction.trim()
    let requestedSkillId = ''
    if (action === 'custom' && effectiveInstruction.startsWith('/')) {
      const commandMatch = effectiveInstruction.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      const requestedSkill = commandMatch && skills.find((skill) => skill.command.toLocaleLowerCase() === commandMatch[1].toLocaleLowerCase())
      if (!requestedSkill) {
        setError(t('unknownSkill'))
        return
      }
      requestedSkillId = requestedSkill.id
      effectiveInstruction = commandMatch?.[2]?.trim() || (pack.code === 'en-US' ? 'Apply this skill to the current material.' : '请使用此 Skill 处理当前材料。')
    }
    const workspaceId = activeProjectId
    if (scope === 'combination' && activeProjectId === looseFilesId) { setError('当前文件不在组合中，无法使用“对组合”。'); return }
    if (scope === 'selection' && visionAvailable) {
      const images = selections.flatMap((item) => item.images)
      const bytes = images.reduce((total, image) => total + (image.byteLength || Math.ceil((image.dataUrl?.length || 0) * .75)), 0)
      if (images.length > maximumVisionImages || bytes > maximumVisionBytes) {
        setError(`单次最多发送 ${maximumVisionImages} 张、合计 12 MB 的选区图片；请分批提问。`)
        return
      }
    }
    const expectedContextScope = scope === 'combination' ? 'combination' : 'file'
    let conversationId = activeConversationId
    let previousHistory = history
    const activeRoute = conversations.find((item) => item.id === conversationId)
    const routeMatches = activeRoute && activeRoute.ownerType === 'file' && activeRoute.fileId === activeFileId && (activeRoute.contextScope || 'file') === expectedContextScope
    let codexThreadId = routeMatches && activeRoute.codexThreadVersion === 2 ? activeRoute.codexThreadId || '' : ''
    if (!conversationId || !routeMatches) {
      // An empty active id represents a user-requested draft. Do not reuse an
      // older conversation; persist this one only when the first request starts.
      const existing = activeConversationId ? conversations.find((item) => item.ownerType === 'file' && item.fileId === activeFileId && (item.contextScope || 'file') === expectedContextScope) : undefined
      const conversation: Conversation = existing || { id: makeId(), title: t('untitledConversation'), history: [], ownerType: 'file', fileId: activeFileId || undefined, contextScope: expectedContextScope }
      conversationId = conversation.id
      previousHistory = conversation.history
      codexThreadId = conversation.codexThreadVersion === 2 ? conversation.codexThreadId || '' : ''
      if (!existing) setConversations((items) => [...items, conversation])
      setActiveConversationId(conversationId)
      activeConversationIdRef.current = conversationId
      setHistory(previousHistory)
    }
    const taskKey = `${workspaceId}:${conversationId}`
    if (aiTasks.has(taskKey)) return
    chatFollowSuspendedRef.current = false
    chatAutoFollowRef.current = true
    const targetUsesContext = scope !== 'selection'
    const targetIsProject = scope === 'combination'
    const capturedSelections = targetUsesContext ? [] : selections
    const capturedSelectedText = targetUsesContext ? '' : selectedText
    const selectionImages = capturedSelections.flatMap((item) => item.images)
    const selectionUsesText = Boolean(capturedSelectedText.trim())
    const fastSelectionTranslation = selectionUsesText && action === 'translate'
    const reasoningActive = deepThinking && aiConfig.reasoningEnabled
    const actionLabel = (requestedSkillId ? skills.find((skill) => skill.id === requestedSkillId)?.name : effectiveInstruction) || ({ translate: t('translate'), explain: t('explain'), insight: t('insight'), summarize: t('summarize'), custom: 'AI' }[action])
    const emptySelectionChat = !targetUsesContext && !selectionUsesText && selectionImages.length === 0 && action === 'custom' && Boolean(effectiveInstruction)
    const scopeLabel = targetIsProject ? '组合' : targetUsesContext ? t('documentScope') : t('selectedScope')
    const userLabel = emptySelectionChat ? t('selectedScope') : `${scopeLabel} · ${actionLabel}`
    const activeProjectName = projects.find((item) => item.id === activeProjectId)?.name || source.name
    const targetText = targetIsProject ? `组合：${activeProjectName}` : targetUsesContext ? `文件：${source.name}` : emptySelectionChat ? effectiveInstruction : (capturedSelectedText || `视觉选区 · ${selectionImages.length} 张图片`)
    const contextMode: ChatMessage['contextMode'] = scope
    let attachments: ChatMessage['attachments'] = []
    try { if (selectionImages.length) attachments = await retainSelectionImages(capturedSelections) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存选区图片'); return }
    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: targetText, prompt: effectiveInstruction || actionLabel, contextMode, label: userLabel, sourcePage: currentPage, attachments }
    const assistantId = makeId()
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', contextMode, citationsDisabled: !targetUsesContext || targetIsProject }
    const requestHistory = [...previousHistory, userMessage]
    const visibleHistory = [...requestHistory, assistantMessage]
    setHistory(visibleHistory)
    setConversations((items) => items.map((item) => item.id === conversationId ? {
      ...item,
      title: item.history.length ? item.title : actionLabel.slice(0, 32),
      history: visibleHistory,
    } : item))
    setAiTasks((items) => new Set(items).add(taskKey))
    const requestController = new AbortController()
    abortControllersRef.current.set(taskKey, requestController)
    setCustomPrompt('')
    if (!targetUsesContext && (capturedSelections.length || capturedSelectedText)) {
      const consumed = new Set(capturedSelections.map((item) => item.id))
      const remaining = selectionsRef.current.filter((item) => !consumed.has(item.id))
      selectionsRef.current = remaining
      setSelections(remaining)
      setSelectedText(remaining.map((item) => item.text).filter(Boolean).join('\n\n'))
    }
    try {
      // Full screenshots live on disk and are materialized only for the duration of this request.
      const requestImages: string[] = []
      if (visionAvailable) {
        for (const selectionImage of selectionImages) requestImages.push(await resolveSelectionImage(selectionImage))
      }
      const retrieval = targetUsesContext ? await buildProjectContext(workspaceId, effectiveInstruction || actionLabel, targetIsProject ? undefined : activeFileId || undefined) : { context: '', references: [] }
      const targetProject = snapshotCurrent()
      const annotationContext = !targetUsesContext || window.readingAssistant ? '' : targetIsProject
        ? (targetProject?.files || []).flatMap((file) => file.annotations.filter((annotation): annotation is TextAnnotation => annotation.type === 'text' && Boolean(annotation.text.trim())).map((annotation) => `[${file.name}｜第 ${annotation.page} 页批注]\n${annotation.text.trim()}`)).join('\n\n')
        : annotations.filter((annotation): annotation is TextAnnotation => annotation.type === 'text' && Boolean(annotation.text.trim())).map((annotation) => `[第 ${annotation.page} 页批注]\n${annotation.text.trim()}`).join('\n\n')
      const documentText = [retrieval.context, annotationContext].filter(Boolean).join('\n\n')
      const attachedIds = conversations.find((conversation) => conversation.id === conversationId)?.documentFileIds || []
      const availableIds = attachedIds.filter((id) => targetProject?.files.some((file) => file.id === id))
      const documentSource = 'documentSource' in retrieval ? retrieval.documentSource : undefined
      const continuedDocumentSource = documentSource || (window.readingAssistant && availableIds.length ? { projectId: workspaceId, fileIds: availableIds } : undefined)
      if (documentSource) updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, documentFileIds: documentSource.fileIds }))
      if (targetUsesContext && !documentText && !('documentSource' in retrieval && retrieval.documentSource)) throw new Error(pack.code === 'en-US' ? 'The document has no readable text to process.' : '文档中没有可供处理的可读文字。')
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({
          action,
          selectedText: capturedSelectedText,
          documentText,
          documentSource: continuedDocumentSource,
          references: targetIsProject ? [] : retrieval.references,
          instruction: effectiveInstruction,
          includeContext: targetUsesContext && Boolean(retrieval.context),
          contextMode,
          anchorPages: targetUsesContext ? [] : Array.from(new Set(capturedSelections.flatMap((item) => item.regions.map((region) => region.page)).concat(currentPage))),
          history: recentSelectionHistory(previousHistory),
          aiConfig,
          deepThinking: fastSelectionTranslation ? false : reasoningActive,
          responseLanguage: pack.aiLanguage,
          userMemory: memorySettings.userMemoryEnabled ? userMemoryRef.current : '',
          selectionHasImages: requestImages.length > 0,
          selectionImages: requestImages,
          codexThreadId,
          skills: targetUsesContext || requestedSkillId ? skills.map(({ id, name, command, description, instructions }) => ({ id, name, command, description, instructions })) : [],
          requestedSkillId,
        }),
      })
      let streamedContent = ''
      const done = await readAiStream(response, (event) => {
        if (event.type === 'thread') updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, codexThreadId: event.threadId, codexThreadVersion: 2 }))
        if (event.type === 'delta') {
          streamedContent += event.delta
          updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((message) => message.id === assistantId ? { ...message, content: streamedContent } : message) }))
        }
        if (event.type === 'done') {
          streamedContent = event.content
          updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((message) => message.id === assistantId ? { ...message, content: event.content, label: event.skillName ? `${t('skillUsed')} · ${event.skillName}` : undefined, references: targetUsesContext && !targetIsProject && Array.isArray(event.references) ? event.references : undefined } : message) }))
        }
      })
      if (done.files?.length) await addGeneratedTextFiles(workspaceId, done.files)
      learnUserMemory(effectiveInstruction || actionLabel, done.content)
    } catch (reason) {
      const message = requestController.signal.aborted ? (pack.code === 'en-US' ? 'Generation stopped.' : '已停止生成。') : reason instanceof Error ? reason.message : t('processFailed')
      updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((item) => item.id === assistantId ? { ...item, content: item.content ? `${item.content}\n\n⚠️ ${message}` : `⚠️ ${message}` } : item) }))
    } finally {
      abortControllersRef.current.delete(taskKey)
      setAiTasks((items) => { const next = new Set(items); next.delete(taskKey); return next })
    }
  }

  const stopAi = () => {
    if (currentAiTaskKey) abortControllersRef.current.get(currentAiTaskKey)?.abort()
  }

  const deleteMessage = async (id: string) => {
    const removed = history.find((message) => message.id === id)
    const conversation = conversations.find((item) => item.id === activeConversationId)
    try {
      if (conversation?.codexThreadId) {
        const response = await fetch('/api/ai/thread/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: conversation.codexThreadId }) })
        if (!response.ok) throw new Error('无法删除 Codex 对话记录，请重试')
      }
      if (removed?.attachments?.length) await deleteStoredSelectionImages(removed.attachments.map((image) => image.id))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法删除选区图片'); return }
    const next = history.filter((message) => message.id !== id)
    setHistory(next)
    setConversations((items) => items.map((item) => item.id === activeConversationId ? { ...item, history: next, codexThreadId: undefined } : item))
    setCitationFocus(null)
  }

  const jumpToPage = (page: number, regionTop?: number, storedScrollTop?: number) => {
    const safePage = Math.max(1, page)
    setCurrentPage(safePage)
    const scrollWhenRendered = (attempt = 0) => requestAnimationFrame(() => {
      const container = readerScrollRef.current
      const target = container?.querySelector<HTMLElement>(`[data-page-number="${safePage}"]`)
      if (!container || !target) return
      const nearbyPagesReady = Array.from(container.querySelectorAll<HTMLElement>('.selectable-page')).every((page) => {
        const canvas = page.querySelector('canvas')
        return Boolean(canvas && canvas.width > 0 && canvas.height > 0)
      })
      if ((target.classList.contains('pdf-page-placeholder') || !nearbyPagesReady) && attempt < 180) return scrollWhenRendered(attempt + 1)
      const regionOffset = typeof regionTop === 'number' ? target.getBoundingClientRect().height * regionTop - container.clientHeight * .22 : -20
      const top = typeof storedScrollTop === 'number' && regionTop === undefined ? storedScrollTop : target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop + regionOffset
      container.scrollTo({ top, behavior: 'auto' })
      setCurrentPage(safePage)
    })
    scrollWhenRendered()
  }

  const captureReaderLocation = () => readerControllerRef.current.current(currentPage, zoom, readerScrollRef.current?.scrollTop || 0)

  const applyReaderLocation = async (location: ReaderLocation, showFocus = true) => {
    const project = projects.find((item) => item.id === location.projectId) || (await projectRepository.get(location.projectId).then((item) => item ? ({ ...item, hydrated: true } as RuntimeProject) : null))
    if (!project || !project.files.some((file) => file.id === location.fileId)) { setError('引用或标签对应的文件已被删除。'); return false }
    const alreadyOpen = activeProjectIdRef.current === location.projectId && activeFileIdRef.current === location.fileId && Boolean(source)
    if (!alreadyOpen) {
      const opened = await openProjectFile(location.projectId, location.fileId)
      if (!opened) return false
    }
    if (location.zoom) setZoom(location.zoom)
    setCitationFocus(showFocus && location.region ? { page: location.page, region: location.region } : null)
    jumpToPage(location.page, location.region?.top, location.scrollTop)
    window.setTimeout(() => setCitationFocus(null), 2400)
    return true
  }

  const navigateToLocation = async (location: ReaderLocation, showFocus = true) => {
    await navigationRef.current.navigate(location, captureReaderLocation, (target) => applyReaderLocation(target, showFocus))
    setNavigationDepth(navigationRef.current.depth)
  }

  const navigateBack = async () => {
    await navigationRef.current.back(applyReaderLocation)
    setNavigationDepth(navigationRef.current.depth)
  }

  const openTag = (tag: DocumentTag) => void navigateToLocation({ projectId: tag.projectId, fileId: tag.fileId, page: tag.page, region: tag.region }, false)

  const openReference = (reference: NonNullable<ChatMessage['references']>[number]) => {
    const project = projects.find((item) => item.id === reference.projectId)
    if (project?.hydrated && !validateReference(project, reference)) { setError('引用已失效，原段落可能已被删除或重新索引。'); return }
    void navigateToLocation({ projectId: reference.projectId, fileId: reference.fileId, page: reference.page, region: reference.region })
  }

  const addTagAt = (page: number, region: NormalizedRegion) => {
    if (!activeProjectId || !activeFileId) return
    setCitationFocus(null)
    const tag = createTag(activeProjectId, activeFileId, page, region, '')
    setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, tags: [...project.tags, tag], updatedAt: Date.now() } : project))
    setRecentTagId(tag.id)
  }

  const addTextToAi = (text: string) => {
    const selectionId = makeId()
    setSelections((items) => { const next = [...items, { id: selectionId, image: '', images: [], page: currentPage, regions: [], text, textParts: [text], loading: false }]; selectionsRef.current = next; return next })
    setSelectedText((previous) => [previous, text].filter(Boolean).join('\n\n'))
    setScope('selection')
  }

  const translateTextInline = async (text: string, signal: AbortSignal, onDelta: (delta: string) => void) => {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        action: 'translate',
        selectedText: text,
        documentText: '',
        includeContext: false,
        history: [],
        aiConfig,
        deepThinking: false,
        fastTranslation: true,
        responseLanguage: pack.aiLanguage,
      }),
    })
    const done = await readAiStream(response, (event) => { if (event.type === 'delta') onDelta(event.delta) })
    return done.content
  }

  const statusText = useMemo(() => {
    if (busy) return progress || t('processing')
    if (selectedText) return t('selectedStatus').replace('{count}', String(selections.length)).replace('{chars}', String(selectedText.length))
    if (hasVisualSelection) return t('visualStatus').replace('{count}', String(selections.length))
    return ''
  }, [busy, progress, selectedText, selections.length, hasVisualSelection, t])

  const updatePanel = (id: PanelId, layout: PanelLayout) => {
    if (id === 'tags' && !layout.open) setRecentTagId(null)
    if (id === 'chat' && !layout.open) chatSavedScrollTopRef.current = panelScrollRef.current?.scrollTop ?? chatSavedScrollTopRef.current
    if (id === 'chat' && layout.open && !panelLayouts.chat.open) chatRestorePendingRef.current = true
    setPanelLayouts((items) => ({ ...items, [id]: layout }))
  }
  const raisePanel = (id: PanelId) => setPanelLayouts((items) => ({ ...items, [id]: { ...items[id], z: nextPanelZ(items) } }))
  const togglePanel = useCallback((id: PanelId) => {
    if (id === 'tags' && panelLayouts.tags.open) setRecentTagId(null)
    if (id === 'chat') {
      if (panelLayouts.chat.open) chatSavedScrollTopRef.current = panelScrollRef.current?.scrollTop ?? chatSavedScrollTopRef.current
      else chatRestorePendingRef.current = true
    }
    setPanelLayouts((items) => ({ ...items, [id]: { ...items[id], open: !items[id].open, z: nextPanelZ(items) } }))
  }, [panelLayouts.tags.open, panelLayouts.chat.open])
  const updatePanelOrder = useCallback((next: PanelId[]) => setPanelOrder((current) => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next), [])
  const toggleAnnotationMode = () => {
    setAnnotationMode((active) => {
      if (!active) {
        setTagMode(false)
        window.getSelection()?.removeAllRanges()
      }
      return !active
    })
  }
  const undoLastInkStroke = () => setAnnotations((items) => {
    let index = -1
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      if (items[itemIndex].type === 'ink') { index = itemIndex; break }
    }
    return index < 0 ? items : items.filter((_, itemIndex) => itemIndex !== index)
  })
  const toggleTagMode = () => {
    const next = !tagMode
    if (next) {
      setAnnotationMode(false); window.getSelection()?.removeAllRanges()
    }
    setTagMode(next)
  }
  useEffect(() => {
    const runShortcut = (action: ShortcutAction) => {
      if (action === 'projects') togglePanel('projects')
      if (action === 'tags' && source) togglePanel('tags')
      if (action === 'chat' && source) togglePanel('chat')
      if (action === 'annotation' && source) toggleAnnotationMode()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || event.repeat) return
      const shortcut = shortcutFromKeyboardEvent(event)
      const action = findShortcutAction(shortcutSettings, shortcut)
      if (!action) return
      const target = event.target
      if (!event.ctrlKey && !event.altKey && !event.metaKey && target instanceof HTMLElement && target.matches('input,textarea,[contenteditable="true"]')) return
      event.preventDefault(); event.stopPropagation(); runShortcut(action)
    }
    const onMouseDown = (event: MouseEvent) => {
      if (settingsOpen) return
      const action = findShortcutAction(shortcutSettings, shortcutFromMouseEvent(event))
      if (!action) return
      event.preventDefault(); event.stopPropagation(); runShortcut(action)
    }
    const onContextMenu = (event: MouseEvent) => {
      if (settingsOpen) return
      if (findShortcutAction(shortcutSettings, shortcutFromMouseEvent(event))) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('mousedown', onMouseDown, true); window.removeEventListener('contextmenu', onContextMenu, true) }
  }, [shortcutSettings, source, panelLayouts, annotationMode, tagMode, settingsOpen, togglePanel])
  const panelPosition = (id: PanelId) => {
    const index = panelOrder.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const visiblePanelIds = (Object.keys(panelLayouts) as PanelId[])
    .filter((id) => id !== 'selection' && panelLayouts[id].open && (id === 'projects' || (id === 'tags' && projects.some((project) => project.tags.length)) || Boolean(source)))
    .sort((first, second) => panelPosition(first) - panelPosition(second))
  const leftPanelIds = visiblePanelIds.filter((id) => panelLayouts[id].dock === 'left')
  const rightPanelIds = visiblePanelIds.filter((id) => panelLayouts[id].dock === 'right')
  const floatingPanelIds = visiblePanelIds.filter((id) => panelLayouts[id].dock === 'float')

  const toggleHighlight = (item: Omit<DocumentHighlight, 'id'>) => setHighlights((items) => {
    const normalizedText = item.text.replace(/\s+/g, ' ').trim()
    let removed = false
    const withoutSelectedRegions = items.flatMap((existing) => {
      if (item.regions?.length && existing.regions?.length) {
        const regions = existing.regions.filter((region) => !item.regions!.some((selected) => highlightRegionOverlap(region, selected)))
        if (regions.length !== existing.regions.length) removed = true
        return regions.length ? [{ ...existing, regions }] : []
      }
      if (existing.page === item.page && existing.text.replace(/\s+/g, ' ').trim() === normalizedText) { removed = true; return [] }
      return [existing]
    })
    if (removed) return withoutSelectedRegions
    return [...items, { ...item, id: makeId() }]
  })

  const openProjectConversation = async (projectId: string, conversationId: string) => {
    if (projectId === activeProjectId) openConversation(conversationId)
    else {
      const candidate = projects.find((item) => item.id === projectId)
      if (!candidate) return
      try {
        let project = await hydrateProject(candidate)
        let file: RuntimeProjectFile | null = null
        if (project.activeFileId) { const hydrated = await hydrateProjectFile(project, project.activeFileId); project = hydrated.project; file = hydrated.file }
        const target = project.conversations.find((item) => item.id === conversationId)
        if (!target) return
        const snapshot = snapshotCurrent()
        if (snapshot && snapshot.id !== project.id) void projectRepository.save(snapshot)
        setProjects((items) => items.map((item) => item.id === project.id ? project : snapshot && item.id === snapshot.id ? coolProject(snapshot) : item))
        loadProjectFile({ ...project, activeConversationId: conversationId }, file)
        setScope(target.contextScope === 'combination' || target.ownerType === 'combination' ? 'combination' : [...target.history].reverse().find((message) => message.role === 'user')?.contextMode === 'document' ? 'document' : 'selection')
      } catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开对话。') }
    }
    setPanelLayouts((items) => ({ ...items, chat: { ...items.chat, open: true, z: nextPanelZ(items) } }))
  }
  const currentProject = projects.find((project) => project.id === activeProjectId)
  const renameCombination = (projectId: string, name: string) => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    const next = { ...project, name, updatedAt: Date.now() }
    setProjects((items) => items.map((item) => item.id === projectId ? next : item))
    if (next.hydrated) void projectRepository.save(next)
    else void projectRepository.get(projectId).then((stored) => stored && projectRepository.save({ ...stored, name, updatedAt: next.updatedAt })).catch(() => undefined)
  }
  const reorderCombination = (projectId: string, targetIndex: number) => setProjects((items) => {
    const combinations = items.filter((item) => !item.isLoose && item.id !== looseFilesId)
    const loose = items.filter((item) => item.isLoose || item.id === looseFilesId)
    const from = combinations.findIndex((item) => item.id === projectId)
    if (from < 0) return items
    const next = [...combinations]; const [moved] = next.splice(from, 1); next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, moved); next.push(...loose)
    localStorage.setItem('reading-assistant-combination-order', JSON.stringify(next.map((item) => item.id)))
    return next
  })
  const moveProjectFile = async (sourceId: string, fileId: string, targetId: string, beforeFileId?: string) => {
    const snapshot = snapshotCurrent()
    let sourceProject = snapshot?.id === sourceId ? snapshot : projects.find((item) => item.id === sourceId)
    let targetProject = snapshot?.id === targetId ? snapshot : projects.find((item) => item.id === targetId)
    if (!sourceProject || !targetProject) return
    try {
      sourceProject = await hydrateProject(sourceProject); targetProject = sourceId === targetId ? sourceProject : await hydrateProject(targetProject)
      const file = sourceProject.files.find((item) => item.id === fileId)
      if (!file) return
      if (sourceId === targetId) {
        const files = sourceProject.files.filter((item) => item.id !== fileId)
        const before = beforeFileId ? files.findIndex((item) => item.id === beforeFileId) : files.length
        files.splice(before < 0 ? files.length : before, 0, file)
        const next = { ...sourceProject, files, updatedAt: Date.now() }
        await projectRepository.save(next); setProjects((items) => items.map((item) => item.id === sourceId ? (sourceId === activeProjectId ? next : coolProject(next)) : item)); return
      }
      const blob = await projectRepository.getSource(sourceId, fileId, file.type)
      if (!blob) throw new Error('源文件缺失，无法移动。')
      const movedFile: RuntimeProjectFile = { ...file, projectId: targetId, paragraphs: file.paragraphs.map((paragraph) => ({ ...paragraph, projectId: targetId })), updatedAt: Date.now() }
      const targetFiles = [...targetProject.files]
      const insertAt = beforeFileId ? targetFiles.findIndex((item) => item.id === beforeFileId) : targetFiles.length
      targetFiles.splice(insertAt < 0 ? targetFiles.length : insertAt, 0, movedFile)
      const movedConversations = sourceProject.conversations.filter((item) => item.ownerType === 'file' && item.fileId === fileId)
      const movedTags = sourceProject.tags.filter((item) => item.fileId === fileId).map((item) => ({ ...item, projectId: targetId }))
      const nextSource: RuntimeProject = { ...sourceProject, files: sourceProject.files.filter((item) => item.id !== fileId), conversations: sourceProject.conversations.filter((item) => !(item.ownerType === 'file' && item.fileId === fileId)), tags: sourceProject.tags.filter((item) => item.fileId !== fileId), activeFileId: sourceProject.activeFileId === fileId ? sourceProject.files.find((item) => item.id !== fileId)?.id || null : sourceProject.activeFileId, updatedAt: Date.now() }
      const nextTarget: RuntimeProject = { ...targetProject, files: targetFiles, conversations: [...targetProject.conversations, ...movedConversations], tags: [...targetProject.tags, ...movedTags], activeFileId: fileId, activeConversationId: movedConversations[0]?.id || targetProject.activeConversationId, updatedAt: Date.now() }
      await projectRepository.saveSource(targetId, fileId, new File([blob], file.name, { type: file.type, lastModified: file.lastModified }))
      await Promise.all([projectRepository.save(nextSource), projectRepository.save(nextTarget)])
      await projectRepository.deleteFile(sourceId, fileId)
      setProjects((items) => items.map((item) => item.id === sourceId ? (sourceId === activeProjectId ? nextSource : coolProject(nextSource)) : item.id === targetId ? (targetId === activeProjectId ? nextTarget : coolProject(nextTarget)) : item))
      navigationRef.current.clear(); setNavigationDepth(0)
      if (activeFileId === fileId) loadProjectFile(nextTarget, movedFile)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '移动文件失败。') }
  }
  const dissolveCombination = async (projectId: string) => {
    let group = snapshotCurrent()?.id === projectId ? snapshotCurrent() : projects.find((item) => item.id === projectId)
    let loose = projects.find((item) => item.id === looseFilesId)
    if (!group || !loose || group.isLoose) return
    try {
      group = await hydrateProject(group); loose = await hydrateProject(loose)
      const movedFiles: RuntimeProjectFile[] = []
      for (const file of group.files) {
        const blob = await projectRepository.getSource(group.id, file.id, file.type)
        if (!blob) throw new Error(`无法找到 ${file.name} 的源文件。`)
        await projectRepository.saveSource(loose.id, file.id, new File([blob], file.name, { type: file.type, lastModified: file.lastModified }))
        movedFiles.push({ ...file, projectId: loose.id, paragraphs: file.paragraphs.map((paragraph) => ({ ...paragraph, projectId: loose!.id })) })
      }
      const fileIds = new Set(group.files.map((file) => file.id))
      const nextLoose: RuntimeProject = { ...loose, files: [...loose.files, ...movedFiles], conversations: [...loose.conversations, ...group.conversations.filter((item) => item.ownerType === 'file' && item.fileId && fileIds.has(item.fileId))], tags: [...loose.tags, ...group.tags.map((tag) => ({ ...tag, projectId: loose!.id }))], updatedAt: Date.now(), hydrated: true }
      await projectRepository.save(nextLoose)
      await projectRepository.deleteProject(group.id)
      navigationRef.current.clear(); setNavigationDepth(0)
      const nextProjects = projects.filter((item) => item.id !== group!.id).map((item) => item.id === loose!.id ? (loose!.id === activeProjectId ? nextLoose : coolProject(nextLoose)) : item)
      setProjects(nextProjects)
      if (activeProjectId === group.id) {
        const active = movedFiles.find((item) => item.id === activeFileId) || movedFiles[0] || null
        loadProjectFile(nextLoose, active)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '分解组合失败。') }
  }
  const deleteConversationInProject = async (projectId: string, conversationId: string) => {
    if (projectId === activeProjectId) { await deleteConversation(conversationId); return }
    const project = projects.find((item) => item.id === projectId); if (!project) return
    const hydrated = await hydrateProject(project); const removed = hydrated.conversations.find((item) => item.id === conversationId)
    try { if (removed) await forgetConversationAssets(removed) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法删除对话资源'); return }
    const next = { ...hydrated, conversations: hydrated.conversations.filter((item) => item.id !== conversationId), updatedAt: currentTimestamp() }
    await projectRepository.save(next); setProjects((items) => items.map((item) => item.id === projectId ? coolProject(next) : item))
  }
  const deleteProjectFile = async (projectId: string, fileId: string) => {
    let base = snapshotCurrent()?.id === projectId ? snapshotCurrent() : projects.find((project) => project.id === projectId)
    if (!base || !window.confirm('删除文件将永久删除该文件的对话、阅读位置、高亮、批注、标签、资源和索引。继续吗？')) return
    base = await hydrateProject(base)
    try { for (const conversation of base.conversations.filter((item) => item.ownerType === 'file' && item.fileId === fileId)) await forgetConversationAssets(conversation) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法删除文件关联的对话资源'); return }
    const removed = base.files.find((file) => file.id === fileId)
    if (removed?.source?.url) URL.revokeObjectURL(removed.source.url)
    const files = base.files.filter((file) => file.id !== fileId)
    const next: RuntimeProject = { ...base, files, conversations: base.conversations.filter((item) => !(item.ownerType === 'file' && item.fileId === fileId)), tags: tagsWithoutFile(base.tags, fileId), activeFileId: base.activeFileId === fileId ? files[0]?.id || null : base.activeFileId, updatedAt: Date.now() }
    await projectRepository.deleteFile(projectId, fileId)
    await projectRepository.save(next)
    setProjects((items) => items.map((project) => project.id === projectId ? (projectId === activeProjectId ? next : coolProject(next)) : project))
    if (projectId === activeProjectId && fileId === activeFileId) {
      if (next.activeFileId) {
        const hydrated = await hydrateProjectFile(next, next.activeFileId)
        setProjects((items) => items.map((project) => project.id === projectId ? hydrated.project : project))
        loadProjectFile(hydrated.project, hydrated.file)
      } else loadProjectFile(next, null)
    }
  }
  const updateTagOwner = async (id: string, update: (tags: DocumentTag[]) => DocumentTag[]) => {
    const owner = projects.find((project) => project.tags.some((tag) => tag.id === id))
    if (!owner) return
    const hydrated = owner.id === activeProjectId ? snapshotCurrent() || owner : await hydrateProject(owner)
    const next = { ...hydrated, tags: update(hydrated.tags), updatedAt: Date.now() }
    setProjects((items) => items.map((project) => project.id === owner.id ? (owner.id === activeProjectId ? next : coolProject(next)) : project))
    await projectRepository.save(next)
  }
  const deleteTag = (id: string) => {
    if (id === recentTagId) setRecentTagId(null)
    void updateTagOwner(id, (tags) => tags.filter((tag) => tag.id !== id))
  }
  const renameTag = (id: string, label: string) => {
    if (id === recentTagId) setRecentTagId(null)
    void updateTagOwner(id, (tags) => tags.map((tag) => tag.id === id ? { ...tag, label } : tag))
  }
  const moveTag = (id: string, region: NormalizedRegion) => { void updateTagOwner(id, (tags) => tags.map((tag) => tag.id === id ? { ...tag, region } : tag)) }
  const projectContent = <ProjectExplorer
    projects={projects.map((project) => ({ id: project.id, name: project.name, isLoose: project.isLoose || project.id === looseFilesId, busy: Array.from(aiTasks).some((key) => key.startsWith(`${project.id}:`)), files: project.files.map((file) => ({ id: file.id, name: file.name, indexStatus: file.indexState.status })), conversations: project.id === activeProjectId ? conversations : project.conversations }))}
    activeProjectId={activeProjectId}
    activeFileId={activeFileId}
    activeConversationId={activeConversationId}
    createSignal={createCombinationSignal}
    onCreateProject={createEmptyProject}
    onOpenProject={openProject}
    onAddFile={(projectId, files) => openFileBatch(files, projectId)}
    onOpenFile={(projectId, fileId) => void openProjectFile(projectId, fileId)}
    onDeleteFile={(projectId, fileId) => void deleteProjectFile(projectId, fileId)}
    onOpenConversation={openProjectConversation}
    onDeleteConversation={(projectId, conversationId) => void deleteConversationInProject(projectId, conversationId)}
    onRenameCombination={renameCombination}
    onDissolveCombination={(id) => void dissolveCombination(id)}
    onMoveFile={(sourceId, fileId, targetId, beforeId) => void moveProjectFile(sourceId, fileId, targetId, beforeId)}
    onReorderCombination={reorderCombination}
  />
  const tagContent = <TagPanel tags={projects.flatMap((project) => project.tags)} files={projects.flatMap((project) => project.files)} tagMode={tagMode} recentTagId={recentTagId} canGoBack={navigationDepth > 0} onToggleTagMode={toggleTagMode} onBack={() => void navigateBack()} onOpen={openTag} onRename={renameTag} onDelete={deleteTag} onDismissRecent={() => setRecentTagId(null)} />

  const selectionHasImages = selections.some((selection) => selection.images.length > 0)
  const activeThinkingLabel = t('processing')
  const selectionContent = <div className="selection-panel-body single" ref={selectionBodyRef}><section className="selection-content-section">
    <div className="section-label"><span>{t('selectedContent')} · {selections.length}</span>{selections.length > 0 && <button onClick={clearCapturedSelections}><X size={14} /> {t('clear')}</button>}</div>
    {selections.length === 0 ? <div className="selection-empty"><MousePointer2 size={22} /></div> : <div className={`selection-result-split ${selectionHasImages ? 'with-images' : 'text-only'}`} ref={selectionSplitRef} style={selectionHasImages ? { gridTemplateRows: `minmax(72px, ${selectionSplitRatio}fr) 7px minmax(72px, ${1 - selectionSplitRatio}fr)` } : undefined}>{selectionHasImages && <div className="selection-image-pane" ref={selectionImagesRef}><div className="selection-strip">{selections.flatMap((selection) => selection.images.map((image, imageIndex) => <div className="selection-thumb" key={`${selection.id}-${imageIndex}`}>{image.preview ? <img src={image.preview} alt="选区预览" /> : <div className="selection-thumb-placeholder">P{selection.regions[imageIndex]?.page || selection.page}</div>}{selection.loading && <span><LoaderCircle className="spin" size={10} /></span>}<button className="remove-selection-image" onClick={() => removeSelectionImage(selection.id, imageIndex)}><X size={11} /></button></div>))}</div></div>}{selectionHasImages && <div className="section-resizer" role="separator" aria-label="调整选区图片与识别文字高度" aria-orientation="horizontal" title="拖动调整图片与识别文字高度" onPointerDown={startSelectionSplit} onPointerMove={moveSelectionSplit} onPointerUp={stopSelectionSplit} onPointerCancel={stopSelectionSplit} />}{busy === 'ocr' ? <div className="inline-loading selection-text-pane"><LoaderCircle className="spin" size={16} /> {progress}</div> : <textarea className="selection-text-pane" ref={selectionTextRef} value={selectedText} onChange={(e) => setSelectedText(e.target.value)} />}</div>}
  </section></div>

  const selectionPromptAttachments = scope === 'selection' && (selections.length > 0 || selectedText) ? <div className="prompt-selection-context">
    <div className="prompt-selection-items">
      {selections.flatMap((selection) => selection.images.map((image, imageIndex) => <div className="prompt-selection-image" key={`${selection.id}-${imageIndex}`}>{image.preview ? <img src={image.preview} alt="选区" /> : <span>P{selection.regions[imageIndex]?.page || selection.page}</span>}<button onClick={() => removeSelectionImage(selection.id, imageIndex)} title="移除选区"><X size={10} /></button></div>))}
      {selections.filter((selection) => selection.text && selection.images.length === 0).map((selection) => <div className="prompt-selection-text" key={selection.id}><TextCursorInput size={12} /><span>{selection.text.slice(0, 80)}{selection.text.length > 80 ? '…' : ''}</span><button onClick={() => removeCapturedSelection(selection.id)} title="移除文字选区"><X size={10} /></button></div>)}
    </div>
    <div className="prompt-selection-options"><button onClick={clearCapturedSelections}>清空</button></div>
  </div> : null

  const chatContent = <div className="chat-panel-layout" style={{ '--ai-font-size': `${aiFontSize}px` } as CSSProperties}>
    <section className="ai-fixed-controls">
      <div className="scope-toolbar"><div className="scope-switch" role="group" aria-label="AI 处理范围"><button className={scope === 'selection' ? 'active' : ''} onClick={() => setScope('selection')}>{t('selectedScope')}{selections.length > 0 && <span>{selections.length}</span>}</button><button className={scope === 'document' ? 'active' : ''} onClick={() => setScope('document')}>{t('documentScope')}</button><button disabled={activeProjectId === looseFilesId} className={scope === 'combination' ? 'active' : ''} onClick={() => setScope('combination')}>对组合</button></div></div>
      <div className="action-grid">{aiActions.map(([action, Icon]) => <button key={action} disabled={!!busy || currentAiBusy || (scope === 'selection' && !selectionReady)} onClick={() => runAi(action)}><Icon /><span>{t(action)}</span></button>)}</div>
    </section>
    <div className="panel-scroll" ref={panelScrollRef} onWheelCapture={(event) => { if (event.ctrlKey) { event.preventDefault(); setAiFontSize((value) => Math.max(10, Math.min(26, value + (event.deltaY < 0 ? 1 : -1)))); return } stopFollowingOnUpwardWheel(event.currentTarget, event.deltaY, event.deltaMode) }} onScroll={(event) => trackChatPosition(event.currentTarget)}>
      <section className="conversation">
        <Suspense fallback={null}><ConversationMessages key={activeConversationId} history={history} deleteMessage={deleteMessage} openReference={openReference} /></Suspense>
        {currentAiBusy && <div className="thinking"><LoaderCircle className="spin" size={18} /><span>{activeThinkingLabel}</span><button onClick={stopAi}><Square size={13} />停止</button></div>}
        <div ref={resultsEndRef} />
      </section>
      {error && <div className="error-banner"><X size={15} /><span>{error}</span></div>}
    </div>
    <div className="prompt-area"><div className="prompt-height-resizer" onPointerDown={startPromptResize} role="separator" aria-orientation="horizontal" />{aiConfig.provider !== 'codex' && !aiConfig.apiKey && !configured && <button className="config-warning" onClick={openSettings}>{t('notConfigured')}</button>}{skillSuggestions.length > 0 && <div className="skill-command-menu">{skillSuggestions.map((skill) => <button key={skill.id} onClick={() => setCustomPrompt(`/${skill.command} `)}><Puzzle size={14} /><span><strong>/{skill.command}</strong><small>{skill.name}</small></span></button>)}</div>}{selectionPromptAttachments}<div className="prompt-box" style={{ height: promptHeight }}><textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (customPrompt.trim()) runAi('custom', customPrompt.trim()) } }} placeholder={scope === 'combination' ? '针对整个组合提问…' : scope === 'document' ? t('promptDocument') : t('promptSelection')} /><button disabled={!!busy || currentAiBusy || !customPrompt.trim()} onClick={() => runAi('custom', customPrompt.trim())}><Send size={17} /></button></div><small className="prompt-hint"><span className="prompt-mode-switches"><label className="reasoning-switch"><input type="checkbox" checked={deepThinking && aiConfig.reasoningEnabled} disabled={!aiConfig.reasoningEnabled} onChange={(event) => setDeepThinking(event.target.checked)} /><span className="switch-track"><i /></span><Sparkles size={12} />{t('deepThinking')}</label></span><span>{t('sendHint')} · <button onClick={() => setCustomPrompt('/')}>{t('chooseSkillHint')}</button></span></small></div>
  </div>

  const panelContent: Record<PanelId, ReactNode> = { projects: projectContent, selection: selectionContent, chat: chatContent, tags: tagContent }
  const panelMeta: Record<PanelId, { title: string; icon: ReactNode; actions?: ReactNode }> = {
    projects: { title: '文件', icon: <FolderOpen size={15} />, actions: <button onClick={() => setCreateCombinationSignal((value) => value + 1)} title="新建组合"><Combine size={15} /></button> }, selection: { title: t('selection'), icon: <MousePointer2 size={15} /> },
    chat: { title: '对话', icon: <BrainCircuit size={16} />, actions: <button onClick={createConversation} title={t('newConversation')}><Plus size={14} /></button> },
    tags: { title: '标签', icon: <Tag size={15} /> },
  }
  const renderPanel = (id: PanelId) => <WorkspacePanel key={id} id={id} title={panelMeta[id].title} icon={panelMeta[id].icon} actions={panelMeta[id].actions} layout={panelLayouts[id]} onChange={(layout) => updatePanel(id, layout)} onFocus={() => raisePanel(id)}>{panelContent[id]}</WorkspacePanel>
  const renderDockPanels = (ids: PanelId[]) => ids.map((id, index) => <Fragment key={id}>{renderPanel(id)}{index < ids.length - 1 && <div className="dock-splitter" onPointerDown={(event) => startDockSplitResize(id, ids[index + 1], event)} />}</Fragment>)

  return (
    <div className={`app-shell modern-shell activity-${activitySide}`}>
      {fileDragActive && <div className="file-drop-overlay"><div><FolderOpen size={32} /><strong>{t('dropToOpen')}</strong><small>{t('dropToOpenHelp')}</small></div></div>}
      {busy === 'convert' && <div className="conversion-overlay"><LoaderCircle className="spin" size={24} /><strong>{progress || t('convertingDocument')}</strong></div>}
      <ActivityBar
        openPanels={{ projects: panelLayouts.projects.open, selection: panelLayouts.selection.open, tags: panelLayouts.tags.open, chat: panelLayouts.chat.open }}
        hasSource={Boolean(source)}
        dark={dark}
        annotationActive={annotationMode}
        labels={{ conversations: t('conversations'), light: t('light'), dark: t('dark'), settings: t('settings') }}
        onTogglePanel={togglePanel}
        onToggleAnnotation={toggleAnnotationMode}
        onToggleTheme={() => setDark((value) => !value)}
        onOpenSettings={openSettings}
        onPanelOrderChange={updatePanelOrder}
        side={activitySide}
        onSideChange={setActivitySide}
      />
      <main className="workspace" style={{ '--selection-width': `${leftPanelIds.length ? leftDockWidth : 0}px`, '--ai-width': `${rightPanelIds.length ? rightDockWidth : 0}px` } as CSSProperties}>
        {leftPanelIds.length > 0 && <div className="dock-column dock-column-left">{renderDockPanels(leftPanelIds)}<div className="panel-resizer right" onPointerDown={(event) => startResize('left', leftDockWidth, event)} /></div>}

        <section className="reader-pane">
          {!source ? <div className="empty-reader"><img src="/app-icon.svg" alt="Raid" /><p>{t('emptyReaderPrompt')}</p></div> : <>
            <div className="reader-toolbar">
              <div className="reader-status-group">
                {annotationMode ? <div className="annotation-tools" role="toolbar" aria-label="批注工具">
                  <label className="annotation-color" title="批注颜色"><Palette size={13} /><input type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
                  <button className={annotationTool === 'text' ? 'active' : ''} onClick={() => setAnnotationTool('text')} title="文本批注"><Type size={14} /><span>文本</span></button>
                  <button className={annotationTool === 'ink' ? 'active' : ''} onClick={() => setAnnotationTool('ink')} title="墨迹"><PenLine size={14} /><span>墨迹</span></button>
                  {annotationTool === 'ink' && <label className="annotation-width" title={`墨迹粗细 ${Math.round(annotationStrokeWidth * 1000)}`}><input type="range" min="1" max="12" step="1" value={annotationStrokeWidth * 1000} onChange={(event) => { const value = Number(event.target.value) / 1000; setAnnotationStrokeWidth(value); localStorage.setItem('reading-assistant-ink-width', String(value)) }} /></label>}
                  <button disabled={!annotations.some((annotation) => annotation.type === 'ink')} onClick={undoLastInkStroke} title="撤回上一笔"><Undo2 size={14} /><span>撤回</span></button>
                  <button className={annotationTool === 'eraser' ? 'active' : ''} onClick={() => setAnnotationTool('eraser')} title="擦除整条笔画"><Eraser size={14} /><span>橡皮</span></button>
                </div> : <div className="selection-mode-switch" role="group" aria-label="选择方式">
                  <button className={!areaSelectionEnabled ? 'active' : ''} onClick={() => setAreaSelectionEnabled(false)}><TextCursorInput size={14} /><span>{t('chooseText')}</span></button>
                  <button className={areaSelectionEnabled ? 'active' : ''} onClick={() => setAreaSelectionEnabled(true)}><MousePointer2 size={14} /><span>{t('chooseArea')}</span></button>
                </div>}
                {statusText && <div className="status"><span className={busy ? 'status-dot active' : 'status-dot'} /> {statusText}</div>}
              </div>
              {source.kind === 'pdf' && <div className="page-control">
                <button disabled={currentPage <= 1} onClick={() => turnPage(-1)} title={t('previousPage')}><ChevronLeft size={16} /></button>
                <input aria-label="页码" type="text" inputMode="numeric" value={pageInput} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))} onBlur={commitPageInput} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setPageInput(String(currentPage)); event.currentTarget.blur() } }} /><span>/ {pdf?.numPages || '…'}</span>
                <button disabled={!pdf || currentPage >= pdf.numPages} onClick={() => turnPage(1)} title={t('nextPage')}><ChevronRight size={16} /></button>
              </div>}
              <div className="reader-tools">
                <div className="zoom-control"><button onClick={() => setZoom((z) => Math.max(0.25, z - 0.1))}><Minus size={15} /></button><input aria-label="缩放倍率" type="text" inputMode="numeric" value={zoomInput} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setZoomInput(event.target.value.replace(/\D/g, ''))} onBlur={commitZoomInput} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setZoomInput(String(Math.round(zoom * 100))); event.currentTarget.blur() } }} /><span>%</span><button onClick={() => setZoom((z) => Math.min(5, z + 0.1))}><Plus size={15} /></button></div>
              </div>
            </div>
            <div className="reader-scroll" ref={readerScrollRef} onScroll={onReaderScroll} onWheel={onReaderWheel}><Suspense fallback={<div className="viewer-state"><span className="spinner" /><p>{t('loadingPdf')}</p></div>}><DocumentViewer key={source.url} source={source} zoom={zoom} currentPage={currentPage} inverted={dark} areaSelectionEnabled={areaSelectionEnabled} tagMode={tagMode} tags={(currentProject?.tags || []).filter((tag) => tag.fileId === activeFileId)} onCreateTag={addTagAt} onMoveTag={moveTag} onPdfReady={onPdfReady} onSelect={onSelect} onTextAi={addTextToAi} onTextTranslate={translateTextInline} highlights={highlights} onHighlight={toggleHighlight} citationFocus={citationFocus} annotationMode={annotationMode} annotationTool={annotationTool} annotationColor={annotationColor} annotationStrokeWidth={annotationStrokeWidth} annotations={annotations} onAnnotationsChange={setAnnotations} /></Suspense></div>
          </>}</section>
        {rightPanelIds.length > 0 && <div className="dock-column dock-column-right"><div className="panel-resizer left" onPointerDown={(event) => startResize('right', rightDockWidth, event)} />{renderDockPanels(rightPanelIds)}</div>}
        {floatingPanelIds.map(renderPanel)}
        </main>
      {settingsOpen && <Suspense fallback={null}><AiSettingsModal
          value={aiConfig}
          serverConfigured={Boolean(configured)}
          skills={skills}
          language={pack.code}
          languages={getLanguagePacks()}
          memorySettings={memorySettings}
          userMemory={userMemory}
          shortcutSettings={shortcutSettings}
          onClose={() => setSettingsOpen(false)}
          onImportSkill={importSkillFolder}
          onRemoveSkill={removeSkill}
          onImportLanguage={importLanguageFolder}
          onLanguageChange={changeLanguage}
          onMemorySettingsChange={changeMemorySettings}
          onUserMemoryChange={changeUserMemory}
          onShortcutSettingsChange={(settings) => { setShortcutSettings(settings); localStorage.setItem('reading-assistant-shortcuts', JSON.stringify(settings)) }}
          onSave={(config) => {
            setAiConfig(config)
            if (!config.reasoningEnabled) setDeepThinking(false)
            localStorage.setItem('reading-assistant-ai-config', JSON.stringify(config))
          }}
        /></Suspense>}
    </div>
  )
}
