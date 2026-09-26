import { BrainCircuit, FolderOpen, Moon, Pen, Settings2, Sun, Tag } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { PanelId } from '../types'

type ActivityId = 'projects' | 'tags' | 'chat' | 'annotation'
type DragState = { id: ActivityId; pointerId: number; origin: number; target: number; startY: number; deltaY: number; moved: boolean; settling?: boolean }
const defaultOrder: ActivityId[] = ['projects', 'tags', 'chat', 'annotation']
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
  labels: { conversations: string; light: string; dark: string; settings: string }
  onTogglePanel: (id: PanelId) => void
  onToggleAnnotation: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
  onPanelOrderChange: (order: PanelId[]) => void
  side: 'left' | 'right'
  onSideChange: (side: 'left' | 'right') => void
}

export default function ActivityBar({ openPanels, hasSource, dark, annotationActive, labels, onTogglePanel, onToggleAnnotation, onToggleTheme, onOpenSettings, onPanelOrderChange, side, onSideChange }: Props) {
  const [order, setOrder] = useState(loadOrder)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [committingOrder, setCommittingOrder] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    onPanelOrderChange(order.flatMap((id): PanelId[] => id === 'annotation' ? [] : [id]))
  }, [order, onPanelOrderChange])

  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
  }, [])

  const updateDrag = (next: DragState | null) => { dragRef.current = next; setDrag(next) }
  const startDrag = (id: ActivityId, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || dragRef.current) return
    const origin = order.indexOf(id)
    updateDrag({ id, pointerId: event.pointerId, origin, target: origin, startY: event.clientY, deltaY: 0, moved: false })
  }
  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId || current.settling) return
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
    const shouldSettle = commit && current.moved
    if (shouldSettle) {
      const next = [...order]
      if (current.target !== current.origin) {
        const [item] = next.splice(current.origin, 1)
        next.splice(current.target, 0, item)
      }
      updateDrag({ ...current, deltaY: (current.target - current.origin) * activityStep, settling: true })
      settleTimerRef.current = window.setTimeout(() => {
        setCommittingOrder(true)
        if (current.target !== current.origin) {
          setOrder(next)
          localStorage.setItem(orderStorageKey, JSON.stringify(next))
        }
        updateDrag(null)
        settleTimerRef.current = null
        requestAnimationFrame(() => requestAnimationFrame(() => setCommittingOrder(false)))
      }, 90)
    } else {
      updateDrag(null)
    }
    suppressClickRef.current = current.moved
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
    projects: <button className={openPanels.projects ? 'active' : ''} onClick={() => onTogglePanel('projects')} title="文件"><FolderOpen /></button>,
    tags: <button className={openPanels.tags ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('tags')} title="标签"><Tag /></button>,
    chat: <button className={openPanels.chat ? 'active' : ''} disabled={!hasSource} onClick={() => onTogglePanel('chat')} title={labels.conversations}><BrainCircuit /></button>,
    annotation: <button className={annotationActive ? 'active' : ''} disabled={!hasSource} onClick={onToggleAnnotation} title="批注"><Pen /></button>,
  }

  return <nav className={`activity-bar activity-${side} ${drag?.moved && !drag.settling ? 'activity-dragging' : ''} ${committingOrder ? 'activity-order-committing' : ''}`}>
    <div className="activity-logo" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-raid-activity', side) }} onDragEnd={(event) => { if (event.clientX > window.innerWidth / 2) onSideChange('right'); else onSideChange('left') }} title="拖到窗口另一侧"><img src="/app-icon.svg" alt="Raid" width={30} height={30} draggable={false} /></div>
    {order.map((id) => <span className="activity-reorder-item" data-reorder-state={drag?.id === id ? (drag.settling ? 'settling' : 'dragging') : undefined} key={id} style={itemStyle(id)} onPointerDown={(event) => startDrag(id, event)} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event, true)} onPointerCancel={(event) => finishDrag(event, false)} onClickCapture={(event) => { if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation() } }}>{items[id]}</span>)}
    <span className="activity-spacer" />
    <button onClick={onToggleTheme} title={dark ? labels.light : labels.dark}>{dark ? <Sun /> : <Moon />}</button>
    <button onClick={onOpenSettings} title={labels.settings}><Settings2 /></button>
  </nav>
}
