const pressable = [
  'button', 'a[href]', 'summary', '[role="button"]', 'label.btn', '[data-pressable]',
  'input:is([type="button"], [type="submit"], [type="reset"], [type="image"], [type="checkbox"], [type="radio"])',
].join(', ')
const minimumPressMs = 80

export function installTouchPressFeedback(doc: Document = document): () => void {
  let press: { control: Element; pointerId: number; startedAt: number } | undefined
  let releaseTimer: ReturnType<typeof setTimeout> | undefined

  function clearPress() {
    clearTimeout(releaseTimer)
    press?.control.removeAttribute('data-touch-pressed')
    press = undefined
  }

  function pointerDown(event: PointerEvent) {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || !event.isPrimary || event.button !== 0) return
    clearPress()
    const control = event.target instanceof Element ? event.target.closest(pressable) : null
    if (!control || control.matches(':disabled, [aria-disabled="true"]')) return
    press = { control, pointerId: event.pointerId, startedAt: event.timeStamp }
    control.setAttribute('data-touch-pressed', '')
  }

  function pointerUp(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return
    const remaining = minimumPressMs - (event.timeStamp - press.startedAt)
    if (remaining > 0) releaseTimer = setTimeout(clearPress, remaining)
    else clearPress()
  }

  function pointerCancel(event: PointerEvent) {
    if (event.pointerId === press?.pointerId) clearPress()
  }

  const listeners = new AbortController()
  const options = { capture: true, passive: true, signal: listeners.signal }
  doc.addEventListener('pointerdown', pointerDown, options)
  doc.addEventListener('pointerup', pointerUp, options)
  doc.addEventListener('pointercancel', pointerCancel, options)
  doc.addEventListener('contextmenu', clearPress, options)
  doc.defaultView?.addEventListener('blur', clearPress, { signal: listeners.signal })
  return () => {
    clearPress()
    listeners.abort()
  }
}
