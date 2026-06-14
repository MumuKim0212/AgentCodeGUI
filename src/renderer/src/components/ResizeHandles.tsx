import type { ResizeEdge } from '@shared/protocol'

const CURSORS: Record<ResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize'
}
const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * Custom resize handles for the frameless+transparent window. Windows can't
 * hit-test resize on transparent pixels, so we grab the 16px transparent margin
 * around the rounded card and let the main process drive the bounds: it samples
 * the live OS cursor, which (unlike renderer pointer events on a moving window)
 * never feeds back on itself and snowballs the window larger. The renderer only
 * reports press → resizeStart and release → resizeEnd.
 */
export function ResizeHandles() {
  // Press a handle → the main process drives the bounds from the live OS cursor; the
  // renderer's only job is to say when the gesture ends. We end on a *window-level*
  // mouseup rather than the handle's own pointerup: a button press grabs Chromium's
  // implicit mouse capture, so the release is delivered to the document even once the
  // cursor has slipped off the thin handle or the resizing window has moved out from
  // under it. The old per-handle setPointerCapture/onPointerUp could silently drop the
  // release while the window resized — leaving the main-process timer running, so the
  // window kept resizing (and growing) on every later mouse move.
  const onDown = (edge: ResizeEdge) => (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    window.api.win.resizeStart(edge)
    const end = (): void => {
      window.removeEventListener('mouseup', end)
      window.api.win.resizeEnd()
    }
    window.addEventListener('mouseup', end)
  }

  return (
    <div className="resize-layer">
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={'rz rz-' + edge}
          style={{ cursor: CURSORS[edge] }}
          onMouseDown={onDown(edge)}
        />
      ))}
    </div>
  )
}
