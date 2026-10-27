import { useEffect, useState } from 'react'
import type { LibraryConversation } from '../shared/models'
import { ConversationDetailPage } from './pages/ConversationDetailPage'
import { ConversationsPage } from './pages/ConversationsPage'
import { CurrentConversationPanel } from './pages/CurrentConversationPanel'
import { SettingsPage } from './pages/SettingsPage'
import { isOverlayPanel } from './services/host-bridge'
import {
  getAccounts,
  getConversation,
  getSharedDirectoryStatus,
} from './services/panel-api'

type View =
  | { name: 'conversations' }
  | { name: 'settings' }
  | { name: 'detail'; conversation: LibraryConversation }

function ManagerApp() {
  const [view, setView] = useState<View>({ name: 'conversations' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const isDetail = view.name === 'detail'

  useEffect(() => {
    const conversationId = new URLSearchParams(location.hash.slice(1))
      .get('conversation')
    if (!conversationId) {
      return
    }
    let active = true
    void Promise.all([
      getConversation(conversationId),
      getAccounts(),
      getSharedDirectoryStatus(),
    ]).then(([conversation, accounts, directory]) => {
      if (!active || conversation === null) {
        return
      }
      const accountLabel = accounts.find(
        (account) => account.id === conversation.accountId,
      )?.label ?? 'Unknown'
      setView({
        name: 'detail',
        conversation: {
          ...conversation,
          sourceEnvironmentId: directory.currentEnvironment.id,
          sourceEnvironmentLabel: directory.currentEnvironment.label,
          sourceIsLocal: true,
          accountLabel,
        },
      })
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const showConversations = (): void => {
    location.hash = ''
    setView({ name: 'conversations' })
  }

  const showConversation = (conversation: LibraryConversation): void => {
    if (conversation.sourceIsLocal) {
      location.hash = new URLSearchParams({
        conversation: conversation.id,
      }).toString()
    } else {
      location.hash = ''
    }
    setView({ name: 'detail', conversation })
  }

  const showSettings = (): void => {
    location.hash = ''
    setView({ name: 'settings' })
  }

  const markDataChanged = (): void => {
    setRefreshVersion((value) => value + 1)
  }

  return (
    <div className="manager-shell">
      <aside className="manager-sidebar">
        <div className="manager-brand">
          <span className="mini-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>AI Chat Memory</strong><small>本地对话 Manager</small></span>
        </div>
        <nav aria-label="Manager 主导航">
          <button
            type="button"
            className={view.name === 'conversations' || isDetail ? 'active' : ''}
            onClick={showConversations}
          >
            <span aria-hidden="true">▤</span>对话库
          </button>
          <button
            type="button"
            className={view.name === 'settings' ? 'active' : ''}
            onClick={showSettings}
          >
            <span aria-hidden="true">⚙</span>设置
          </button>
        </nav>
        <p>数据仅保存在本机及你明确授权的共享目录。</p>
      </aside>

      <section className="manager-workspace">
        <header className="manager-topbar">
          <div>
            {isDetail && (
              <button
                type="button"
                aria-label="返回对话库"
                onClick={showConversations}
              >
                ←
              </button>
            )}
            <span>
              <strong>{isDetail ? '对话详情' : view.name === 'settings' ? '设置' : '对话库'}</strong>
              <small>{isDetail ? '查看已保存内容' : 'AI Chat Memory Manager'}</small>
            </span>
          </div>
        </header>

        <div className="manager-content">
        {view.name === 'conversations' && (
          <ConversationsPage
            refreshVersion={refreshVersion}
            onOpenConversation={showConversation}
            onDataChanged={markDataChanged}
          />
        )}
        {view.name === 'settings' && <SettingsPage onDataChanged={markDataChanged} />}
        {view.name === 'detail' && (
          <ConversationDetailPage
            key={`${view.conversation.sourceEnvironmentId}\0${view.conversation.id}\0${view.conversation.sourceIsLocal}`}
            conversationId={view.conversation.id}
            sourceEnvironmentId={view.conversation.sourceEnvironmentId}
            sourceEnvironmentLabel={view.conversation.sourceEnvironmentLabel}
            sourceIsLocal={view.conversation.sourceIsLocal}
            sourceAccountLabel={view.conversation.accountLabel}
            onDeleted={() => {
              markDataChanged()
              showConversations()
            }}
          />
        )}
        </div>
      </section>
    </div>
  )
}

export function App() {
  return isOverlayPanel() ? <CurrentConversationPanel /> : <ManagerApp />
}
