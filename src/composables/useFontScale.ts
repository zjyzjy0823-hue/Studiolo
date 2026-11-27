import { ref, type Ref } from 'vue'

export type FontScaleId = 'compact' | 'small' | 'standard' | 'large' | 'xlarge' | 'huge'

export const FONT_SCALE_OPTIONS: { id: FontScaleId; label: string; factor: number }[] = [
  { id: 'compact', label: '紧凑', factor: 0.8 },
  { id: 'small', label: '小', factor: 0.9 },
  { id: 'standard', label: '标准', factor: 1 },
  { id: 'large', label: '大', factor: 1.12 },
  { id: 'xlarge', label: '更大', factor: 1.25 },
  { id: 'huge', label: '特大', factor: 1.4 },
]

export const DEFAULT_FONT_SCALE: FontScaleId = 'standard'
const STORAGE_KEY = 'studiolo:font-scale'
const VALID_IDS = new Set<FontScaleId>(FONT_SCALE_OPTIONS.map(opt => opt.id))

export function readStoredFontScale(): FontScaleId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as FontScaleId | null
    if (saved && VALID_IDS.has(saved)) {
      return saved
    }
    return DEFAULT_FONT_SCALE
  } catch {
    return DEFAULT_FONT_SCALE
  }
}

export function applyFontScale(id: FontScaleId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.fontSize = id
  }
}

const currentScale = ref<FontScaleId>(readStoredFontScale())
applyFontScale(currentScale.value)

export function useFontScale(): { scale: Ref<FontScaleId>; setScale(id: FontScaleId): void } {
  applyFontScale(currentScale.value)

  function setScale(id: FontScaleId) {
    const validId = VALID_IDS.has(id) ? id : DEFAULT_FONT_SCALE
    currentScale.value = validId
    applyFontScale(validId)
    try {
      localStorage.setItem(STORAGE_KEY, validId)
    } catch {
      // 存储受限静默降级，保持响应式状态
    }
  }

  return {
    scale: currentScale,
    setScale,
  }
}
