import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SharedDirectoryStatus } from '../shared/models'
import {
  connectSharedDirectory,
  disconnectSharedDirectory,
  getSharedDirectoryStatus,
  requestStoredDirectoryPermission,
  updateEnvironmentLabelAndMirror,
} from '../services/shared-directory-service'
import './styles.css'

function getStateCopy(status: SharedDirectoryStatus | null): string {
  switch (status?.state) {
    case 'granted':
      return `已连接“${status.rootName ?? '共享目录'}”`
    case 'permission-required':
      return '目录权限需要重新确认'
    case 'unavailable':
      return '当前浏览器内核不支持持久目录访问'
    default:
      return '尚未连接共享目录'
  }
}

export function StorageSetupApp() {
  const [status, setStatus] = useState<SharedDirectoryStatus | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickerSupported = typeof window.showDirectoryPicker === 'function'

  const refresh = async (): Promise<void> => {
    const next = await getSharedDirectoryStatus()
    setStatus(next)
    setLabel(next.currentEnvironment.label)
  }

  useEffect(() => {
    let active = true
    void getSharedDirectoryStatus()
      .then((next) => {
        if (active) {
          setStatus(next)
          setLabel(next.currentEnvironment.label)
        }
      })
      .catch(() => {
        if (active) {
          setError('共享目录状态读取失败')
        }
      })
    return () => {
      active = false
    }
  }, [])

  const chooseDirectory = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    if (!pickerSupported) {
      setError('当前 Chromium 内核不支持目录选择，请升级浏览器内核')
      return
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: 'ai-chat-memory-root',
        mode: 'readwrite',
        startIn: 'documents',
      })
      setBusy(true)
      const next = await connectSharedDirectory(handle)
      setStatus(next)
      setLabel(next.currentEnvironment.label)
      setNotice('目录连接成功，本环境数据已经写入独立子目录')
    } catch (chooseError: unknown) {
      if (!(chooseError instanceof DOMException && chooseError.name === 'AbortError')) {
        setError('目录连接失败，请确认已授予读写权限')
      }
    } finally {
      setBusy(false)
    }
  }

  const authorizeExisting = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const permission = await requestStoredDirectoryPermission()
      if (permission !== 'granted') {
        setError('未获得共享目录读写权限')
        return
      }
      await refresh()
      setNotice('目录权限已恢复并完成同步')
    } catch {
      setError('目录重新授权失败')
    } finally {
      setBusy(false)
    }
  }

  const saveLabel = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const environment = await updateEnvironmentLabelAndMirror(label)
      setLabel(environment.label)
      await refresh()
      setNotice('本环境名称已保存')
    } catch (labelError: unknown) {
      setError(labelError instanceof Error ? labelError.message : '环境名称保存失败')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await disconnectSharedDirectory()
      await refresh()
      setNotice('已断开连接；磁盘中的数据文件没有被删除')
    } catch {
      setError('断开共享目录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="storage-shell">
      <header>
        <span className="storage-mark" aria-hidden="true">▥</span>
        <div>
          <small>AI Chat Memory</small>
          <h1>共享目录设置</h1>
        </div>
      </header>

      <section className="storage-card storage-intro">
        <h2>同一根目录，环境彼此隔离</h2>
        <p>
          请在每个 Chromium 浏览器环境中选择同一个目录。插件自动同步到当前环境自己的
          <code> environments/env-&lt;环境 ID&gt; </code>子目录。对话库中也可删除其他环境的对话，原环境再次运行后执行本地删除。
        </p>
        <p className="storage-privacy-warning">
          对话会以可读 JSON 保存在该目录中，不会加密；请勿选择云盘、公用或他人可访问的目录。
        </p>
      </section>

      {error && <div className="storage-banner storage-error">{error}</div>}
      {notice && <div className="storage-banner storage-success">{notice}</div>}

      <section className="storage-card">
        <div className="storage-status-row">
          <span>
            <small>目录状态</small>
            <strong>{getStateCopy(status)}</strong>
          </span>
          <i className={status?.state === 'granted' ? 'status-dot connected' : 'status-dot'} />
        </div>
        <div className="storage-actions">
          <button className="primary" type="button" disabled={busy} onClick={() => void chooseDirectory()}>
            {status?.state === 'disconnected' ? '选择共享目录' : '更换共享目录'}
          </button>
          {status?.state === 'permission-required' && (
            <button type="button" disabled={busy} onClick={() => void authorizeExisting()}>
              重新授权
            </button>
          )}
        </div>
      </section>

      <section className="storage-card">
        <label className="environment-label">
          <span>本环境名称</span>
          <small>用于在其他环境的选择列表中识别此环境</small>
          <div>
            <input
              value={label}
              maxLength={80}
              disabled={status === null || busy}
              onChange={(event) => setLabel(event.target.value)}
            />
            <button type="button" disabled={status === null || busy} onClick={() => void saveLabel()}>
              保存名称
            </button>
          </div>
        </label>
        <p className="environment-id">
          环境 ID：<code>{status?.currentEnvironment.id ?? '读取中…'}</code>
        </p>
      </section>

      <footer>
        {status?.state !== 'disconnected' && (
          <button className="disconnect" type="button" disabled={busy} onClick={() => void disconnect()}>
            断开目录
          </button>
        )}
        <button type="button" onClick={() => window.close()}>完成并关闭</button>
      </footer>
    </main>
  )
}

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Storage setup root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <StorageSetupApp />
  </StrictMode>,
)
