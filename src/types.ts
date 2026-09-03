import type { PDFDocumentProxy } from 'pdfjs-dist'

export type NormalizedRegion = { left: number; top: number; width: number; height: number }

export type SourceFile = { name: string; kind: 'pdf' | 'image'; url: string; file: File }
export type SelectionResult = { image: string; images: string[]; page: number; regions: Array<{ page: number; region: NormalizedRegion }>; annotationTexts?: string[] }

export type DocumentParagraph = {
  id: string; projectId: string; fileId: string; page: number; region: NormalizedRegion
  text: string; textHash: string; order: number
}

export type ChatReference = {
  id: string; number: number; projectId: string; fileId: string; fileName: string
  paragraphId: string; page: number; region: NormalizedRegion; text: string; textHash: string
}

export type ChatMessage = {
  id: string; role: 'user' | 'assistant'; content: string; contextMode?: 'selection' | 'document' | 'project'
  label?: string; prompt?: string; sourcePage?: number; references?: ChatReference[]; citationsDisabled?: boolean
}

export type AiConfig = {
  provider: 'api' | 'codex'; apiKey: string; baseUrl: string; model: string
  visionEnabled: boolean; visionApiKey: string; visionBaseUrl: string; visionModel: string
  reasoningEnabled: boolean; reasoningApiKey: string; reasoningBaseUrl: string; reasoningModel: string
  codexModel: string; codexReasoningModel: string; codexAgentEnabled: boolean
}

export type ImportedSkill = { id: string; name: string; command: string; description: string; instructions: string; sourcePath: string }
export type MemorySettings = { userMemoryEnabled: boolean }
export type DocumentHighlight = { id: string; page: number; text: string; color: string; regions?: SelectionResult['regions'] }
export type AnnotationPoint = { x: number; y: number }
export type InkAnnotation = { id: string; type: 'ink'; page: number; color: string; strokeWidth: number; points: AnnotationPoint[] }
export type TextAnnotation = { id: string; type: 'text'; page: number; color: string; x: number; y: number; width: number; height: number; fontSize: number; text: string }
export type DocumentAnnotation = InkAnnotation | TextAnnotation
export type AnnotationTool = 'text' | 'ink' | 'eraser'

export type FolderImportResult = { canceled?: boolean; folderPath?: string; files?: Array<{ path: string; content: string }>; error?: string }
export type DocumentConversionResult = { name?: string; type?: string; data?: Uint8Array; error?: string }
export type AiAction = 'translate' | 'explain' | 'insight' | 'summarize' | 'custom'
export type CapturedSelection = SelectionResult & { id: string; text: string; textParts: string[]; loading: boolean }
export type Conversation = { id: string; title: string; history: ChatMessage[] }

export type ReadingState = { page: number; zoom: number; scrollTop: number; region?: NormalizedRegion }
export type IndexState = { status: 'pending' | 'indexing' | 'ready' | 'error'; version: number; indexedAt?: number; error?: string }

export type ProjectFile = {
  id: string; projectId: string; name: string; kind: 'pdf' | 'image'; type: string; size: number; lastModified: number
  createdAt: number; updatedAt: number; readingState: ReadingState; highlights: DocumentHighlight[]
  annotations: DocumentAnnotation[]; paragraphs: DocumentParagraph[]; indexState: IndexState
}

export type RuntimeProjectFile = ProjectFile & { source?: SourceFile; pdf?: PDFDocumentProxy | null; sourceLoaded?: boolean }

export type DocumentTag = {
  id: string; projectId: string; fileId: string; page: number; region: NormalizedRegion; label: string; createdAt: number
}

export type Project = {
  id: string; name: string; files: ProjectFile[]; conversations: Conversation[]; activeConversationId: string
  activeFileId: string | null; projectNotes: string; projectNoteAssets: Record<string, string>; tags: DocumentTag[]
  createdAt: number; updatedAt: number
}

export type RuntimeProject = Omit<Project, 'files'> & { files: RuntimeProjectFile[]; hydrated?: boolean }
export type ProjectSummary = { id: string; name: string; fileCount: number; conversationCount: number; updatedAt: number; activeFileId: string | null }

export type ReaderLocation = { projectId: string; fileId: string; page: number; region?: NormalizedRegion; zoom?: number; scrollTop?: number }

export type PanelId = 'projects' | 'selection' | 'chat' | 'notes' | 'tags'
export type PanelDock = 'left' | 'right' | 'float'
export type PanelLayout = { open: boolean; dock: PanelDock; x: number; y: number; width: number; height: number; dockSize: number; z: number }

declare global {
  interface Window {
    readingAssistant?: {
      selectSkillFolder: () => Promise<FolderImportResult>
      selectLanguageFolder: () => Promise<FolderImportResult>
      convertDocument: (payload: { name: string; type: string; lastModified: number; data: ArrayBuffer }) => Promise<DocumentConversionResult>
      listProjects: () => Promise<ProjectSummary[]>
      getProject: (id: string) => Promise<Project | null>
      saveProject: (project: Project) => Promise<boolean>
      getProjectFileSource: (projectId: string, fileId: string) => Promise<Uint8Array | null>
      saveProjectFileSource: (payload: { projectId: string; fileId: string; data: ArrayBuffer }) => Promise<boolean>
      deleteProject: (id: string) => Promise<void>
      deleteProjectFile: (projectId: string, fileId: string) => Promise<void>
      openExternal: (url: string) => Promise<boolean>
      movePanelWindow: (id: string, x: number, y: number) => void
      preparePanelDrag: () => void
      setPanelDragging: (active: boolean) => void
      setDockZones: (visible: boolean, active: 'left' | 'right' | null, dark?: boolean) => void
    }
  }
}
