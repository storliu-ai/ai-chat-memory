import { useEffect, useMemo, useState } from 'react'
import type {
  LibraryAccount,
  ConversationQuery,
  ConversationStats,
  LibraryConversation,
  LibraryConversationPage,
  Platform,
  SharedDirectoryStatus,
  AppSettings,
} from '../../shared/models'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConversationList } from '../components/ConversationList'
import { EnvironmentSelector } from '../components/EnvironmentSelector'
import { EnvironmentExportDialog } from '../components/EnvironmentExportDialog'
import {
  FilterBar,
  type ImportanceFilter,
  type TimeFilter,
} from '../components/FilterBar'
import { SearchBar } from '../components/SearchBar'
import { Stats } from '../components/Stats'
import {
  getLibraryView,
  getSettings,
  removeConversation,
  removeSharedConversation,
  setConversationImportant,
  setVisibleEnvironmentIds,
} from '../services/panel-api'

interface ConversationsPageProps {
  refreshVersion: number
  onOpenConversation: (conversation: LibraryConversation) => void
  onDataChanged: () => void
}

const EMPTY_PAGE: LibraryConversationPage = { items: [], total: 0, page: 1, pageSize: 20 }
const EMPTY_STATS: ConversationStats = { total: 0, createdToday: 0 }

function getUpdatedAfter(time: TimeFilter): number | undefined {
  const now = new Date()
  switch (time) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    case '7days':
      return Date.now() - 7 * 24 * 60 * 60 * 1_000
    case '30days':
      return Date.now() - 30 * 24 * 60 * 60 * 1_000
    default:
      return undefined
  }
}

export function ConversationsPage({
  refreshVersion,
  onOpenConversation,
  onDataChanged,
}: ConversationsPageProps) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<'all' | Platform>('all')
  const [accountId, setAccountId] = useState('all')
  const [environmentId, setEnvironmentId] = useState('all')
  const [time, setTime] = useState<TimeFilter>('all')
  const [importance, setImportance] = useState<ImportanceFilter>('all')
  const [page, setPage] = useState(1)
  const [pageData, setPageData] = useState<LibraryConversationPage>(EMPTY_PAGE)
  const [stats, setStats] = useState<ConversationStats>(EMPTY_STATS)
  const [accounts, setAccounts] = useState<LibraryAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localRefresh, setLocalRefresh] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<LibraryConversation | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [directory, setDirectory] = useState<SharedDirectoryStatus | null>(null)
  const [environmentBusy, setEnvironmentBusy] = useState(false)
  const [displaySettings, setDisplaySettings] = useState<AppSettings | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const refresh = (): void => {
      setLocalRefresh((value) => value + 1)
    }
    const handleVisibilityChange = (): void => {
      if (!document.hidden) {
        refresh()
      }
    }
    const delayedRefresh = window.setTimeout(refresh, 2_000)

    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearTimeout(delayedRefresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const selectedAccount = accounts.find((account) => JSON.stringify([account.sourceEnvironmentId, account.id]) === accountId)
  const filters = useMemo<ConversationQuery>(
    () => ({
      search: search || undefined,
      platform: platform === 'all' ? undefined : platform,
      accountId: selectedAccount?.id,
      accountSourceEnvironmentId: selectedAccount?.sourceEnvironmentId,
      sourceEnvironmentId: environmentId === 'all' ? undefined : environmentId,
      updatedAfter: getUpdatedAfter(time),
      important: importance === 'all' ? undefined : importance === 'important',
    }),
    [search, platform, selectedAccount?.id, selectedAccount?.sourceEnvironmentId, environmentId, time, importance],
  )

  useEffect(() => {
    let active = true

    void Promise.all([
      getLibraryView({ ...filters, page, pageSize: 20 }),
      getSettings(),
    ])
      .then(([library, nextSettings]) => {
        if (active) {
          setPageData(library.page)
          setStats(library.stats)
          setAccounts(library.filterAccounts)
          if (accountId !== 'all' && !library.filterAccounts.some((account) =>
            JSON.stringify([account.sourceEnvironmentId, account.id]) === accountId)) {
            setAccountId('all')
            setPage(1)
          }
          setDirectory(library.directory)
          if (environmentId !== 'all' && environmentId !== library.directory.currentEnvironment.id &&
              !library.directory.otherEnvironments.some((environment) =>
                environment.id === environmentId && library.directory.visibleEnvironmentIds.includes(environment.id))) {
            setEnvironmentId('all')
            setAccountId('all')
            setPage(1)
          }
          setDisplaySettings(nextSettings)
          setError(null)
        }
      })
      .catch(() => {
        if (active) {
          setError('对话数据读取失败')
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [filters, page, refreshVersion, localRefresh, accountId, environmentId])

  const handleDelete = async (): Promise<void> => {
    if (pendingDelete === null || deleteBusy) {
      return
    }
    const conversation = pendingDelete
    setDeleteBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (conversation.sourceIsLocal) {
        await removeConversation(conversation.id)
      } else {
        await removeSharedConversation(conversation.sourceEnvironmentId, conversation.id)
        setNotice(`已删除“${conversation.sourceEnvironmentLabel}”中的共享副本，并保存删除指令；原环境使用新版插件再次运行且共享目录授权有效时，将删除本地记录。`)
      }
      setPendingDelete(null)
      if (pageData.items.length === 1 && page > 1) {
        setPage(page - 1)
      }
      setLocalRefresh((value) => value + 1)
      onDataChanged()
    } catch {
      setError(conversation.sourceIsLocal
        ? '删除本地对话失败'
        : '跨环境删除未全部完成，已写入的删除指令会保留。请确认共享目录可用且已授权读写，刷新后重试。')
      setPendingDelete(null)
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleToggleImportant = async (
    conversation: LibraryConversation,
  ): Promise<void> => {
    if (!conversation.sourceIsLocal) {
      return
    }
    setError(null)
    try {
      const updated = await setConversationImportant(
        conversation.id,
        !conversation.important,
      )
      setPageData((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      }))
      setLocalRefresh((value) => value + 1)
      onDataChanged()
    } catch {
      setError('重要标记更新失败')
    }
  }

  const handleEnvironmentChange = async (environmentIds: string[]): Promise<void> => {
    if (directory === null || environmentBusy) {
      return
    }
    setEnvironmentBusy(true)
    setError(null)
    try {
      await setVisibleEnvironmentIds(environmentIds)
      setDirectory((current) => current === null
        ? current
        : { ...current, visibleEnvironmentIds: environmentIds })
      setAccountId('all')
      setEnvironmentId('all')
      setPage(1)
      setLocalRefresh((value) => value + 1)
    } catch {
      setError('显示环境切换失败')
    } finally {
      setEnvironmentBusy(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(pageData.total / pageData.pageSize))

  return (
    <div className="page conversations-page">
      <div className="page-title-row">
        <div className="conversations-title-block">
          <span className="section-kicker">仅保存在本地</span>
          <div className="conversations-title-line">
            <h2>全部对话</h2>
            {directory !== null && (
              <EnvironmentSelector
                status={directory}
                busy={environmentBusy}
                onChange={(environmentIds) => void handleEnvironmentChange(environmentIds)}
              />
            )}
          </div>
        </div>
        <div className="page-title-actions">
          <button
            className="text-button"
            type="button"
            disabled={directory === null}
            onClick={() => setExportDialogOpen(true)}
          >
            导出对话
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => setLocalRefresh((value) => value + 1)}
          >
            刷新
          </button>
        </div>
      </div>

      <Stats {...stats} />
      <SearchBar value={searchInput} onChange={setSearchInput} />
      <FilterBar
        environmentId={environmentId}
        environments={directory === null ? [] : [directory.currentEnvironment, ...directory.otherEnvironments.filter((environment) => directory.visibleEnvironmentIds.includes(environment.id))]}
        onEnvironmentChange={(value) => {
          setEnvironmentId(value)
          setAccountId('all')
          setPage(1)
        }}
        platform={platform}
        accountId={accountId}
        time={time}
        importance={importance}
        accounts={accounts}
        onPlatformChange={(value) => {
          setPlatform(value)
          setAccountId('all')
          setPage(1)
        }}
        onAccountChange={(value) => {
          setAccountId(value)
          setPage(1)
        }}
        onTimeChange={(value) => {
          setTime(value)
          setPage(1)
        }}
        onImportanceChange={(value) => {
          setImportance(value)
          setPage(1)
        }}
      />

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      {loading ? (
        <div className="loading-state" role="status">
          <span />
          正在读取本地对话…
        </div>
      ) : (
        <ConversationList
          conversations={pageData.items}
          onOpen={onOpenConversation}
          onDelete={setPendingDelete}
          onToggleImportant={(conversation) => void handleToggleImportant(conversation)}
          accountColors={displaySettings?.accountTagColors ?? {}}
          environmentColors={displaySettings?.environmentCardColors ?? {}}
          environmentColorsEnabled={
            (directory?.visibleEnvironmentIds.length ?? 0) > 0
          }
        />
      )}

      {pageData.total > pageData.pageSize && (
        <nav className="pagination" aria-label="对话分页">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>
            {page} / {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </nav>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={pendingDelete.sourceIsLocal ? '删除这条对话？' : '从来源环境删除这条对话？'}
          description={
            <>
              {!pendingDelete.sourceIsLocal
                ? `“${pendingDelete.title}”的共享副本将立即删除，并保存删除指令。“${pendingDelete.sourceEnvironmentLabel}”使用 0.5.35 或更新版本再次运行且共享目录授权有效时，会删除本地记录及其附件；若届时仍记录为置顶，还会加入自动保存排除列表。其他读取该目录的环境也会受到影响。此操作无法撤销。`
                : pendingDelete.pinned
                ? `“${pendingDelete.title}”将从当前环境删除，并加入自动保存排除列表；以后即使保持置顶也不会再次自动收录。`
                : `“${pendingDelete.title}”将只从当前环境删除。该记录未置顶，不会加入自动保存排除列表；以后若置顶，仍可重新自动收录。`}
            </>
          }
          confirmLabel="确认删除"
          busy={deleteBusy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDelete()}
        />
      )}

      {exportDialogOpen && directory !== null && (
        <EnvironmentExportDialog
          directory={directory}
          onClose={() => setExportDialogOpen(false)}
          onNotice={(message) => {
            setError(null)
            setNotice(message)
          }}
          onError={(message) => {
            setNotice(null)
            setError(message || null)
          }}
        />
      )}
    </div>
  )
}
