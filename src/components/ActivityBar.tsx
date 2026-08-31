import { BookOpen, BrainCircuit, FolderOpen, Moon, MousePointer2, PencilRuler, Plus, Settings2, StickyNote, Sun } from 'lucide-react'
import { useState } from 'react'
import type { PanelId } from '../types'

type ActivityId = 'projects' | 'selection' | 'notes' | 'chat' | 'annotation' | 'open'
const defaultOrder: ActivityId[] = ['projects', 'selection', 'notes', 'chat', 'annotation', 'open']
const orderStorageKey = 'reading-assistant-activity-order'

function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(orderStorageKey) || '[]') as ActivityId[]
    if (saved.length === defaultOrder.length && defaultOrder.every((id) => saved.includes(id))) return saved
  } catch { /* Use the stable default order. */ }
  return defaultOrder
}

type Props = {
  openPanels: Record<PanelId, boolean>
  hasSource: boolean
  dark: boolean
  annotationActive: boolean
  labels: {
    openFile: string
    selection: string
    conversations: string
    light: string
    dark: string
    settings: string
  }
  onOpenFile: (file: File) => void
  onTogglePanel: (id: PanelId) => void
  onToggleAnnotation: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
}

export default function ActivityBar({ openPanels, hasSource, dark, annotationActive, labels, onOpenFile, onTogglePanel, onToggleAnnotation, onToggleTheme, onOpenSettings }: Props) {
  const [order, setOrder] = useState(loadOrder)
  const [dragging, setDragging] = useState<ActivityId | null>(null)
  const [dragTarget, setDragTarget] = useState<ActivityId | null>(null)
  const reorder = (target: ActivityId) => {
    if (!dragging || dragging === target) return
    const next = order.filter((id) => id !== dragging)
    next.splice(next.indexOf(target), 0, dragging)
    setOrder(next)
    localStorage.setItem(orderStorageKey, JSON.stringify(next))
  }
  const dragProps = (id: ActivityId) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => { setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) },
    onDragEnter: () => setDragTarget(id),
    onDragOver: (event: React.DragEvent<HTMLElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragTarget(id) },
    onDrop: (event: React.DragEvent<HTMLElement>) => { event.preventDefault(); reorder(id); setDragTarget(null) },
    onDragEnd: () => { setDragging(null); setDragTarget(null) },
    'data-reorder-state': dragging === id ? 'dragging' : dragTarget === id ? 'target' : undefined,
  })
  const items: Record<ActivityId, React.ReactNode> = {
    projects: <button className={openPanels.projects ? 'active' : ''} onClick={() => onTogglePanel('projects')} title="项目"><FolderOpen /></button>,
    selection: <button className={openPanels.selection ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('selection')} title={labels.selection}><MousePointer2 /></button>,
    notes: <button className={openPanels.notes ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('notes')} title="笔记"><StickyNote /></button>,
    chat: <button className={openPanels.chat ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('chat')} title={labels.conversations}><BrainCircuit /></button>,
    annotation: <button className={annotationActive ? 'active' : ''} disabled={!hasSource} onClick={onToggleAnnotation} title="批注"><PencilRuler /></button>,
    open: <label title={labels.openFile}><Plus /><input hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onOpenFile(file) }} /></label>,
  }
  return <nav className="activity-bar">
    <div className="activity-logo"><BookOpen size={28} strokeWidth={2.3} /></div>
    {order.map((id) => <span {...dragProps(id)} className="activity-reorder-item" key={id}>{items[id]}</span>)}
    <span className="activity-spacer" />
    <button onClick={onToggleTheme} title={dark ? labels.light : labels.dark}>{dark ? <Sun /> : <Moon />}</button>
    <button onClick={onOpenSettings} title={labels.settings}><Settings2 /></button>
  </nav>
}
