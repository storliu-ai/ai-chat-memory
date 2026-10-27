import { getShareCaptureProgress, type ShareCaptureStatus } from '../../shared/share-capture'

export function ShareCaptureProgress({ status }: { status: ShareCaptureStatus | null }) {
  const complete = status?.phase === 'complete'
  const terminal = status !== null && ['complete', 'failed', 'cancelled'].includes(status.phase)
  const failed = status?.phase === 'failed'
  const needsForeground = status?.phase === 'needs-foreground'
  return (
    <div className="share-capture-progress" data-phase={status?.phase} role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>
      {needsForeground && <strong className="share-foreground-notice">需要打开分享采集页继续</strong>}
      {(!terminal || complete) && <div className="capture-progress-track" role="progressbar" aria-label="采集阶段进度"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={getShareCaptureProgress(status)} aria-valuetext={status?.message ?? '正在准备分享采集'}>
        <div className="capture-progress-fill" style={{ width: `${getShareCaptureProgress(status)}%` }} />
      </div>}
      <strong>已读取 {status?.messageCount ?? 0} 条消息{complete ? ' · 已保存到原对话' : status?.phase === 'ready' ? ' · 正在保存' : ''}</strong>
      <p>{status?.message ?? '正在准备分享采集…'}</p>
    </div>
  )
}
