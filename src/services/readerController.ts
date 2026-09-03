import type { ReaderLocation } from '../types'

export class ReaderController {
  private projectId: string | null = null
  private fileId: string | null = null

  activate(projectId: string, fileId: string | null) { this.projectId = projectId; this.fileId = fileId }
  clear() { this.projectId = null; this.fileId = null }
  matches(location: Pick<ReaderLocation, 'projectId' | 'fileId'>) { return this.projectId === location.projectId && this.fileId === location.fileId }
  current(page: number, zoom: number, scrollTop: number): ReaderLocation | null {
    return this.projectId && this.fileId ? { projectId: this.projectId, fileId: this.fileId, page, zoom, scrollTop } : null
  }
}
