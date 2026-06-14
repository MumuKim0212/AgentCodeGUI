import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangedFile } from '@shared/protocol'
import { FileBadge } from './fileType'
import { IconChevsRight, IconClose, IconCloseOthers, IconTrash, IconX2 } from './icons'

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// 우클릭 메뉴의 화면 가장자리 클램프용 추정치
const MENU_W = 178
const MENU_H = 164

// 채팅 헤더 아래 최근 파일 탭 — 탐색기·툴 로그·변경 패널·정의 이동에서 연 파일이
// 최신순으로 쌓이고, 클릭하면 그 파일이 모달(diff 있으면 diff, 없으면 뷰어)로
// 열린다. 비어 있으면 줄 자체가 사라져 채팅 공간을 차지하지 않는다. 채팅별 영속.
export const RecentFiles = memo(function RecentFiles({
  files,
  changed,
  activePath,
  onOpen,
  onRemove,
  onReorder
}: {
  files: string[] // 최신순 rel 경로
  changed: ChangedFile[] // 이 세션에서 만진 파일 → M/N 배지
  activePath: string | null // 지금 모달로 열려 있는 파일 (액센트 표시)
  onOpen: (path: string) => void
  onRemove: (paths: string[]) => void // 한 개든 여러 개든 한 번에 제거
  onReorder: (files: string[]) => void // 드래그로 바뀐 순서 전체를 반영
}) {
  // 드래그 중인 탭 — 다른 탭 위를 지날 때마다 실시간으로 자리를 바꾼다
  const [dragPath, setDragPath] = useState<string | null>(null)
  // 탭 우클릭 메뉴 (닫기 / 다른 탭 닫기 / 오른쪽 탭 닫기 / 모두 닫기)
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)

  // FLIP: 순서가 바뀌면(드래그·닫기) 탭이 툭 점프하지 않고 이전 위치에서 새 위치로
  // 미끄러진다 — 커밋 직후 이전 rect와의 가로 차이만큼 transform으로 되돌려놓고,
  // 다음 프레임에 transform을 풀면서 transition을 걸어 제자리로 흘려보낸다.
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const prevRects = useRef(new Map<string, number>()) // path → left
  // 애니메이션 중인 탭 — 이동 중인 탭 위에서 스왑을 판정하면 왕복 루프가 생기므로
  // (탭 폭이 제각각 → 스왑 직후 커서가 다시 상대 탭 위) dragOver에서 제외한다
  const animating = useRef(new Set<string>())
  useLayoutEffect(() => {
    const rects = new Map<string, number>()
    for (const [p, el] of tabRefs.current) rects.set(p, el.getBoundingClientRect().left)
    for (const [p, el] of tabRefs.current) {
      const prev = prevRects.current.get(p)
      const cur = rects.get(p)
      if (prev == null || cur == null) continue
      const dx = prev - cur
      if (!dx) continue
      animating.current.add(p)
      el.style.transition = 'none'
      el.style.transform = `translateX(${dx}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)'
        el.style.transform = ''
        let done = false
        const clear = (): void => {
          if (done) return
          done = true
          animating.current.delete(p)
          el.style.transition = '' // CSS의 hover transition(배경·링)을 되살린다
          el.removeEventListener('transitionend', clear)
          el.removeEventListener('transitioncancel', clear)
        }
        el.addEventListener('transitionend', clear)
        el.addEventListener('transitioncancel', clear)
        setTimeout(clear, 240) // 이벤트가 유실돼도 잠금이 남지 않게
      })
    }
    prevRects.current = rects
  }, [files])
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (files.length === 0) return null

  const menuIdx = menu ? files.indexOf(menu.path) : -1
  const pick = (paths: string[]): void => {
    onRemove(paths)
    setMenu(null)
  }

  return (
    <div className="chat-files">
      {files.map((p) => {
        const chg = changed.find((f) => f.path === p)
        return (
          <button
            key={p}
            ref={(el) => {
              if (el) tabRefs.current.set(p, el)
              else tabRefs.current.delete(p)
            }}
            className={'cf-tab' + (p === activePath ? ' on' : '') + (p === dragPath ? ' dragging' : '')}
            onClick={() => onOpen(p)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ path: p, x: e.clientX, y: e.clientY })
            }}
            // 휠클릭 = 목록에서 제거 (IDE 탭 관습)
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onRemove([p])
              }
            }}
            // 꾹 눌러 드래그 → 다른 탭 위를 지나면 그 자리로 끼워넣기 (실시간)
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', p)
              setDragPath(p)
            }}
            onDragEnd={() => setDragPath(null)}
            onDragOver={(e) => {
              if (dragPath == null || dragPath === p) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (animating.current.has(p)) return // 이동 중인 탭 위에선 판정 보류
              const from = files.indexOf(dragPath)
              const to = files.indexOf(p)
              if (from < 0 || to < 0 || from === to) return
              // 중간점 규칙: 커서가 상대 탭의 가운데를 넘어야만 자리를 바꾼다 —
              // 폭이 다른 탭끼리 스칠 때 스왑이 왕복하는 것을 막는다
              const rect = e.currentTarget.getBoundingClientRect()
              const mid = rect.left + rect.width / 2
              if (from < to && e.clientX < mid) return
              if (from > to && e.clientX > mid) return
              const next = [...files]
              next.splice(from, 1)
              next.splice(to, 0, dragPath)
              onReorder(next)
            }}
            onDrop={(e) => e.preventDefault()}
          >
            <FileBadge path={p} size={15} />
            <span className="cf-name">{basename(p)}</span>
            {chg && <span className={'exp-chg ' + chg.tag}>{chg.tag === 'new' ? 'N' : 'M'}</span>}
            <span
              className="cf-x"
              role="button"
              aria-label="목록에서 제거"
              onClick={(e) => {
                e.stopPropagation()
                onRemove([p])
              }}
            >
              <IconX2 size={10} />
            </span>
          </button>
        )
      })}

      {menu && menuIdx >= 0 && (
        <div
          className="ctx-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H - 8))
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="ctx-item" onClick={() => pick([menu.path])}>
            <IconClose size={15} /> 닫기
          </button>
          {files.length > 1 && (
            <button className="ctx-item" onClick={() => pick(files.filter((p) => p !== menu.path))}>
              <IconCloseOthers size={15} /> 다른 탭 닫기
            </button>
          )}
          {menuIdx < files.length - 1 && (
            <button className="ctx-item" onClick={() => pick(files.slice(menuIdx + 1))}>
              <IconChevsRight size={15} /> 오른쪽 탭 닫기
            </button>
          )}
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => pick(files)}>
            <IconTrash size={15} /> 모두 닫기
          </button>
        </div>
      )}
    </div>
  )
})
