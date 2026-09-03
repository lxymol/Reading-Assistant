import type { DocumentTag, NormalizedRegion } from '../types'

export const createTag = (projectId: string, fileId: string, page: number, region: NormalizedRegion, label: string): DocumentTag => ({
  id: crypto.randomUUID(), projectId, fileId, page, region, label: label.trim(), createdAt: Date.now(),
})

export const tagsWithoutFile = (tags: DocumentTag[], fileId: string) => tags.filter((tag) => tag.fileId !== fileId)
