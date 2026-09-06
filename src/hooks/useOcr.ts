import { useCallback, useEffect, useRef } from 'react'
import type { Worker as OcrWorker } from 'tesseract.js'
import { useI18n } from '../i18n'

export function useOcr(setProgress: (progress: string) => void) {
  const { t } = useI18n()
  const workerRef = useRef<OcrWorker | null>(null)
  const workerPromiseRef = useRef<Promise<OcrWorker> | null>(null)
  const workerIdleTimerRef = useRef<number | null>(null)
  const showOcrProgressRef = useRef(false)

  useEffect(() => () => {
    if (workerIdleTimerRef.current !== null) window.clearTimeout(workerIdleTimerRef.current)
    workerRef.current?.terminate()
  }, [])

  const getWorker = useCallback(async () => {
    if (workerIdleTimerRef.current !== null) {
      window.clearTimeout(workerIdleTimerRef.current)
      workerIdleTimerRef.current = null
    }
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
  }, [t, setProgress])

  const recognize = useCallback(async (image: string) => {
    showOcrProgressRef.current = true
    setProgress(t('preparingOcr'))
    const worker = await getWorker()
    try {
      const result = await worker.recognize(image)
      return result.data.text.trim()
    } finally {
      showOcrProgressRef.current = false
      if (workerIdleTimerRef.current !== null) window.clearTimeout(workerIdleTimerRef.current)
      workerIdleTimerRef.current = window.setTimeout(() => {
        const idleWorker = workerRef.current
        workerRef.current = null
        workerPromiseRef.current = null
        workerIdleTimerRef.current = null
        void idleWorker?.terminate()
      }, 5 * 60 * 1000)
    }
  }, [getWorker, t, setProgress])

  return recognize
}
