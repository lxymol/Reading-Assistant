import type { ReaderLocation } from '../types'

export type LocationCapture = () => ReaderLocation | null
export type LocationNavigator = (location: ReaderLocation) => Promise<boolean> | boolean

export class NavigationService {
  private history: ReaderLocation[] = []
  private readonly limit: number
  constructor(limit = 100) { this.limit = limit }

  get canGoBack() { return this.history.length > 0 }
  get depth() { return this.history.length }

  async navigate(target: ReaderLocation, capture: LocationCapture, apply: LocationNavigator, record = true) {
    const current = capture()
    if (record && current) {
      this.history.push(current)
      if (this.history.length > this.limit) this.history.shift()
    }
    const succeeded = await apply(target)
    if (!succeeded && record && current) this.history.pop()
    return succeeded
  }

  async back(apply: LocationNavigator) {
    const previous = this.history.pop()
    if (!previous) return false
    const succeeded = await apply(previous)
    if (!succeeded) this.history.push(previous)
    return succeeded
  }

  clear() { this.history = [] }
}
