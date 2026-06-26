import { useEffect, useRef, useState } from 'react'
import { IconMin, IconMax, IconRestore, IconClose } from './icons'

export function TitleBar({ title }: { title: string }) {
  const [max, setMax] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  useEffect(() => window.api.onWinState((s) => setMax(s.maximized)), [])
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
  }, [])
  // The title bar is no longer an -webkit-app-region:drag region (that swallows
  // clicks/double-clicks on Windows), so we drive it ourselves: a press becomes a
  // window drag only once the cursor moves past a small threshold; a clean press
  // (no movement) that lands within 450ms of the previous clean press toggles
  // maximize. Tracking the *previous click* (not the press) and resetting after a
  // drag means stray nearby clicks or a drag-then-regrab never maximize by accident.
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const DRAG_THRESHOLD = 4 // px the cursor must move before a press counts as a drag
    let lastClick = Number.NEGATIVE_INFINITY // timestamp of the last clean (no-drag) release
    let downX = 0
    let downY = 0
    let armed = false // a primary button is down and could still become a drag
    let dragging = false

    const onMove = (e: MouseEvent): void => {
      if (!armed || dragging) return
      if (Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY) > DRAG_THRESHOLD) {
        dragging = true
        window.api.win.dragStart()
      }
    }
    const onUp = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      armed = false
      if (dragging) {
        dragging = false
        lastClick = Number.NEGATIVE_INFINITY // a drag is never half of a double-click
        window.api.win.dragEnd()
        return
      }
      // a clean press+release: maximize only on a genuine double-click
      if (e.timeStamp - lastClick <= 450) {
        lastClick = Number.NEGATIVE_INFINITY
        window.api.win.toggleMaximize()
      } else {
        lastClick = e.timeStamp
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('.tb-controls, .tb-left')) return
      e.preventDefault()
      downX = e.screenX
      downY = e.screenY
      armed = true
      dragging = false
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    el.addEventListener('mousedown', onDown)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.api.win.dragEnd()
    }
  }, [])
  return (
    <div className="titlebar" ref={barRef}>
      {/* 사이드바를 접으면 그 "다시 열기" 토글이 여기로 포털된다 (Sidebar.tsx). 비어
          있으면 :empty로 숨겨 제목 위치에 영향이 없다. */}
      <span className="tb-left" id="tb-left-slot" />
      {title && <span className="tb-page">{title}</span>}
      <div className="tb-spacer" />
      <div className="tb-controls">
        <button className="tb-btn" aria-label="최소화" data-tip="최소화" onClick={() => window.api.win.minimize()}>
          <IconMin size={15} />
        </button>
        <button
          className="tb-btn"
          aria-label={max ? '이전 크기로' : '최대화'}
          data-tip={max ? '이전 크기로' : '최대화'}
          onClick={() => window.api.win.toggleMaximize()}
        >
          {max ? <IconRestore size={14} /> : <IconMax size={13} />}
        </button>
        <button className="tb-btn close" aria-label="닫기" data-tip="닫기" onClick={() => window.api.win.close()}>
          <IconClose size={15} />
        </button>
      </div>
    </div>
  )
}
