import { memo, useEffect, useRef, useState } from 'react'
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

const normalizeAssistantMarkdown = (content: string, references?: ChatReference[]) => normalizeAssistantMath(inlineCitationsToMarkdown(content, references))

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeKatex]
// Callback changes and streaming updates to other messages must not reparse
// completed answers, especially those containing expensive math layouts.
const AssistantMarkdown = memo(function AssistantMarkdown({ content, references }: { content: string; references?: ChatReference[] }) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={defaultUrlTransform}>{normalizeAssistantMarkdown(content, references)}</ReactMarkdown>
})

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

type Props = {
  history: ChatMessage[]
  deleteMessage: (id: string) => void
  openReference: (reference: ChatReference) => void
}

export default function ConversationMessages({ history, deleteMessage, openReference }: Props) {
  const { t } = useI18n()
  return <>{history.map((message) => message.role === 'user'
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
              }}><AssistantMarkdown content={message.content} references={message.references} /></div>
            </article>)}</>
}
