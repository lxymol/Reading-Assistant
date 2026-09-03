import { Fragment, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Worker as OcrWorker } from 'tesseract.js'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import {
  BrainCircuit, Check, ChevronLeft, ChevronRight, Copy, FileText, Languages, FolderOpen,
  Eraser, Lightbulb, LoaderCircle, MessageSquareText, Minus, Palette, PenLine,
  Plus, Puzzle, Send, Sparkles, MousePointer2, TextCursorInput, Type, X, StickyNote, Square, Tag,
} from 'lucide-react'
import ActivityBar from './components/ActivityBar'
import NoteEditor from './components/NoteEditor'
import ProjectExplorer from './components/ProjectExplorer'
import TagPanel from './components/TagPanel'
import WorkspacePanel from './components/WorkspacePanel'
import type { DocumentReference } from './lib/pdf'
import type { AiAction, AiConfig, AnnotationTool, CapturedSelection, ChatMessage, ChatReference, Conversation, DocumentAnnotation, DocumentHighlight, DocumentTag, ImportedSkill, MemorySettings, NormalizedRegion, PanelId, PanelLayout, ProjectSummary, ReaderLocation, RuntimeProject, RuntimeProjectFile, SelectionResult, SourceFile, TextAnnotation } from './types'
import { getLanguagePacks, registerLanguagePack, useI18n, type AppLanguage, type LanguagePack } from './i18n'
import { parseLanguageImport, parseSkillImport } from './lib/imports'
import { loadAiConfig, loadDarkTheme, loadMemorySettings, loadPanelLayouts, loadSkills, loadUserMemory } from './lib/preferences'
import { projectRepository } from './services/projectRepository'
import { stableTextHash } from './services/layoutAnalyzer'
import { retrievalService } from './services/retrievalService'
import { createCitationContext, createReferences, validateReference } from './services/citationService'
import { inlineCitationsToMarkdown, referenceNumberFromHref } from './services/inlineCitation'
import { NavigationService } from './services/navigationService'
import { ReaderController } from './services/readerController'
import { createTag, tagsWithoutFile } from './services/tagStore'

const DocumentViewer = lazy(() => import('./components/DocumentViewer'))
const AiSettingsModal = lazy(() => import('./components/AiSettingsModal'))
const documentIndexVersion = 1


const makeId = () => crypto.randomUUID()
const nextPanelZ = (items: Record<PanelId, PanelLayout>) => Math.max(40, ...Object.values(items).map((item) => item.z)) + 1
const normalizePanelZ = (items: Record<PanelId, PanelLayout>) => Object.fromEntries(
  (Object.entries(items) as [PanelId, PanelLayout][])
    .sort(([, first], [, second]) => first.z - second.z)
    .map(([id, layout], index) => [id, { ...layout, z: 41 + index }]),
) as Record<PanelId, PanelLayout>
const normalizeAssistantMarkdown = (content: string, references?: ChatReference[]) => inlineCitationsToMarkdown(content, references)
  .replace(/```(?:latex|tex)\s*([\s\S]*?)```/gi, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
  .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
  .replace(/\\\((.*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`)

function CopyMessageButton({ content, copyLabel }: { content: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1600)
    } catch { /* Clipboard permission errors leave the button unchanged. */ }
  }
  return <button className={copied ? 'copied' : ''} onClick={() => void copy()} title={copyLabel}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
}

type AiStreamEvent = { type: 'delta'; delta: string } | { type: 'done'; content: string; references?: ChatReference[]; model?: string; skillName?: string } | { type: 'error'; error: string }
type AiDoneEvent = Extract<AiStreamEvent, { type: 'done' }>

const readAiStream = async (response: Response, onEvent: (event: AiStreamEvent) => void): Promise<AiDoneEvent> => {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `AI request failed (${response.status})`)
  }
  if (!response.body) throw new Error('AI response stream is unavailable.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent: AiDoneEvent | null = null
  const processLine = (line: string) => {
    if (!line.trim()) return
    let event: AiStreamEvent
    try { event = JSON.parse(line) as AiStreamEvent } catch { return }
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'done') doneEvent = event
    onEvent(event)
  }
  while (true) {
    const next = await reader.read()
    buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done })
    const lines = buffer.split(/\r?\n/)
    buffer = next.done ? '' : lines.pop() || ''
    for (const line of lines) processLine(line)
    if (next.done) break
  }
  if (buffer) processLine(buffer)
  if (!doneEvent) throw new Error('AI response ended before completion.')
  return doneEvent as AiDoneEvent
}

const recentSelectionHistory = (messages: ChatMessage[]) => {
  let inferredMode: ChatMessage['contextMode']
  return messages.map((message) => {
    if (message.role === 'user') {
      inferredMode = message.contextMode
        || (/选区|selected/i.test(message.label || '') ? 'selection' : /项目|project/i.test(message.label || '') ? 'project' : /全文|document/i.test(message.label || '') ? 'document' : undefined)
    }
    const contextMode = message.contextMode || (message.citationsDisabled ? 'selection' : inferredMode)
    return { message, contextMode }
  }).filter(({ message, contextMode }) => contextMode === 'selection' && message.content.length <= 12000)
    .slice(-4)
    .map(({ message }) => ({
      role: message.role,
      content: (message.role === 'user' && message.prompt ? `${message.prompt}\n【当时选区】\n${message.content}` : message.content).slice(0, 4000),
    }))
}

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
  const [, setDocumentText] = useState('')
  const [selectedText, setSelectedText] = useState('')
  const [selections, setSelections] = useState<CapturedSelection[]>([])
  const [initialConversationId] = useState<string>(() => makeId())
  const [conversations, setConversations] = useState<Conversation[]>(() => [{ id: initialConversationId, title: t('untitledConversation'), history: [] }])
  const [activeConversationId, setActiveConversationId] = useState(initialConversationId)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [customPrompt, setCustomPrompt] = useState('')
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoomInput, setZoomInput] = useState('100')
  const [areaSelectionEnabled, setAreaSelectionEnabled] = useState(false)
  const [scope, setScope] = useState<'selection' | 'document' | 'project'>('selection')
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
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectMemories, setProjectMemories] = useState<ProjectSummary[]>([])
  const [aiConfig, setAiConfig] = useState<AiConfig>(loadAiConfig)
  const [skills, setSkills] = useState<ImportedSkill[]>(loadSkills)
  const [memorySettings, setMemorySettings] = useState<MemorySettings>(loadMemorySettings)
  const [userMemory, setUserMemory] = useState(loadUserMemory)
  const [deepThinking, setDeepThinking] = useState(false)
  const [note, setNote] = useState('')
  const [noteAssets, setNoteAssets] = useState<Record<string, string>>({})
  const [highlights, setHighlights] = useState<DocumentHighlight[]>([])
  const [citationFocus, setCitationFocus] = useState<DocumentReference | null>(null)
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([])
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('ink')
  const [annotationColor, setAnnotationColor] = useState('#2f6fed')
  const [tagMode, setTagMode] = useState(false)
  const [recentTagId, setRecentTagId] = useState<string | null>(null)
  const [navigationDepth, setNavigationDepth] = useState(0)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [panelLayouts, setPanelLayouts] = useState(() => normalizePanelZ(loadPanelLayouts()))
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(['projects', 'selection', 'notes', 'tags', 'chat'])
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const hasVisualSelection = aiConfig.visionEnabled && selections.some((item) => item.images.length > 0)
  const selectionReady = Boolean(selectedText || hasVisualSelection)
  const workerRef = useRef<OcrWorker | null>(null)
  const workerPromiseRef = useRef<Promise<OcrWorker> | null>(null)
  const fileDragDepthRef = useRef(0)
  const showOcrProgressRef = useRef(false)
  const resultsEndRef = useRef<HTMLDivElement>(null)
  const panelScrollRef = useRef<HTMLDivElement>(null)
  const chatAutoFollowRef = useRef(true)
  const chatFollowSuspendedRef = useRef(false)
  const chatWasStreamingRef = useRef(false)
  const chatPinnedScrollTopRef = useRef(0)
  const chatLastScrollTopRef = useRef(0)
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
  const userMemoryRef = useRef(userMemory)
  const memorySettingsRef = useRef(memorySettings)
  const memoryUpdateQueueRef = useRef<Promise<void>>(Promise.resolve())
  const navigationRef = useRef(new NavigationService())
  const readerControllerRef = useRef(new ReaderController())
  const currentAiTaskKey = activeProjectId ? `${activeProjectId}:${activeConversationId}` : ''
  const currentAiBusy = aiTasks.has(currentAiTaskKey)
  const slashSkillQuery = customPrompt.match(/^\/([^\s]*)$/)?.[1].toLocaleLowerCase()
  const skillSuggestions = slashSkillQuery === undefined ? [] : skills.filter((skill) => skill.command.toLocaleLowerCase().includes(slashSkillQuery) || skill.name.toLocaleLowerCase().includes(slashSkillQuery)).slice(0, 8)

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
    void projectRepository.list().then(setProjectMemories).catch(() => setProjectMemories([]))
  }

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((data) => setConfigured(data.configured)).catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    let active = true
    const applyRecords = (records: ProjectSummary[]) => {
      if (!active) return
      setProjectMemories(records)
      setProjects((existing) => {
        const restored = records.map((record): RuntimeProject => existing.find((project) => project.id === record.id) || {
          id: record.id, name: record.name, files: [], conversations: [], activeConversationId: '', activeFileId: record.activeFileId,
          projectNotes: '', projectNoteAssets: {}, tags: [], createdAt: record.updatedAt, updatedAt: record.updatedAt, hydrated: false,
        })
        const recordIds = new Set(records.map((record) => record.id))
        return [...restored, ...existing.filter((project) => !recordIds.has(project.id))]
      })
    }
    void projectRepository.list().then(applyRecords).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => () => { workerRef.current?.terminate() }, [])

  useLayoutEffect(() => {
    const container = panelScrollRef.current
    const wasStreaming = chatWasStreamingRef.current
    chatWasStreamingRef.current = currentAiBusy
    if (!container) return
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
    chatFollowSuspendedRef.current = false
    chatAutoFollowRef.current = true
    window.requestAnimationFrame(() => {
      const container = panelScrollRef.current
      if (container) {
        container.scrollTop = container.scrollHeight
        chatLastScrollTopRef.current = container.scrollTop
      }
    })
  }, [promptHeight, leftDockWidth, rightDockWidth, panelLayouts.chat.open, panelLayouts.chat.dock, panelLayouts.chat.height, panelLayouts.chat.dockSize])

  const stopFollowingOnUpwardWheel = (container: HTMLDivElement, deltaY: number, deltaMode: number) => {
    if (deltaY >= 0) return
    chatFollowSuspendedRef.current = true
    chatAutoFollowRef.current = false
    const multiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? container.clientHeight : 1
    chatPinnedScrollTopRef.current = Math.max(0, container.scrollTop + deltaY * multiplier)
  }

  const trackChatPosition = (container: HTMLDivElement) => {
    const top = container.scrollTop
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
    if (!project) return null
    const syncedConversations = conversations.map((item) => item.id === activeConversationId ? { ...item, history } : item)
    return {
      ...project,
      files: project.files.map((file) => file.id === activeFileId ? {
        ...file, source: source || file.source, pdf, sourceLoaded: Boolean(source || file.source),
        readingState: { page: currentPage, zoom, scrollTop: readerScrollRef.current?.scrollTop || 0 },
        highlights, annotations, updatedAt: Date.now(),
      } : file),
      conversations: syncedConversations, activeConversationId, activeFileId,
      projectNotes: note, projectNoteAssets: noteAssets, updatedAt: Date.now(), hydrated: true,
    }
  }, [activeProjectId, projects, conversations, activeConversationId, history, activeFileId, source, pdf, currentPage, zoom, highlights, annotations, note, noteAssets])

  useEffect(() => {
    if (!activeProjectId) return
    const timer = window.setTimeout(() => {
      const snapshot = snapshotCurrent()
      if (snapshot) void projectRepository.save(snapshot).then(() => projectRepository.list()).then(setProjectMemories).catch(() => undefined)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [activeProjectId, snapshotCurrent])

  const loadProjectFile = (project: RuntimeProject, file: RuntimeProjectFile | null) => {
    setActiveProjectId(project.id); activeProjectIdRef.current = project.id
    setActiveFileId(file?.id || null); activeFileIdRef.current = file?.id || null
    readerControllerRef.current.activate(project.id, file?.id || null)
    setSource(file?.source || null); setPdf(file?.pdf || null)
    setDocumentText(file?.paragraphs.map((paragraph) => paragraph.text).join('\n\n') || '')
    setSelectedText(''); setSelections([]); selectionsRef.current = []
    setConversations(project.conversations); setActiveConversationId(project.activeConversationId)
    activeConversationIdRef.current = project.activeConversationId
    setHistory(project.conversations.find((item) => item.id === project.activeConversationId)?.history || [])
    setCustomPrompt(''); setZoom(file?.readingState.zoom || 1); setCurrentPage(file?.readingState.page || 1)
    setNote(project.projectNotes || ''); setNoteAssets(project.projectNoteAssets || {})
    setHighlights(file?.highlights || []); setAnnotations(file?.annotations || [])
    setAnnotationMode(false); setTagMode(false); setCitationFocus(null); setError('')
    pendingPageRestoreRef.current = file?.readingState.page || 1
  }

  const hydrateProject = async (project: RuntimeProject) => {
    if (project.hydrated) return project
    const stored = await projectRepository.get(project.id)
    if (!stored) throw new Error(pack.code === 'en-US' ? 'The project is missing.' : '项目数据缺失。')
    return { ...stored, files: stored.files.map((file) => ({ ...file, sourceLoaded: false })), hydrated: true } as RuntimeProject
  }

  const hydrateProjectFile = async (project: RuntimeProject, fileId: string) => {
    const file = project.files.find((item) => item.id === fileId)
    if (!file) throw new Error(pack.code === 'en-US' ? 'The file no longer exists.' : '文件已被删除或不存在。')
    if (file.sourceLoaded && file.source) return { project, file }
    const blob = await projectRepository.getSource(project.id, file.id, file.type)
    if (!blob) throw new Error(pack.code === 'en-US' ? 'The project source file is missing.' : '项目源文件缺失。')
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
      project = await hydrateProject(project)
      const hydrated = await hydrateProjectFile(project, fileId)
      project = { ...hydrated.project, activeFileId: fileId }
      setProjects((items) => items.map((item) => item.id === projectId ? project! : snapshot && item.id === snapshot.id ? snapshot : item))
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
      const project = await hydrateProject(candidate)
      const fileId = project.activeFileId || project.files[0]?.id || null
      if (fileId) await openProjectFile(id, fileId)
      else {
        const snapshot = snapshotCurrent()
        if (snapshot) void projectRepository.save(snapshot)
        setProjects((items) => items.map((item) => item.id === id ? project : snapshot && item.id === snapshot.id ? snapshot : item))
        loadProjectFile(project, null)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('processFailed')) }
  }

  const createEmptyProject = (requestedName: string) => {
    const name = requestedName.trim()
    if (!name) return
    const conversation: Conversation = { id: makeId(), title: t('untitledConversation'), history: [] }
    const now = Date.now()
    const project: RuntimeProject = { id: makeId(), name, files: [], conversations: [conversation], activeConversationId: conversation.id, activeFileId: null, projectNotes: '', projectNoteAssets: {}, tags: [], createdAt: now, updatedAt: now, hydrated: true }
    const snapshot = snapshotCurrent()
    setProjects((items) => [...items.map((item) => snapshot && item.id === snapshot.id ? snapshot : item), project])
    loadProjectFile(project, null)
    void projectRepository.save(project).then(() => projectRepository.list()).then(setProjectMemories)
  }

  const openFile = async (file: File, targetProjectId: string | null = activeProjectId) => {
    let readableFile = file
    const lowerName = file.name.toLocaleLowerCase()
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(lowerName)
    if (!isPdf && !isImage) {
      if (!window.readingAssistant) { setError(t('desktopConversionOnly')); return }
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
        return
      } finally {
        setBusy(''); setProgress('')
      }
    }
    const snapshot = snapshotCurrent()
    let project = snapshot?.id === targetProjectId ? snapshot : projects.find((item) => item.id === targetProjectId)
    if (project && !project.hydrated) project = await hydrateProject(project)
    if (!project) {
      const conversation: Conversation = { id: makeId(), title: t('untitledConversation'), history: [] }
      const now = Date.now()
      project = { id: makeId(), name: readableFile.name.replace(/\.[^.]+$/, ''), files: [], conversations: [conversation], activeConversationId: conversation.id, activeFileId: null, projectNotes: '', projectNoteAssets: {}, tags: [], createdAt: now, updatedAt: now, hydrated: true }
    }
    const duplicate = project.files.find((item) => item.name === readableFile.name && item.size === readableFile.size && item.lastModified === readableFile.lastModified)
    if (duplicate) { await openProjectFile(project.id, duplicate.id); return }
    const now = Date.now()
    const fileId = makeId()
    const fileKind = readableFile.type === 'application/pdf' || readableFile.name.toLocaleLowerCase().endsWith('.pdf') ? 'pdf' : 'image'
    const projectFile: RuntimeProjectFile = {
      id: fileId, projectId: project.id, name: readableFile.name, kind: fileKind, type: readableFile.type || (fileKind === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      size: readableFile.size, lastModified: readableFile.lastModified, createdAt: now, updatedAt: now,
      readingState: { page: 1, zoom: 1, scrollTop: 0 }, highlights: [], annotations: [], paragraphs: [],
      indexState: { status: 'pending', version: documentIndexVersion },
      source: { name: readableFile.name, kind: fileKind, url: URL.createObjectURL(readableFile), file: readableFile }, pdf: null, sourceLoaded: true,
    }
    project = { ...project, files: [...project.files, projectFile], activeFileId: fileId, updatedAt: now, hydrated: true }
    await projectRepository.saveSource(project.id, fileId, readableFile)
    await projectRepository.save(project)
    setProjects((items) => {
      const without = items.filter((item) => item.id !== project!.id).map((item) => snapshot && item.id === snapshot.id ? snapshot : item)
      return [...without, project!]
    })
    loadProjectFile(project, projectFile)
    setProjectMemories(await projectRepository.list())
  }

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
    setError('')
  }

  const createConversation = () => {
    const conversation: Conversation = { id: makeId(), title: t('untitledConversation'), history: [] }
    setConversations([...syncCurrentConversation(), conversation])
    setActiveConversationId(conversation.id)
    activeConversationIdRef.current = conversation.id
    setHistory([])
    setCustomPrompt('')
    setError('')
  }

  const createConversationForArea = async (areaId: string) => {
    setCollapsedProjectIds((items) => { const next = new Set(items); next.delete(areaId); return next })
    if (areaId === activeProjectId) createConversation()
    else {
      const storedTarget = projects.find((item) => item.id === areaId)
      if (!storedTarget) return
      let target: RuntimeProject
      try { target = await hydrateProject(storedTarget) }
      catch (reason) { setError(reason instanceof Error ? reason.message : t('processFailed')); return }
      const snapshot = snapshotCurrent()
      const conversation: Conversation = { id: makeId(), title: t('untitledConversation'), history: [] }
      const next = { ...target, conversations: [...target.conversations, conversation], activeConversationId: conversation.id }
      let readyProject: RuntimeProject = next
      let readyFile: RuntimeProjectFile | null = null
      if (next.activeFileId) {
        const hydrated = await hydrateProjectFile(next, next.activeFileId)
        readyProject = hydrated.project; readyFile = hydrated.file
      }
      setProjects((items) => items.map((item) => snapshot && item.id === snapshot.id ? snapshot : item).map((item) => item.id === areaId ? readyProject : item))
      loadProjectFile(readyProject, readyFile)
    }
    setPanelLayouts((items) => ({ ...items, chat: { ...items.chat, open: true, z: nextPanelZ(items) } }))
  }

  const deleteConversation = (id: string) => {
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
      if ((event.target as HTMLElement | null)?.closest('.note-editor')) return
      const image = Array.from(event.clipboardData?.files || []).find((file) => file.type.startsWith('image/'))
      if (image) openFile(new File([image], `${t('pastedImage')}-${new Date().toLocaleTimeString().replaceAll(':', '-')}.png`, { type: image.type }))
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
      const file = event.dataTransfer?.files?.[0]
      if (file) void openFile(file)
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
    if (projectId && fileId) setProjects((items) => items.map((project) => project.id === projectId ? { ...project, files: project.files.map((file) => file.id === fileId ? { ...file, pdf: document } : file) } : project))
  }, [])

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

  const getWorker = useCallback(async () => {
    if (!workerPromiseRef.current) {
      workerPromiseRef.current = import('tesseract.js').then(({ createWorker }) => createWorker(['chi_sim', 'eng'], 1, {
        logger: (message) => {
          if (showOcrProgressRef.current && message.status === 'recognizing text') setProgress(`${t('recognizing')} ${Math.round((message.progress || 0) * 100)}%`)
        },
      })).then((worker) => {
        workerRef.current = worker
        return worker
      }).catch((reason) => {
        workerPromiseRef.current = null
        throw reason
      })
    }
    return workerPromiseRef.current
  }, [t])

  const recognize = useCallback(async (image: string) => {
    showOcrProgressRef.current = true
    setProgress(t('preparingOcr'))
    const worker = await getWorker()
    try {
      const result = await worker.recognize(image)
      return result.data.text.trim()
    } finally {
      showOcrProgressRef.current = false
    }
  }, [getWorker, t])

  const onSelect = async (result: SelectionResult) => {
    const selectionId = makeId()
    const captured: CapturedSelection = { ...result, id: selectionId, text: '', textParts: result.images.map(() => ''), loading: true }
    setSelections((items) => { const next = [...items, captured]; selectionsRef.current = next; return next })
    setScope('selection')
    setBusy('ocr')
    setError('')
    try {
      const textParts: string[] = result.images.map(() => '')
      for (let index = 0; index < result.regions.length; index += 1) {
        const selectedRegion = result.regions[index]
        let part = ''
        if (source?.kind === 'pdf' && pdf) {
          setProgress(t('readingPdfText'))
          const { extractPdfRegionText } = await import('./lib/pdf')
          part = await extractPdfRegionText(pdf, selectedRegion.page, selectedRegion.region)
        }
        if (!part && !aiConfig.visionEnabled) part = await recognize(result.images[index])
        const annotationText = result.annotationTexts?.[index]?.trim() || ''
        textParts[index] = [part, annotationText && `批注：${annotationText}`].filter(Boolean).join('\n')
      }
      const current = selectionsRef.current.find((item) => item.id === selectionId)
      if (!current) return
      const survivingParts = current.images.map((image) => textParts[result.images.indexOf(image)] || '')
      const text = survivingParts.filter(Boolean).join('\n\n')
      setSelections((items) => { const next = items.map((item) => item.id === selectionId ? { ...item, text, textParts: survivingParts, loading: false } : item); selectionsRef.current = next; return next })
      if (text) setSelectedText((previous) => [previous, text].filter(Boolean).join('\n\n'))
      if (!text && !aiConfig.visionEnabled) setError(t('noText'))
    } catch (reason) {
      setSelections((items) => { const next = items.map((item) => item.id === selectionId ? { ...item, loading: false } : item); selectionsRef.current = next; return next })
      setError(reason instanceof Error ? `${t('ocrFailed')}: ${reason.message}` : t('ocrFailed'))
    } finally {
      setBusy('')
      setProgress('')
    }
  }

  const removeSelectionImage = (selectionId: string, imageIndex: number) => {
    const target = selectionsRef.current.find((item) => item.id === selectionId)
    if (!target) return
    const removedText = target.textParts[imageIndex] || ''
    const images = target.images.filter((_, index) => index !== imageIndex)
    const regions = target.regions.filter((_, index) => index !== imageIndex)
    const textParts = target.textParts.filter((_, index) => index !== imageIndex)
    const text = textParts.filter(Boolean).join('\n\n')
    const nextSelection = { ...target, image: images[0] || '', images, regions, textParts, text }
    const nextSelections = images.length || text ? selectionsRef.current.map((item) => item.id === selectionId ? nextSelection : item) : selectionsRef.current.filter((item) => item.id !== selectionId)
    selectionsRef.current = nextSelections
    setSelections(nextSelections)
    if (removedText) setSelectedText((previous) => {
      const index = previous.indexOf(removedText)
      if (index < 0) return previous
      return `${previous.slice(0, index)}${previous.slice(index + removedText.length)}`.replace(/\n{3,}/g, '\n\n').trim()
    })
  }

  useEffect(() => {
    if (!source || !activeProjectId || !activeFileId || (source.kind === 'pdf' && !pdf)) return
    const project = projects.find((item) => item.id === activeProjectId)
    const file = project?.files.find((item) => item.id === activeFileId)
    if (!project || !file || file.indexState.status === 'indexing' || file.indexState.status === 'ready') return
    const timer = window.setTimeout(() => {
      const indexing = { ...file, indexState: { status: 'indexing' as const, version: documentIndexVersion } }
      setProjects((items) => items.map((item) => item.id === project.id ? { ...item, files: item.files.map((entry) => entry.id === file.id ? indexing : entry) } : item))
      const task = source.kind === 'pdf' && pdf
        ? import('./services/documentIndexer').then(({ documentIndexer }) => documentIndexer.indexPdf(pdf, project.id, file.id, (done, total) => setProgress(`${t('extracting')} ${done}/${total}`)))
        : recognize(source.url).then((text) => ({
            paragraphs: text.trim() ? [{ id: `${file.id}:image`, projectId: project.id, fileId: file.id, page: 1, region: { left: .02, top: .02, width: .96, height: .96 }, text: text.replace(/\s+/g, ' ').trim(), textHash: `${text.length}:${text.slice(0, 40)}`, order: 0 }] : [],
            state: { status: 'ready' as const, version: documentIndexVersion, indexedAt: Date.now() },
          }))
      void task.then(async ({ paragraphs, state }) => {
        if (source.kind === 'pdf' && pdf && paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) < 80) {
          const ocrParagraphs = []
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            setProgress(`${t('scannedOcr')} ${pageNumber}/${pdf.numPages}`)
            const page = await pdf.getPage(pageNumber)
            const viewport = page.getViewport({ scale: 1.25 })
            const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
            const context = canvas.getContext('2d')
            if (context) {
              await page.render({ canvasContext: context, viewport, canvas }).promise
              const text = (await recognize(canvas.toDataURL('image/jpeg', .9))).replace(/\s+/g, ' ').trim()
              if (text) ocrParagraphs.push({ id: `${file.id}:ocr:${pageNumber}`, projectId: project.id, fileId: file.id, page: pageNumber, region: { left: .02, top: .02, width: .96, height: .96 }, text, textHash: stableTextHash(text), order: ocrParagraphs.length })
            }
            page.cleanup()
          }
          if (ocrParagraphs.length) paragraphs = ocrParagraphs
        }
        setDocumentText(paragraphs.map((paragraph) => paragraph.text).join('\n\n'))
        setProjects((items) => items.map((item) => item.id === project.id ? { ...item, updatedAt: Date.now(), files: item.files.map((entry) => entry.id === file.id ? { ...entry, paragraphs, indexState: state, updatedAt: Date.now() } : entry) } : item))
      }).catch((reason) => {
        setProjects((items) => items.map((item) => item.id === project.id ? { ...item, files: item.files.map((entry) => entry.id === file.id ? { ...entry, indexState: { status: 'error', version: documentIndexVersion, error: reason instanceof Error ? reason.message : String(reason) } } : entry) } : item))
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [source, pdf, activeProjectId, activeFileId, projects, recognize, t])

  const buildProjectContext = (workspaceId: string, query: string, action: AiAction, fileId?: string) => {
    const project = snapshotCurrent()?.id === workspaceId ? snapshotCurrent() : projects.find((item) => item.id === workspaceId)
    if (!project) return { context: '', references: [] }
    const strategy = fileId ? 'document' : 'project'
    const coverageRatio = action === 'summarize' || action === 'translate' ? (fileId ? .78 : .65) : undefined
    const result = retrievalService.retrieve(project, query, { strategy, coverageRatio, fileId, maxHits: 24, maxCharacters: 39000 })
    const references = createReferences(project, result.hits, 24)
    return { context: createCitationContext(references), references }
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

  const deleteProject = async (projectId: string) => {
    const target = projects.find((project) => project.id === projectId)
    target?.files.forEach((file) => { if (file.source?.url) URL.revokeObjectURL(file.source.url) })
    await projectRepository.deleteProject(projectId)
    const remaining = projects.filter((project) => project.id !== projectId)
    setProjects(remaining)
    navigationRef.current.clear(); setNavigationDepth(0)
    if (projectId === activeProjectId) {
      const next = remaining.at(-1)
      if (next) await openProject(next.id)
      else { setActiveProjectId(null); setActiveFileId(null); activeProjectIdRef.current = null; activeFileIdRef.current = null; readerControllerRef.current.clear(); setSource(null); setAnnotations([]); setAnnotationMode(false); setTagMode(false) }
    }
    setProjectMemories(await projectRepository.list())
  }

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
    let conversationId = activeConversationId
    let previousHistory = history
    if (!conversationId || !conversations.some((item) => item.id === conversationId)) {
      const conversation: Conversation = { id: makeId(), title: t('untitledConversation'), history: [] }
      conversationId = conversation.id
      previousHistory = []
      setConversations((items) => [...items, conversation])
      setActiveConversationId(conversationId)
      activeConversationIdRef.current = conversationId
      setHistory([])
    }
    const taskKey = `${workspaceId}:${conversationId}`
    if (aiTasks.has(taskKey)) return
    chatFollowSuspendedRef.current = false
    chatAutoFollowRef.current = true
    const targetUsesContext = scope !== 'selection'
    const targetIsProject = scope === 'project'
    const selectionImages = targetUsesContext ? [] : selections.flatMap((item) => item.images).slice(0, 4)
    const selectionUsesText = !targetUsesContext && Boolean(selectedText.trim())
    const fastSelectionTranslation = selectionUsesText && action === 'translate'
    const requestImages = selectionUsesText ? [] : selectionImages
    const reasoningActive = deepThinking && aiConfig.reasoningEnabled
    const actionLabel = (requestedSkillId ? skills.find((skill) => skill.id === requestedSkillId)?.name : effectiveInstruction) || ({ translate: t('translate'), explain: t('explain'), insight: t('insight'), summarize: t('summarize'), custom: 'AI' }[action])
    const emptySelectionChat = !targetUsesContext && !selectionUsesText && selectionImages.length === 0 && action === 'custom' && Boolean(effectiveInstruction)
    const scopeLabel = targetIsProject ? '项目' : targetUsesContext ? t('documentScope') : t('selectedScope')
    const userLabel = emptySelectionChat ? t('selectedScope') : `${scopeLabel} · ${actionLabel}`
    const activeProjectName = projects.find((item) => item.id === activeProjectId)?.name || source.name
    const targetText = targetIsProject ? `项目：${activeProjectName}` : targetUsesContext ? `文件：${source.name}` : emptySelectionChat ? effectiveInstruction : (selectedText || `视觉选区 · ${selections.flatMap((item) => item.images).length} 张图片`)
    const contextMode: ChatMessage['contextMode'] = scope
    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: targetText, prompt: effectiveInstruction || actionLabel, contextMode, label: userLabel, sourcePage: currentPage }
    const assistantId = makeId()
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', contextMode, citationsDisabled: !targetUsesContext }
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
    try {
      const retrieval = targetUsesContext ? buildProjectContext(workspaceId, effectiveInstruction || actionLabel, action, targetIsProject ? undefined : activeFileId || undefined) : { context: '', references: [] }
      const targetProject = snapshotCurrent()
      const annotationContext = !targetUsesContext ? '' : targetIsProject
        ? (targetProject?.files || []).flatMap((file) => file.annotations.filter((annotation): annotation is TextAnnotation => annotation.type === 'text' && Boolean(annotation.text.trim())).map((annotation) => `[${file.name}｜第 ${annotation.page} 页批注]\n${annotation.text.trim()}`)).join('\n\n')
        : annotations.filter((annotation): annotation is TextAnnotation => annotation.type === 'text' && Boolean(annotation.text.trim())).map((annotation) => `[第 ${annotation.page} 页批注]\n${annotation.text.trim()}`).join('\n\n')
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({
          action,
          selectedText: targetUsesContext ? '' : selectedText,
          documentText: [retrieval.context, annotationContext].filter(Boolean).join('\n\n'),
          references: retrieval.references,
          instruction: effectiveInstruction,
          includeContext: targetUsesContext && Boolean(retrieval.context),
          contextMode,
          anchorPages: targetUsesContext ? [] : Array.from(new Set(selections.flatMap((item) => item.regions.map((region) => region.page)).concat(currentPage))),
          history: targetUsesContext ? previousHistory.map(({ role, content, prompt }) => ({ role, content: role === 'user' ? prompt || content : content })) : recentSelectionHistory(previousHistory),
          aiConfig,
          deepThinking: fastSelectionTranslation ? false : reasoningActive,
          responseLanguage: pack.aiLanguage,
          userMemory: targetUsesContext && memorySettings.userMemoryEnabled ? userMemoryRef.current : '',
          selectionHasImages: requestImages.length > 0,
          selectionImages: aiConfig.visionEnabled ? requestImages : [],
          skills: targetUsesContext || requestedSkillId ? skills.map(({ id, name, command, description, instructions }) => ({ id, name, command, description, instructions })) : [],
          requestedSkillId,
        }),
      })
      let streamedContent = ''
      const done = await readAiStream(response, (event) => {
        if (event.type === 'delta') {
          streamedContent += event.delta
          updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((message) => message.id === assistantId ? { ...message, content: streamedContent } : message) }))
        }
        if (event.type === 'done') {
          streamedContent = event.content
          updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((message) => message.id === assistantId ? { ...message, content: event.content, label: event.skillName ? `${t('skillUsed')} · ${event.skillName}` : undefined, references: targetUsesContext && Array.isArray(event.references) ? event.references : undefined } : message) }))
        }
      })
      learnUserMemory(effectiveInstruction || actionLabel, done.content)
    } catch (reason) {
      const message = requestController.signal.aborted ? (pack.code === 'en-US' ? 'Generation stopped.' : '已停止生成。') : reason instanceof Error ? reason.message : t('processFailed')
      updateConversationRoute(workspaceId, conversationId, (conversation) => ({ ...conversation, history: conversation.history.map((item) => item.id === assistantId ? { ...item, content: item.content ? `${item.content}\n\n⚠️ ${message}` : `⚠️ ${message}` } : item) }))
    } finally {
      abortControllersRef.current.delete(taskKey)
      setAiTasks((items) => { const next = new Set(items); next.delete(taskKey); return next })
      selectionsRef.current = []; setSelections([]); setSelectedText('')
    }
  }

  const stopAi = () => {
    if (currentAiTaskKey) abortControllersRef.current.get(currentAiTaskKey)?.abort()
  }

  const deleteMessage = (id: string) => {
    const next = history.filter((message) => message.id !== id)
    setHistory(next)
    setConversations((items) => items.map((item) => item.id === activeConversationId ? { ...item, history: next } : item))
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
    const opened = await openProjectFile(location.projectId, location.fileId)
    if (!opened) return false
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
    const tag = createTag(activeProjectId, activeFileId, page, region, '')
    setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, tags: [...project.tags, tag], updatedAt: Date.now() } : project))
    setRecentTagId(tag.id)
    setCitationFocus({ page, region })
    window.setTimeout(() => setCitationFocus(null), 1800)
  }

  const addTextToAi = (text: string) => {
    const selectionId = makeId()
    setSelections((items) => { const next = [...items, { id: selectionId, image: '', images: [], page: currentPage, regions: [], text, textParts: [text], loading: false }]; selectionsRef.current = next; return next })
    setSelectedText((previous) => [previous, text].filter(Boolean).join('\n\n'))
    setScope('selection')
    setPanelLayouts((items) => ({ ...items, chat: { ...items.chat, open: true, z: nextPanelZ(items) } }))
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
        deepThinking: deepThinking && aiConfig.reasoningEnabled,
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
    setPanelLayouts((items) => ({ ...items, [id]: layout }))
  }
  const raisePanel = (id: PanelId) => setPanelLayouts((items) => ({ ...items, [id]: { ...items[id], z: nextPanelZ(items) } }))
  const togglePanel = (id: PanelId) => {
    if (id === 'tags' && panelLayouts.tags.open) setRecentTagId(null)
    setPanelLayouts((items) => ({ ...items, [id]: { ...items[id], open: !items[id].open, z: nextPanelZ(items) } }))
  }
  const updatePanelOrder = useCallback((next: PanelId[]) => setPanelOrder((current) => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next), [])
  const toggleAnnotationMode = () => {
    setAnnotationMode((active) => {
      if (!active) {
        setAreaSelectionEnabled(false)
        setTagMode(false)
        window.getSelection()?.removeAllRanges()
      }
      return !active
    })
  }
  const toggleTagMode = () => {
    const next = !tagMode
    if (next) {
      setAreaSelectionEnabled(false); setAnnotationMode(false); window.getSelection()?.removeAllRanges()
    }
    setTagMode(next)
  }
  const panelPosition = (id: PanelId) => {
    const index = panelOrder.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const visiblePanelIds = (Object.keys(panelLayouts) as PanelId[])
    .filter((id) => panelLayouts[id].open && (id === 'projects' || ((id === 'notes' || id === 'tags') && Boolean(activeProjectId)) || Boolean(source)))
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

  const openProjectNotes = (areaId: string) => {
    void openProject(areaId)
    setPanelLayouts((items) => ({ ...items, notes: { ...items.notes, open: true, z: nextPanelZ(items) } }))
  }
  const toggleProjectConversations = (areaId: string) => {
    if (areaId !== activeProjectId) void openProject(areaId)
    setCollapsedProjectIds((items) => {
      const next = new Set(items)
      if (areaId === activeProjectId && !next.has(areaId)) next.add(areaId)
      else next.delete(areaId)
      return next
    })
  }
  const openProjectConversation = (conversationId: string) => {
    openConversation(conversationId)
    setPanelLayouts((items) => ({ ...items, chat: { ...items.chat, open: true, z: nextPanelZ(items) } }))
  }
  const currentProject = projects.find((project) => project.id === activeProjectId)
  const confirmDeleteProject = (projectId: string) => {
    if (window.confirm('删除项目将永久删除其中全部文件、对话、笔记、标签、批注、高亮、资源和索引。继续吗？')) void deleteProject(projectId)
  }
  const deleteProjectFile = async (projectId: string, fileId: string) => {
    const base = snapshotCurrent()?.id === projectId ? snapshotCurrent() : projects.find((project) => project.id === projectId)
    if (!base || !window.confirm('删除文件将永久删除该文件的阅读位置、高亮、批注、文件笔记、标签、资源和索引。继续吗？')) return
    const removed = base.files.find((file) => file.id === fileId)
    if (removed?.source?.url) URL.revokeObjectURL(removed.source.url)
    const files = base.files.filter((file) => file.id !== fileId)
    const next: RuntimeProject = { ...base, files, tags: tagsWithoutFile(base.tags, fileId), activeFileId: base.activeFileId === fileId ? files[0]?.id || null : base.activeFileId, updatedAt: Date.now() }
    await projectRepository.deleteFile(projectId, fileId)
    await projectRepository.save(next)
    setProjects((items) => items.map((project) => project.id === projectId ? next : project))
    if (projectId === activeProjectId && fileId === activeFileId) {
      if (next.activeFileId) {
        const hydrated = await hydrateProjectFile(next, next.activeFileId)
        setProjects((items) => items.map((project) => project.id === projectId ? hydrated.project : project))
        loadProjectFile(hydrated.project, hydrated.file)
      } else loadProjectFile(next, null)
    }
    setProjectMemories(await projectRepository.list())
  }
  const deleteTag = (id: string) => {
    if (id === recentTagId) setRecentTagId(null)
    setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, tags: project.tags.filter((tag) => tag.id !== id), updatedAt: Date.now() } : project))
  }
  const renameTag = (id: string, label: string) => {
    if (id === recentTagId) setRecentTagId(null)
    setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, tags: project.tags.map((tag) => tag.id === id ? { ...tag, label } : tag), updatedAt: Date.now() } : project))
  }
  const moveTag = (id: string, region: NormalizedRegion) => setProjects((items) => items.map((project) => project.id === activeProjectId ? { ...project, tags: project.tags.map((tag) => tag.id === id ? { ...tag, region } : tag), updatedAt: Date.now() } : project))
  const projectContent = <ProjectExplorer
    projects={projects.map((project) => ({ id: project.id, name: project.name, busy: Array.from(aiTasks).some((key) => key.startsWith(`${project.id}:`)), files: project.files.map((file) => ({ id: file.id, name: file.name, indexStatus: file.indexState.status })) }))}
    activeProjectId={activeProjectId}
    activeFileId={activeFileId}
    activeConversationId={activeConversationId}
    conversations={conversations}
    collapsedProjectIds={collapsedProjectIds}
    onCreateProject={createEmptyProject}
    onOpenProject={openProject}
    onAddFile={(projectId, file) => openFile(file, projectId)}
    onOpenFile={(projectId, fileId) => void openProjectFile(projectId, fileId)}
    onDeleteFile={(projectId, fileId) => void deleteProjectFile(projectId, fileId)}
    onDeleteProject={confirmDeleteProject}
    onCreateConversation={createConversationForArea}
    onOpenNotes={openProjectNotes}
    onToggleProject={toggleProjectConversations}
    onOpenConversation={openProjectConversation}
    onDeleteConversation={deleteConversation}
  />
  const tagContent = <TagPanel tags={currentProject?.tags || []} files={currentProject?.files || []} tagMode={tagMode} recentTagId={recentTagId} canGoBack={navigationDepth > 0} onToggleTagMode={toggleTagMode} onBack={() => void navigateBack()} onOpen={openTag} onRename={renameTag} onDelete={deleteTag} />

  const selectionHasImages = selections.some((selection) => selection.images.length > 0)
  const selectionContent = <div className="selection-panel-body single" ref={selectionBodyRef}><section className="selection-content-section">
    <div className="section-label"><span>{t('selectedContent')} · {selections.length}</span>{selections.length > 0 && <button onClick={() => { selectionsRef.current = []; setSelections([]); setSelectedText('') }}><X size={14} /> {t('clear')}</button>}</div>
    {selections.length === 0 ? <div className="selection-empty"><MousePointer2 size={22} /></div> : <div className={`selection-result-split ${selectionHasImages ? 'with-images' : 'text-only'}`} ref={selectionSplitRef} style={selectionHasImages ? { gridTemplateRows: `minmax(72px, ${selectionSplitRatio}fr) 7px minmax(72px, ${1 - selectionSplitRatio}fr)` } : undefined}>{selectionHasImages && <div className="selection-image-pane" ref={selectionImagesRef}><div className="selection-strip">{selections.flatMap((selection) => selection.images.map((image, imageIndex) => <div className="selection-thumb" key={`${selection.id}-${imageIndex}`}><img src={image} alt="选区预览" />{selection.loading && <span><LoaderCircle className="spin" size={10} /></span>}<button className="remove-selection-image" onClick={() => removeSelectionImage(selection.id, imageIndex)}><X size={11} /></button></div>))}</div></div>}{selectionHasImages && <div className="section-resizer" role="separator" aria-label="调整选区图片与识别文字高度" aria-orientation="horizontal" title="拖动调整图片与识别文字高度" onPointerDown={startSelectionSplit} onPointerMove={moveSelectionSplit} onPointerUp={stopSelectionSplit} onPointerCancel={stopSelectionSplit} />}{busy === 'ocr' ? <div className="inline-loading selection-text-pane"><LoaderCircle className="spin" size={16} /> {progress}</div> : <textarea className="selection-text-pane" ref={selectionTextRef} value={selectedText} onChange={(e) => setSelectedText(e.target.value)} />}</div>}
  </section></div>

  const chatContent = <div className="chat-panel-layout">
    <section className="ai-fixed-controls">
      <div className="scope-switch" role="group" aria-label="AI 处理范围"><button className={scope === 'selection' ? 'active' : ''} onClick={() => setScope('selection')}>{t('selectedScope')}{selections.length > 0 && <span>{selections.length}</span>}</button><button className={scope === 'document' ? 'active' : ''} onClick={() => setScope('document')}>{t('documentScope')}</button><button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>对项目</button></div>
      <div className="action-grid"><button disabled={!!busy || currentAiBusy || (scope === 'selection' && !selectionReady)} onClick={() => runAi('translate')}><Languages /><span>{t('translate')}</span></button><button disabled={!!busy || currentAiBusy || (scope === 'selection' && !selectionReady)} onClick={() => runAi('explain')}><MessageSquareText /><span>{t('explain')}</span></button><button disabled={!!busy || currentAiBusy || (scope === 'selection' && !selectionReady)} onClick={() => runAi('insight')}><Lightbulb /><span>{t('insight')}</span></button><button disabled={!!busy || currentAiBusy || (scope === 'selection' && !selectionReady)} onClick={() => runAi('summarize')}><FileText /><span>{t('summarize')}</span></button></div>
    </section>
    <div className="panel-scroll" ref={panelScrollRef} onWheelCapture={(event) => stopFollowingOnUpwardWheel(event.currentTarget, event.deltaY, event.deltaMode)} onScroll={(event) => trackChatPosition(event.currentTarget)}>
      <section className="conversation">
        {history.map((message) => message.role === 'user'
          ? <div className="user-event" key={message.id}><span>{message.label}</span><small>{message.content.slice(0, 80)}{message.content.length > 80 ? '…' : ''}</small><button className="delete-message" onClick={() => deleteMessage(message.id)}><X size={12} /></button></div>
          : <article className="answer-card" key={message.id}>
              <div className="answer-actions"><CopyMessageButton content={message.content} copyLabel={t('copy')} /><button onClick={() => deleteMessage(message.id)}><X size={14} /></button></div>
              <div className="markdown" onClick={(event) => {
                const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#raid-reference-"]')
                if (!link) return
                const number = referenceNumberFromHref(link.getAttribute('href'))
                const reference = message.references?.find((item) => item.number === number)
                if (!reference) return
                event.preventDefault(); openReference(reference)
              }}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={defaultUrlTransform}>{normalizeAssistantMarkdown(message.content, message.references)}</ReactMarkdown></div>
            </article>)}
        {currentAiBusy && <div className="thinking"><LoaderCircle className="spin" size={18} /><span>{t('thinking')}</span><button onClick={stopAi}><Square size={13} />停止</button></div>}
        <div ref={resultsEndRef} />
      </section>
      {error && <div className="error-banner"><X size={15} /><span>{error}</span></div>}
    </div>
    <div className="prompt-area"><div className="prompt-height-resizer" onPointerDown={startPromptResize} role="separator" aria-orientation="horizontal" />{aiConfig.provider !== 'codex' && !aiConfig.apiKey && !configured && <button className="config-warning" onClick={openSettings}>{t('notConfigured')}</button>}{skillSuggestions.length > 0 && <div className="skill-command-menu">{skillSuggestions.map((skill) => <button key={skill.id} onClick={() => setCustomPrompt(`/${skill.command} `)}><Puzzle size={14} /><span><strong>/{skill.command}</strong><small>{skill.name}</small></span></button>)}</div>}<div className="prompt-box" style={{ height: promptHeight }}><textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (customPrompt.trim()) runAi('custom', customPrompt.trim()) } }} placeholder={scope === 'project' ? '针对整个项目提问…' : scope === 'document' ? t('promptDocument') : t('promptSelection')} /><button disabled={!!busy || currentAiBusy || !customPrompt.trim()} onClick={() => runAi('custom', customPrompt.trim())}><Send size={17} /></button></div><small className="prompt-hint"><label className="reasoning-switch"><input type="checkbox" checked={deepThinking && aiConfig.reasoningEnabled} disabled={!aiConfig.reasoningEnabled} onChange={(event) => setDeepThinking(event.target.checked)} /><span className="switch-track"><i /></span><Sparkles size={12} />{t('deepThinking')}</label><span>{t('sendHint')} · <button onClick={() => setCustomPrompt('/')}>{t('chooseSkillHint')}</button></span></small></div>
  </div>

  const notesContent = activeProjectId ? <NoteEditor fileName={currentProject?.name || '项目'} value={note} onChange={setNote} assets={noteAssets} onAssetsChange={setNoteAssets} /> : null
  const panelContent: Record<PanelId, ReactNode> = { projects: projectContent, selection: selectionContent, chat: chatContent, notes: notesContent, tags: tagContent }
  const panelMeta: Record<PanelId, { title: string; icon: ReactNode; actions?: ReactNode }> = {
    projects: { title: '项目', icon: <FolderOpen size={15} /> }, selection: { title: t('selection'), icon: <MousePointer2 size={15} /> },
    chat: { title: t('aiAssistant'), icon: <BrainCircuit size={16} />, actions: <button onClick={createConversation} title={t('newConversation')}><Plus size={14} /></button> }, notes: { title: '笔记', icon: <StickyNote size={15} /> },
    tags: { title: '标签', icon: <Tag size={15} /> },
  }
  const renderPanel = (id: PanelId) => <WorkspacePanel key={id} id={id} title={panelMeta[id].title} icon={panelMeta[id].icon} actions={panelMeta[id].actions} layout={panelLayouts[id]} onChange={(layout) => updatePanel(id, layout)} onFocus={() => raisePanel(id)}>{panelContent[id]}</WorkspacePanel>
  const renderDockPanels = (ids: PanelId[]) => ids.map((id, index) => <Fragment key={id}>{renderPanel(id)}{index < ids.length - 1 && <div className="dock-splitter" onPointerDown={(event) => startDockSplitResize(id, ids[index + 1], event)} />}</Fragment>)

  return (
    <div className="app-shell modern-shell">
      {fileDragActive && <div className="file-drop-overlay"><div><FolderOpen size={32} /><strong>{t('dropToOpen')}</strong><small>{t('dropToOpenHelp')}</small></div></div>}
      {busy === 'convert' && <div className="conversion-overlay"><LoaderCircle className="spin" size={24} /><strong>{progress || t('convertingDocument')}</strong></div>}
      <ActivityBar
        openPanels={{ projects: panelLayouts.projects.open, selection: panelLayouts.selection.open, notes: panelLayouts.notes.open, tags: panelLayouts.tags.open, chat: panelLayouts.chat.open }}
        hasSource={Boolean(source)}
        dark={dark}
        annotationActive={annotationMode}
        labels={{ openFile: t('openFile'), selection: t('selection'), conversations: t('conversations'), light: t('light'), dark: t('dark'), settings: t('settings') }}
        onOpenFile={openFile}
        onTogglePanel={togglePanel}
        onToggleAnnotation={toggleAnnotationMode}
        onToggleTheme={() => setDark((value) => !value)}
        onOpenSettings={openSettings}
        onPanelOrderChange={updatePanelOrder}
      />
      <main className="workspace" style={{ '--selection-width': `${leftPanelIds.length ? leftDockWidth : 0}px`, '--ai-width': `${rightPanelIds.length ? rightDockWidth : 0}px` } as CSSProperties}>
        {leftPanelIds.length > 0 && <div className="dock-column dock-column-left">{renderDockPanels(leftPanelIds)}<div className="panel-resizer right" onPointerDown={(event) => startResize('left', leftDockWidth, event)} /></div>}

        <section className="reader-pane">
          {!source ? <div className="empty-reader"><img src="/app-icon.svg" alt="Raid" /><p>打开或新建一个项目</p></div> : <>
            <div className="reader-toolbar">
              <div className="reader-status-group">
                {annotationMode ? <div className="annotation-tools" role="toolbar" aria-label="批注工具">
                  <label className="annotation-color" title="批注颜色"><Palette size={13} /><input type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
                  <button className={annotationTool === 'text' ? 'active' : ''} onClick={() => setAnnotationTool('text')} title="文本批注"><Type size={14} /><span>文本</span></button>
                  <button className={annotationTool === 'ink' ? 'active' : ''} onClick={() => setAnnotationTool('ink')} title="墨迹"><PenLine size={14} /><span>墨迹</span></button>
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
            <div className="reader-scroll" ref={readerScrollRef} onScroll={onReaderScroll} onWheel={onReaderWheel}><Suspense fallback={<div className="viewer-state"><span className="spinner" /><p>{t('loadingPdf')}</p></div>}><DocumentViewer key={source.url} source={source} zoom={zoom} currentPage={currentPage} inverted={dark} areaSelectionEnabled={areaSelectionEnabled} tagMode={tagMode} tags={(currentProject?.tags || []).filter((tag) => tag.fileId === activeFileId)} onCreateTag={addTagAt} onMoveTag={moveTag} onPdfReady={onPdfReady} onSelect={onSelect} onTextAi={addTextToAi} onTextTranslate={translateTextInline} highlights={highlights} onHighlight={toggleHighlight} citationFocus={citationFocus} annotationMode={annotationMode} annotationTool={annotationTool} annotationColor={annotationColor} annotations={annotations} onAnnotationsChange={setAnnotations} /></Suspense></div>
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
          projects={projectMemories}
          onClose={() => setSettingsOpen(false)}
          onImportSkill={importSkillFolder}
          onRemoveSkill={removeSkill}
          onImportLanguage={importLanguageFolder}
          onLanguageChange={changeLanguage}
          onMemorySettingsChange={changeMemorySettings}
          onUserMemoryChange={changeUserMemory}
          onDeleteProject={deleteProject}
          onSave={(config) => {
            setAiConfig(config)
            if (!config.reasoningEnabled) setDeepThinking(false)
            localStorage.setItem('reading-assistant-ai-config', JSON.stringify(config))
          }}
        /></Suspense>}
    </div>
  )
}
