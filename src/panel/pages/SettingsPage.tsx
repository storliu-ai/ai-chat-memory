import { useEffect, useRef, useState } from 'react'
import {
  MAX_ATTACHMENT_MAX_SIZE_MB,
  PLATFORM_LABELS,
  SUPPORTED_PLATFORMS,
  type AppSettings,
  type Account,
  type ConversationExclusion,
  type Platform,
  type SharedDirectoryStatus,
} from '../../shared/models'
import type { DisplayColorToken } from '../../shared/display-colors'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DisplayColorSettings } from '../components/DisplayColorSettings'
import {
  downloadExport,
  exportData,
  getConversationExclusions,
  getSettings,
  getLibraryView,
  getSharedDirectoryStatus,
  getStorageUsage,
  importData,
  removeAllData,
  removeConversationExclusion,
  openSharedDirectorySetup,
  setAutoSave,
  setAutoSavePlatforms,
  setAutoSavePinnedOnly,
  setChatGPTCaptureMode,
  setChatGPTSaveMethod,
  setAttachmentMaxSizeMb,
  setFileSavePolicy,
  setSaveImages,
  setAccountTagColors,
  setEnvironmentCardColors,
} from '../services/panel-api'

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unit
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function getDirectoryDescription(status: SharedDirectoryStatus | null): string {
  switch (status?.state) {
    case 'granted':
      return `已连接“${status.rootName ?? '共享目录'}”，发现 ${status.otherEnvironments.length} 个其他环境`
    case 'permission-required':
      return '目录已记录，但需要重新授权'
    case 'unavailable':
      return '当前浏览器内核不支持持久目录访问'
    default:
      return '未连接；当前仍只读取本环境数据'
  }
}

export function SettingsPage({ onDataChanged }: { onDataChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [directory, setDirectory] = useState<SharedDirectoryStatus | null>(null)
  const [storageBytes, setStorageBytes] = useState(0)
  const [exclusions, setExclusions] = useState<ConversationExclusion[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])

  useEffect(() => {
    let active = true
    void Promise.all([
      getSettings(),
      getStorageUsage(),
      getSharedDirectoryStatus(),
      getConversationExclusions(),
      getLibraryView({ page: 1, pageSize: 1 }),
    ])
      .then(([nextSettings, usage, nextDirectory, nextExclusions, library]) => {
        if (active) {
          setSettings(nextSettings)
          setStorageBytes(usage.bytes)
          setDirectory(nextDirectory)
          setExclusions(nextExclusions)
          setAccounts(library.accounts)
          setError(null)
        }
      })
      .catch(() => {
        if (active) {
          setError('本地数据读取失败')
        }
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const refreshLocalState = (): void => {
      void Promise.all([
        getSharedDirectoryStatus(),
        getConversationExclusions(),
        getStorageUsage(),
        getLibraryView({ page: 1, pageSize: 1 }),
      ])
        .then(([nextDirectory, nextExclusions, usage, library]) => {
          setDirectory(nextDirectory)
          setExclusions(nextExclusions)
          setStorageBytes(usage.bytes)
          setAccounts(library.accounts)
          onDataChanged()
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refreshLocalState)
    return () => window.removeEventListener('focus', refreshLocalState)
  }, [onDataChanged])

  const toggleAutoSave = async (): Promise<void> => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setAutoSave(!settings.autoSave))
    } catch {
      setError('自动保存设置更新失败')
    } finally {
      setBusy(false)
    }
  }

  const updateAccountColor = async (
    accountId: string,
    color: DisplayColorToken | undefined,
  ): Promise<void> => {
    if (settings === null || busy) {
      return
    }
    const nextColors = { ...settings.accountTagColors }
    if (color === undefined) {
      delete nextColors[accountId]
    } else {
      nextColors[accountId] = color
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setAccountTagColors(nextColors))
      onDataChanged()
    } catch {
      setError('账户标签颜色更新失败')
    } finally {
      setBusy(false)
    }
  }

  const updateEnvironmentColor = async (
    environmentId: string,
    color: DisplayColorToken | undefined,
  ): Promise<void> => {
    if (settings === null || busy) {
      return
    }
    const nextColors = { ...settings.environmentCardColors }
    if (color === undefined) {
      delete nextColors[environmentId]
    } else {
      nextColors[environmentId] = color
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setEnvironmentCardColors(nextColors))
      onDataChanged()
    } catch {
      setError('环境背景颜色更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleAutoSavePinnedOnly = async (): Promise<void> => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setAutoSavePinnedOnly(!settings.autoSavePinnedOnly))
    } catch {
      setError('置顶对话自动保存设置更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleAutoSavePlatform = async (platform: Platform): Promise<void> => {
    if (!settings || busy) {
      return
    }
    const platformIsEnabled = settings.autoSavePlatforms.includes(platform)
    const nextPlatforms = SUPPORTED_PLATFORMS.filter((candidate) =>
      candidate === platform
        ? !platformIsEnabled
        : settings.autoSavePlatforms.includes(candidate),
    )
    setBusy(true)
    setError(null)
    try {
      setSettings(await setAutoSavePlatforms(nextPlatforms))
    } catch {
      setError('自动保存平台设置更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleSaveImages = async (): Promise<void> => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setSaveImages(!settings.saveImages))
    } catch {
      setError('图片保存设置更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleFileSaving = async (): Promise<void> => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setFileSavePolicy(
        settings.fileSavePolicy === 'never' ? 'per-conversation' : 'never',
      ))
    } catch {
      setError('文件保存策略更新失败')
    } finally {
      setBusy(false)
    }
  }

  const updateAttachmentMaximum = async (
    attachmentMaxSizeMb: number,
  ): Promise<void> => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setSettings(await setAttachmentMaxSizeMb(attachmentMaxSizeMb))
    } catch {
      setError('附件大小上限更新失败')
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      downloadExport(await exportData())
      setNotice('JSON 已导出到本机')
    } catch {
      setError('导出本地数据失败')
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (file: File): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await importData(await file.text())
      setNotice(`导入完成：新增 ${result.inserted}，更新 ${result.updated}，未变化 ${result.unchanged}`)
      const [usage, nextExclusions] = await Promise.all([
        getStorageUsage(),
        getConversationExclusions(),
      ])
      setStorageBytes(usage.bytes)
      setExclusions(nextExclusions)
      onDataChanged()
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : '导入 JSON 失败')
    } finally {
      if (inputRef.current) {
        inputRef.current.value = ''
      }
      setBusy(false)
    }
  }

  const handleDeleteAll = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await removeAllData()
      setStorageBytes(0)
      setExclusions([])
      setSettings(await getSettings())
      setNotice('所有本地数据已清空')
      setClearAllDialogOpen(false)
      onDataChanged()
    } catch {
      setError('清空本地数据失败')
      setClearAllDialogOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleRemoveExclusion = async (id: string): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await removeConversationExclusion(id)
      setExclusions((current) => current.filter((item) => item.id !== id))
      setStorageBytes((await getStorageUsage()).bytes)
      setNotice('已解除排除；下次打开或更新该对话时可再次自动保存')
    } catch {
      setError('解除自动保存排除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page settings-page">
      <div className="page-title-row">
        <div>
          <span className="section-kicker">当前设备</span>
          <h2>设置</h2>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <section className="settings-section">
        <button
          className="setting-row setting-toggle"
          type="button"
          disabled={settings === null || busy}
          onClick={() => void toggleAutoSave()}
        >
          <span>
            <strong>自动保存</strong>
            <small>
              {settings?.autoSave
                ? settings.autoSavePlatforms.length > 0
                  ? `已开启：${settings.autoSavePlatforms.map((platform) => PLATFORM_LABELS[platform]).join('、')}`
                  : '已开启，但尚未选择生效平台'
                : '已关闭，可在对话页手动保存当前对话'}
            </small>
          </span>
          <i className={settings?.autoSave ? 'switch switch-on' : 'switch'} aria-hidden="true" />
        </button>
        <div className="auto-save-platforms">
          <span className="auto-save-platforms-copy">
            <strong>自动保存生效平台</strong>
            <small>三个平台可独立选择；手动保存不受此处限制</small>
          </span>
          <div className="platform-choice-grid" role="group" aria-label="选择自动保存生效平台">
            {SUPPORTED_PLATFORMS.map((platform) => {
              const selected = settings?.autoSavePlatforms.includes(platform) === true
              return (
                <button
                  key={platform}
                  className={selected ? 'platform-choice platform-choice-selected' : 'platform-choice'}
                  type="button"
                  aria-pressed={selected}
                  disabled={settings === null || busy}
                  onClick={() => void toggleAutoSavePlatform(platform)}
                >
                  <i aria-hidden="true">{selected ? '✓' : ''}</i>
                  {PLATFORM_LABELS[platform]}
                </button>
              )
            })}
          </div>
        </div>
        <button
          className="setting-row setting-toggle"
          type="button"
          disabled={settings === null || busy}
          onClick={() => void toggleAutoSavePinnedOnly()}
        >
          <span>
            <strong>首次仅收录已置顶对话</strong>
            <small>三个平台统一限制；无原生置顶时可手动保存，已存对话仍自动更新</small>
          </span>
          <i
            className={settings?.autoSavePinnedOnly ? 'switch switch-on' : 'switch'}
            aria-hidden="true"
          />
        </button>
      </section>

      <section className="settings-section attachment-settings-section">
        <div className="setting-row capture-mode-setting">
          <span>
            <strong>ChatGPT 默认采集保存模式</strong>
            <small>用于手动保存；侧边栏可为当前对话单独选择，自动同步仍读取当前页面</small>
          </span>
          <div className="capture-mode-buttons" role="group" aria-label="ChatGPT 默认采集方式">
            {(['conversation', 'share'] as const).map((mode) => (
            <button key={mode} type="button" disabled={settings === null || busy}
              aria-pressed={(settings?.chatgptCaptureMode ?? 'conversation') === mode}
              onClick={() => {
              setBusy(true)
              void setChatGPTCaptureMode(mode).then(setSettings).catch(() => setError('读取方式保存失败')).finally(() => setBusy(false))
              }}>
              {mode === 'conversation' ? '本对话滑动' : '分享页滑动'}
            </button>
            ))}
          </div>
        </div>
        <div className="setting-row capture-mode-setting">
          <span><strong>ChatGPT 默认保存方式</strong><small>DOM 读取页面；接口依据完整分页或当前分支核对后保存</small></span>
          <div className="capture-mode-buttons" role="group" aria-label="ChatGPT 默认保存方式">
            {(['dom', 'network'] as const).map((method) => <button key={method} type="button" disabled={settings === null || busy}
              aria-pressed={(settings?.chatgptSaveMethod ?? 'dom') === method} onClick={() => {
                setBusy(true)
                void setChatGPTSaveMethod(method).then(setSettings).catch(() => setError('保存方式设置失败')).finally(() => setBusy(false))
              }}>{method === 'dom' ? '页面滑动 + DOM' : '页面滑动 + 接口'}</button>)}
          </div>
        </div>
      </section>

      <section className="settings-section attachment-settings-section">
        <button
          className="setting-row setting-toggle"
          type="button"
          disabled={settings === null || busy}
          onClick={() => void toggleSaveImages()}
        >
          <span>
            <strong>新对话默认保存图片</strong>
            <small>作为新对话默认值；每条已保存对话可在侧边栏或详情中单独覆盖</small>
          </span>
          <i
            className={settings?.saveImages ? 'switch switch-on' : 'switch'}
            aria-hidden="true"
          />
        </button>
        <button
          className="setting-row setting-toggle"
          type="button"
          disabled={settings === null || busy}
          onClick={() => void toggleFileSaving()}
        >
          <span>
            <strong>普通文件保存</strong>
            <small>开启后仍需在每条对话中单独授权；与重要标记互不影响</small>
          </span>
          <i
            className={settings?.fileSavePolicy === 'per-conversation'
              ? 'switch switch-on'
              : 'switch'}
            aria-hidden="true"
          />
        </button>
        <label className="setting-row setting-select-row">
          <span>
            <strong>单个附件上限</strong>
            <small>图片和文件统一限制；超过 10 MB 永不保存</small>
          </span>
          <select
            aria-label="单个附件大小上限"
            value={settings?.attachmentMaxSizeMb ?? MAX_ATTACHMENT_MAX_SIZE_MB}
            disabled={settings === null || busy}
            onChange={(event) => void updateAttachmentMaximum(Number(event.target.value))}
          >
            {[1, 2, 5, 10].map((size) => (
              <option key={size} value={size}>{size} MB</option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-section exclusion-section">
        <div className="setting-row">
          <span>
            <strong>自动保存排除列表</strong>
            <small>手动删除的对话不会再次自动收录；手动保存可直接恢复</small>
          </span>
          <b>{exclusions.length}</b>
        </div>
        {exclusions.map((exclusion) => (
          <div className="exclusion-row" key={exclusion.id}>
            <span>
              <strong title={exclusion.title}>{exclusion.title}</strong>
              <small>{PLATFORM_LABELS[exclusion.platform]}</small>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRemoveExclusion(exclusion.id)}
            >
              解除排除
            </button>
          </div>
        ))}
      </section>

      <section className="settings-section shared-directory-section">
        <div className="setting-row">
          <span>
            <strong>环境与共享目录</strong>
            <small>{getDirectoryDescription(directory)}</small>
            <small>
              本环境：{directory?.currentEnvironment.label ?? '读取中…'}
            </small>
          </span>
          <button
            className="shared-directory-button"
            type="button"
            onClick={() => void openSharedDirectorySetup().catch(() => {
              setError('无法打开共享目录设置页')
            })}
          >
            {directory?.state === 'disconnected' ? '连接' : '环境设置'}
          </button>
        </div>
      </section>

      <DisplayColorSettings
        accounts={accounts}
        environments={directory === null
          ? []
          : [directory.currentEnvironment, ...directory.otherEnvironments]}
        currentEnvironmentId={directory?.currentEnvironment.id ?? null}
        accountColors={settings?.accountTagColors ?? {}}
        environmentColors={settings?.environmentCardColors ?? {}}
        busy={busy}
        onAccountColorChange={(accountId, color) => {
          void updateAccountColor(accountId, color)
        }}
        onEnvironmentColorChange={(environmentId, color) => {
          void updateEnvironmentColor(environmentId, color)
        }}
      />

      <section className="settings-section">
        <div className="setting-row">
          <span>
            <strong>对话 JSON</strong>
            <small>包含账户、对话正文和已保存附件，不包含显示设置和自动保存排除记录</small>
          </span>
          <b>{formatBytes(storageBytes)}</b>
        </div>
      </section>

      <section className="settings-section data-actions">
        <h3>本地数据</h3>
        <button type="button" disabled={busy} onClick={() => void handleExport()}>
          <span>导出完整对话备份</span>
          <small>单个 JSON</small>
        </button>
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
          <span>导入数据</span>
          <small>校验并去重</small>
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void handleImport(file)
            }
          }}
        />
      </section>

      <section className="danger-zone">
        <h3>危险操作</h3>
        <button type="button" disabled={busy} onClick={() => setClearAllDialogOpen(true)}>
          清空所有数据
        </button>
        <p>清空本环境对话、排除记录和应用设置；共享目录连接与环境身份保留。</p>
      </section>

      <p className="privacy-note">
        聊天数据只保存在本机数据库及你明确授权的共享目录。{' '}
        <a href={chrome.runtime.getURL('privacy.html')} target="_blank" rel="noopener noreferrer">
          隐私政策 / Privacy Policy
        </a>
        {' · '}
        <a href={chrome.runtime.getURL('license.html')} target="_blank" rel="noopener noreferrer">
          开源许可与源码 / License &amp; Source
        </a>
      </p>

      {clearAllDialogOpen && (
        <ConfirmDialog
          title="清空所有本地数据？"
          description="本环境的全部对话、自动保存排除记录、账号标签和应用设置都会被删除；自动保存恢复为默认开启。共享目录连接和本环境身份会保留，并同步为空数据。此操作无法撤销。"
          confirmLabel="全部清空"
          busy={busy}
          onCancel={() => setClearAllDialogOpen(false)}
          onConfirm={() => void handleDeleteAll()}
        />
      )}
    </div>
  )
}
