import { MapPin, Tag, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { DocumentTag, ProjectFile } from '../types'

type Props = {
  tags: DocumentTag[]
  files: Pick<ProjectFile, 'id' | 'name'>[]
  tagMode: boolean
  recentTagId: string | null
  canGoBack: boolean
  onToggleTagMode: () => void
  onBack: () => void
  onOpen: (tag: DocumentTag) => void
  onRename: (id: string, label: string) => void
  onDelete: (id: string) => void
  onDismissRecent: () => void
}

export default function TagPanel({ tags, files, tagMode, recentTagId, canGoBack, onToggleTagMode, onBack, onOpen, onRename, onDelete, onDismissRecent }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const fileNames = new Map(files.map((file) => [file.id, file.name]))
  const ordered = [...tags].sort((a, b) => b.createdAt - a.createdAt)
  useEffect(() => {
    if (!recentTagId) return
    const ownerDocument = rootRef.current?.ownerDocument
    if (!ownerDocument || ownerDocument === document) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest(`[data-tag-id="${CSS.escape(recentTagId)}"]`)) onDismissRecent()
    }
    ownerDocument.addEventListener('pointerdown', dismiss, true)
    return () => ownerDocument.removeEventListener('pointerdown', dismiss, true)
  }, [recentTagId, onDismissRecent])
  return <div ref={rootRef} className="tag-panel-layout">
    <div className="tag-panel-toolbar">
      <button className={tagMode ? 'active' : ''} onClick={onToggleTagMode}><Tag size={14} />{tagMode ? '关闭标签模式' : '标签操作'}</button>
      <button disabled={!canGoBack} onClick={onBack} title="回到上一次标签或引用跳转前的位置"><Undo2 size={14} />回退</button>
    </div>
    {!ordered.length ? <div className="tag-empty"><Tag size={24} /><p>还没有标签</p></div> : <div className="tag-list">{ordered.map((tag) => <article data-tag-id={tag.id} className={tag.id === recentTagId ? 'recent' : ''} key={tag.id}>
    <button className="tag-open" title="跳转到标签" onClick={() => onOpen(tag)}><MapPin size={14} /></button>
    <span className="tag-details"><input aria-label="标签名称" value={tag.label} placeholder={`第 ${tag.page} 页`} onChange={(event) => onRename(tag.id, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><small>{fileNames.get(tag.fileId) || '文件已删除'} · 第 {tag.page} 页</small></span>
    <button className="tag-delete" title="删除标签" onClick={() => onDelete(tag.id)}><Trash2 size={13} /></button>
  </article>)}</div>}
  </div>
}
