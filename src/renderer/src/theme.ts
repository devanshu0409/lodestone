import { useEffect, useState } from 'react'
import { create } from 'zustand'

export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'lodestone.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref
}

function apply(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolve(pref)
}

interface ThemeState {
  pref: ThemePref
  setPref(pref: ThemePref): void
}

export const useTheme = create<ThemeState>((set) => ({
  pref: (localStorage.getItem(STORAGE_KEY) as ThemePref) || 'system',
  setPref: (pref) => {
    localStorage.setItem(STORAGE_KEY, pref)
    apply(pref)
    set({ pref })
  }
}))

/** Resolved light/dark value that re-renders when the OS scheme flips in system mode. */
export function useResolvedTheme(): 'light' | 'dark' {
  const pref = useTheme((s) => s.pref)
  const [sysDark, setSysDark] = useState(media.matches)
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent): void => setSysDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return pref === 'system' ? (sysDark ? 'dark' : 'light') : pref
}

// Apply before first render, and follow OS changes while in system mode.
apply(useTheme.getState().pref)
media.addEventListener('change', () => {
  if (useTheme.getState().pref === 'system') apply('system')
})
