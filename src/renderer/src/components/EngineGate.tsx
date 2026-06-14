import { useEffect, useRef, useState } from 'react'
import { IconAlert, IconCheck, IconBolt, IconClaude } from './icons'

// numeric semver-ish compare: <0 if a is older than b
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

type Phase = 'hidden' | 'prompt' | 'installing' | 'done' | 'error'

/**
 * On launch: if the Claude engine isn't installed (or is older than the latest
 * available), pops a card prompting to install the latest version — one click
 * installs it into ~/.agentcodegui and activates it.
 */
export function EngineGate() {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [kind, setKind] = useState<'install' | 'update'>('install')
  const [target, setTarget] = useState('') // latest version to install
  const [activeVer, setActiveVer] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const installingRef = useRef(false)

  // one-time check on mount
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [state, avail] = await Promise.all([window.api.engine.state(), window.api.engine.listAvailable()])
        if (!alive) return
        const latest = avail.latest
        if (!latest) return // can't determine latest (offline) → stay hidden
        setTarget(latest)
        setActiveVer(state.active)
        if (!state.active) {
          setKind('install')
          setPhase('prompt')
        } else if (cmpVer(state.active, latest) < 0) {
          setKind('update')
          setPhase('prompt')
        }
      } catch {
        /* offline / error → stay hidden, settings still lets them install */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // accumulate npm output while our own install runs
  useEffect(() => {
    return window.api.engine.onInstallProgress((p) => {
      if (p.line && installingRef.current) setLog((l) => [...l, p.line as string])
    })
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const doInstall = async (): Promise<void> => {
    installingRef.current = true
    setError(null)
    setLog(['설치를 준비하는 중…'])
    setPhase('installing')
    try {
      const r = await window.api.engine.install(target)
      if (r.ok) {
        await window.api.engine.setActive(target)
        setPhase('done')
      } else {
        setError(r.error ?? '알 수 없는 오류로 설치에 실패했습니다.')
        setPhase('error')
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setPhase('error')
    } finally {
      installingRef.current = false
    }
  }

  if (phase === 'hidden') return null

  if (phase === 'prompt') {
    return (
      <div className="set-dialog-overlay">
        <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="sd-ic warn">{kind === 'update' ? <IconBolt size={22} /> : <IconClaude size={22} />}</div>
          <div className="sd-title">{kind === 'install' ? 'Claude 엔진 설치' : '새 엔진 버전'}</div>
          <div className="sd-msg">
            {kind === 'install'
              ? `Claude Code 엔진이 아직 설치되지 않았습니다. 최신 버전(${target})을 설치하면 바로 사용할 수 있어요.`
              : `현재 ${activeVer} 버전을 사용 중입니다. 최신 버전(${target})으로 업데이트할까요?`}
          </div>
          <div className="sd-btns">
            <button className="sd-cancel" onClick={() => setPhase('hidden')}>
              나중에
            </button>
            <button className="sd-go" onClick={doInstall}>
              {kind === 'install' ? '설치' : '업데이트'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // installing / done / error → log card
  const statusCls = phase === 'installing' ? 'running' : phase === 'done' ? 'done' : 'error'
  return (
    <div
      className="set-dialog-overlay"
      onMouseDown={() => {
        if (phase !== 'installing') setPhase('hidden')
      }}
    >
      <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ic-head">
          <span className={'ic-hic ' + statusCls}>
            {phase === 'installing' ? (
              <span className="set-spin" />
            ) : phase === 'done' ? (
              <IconCheck size={16} />
            ) : (
              <IconAlert size={16} />
            )}
          </span>
          <span className="ic-title">
            {phase === 'installing' ? '엔진 설치 중' : phase === 'done' ? '설치 완료' : '설치 실패'}
          </span>
          <span className="ic-ver">{target}</span>
        </div>
        <div className="ic-log scroll" ref={logRef}>
          {log.map((l, i) => (
            <div className="ic-ln" key={i}>
              {l}
            </div>
          ))}
          {phase === 'error' && error && <div className="ic-ln err">{error}</div>}
        </div>
        <div className="ic-foot">
          <span className={'ic-status ' + statusCls}>
            {phase === 'installing'
              ? '설치하는 중…'
              : phase === 'done'
                ? '설치가 완료되었습니다'
                : '설치에 실패했습니다'}
          </span>
          {phase === 'error' && (
            <button className="sd-cancel" onClick={doInstall}>
              다시 시도
            </button>
          )}
          <button className="sd-go" onClick={() => setPhase('hidden')} disabled={phase === 'installing'}>
            확인
          </button>
        </div>
      </div>
    </div>
  )
}
