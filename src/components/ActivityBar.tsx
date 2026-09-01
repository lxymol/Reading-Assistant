import { BookOpen, BrainCircuit, FolderOpen, Moon, MousePointer2, PencilRuler, Plus, Settings2, StickyNote, Sun } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { PanelId } from '../types'

type ActivityId = 'projects' | 'selection' | 'notes' | 'chat' | 'annotation' | 'open'
type DragState = { id: ActivityId; pointerId: number; origin: number; target: number; startY: number; deltaY: number; moved: boolean }
const defaultOrder: ActivityId[] = ['projects', 'selection', 'notes', 'chat', 'annotation', 'open']
const orderStorageKey = 'reading-assistant-activity-order'
const activityStep = 47

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
  labels: { openFile: string; selection: string; conversations: string; light: string; dark: string; settings: string }
  onOpenFile: (file: File) => void
  onTogglePanel: (id: PanelId) => void
  onToggleAnnotation: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
  onPanelOrderChange: (order: PanelId[]) => void
}

export default function ActivityBar({ openPanels, hasSource, dark, annotationActive, labels, onOpenFile, onTogglePanel, onToggleAnnotation, onToggleTheme, onOpenSettings, onPanelOrderChange }: Props) {
  const [order, setOrder] = useState(loadOrder)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    onPanelOrderChange(order.filter((id): id is PanelId => ['projects', 'selection', 'notes', 'chat'].includes(id)))
  }, [order, onPanelOrderChange])

  const updateDrag = (next: DragState | null) => { dragRef.current = next; setDrag(next) }
  const startDrag = (id: ActivityId, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    const origin = order.indexOf(id)
    updateDrag({ id, pointerId: event.pointerId, origin, target: origin, startY: event.clientY, deltaY: 0, moved: false })
  }
  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    const deltaY = event.clientY - current.startY
    const moved = current.moved || Math.abs(deltaY) > 4
    if (moved) {
      event.preventDefault()
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    }
    const target = Math.max(0, Math.min(order.length - 1, current.origin + Math.round(deltaY / activityStep)))
    updateDrag({ ...current, deltaY, target, moved })
  }
  const finishDrag = (event: ReactPointerEvent<HTMLSpanElement>, commit: boolean) => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (commit && current.moved && current.target !== current.origin) {
      const next = [...order]
      const [item] = next.splice(current.origin, 1)
      next.splice(current.target, 0, item)
      setOrder(next)
      localStorage.setItem(orderStorageKey, JSON.stringify(next))
    }
    suppressClickRef.current = current.moved
    updateDrag(null)
    window.setTimeout(() => { suppressClickRef.current = false }, 0)
  }
  const itemStyle = (id: ActivityId): CSSProperties | undefined => {
    if (!drag) return undefined
    const index = order.indexOf(id)
    if (id === drag.id) return { transform: `translateY(${drag.deltaY}px)` }
    if (drag.target > drag.origin && index > drag.origin && index <= drag.target) return { transform: `translateY(-${activityStep}px)` }
    if (drag.target < drag.origin && index >= drag.target && index < drag.origin) return { transform: `translateY(${activityStep}px)` }
    return undefined
  }

  const items: Record<ActivityId, React.ReactNode> = {
    projects: <button className={openPanels.projects ? 'active' : ''} onClick={() => onTogglePanel('projects')} title="项目"><FolderOpen /></button>,
    selection: <button className={openPanels.selection ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('selection')} title={labels.selection}><MousePointer2 /></button>,
    notes: <button className={openPanels.notes ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('notes')} title="笔记"><StickyNote /></button>,
    chat: <button className={openPanels.chat ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('chat')} title={labels.conversations}><BrainCircuit /></button>,
    annotation: <button className={annotationActive ? 'active' : ''} disabled={!hasSource} onClick={onToggleAnnotation} title="批注"><PencilRuler /></button>,
    open: <label title={labels.openFile}><Plus /><input hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onOpenFile(file) }} /></label>,
  }

  return <nav className={`activity-bar ${drag?.moved ? 'activity-dragging' : ''}`}>
    <div className="activity-logo"><BookOpen size={28} strokeWidth={2.3} /></div>
    {order.map((id) => <span className="activity-reorder-item" data-reorder-state={drag?.id === id ? 'dragging' : undefined} key={id} style={itemStyle(id)} onPointerDown={(event) => startDrag(id, event)} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event, true)} onPointerCancel={(event) => finishDrag(event, false)} onClickCapture={(event) => { if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation() } }}>{items[id]}</span>)}
    <span className="activity-spacer" />
    <button onClick={onToggleTheme} title={dark ? labels.light : labels.dark}>{dark ? <Sun /> : <Moon />}</button>
    <button onClick={onOpenSettings} title={labels.settings}><Settings2 /></button>
  </nav>
}
