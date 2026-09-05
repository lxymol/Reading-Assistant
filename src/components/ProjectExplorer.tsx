import { ChevronDown, ChevronRight, FilePlus2, FileText, LoaderCircle, MessageSquareText, Ungroup, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

type Conversation = { id: string; title: string; ownerType?: 'file' | 'combination'; fileId?: string }
type FileItem = { id: string; name: string; indexStatus: string }
type Combination = { id: string; name: string; busy: boolean; isLoose?: boolean; files: FileItem[]; conversations: Conversation[] }
type DragPayload = { kind: 'file'; combinationId: string; fileId: string } | { kind: 'combination'; combinationId: string }
type CombinationDrag = { id: string; pointerId: number; origin: number; target: number; startY: number; deltaY: number; moved: boolean; rects: DOMRect[] }

type Props = {
  projects: Combination[]; activeProjectId: string | null; activeFileId: string | null; activeConversationId: string
  createSignal: number
  onCreateProject: (name: string) => string | void; onOpenProject: (id: string) => void; onAddFile: (projectId: string, files: File[]) => Promise<void> | void
  onOpenFile: (projectId: string, fileId: string) => void; onDeleteFile: (projectId: string, fileId: string) => void
  onOpenConversation: (projectId: string, conversationId: string) => void; onDeleteConversation: (projectId: string, conversationId: string) => void
  onRenameCombination: (id: string, name: string) => void; onDissolveCombination: (id: string) => void
  onMoveFile: (sourceId: string, fileId: string, targetId: string, beforeFileId?: string) => void
  onReorderCombination: (id: string, targetIndex: number) => void
}

const readDrag = (event: DragEvent): DragPayload | null => {
  try { return JSON.parse(event.dataTransfer.getData('application/x-raid-item')) as DragPayload } catch { return null }
}

export default function ProjectExplorer(props: Props) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(() => new Set())
  const [combinationDrag, setCombinationDrag] = useState<CombinationDrag | null>(null)
  const combinationDragRef = useRef<CombinationDrag | null>(null)
  const suppressCombinationClickRef = useRef(false)
  const combinationNodes = useRef(new Map<string, HTMLElement>())
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const createSignalRef = useRef(props.createSignal)
  const toggle = (setter: typeof setCollapsed, id: string) => setter((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleOnRelease = (event: ReactPointerEvent<HTMLElement>, setter: typeof setCollapsed, id: string) => {
    event.stopPropagation()
    if (event.button === 0) toggle(setter, id)
  }
  const toggleFromKeyboardClick = (event: ReactMouseEvent<HTMLElement>, setter: typeof setCollapsed, id: string) => {
    event.stopPropagation()
    if (event.detail === 0) toggle(setter, id)
  }
  const create = () => {
    const name = '新建组合'
    const id = props.onCreateProject(name)
    if (id) setRenaming({ id, name })
  }
  const loose = props.projects.find((item) => item.isLoose)
  const combinations = props.projects.filter((item) => !item.isLoose)

  const updateCombinationDrag = (next: CombinationDrag | null) => { combinationDragRef.current = next; setCombinationDrag(next) }
  const startCombinationDrag = (project: Combination, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('label,i,input')) return
    const origin = combinations.findIndex((item) => item.id === project.id)
    if (origin < 0) return
    const rects = combinations.map((item) => combinationNodes.current.get(item.id)?.getBoundingClientRect()).filter((rect): rect is DOMRect => Boolean(rect))
    if (rects.length !== combinations.length) return
    combinationDragRef.current = { id: project.id, pointerId: event.pointerId, origin, target: origin, startY: event.clientY, deltaY: 0, moved: false, rects }
  }
  const moveCombinationDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = combinationDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const own = drag.rects[drag.origin]
    const minimum = drag.rects[0].top - own.top
    const maximum = drag.rects.at(-1)!.bottom - own.bottom
    const deltaY = Math.max(minimum, Math.min(maximum, event.clientY - drag.startY))
    const moved = drag.moved || Math.abs(deltaY) > 4
    if (moved) {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
    const center = own.top + own.height / 2 + deltaY
    let target = drag.origin
    drag.rects.forEach((rect, index) => { if (Math.abs(center - (rect.top + rect.height / 2)) < Math.abs(center - (drag.rects[target].top + drag.rects[target].height / 2))) target = index })
    const next = { ...drag, target, deltaY, moved }
    combinationDragRef.current = next
    if (moved) setCombinationDrag(next)
  }
  const finishCombinationDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = combinationDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (commit && drag.moved && drag.target !== drag.origin) props.onReorderCombination(drag.id, drag.target)
    suppressCombinationClickRef.current = drag.moved
    updateCombinationDrag(null)
    window.setTimeout(() => { suppressCombinationClickRef.current = false }, 0)
  }
  useEffect(() => {
    if (props.createSignal === createSignalRef.current) return
    createSignalRef.current = props.createSignal
    create()
  }, [props.createSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!renaming) return
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [renaming])

  const renderFile = (project: Combination, file: FileItem) => {
    const chats = project.conversations.filter((item) => item.ownerType === 'file' && item.fileId === file.id)
    const chatsExpanded = expandedFileIds.has(file.id)
    return <div className="library-file-wrap" key={file.id} onDragOver={(event) => { if (readDrag(event)?.kind === 'file') event.preventDefault() }} onDrop={(event) => { const data = readDrag(event); if (data?.kind === 'file') { event.preventDefault(); event.stopPropagation(); props.onMoveFile(data.combinationId, data.fileId, project.id, file.id) } }}>
      <button className={`library-file ${file.id === props.activeFileId ? 'active' : ''}`} onClick={() => props.onOpenFile(project.id, file.id)}>
        <i draggable={false} className={`file-chat-toggle ${chats.length ? '' : 'empty'}`} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => toggleOnRelease(event, setExpandedFileIds, file.id)} onClick={(event) => toggleFromKeyboardClick(event, setExpandedFileIds, file.id)} title={chatsExpanded ? '收起文件对话' : '展开文件对话'}>{chatsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</i>
        {file.indexStatus === 'indexing' ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}<span className="file-drag-source" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-raid-item', JSON.stringify({ kind: 'file', combinationId: project.id, fileId: file.id })) }}>{file.name}</span>{chats.length > 0 && <small className="file-chat-count">{chats.length}</small>}<i draggable={false} className="file-delete" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onDeleteFile(project.id, file.id) }} title="删除文件"><X size={11} /></i>
      </button>
      <div className={`file-conversation-shell ${chatsExpanded ? 'expanded' : ''}`} aria-hidden={!chatsExpanded}><div className="file-conversation-list">{chats.length ? chats.map((chat) => <button className={`file-conversation ${chat.id === props.activeConversationId ? 'active' : ''}`} key={chat.id} onClick={() => props.onOpenConversation(project.id, chat.id)}><MessageSquareText size={11} /><span>{chat.title}</span><i onClick={(event) => { event.stopPropagation(); props.onDeleteConversation(project.id, chat.id) }}><X size={10} /></i></button>) : <small className="file-conversation-empty">暂无文件对话</small>}</div></div>
    </div>
  }

  const renderCombination = (project: Combination) => {
    const isCollapsed = collapsed.has(project.id)
    const canManage = !project.isLoose
    const projectIndex = combinations.findIndex((item) => item.id === project.id)
    const dropClass = combinationDrag?.moved && combinationDrag.target === projectIndex && combinationDrag.target !== combinationDrag.origin ? (combinationDrag.target < combinationDrag.origin ? 'drop-before' : 'drop-after') : ''
    return <section ref={(node) => { if (node) combinationNodes.current.set(project.id, node); else combinationNodes.current.delete(project.id) }} className={`project-item combination-item ${project.id === props.activeProjectId ? 'active' : ''} ${combinationDrag?.id === project.id ? 'dragging' : ''} ${dropClass}`} key={project.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const data = readDrag(event); if (data?.kind === 'file') { event.preventDefault(); event.stopPropagation(); props.onMoveFile(data.combinationId, data.fileId, project.id) } }}>
      <div className="project-title" onPointerDown={(event) => canManage && renaming?.id !== project.id && startCombinationDrag(project, event)} onPointerMove={moveCombinationDrag} onPointerUp={(event) => finishCombinationDrag(event, true)} onPointerCancel={(event) => finishCombinationDrag(event, false)}>
        <button className="combination-main" onClick={(event) => { if (suppressCombinationClickRef.current) { event.preventDefault(); return } props.onOpenProject(project.id) }}>{project.busy && <LoaderCircle className="spin" size={14} />}{renaming?.id === project.id ? <input ref={renameInputRef} value={renaming.name} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenaming({ id: project.id, name: event.target.value })} onBlur={() => { const value = renaming.name.trim(); if (value) props.onRenameCombination(project.id, value); setRenaming(null) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null) }} /> : <span onDoubleClick={(event) => { event.stopPropagation(); if (canManage) setRenaming({ id: project.id, name: project.name }) }} title={canManage ? '双击重命名' : undefined}>{project.name}</span>}<small className="combination-file-count">{project.files.length}</small></button>
        <label title="向组合添加文件"><FilePlus2 size={13} /><input hidden multiple type="file" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void props.onAddFile(project.id, files) }} /></label>
        {canManage && <i onClick={() => props.onDissolveCombination(project.id)} title="分解组合"><Ungroup size={13} /></i>}
        <i draggable={false} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => toggleOnRelease(event, setCollapsed, project.id)} onClick={(event) => toggleFromKeyboardClick(event, setCollapsed, project.id)} title={isCollapsed ? '展开' : '收起'}>{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</i>
      </div>
      <div className={`project-files-shell ${isCollapsed ? '' : 'expanded'}`} aria-hidden={isCollapsed}><div className="project-files" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const data = readDrag(event); if (data?.kind === 'file') { event.preventDefault(); event.stopPropagation(); props.onMoveFile(data.combinationId, data.fileId, project.id) } }}>{project.files.map((file) => renderFile(project, file))}</div></div>
    </section>
  }

  const empty = combinations.length === 0 && !loose?.files.length
  if (empty) return <div className="project-explorer empty-project-explorer"><label className="empty-library-add"><FilePlus2 size={15} /><span>添加文件</span><input hidden multiple type="file" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void props.onAddFile(loose?.id || 'raid-loose-files', files) }} /></label></div>

  const looseCollapsed = loose ? collapsed.has(loose.id) : false
  return <div className="project-explorer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const data = readDrag(event); if (data?.kind === 'file' && loose) props.onMoveFile(data.combinationId, data.fileId, loose.id) }}>
    {combinations.map(renderCombination)}
    {loose && <section className="loose-files-list" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const data = readDrag(event); if (data?.kind === 'file') { event.preventDefault(); event.stopPropagation(); props.onMoveFile(data.combinationId, data.fileId, loose.id) } }}>
      <div className="loose-files-list-heading"><span>未分组文件</span><button onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => toggleOnRelease(event, setCollapsed, loose.id)} onClick={(event) => toggleFromKeyboardClick(event, setCollapsed, loose.id)} title={looseCollapsed ? '展开' : '收起'}>{looseCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button></div>
      <div className={`project-files-shell ${looseCollapsed ? '' : 'expanded'}`} aria-hidden={looseCollapsed}><div className="project-files loose-file-rows">{loose.files.map((file) => renderFile(loose, file))}</div></div>
    </section>}
  </div>
}
