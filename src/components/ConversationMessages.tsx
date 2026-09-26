import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, X } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { ChatMessage, ChatReference } from '../types'
import { useI18n } from '../i18n'
import { inlineCitationsToMarkdown, referenceNumberFromHref } from '../services/inlineCitation'
import { normalizeAssistantMath } from '../services/markdownMath'
import { loadStoredSelectionImage } from '../services/selectionImageCache'

const normalizeAssistantMarkdown = (content: string, references?: ChatReference[]) => normalizeAssistantMath(inlineCitationsToMarkdown(content, references))

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]
// Callback changes and streaming updates to other messages must not reparse
// completed answers, especially those containing expensive math layouts.
const AssistantMarkdown = memo(function AssistantMarkdown({ content, references }: { content: string; references?: ChatReference[] }) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={defaultUrlTransform}>{normalizeAssistantMarkdown(content, references)}</ReactMarkdown>
})

function CopyMessageButton({ content, copyLabel, copiedLabel }: { content: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      if (!mountedRef.current) return
      setCopied(true)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { timerRef.current = null; setCopied(false) }, 2000)
    } catch { /* Clipboard permission errors leave the button unchanged. */ }
  }
  return <button className={copied ? 'copied' : ''} onClick={() => void copy()} title={copied ? copiedLabel : copyLabel} aria-label={copied ? copiedLabel : copyLabel}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
}

function SelectionAttachment({ id, page }: { id: string; page: number }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const [thumbnail, setThumbnail] = useState('')
  const [full, setFull] = useState('')
  const [portalBody, setPortalBody] = useState<HTMLElement | null>(null)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  useEffect(() => {
    const button = buttonRef.current
    if (!button) return
    let active = true
    let url = ''
    let loading = false
    let visible = false
    let releaseTimer: number | null = null
    const observer = new IntersectionObserver((entries) => {
      visible = Boolean(entries[0]?.isIntersecting)
      if (visible) {
        if (releaseTimer !== null) window.clearTimeout(releaseTimer)
        releaseTimer = null
        if (url || loading) return
        loading = true
        void loadStoredSelectionImage(id, true).then((blob) => {
          if (!active || !visible) return
          url = URL.createObjectURL(blob)
          setThumbnail(url)
        }).catch(() => undefined).finally(() => { loading = false })
        return
      }
      if (releaseTimer !== null) window.clearTimeout(releaseTimer)
      releaseTimer = window.setTimeout(() => {
        if (visible || !active) return
        setThumbnail('')
        if (url) URL.revokeObjectURL(url)
        url = ''
      }, 1000)
    }, { root: button.closest('.panel-scroll'), rootMargin: '200px' })
    observer.observe(button)
    return () => { active = false; observer.disconnect(); if (releaseTimer !== null) window.clearTimeout(releaseTimer); if (url) URL.revokeObjectURL(url) }
  }, [id])
  useEffect(() => () => { if (full) URL.revokeObjectURL(full) }, [full])
  const open = async () => {
    try {
      const url = URL.createObjectURL(await loadStoredSelectionImage(id))
      if (mountedRef.current) {
        setPortalBody(buttonRef.current?.ownerDocument.body || document.body)
        setFull(url)
      }
      else URL.revokeObjectURL(url)
    } catch { /* The image may have been removed. */ }
  }
  return <>
    <button ref={buttonRef} className="conversation-selection-thumb" onClick={() => void open()} title={`查看第 ${page} 页选区图片`}>{thumbnail ? <img src={thumbnail} alt={`第 ${page} 页选区`} /> : <span>P{page}</span>}</button>
    {full && createPortal(<div className="selection-image-viewer" role="dialog" aria-modal="true" aria-label={`第 ${page} 页选区图片`} onClick={() => setFull('')}><button title="关闭" onClick={() => setFull('')}><X size={18} /></button><img src={full} alt={`第 ${page} 页选区图片`} onClick={(event) => event.stopPropagation()} /></div>, portalBody || document.body)}
  </>
}

type Props = {
  history: ChatMessage[]
  deleteMessage: (id: string) => void
  openReference: (reference: ChatReference) => void
}

export default function ConversationMessages({ history, deleteMessage, openReference }: Props) {
  const { t } = useI18n()
  const [visibleCount, setVisibleCount] = useState(40)
  const olderCount = Math.max(0, history.length - visibleCount)
  const showOlder = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const container = event.currentTarget.closest<HTMLElement>('.panel-scroll')
    const oldHeight = container?.scrollHeight || 0
    const oldTop = container?.scrollTop || 0
    setVisibleCount((count) => count + 40)
    window.requestAnimationFrame(() => { if (container) container.scrollTop = oldTop + container.scrollHeight - oldHeight })
  }
  return <>{olderCount > 0 && <button className="load-older-messages" onClick={showOlder}>加载更早消息（还有 {olderCount} 条）</button>}{history.slice(-visibleCount).map((message) => message.role === 'user'
          ? <div className="user-event" key={message.id}><span>{message.prompt || message.label}</span>{message.content !== message.prompt && <small>{message.content.slice(0, 120)}{message.content.length > 120 ? '…' : ''}</small>}{Boolean(message.attachments?.length) && <div className="conversation-attachments">{message.attachments?.map((image) => <SelectionAttachment key={image.id} id={image.id} page={image.page} />)}</div>}<button className="delete-message" onClick={() => deleteMessage(message.id)}><X size={12} /></button></div>
          : <article className="answer-card" key={message.id}>
              <div className="answer-actions"><CopyMessageButton content={message.content} copyLabel={t('copy')} copiedLabel={t('copied')} /><button onClick={() => deleteMessage(message.id)}><X size={14} /></button></div>
              <div className="markdown" onClick={(event) => {
                const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#raid-reference-"]')
                if (!link) return
                const number = referenceNumberFromHref(link.getAttribute('href'))
                const reference = message.references?.find((item) => item.number === number)
                if (!reference) return
                event.preventDefault(); openReference(reference)
              }}><AssistantMarkdown content={message.content} references={message.references} /></div>
            </article>)}</>
}
