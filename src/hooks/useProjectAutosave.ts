import { useEffect, useMemo } from 'react'
import type { RuntimeProject } from '../types'
import { createAutosaveScheduler } from '../services/autosaveScheduler'
import { projectRepository } from '../services/projectRepository'

export function useProjectAutosave(projectId: string | null, snapshot: () => RuntimeProject | null, onError: (message: string) => void) {
  const scheduler = useMemo(() => createAutosaveScheduler<RuntimeProject>(
    (project) => projectRepository.save(project),
    (error) => onError(error instanceof Error ? error.message : '项目保存失败。'),
  ), [onError])

  useEffect(() => {
    const unsubscribe = projectRepository.onWrite((id) => scheduler.cancel(id))
    if (projectId) scheduler.schedule(projectId, snapshot)
    else void scheduler.flush()
    return unsubscribe
  }, [projectId, snapshot, scheduler])

  useEffect(() => {
    const flush = () => { void scheduler.flush() }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      flush()
    }
  }, [scheduler])
}
