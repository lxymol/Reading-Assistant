import { useCallback, useEffect, useRef } from 'react'
import type { Worker as OcrWorker } from 'tesseract.js'
import { useI18n } from '../i18n'

export function useOcr(setProgress: (progress: string) => void) {
  const { t } = useI18n()
  const workerRef = useRef<OcrWorker | null>(null)
  const workerPromiseRef = useRef<Promise<OcrWorker> | null>(null)
  const workerIdleTimerRef = useRef<number | null>(null)
  const showOcrProgressRef = useRef(false)
  const pendingRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (workerIdleTimerRef.current !== null) window.clearTimeout(workerIdleTimerRef.current)
      const pendingWorker = workerPromiseRef.current
      workerRef.current = null
      workerPromiseRef.current = null
      void pendingWorker?.then((worker) => worker.terminate()).catch(() => undefined)
    }
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
        if (mountedRef.current) workerRef.current = worker
        return worker
      }).catch((reason) => {
        workerPromiseRef.current = null
        throw reason
      })
    }
    return workerPromiseRef.current
  }, [t, setProgress])

  const recognize = useCallback(async (image: string) => {
    pendingRef.current += 1
    showOcrProgressRef.current = true
    setProgress(t('preparingOcr'))
    try {
      const worker = await getWorker()
      const result = await worker.recognize(image)
      return result.data.text.trim()
    } finally {
      pendingRef.current -= 1
      showOcrProgressRef.current = pendingRef.current > 0
      if (workerIdleTimerRef.current !== null) window.clearTimeout(workerIdleTimerRef.current)
      if (pendingRef.current === 0 && mountedRef.current) {
        workerIdleTimerRef.current = window.setTimeout(() => {
          const idleWorker = workerRef.current
          workerRef.current = null
          workerPromiseRef.current = null
          workerIdleTimerRef.current = null
          void idleWorker?.terminate()
        }, 30 * 1000)
      }
    }
  }, [getWorker, t, setProgress])

  return recognize
}
