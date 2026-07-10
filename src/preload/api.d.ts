import type { LodestoneApi } from './index'

declare global {
  interface Window {
    lodestone: LodestoneApi
  }
}

export {}
