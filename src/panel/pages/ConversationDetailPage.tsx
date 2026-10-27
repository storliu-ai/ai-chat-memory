import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PLATFORM_LABELS,
  type AppSettings,
  type Account,
  type Conversation,
  type ConversationAttachment,
} from '../../shared/models'
import { isConversationUpdatedExtensionEvent } from '../../shared/extension-events'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConversationExportDialog } from '../components/ConversationExportDialog'
import { ImagePreviewDialog } from '../components/ImagePreviewDialog'
import { TextAttachmentPreviewDialog } from '../components/TextAttachmentPreviewDialog'
import { MessageContent } from '../components/MessageContent'
import {
  getAccounts,
  getConversation,
  getSettings,
  getSharedConversation,
  openConversationUrl,
  removeConversation,
  renameAccount,
  setConversationImportant,
  setConversationImageAttachmentPermission,
  setConversationFileAttachmentPermission,
  supplementConversationAttachment,
} from '../services/panel-api'
import { placeConversationAttachments } from '../attachment-placement'
import { readLocalAttachmentFile } from '../local-attachment-file'
import { BYTES_PER_MEBIBYTE } from '../../shared/attachments'
import { canPreviewTextAttachment } from '../text-attachment-preview'

interface ConversationDetailPageProps {
  conversationId: string
  sourceEnvironmentId: string
  sourceEnvironmentLabel: string
  sourceIsLocal: boolean
  sourceAccountLabel: string
  onDeleted: () => void
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatMessageTime(
  timestamp: number,
  precision: 'minute' | 'second' | undefined,
): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  if (precision !== 'minute') {
    options.second = '2-digit'
  }
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(timestamp))
}

function formatAttachmentSize(size: number | null): string {
  if (size === null) {
    return '大小未知'
  }
  if (size < 1_024) {
    return `${size} B`
  }
  const units = ['KB', 'MB']
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1_024)) - 1, 1)
  const value = size / 1_024 ** (unit + 1)
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function getAttachmentStatusLabel(
  attachment: ConversationAttachment,
  settings: AppSettings | null,
  saveImages: boolean,
): string {
  switch (attachment.status) {
    case 'saved':
      return `已保存到插件本地 · ${formatAttachmentSize(attachment.size)}`
    case 'confirmation-required':
      return '尚未授权保存普通文件'
    case 'not-saved':
      if (attachment.kind === 'image' && !saveImages) {
        return '这条对话已关闭图片保存'
      }
      if (attachment.kind === 'file' && settings?.fileSavePolicy === 'never') {
        return '设置中已关闭普通文件保存'
      }
      return '已按设置跳过'
    case 'too-large':
      return `超过保存上限 · ${formatAttachmentSize(attachment.size)}`
    case 'unavailable':
      if (attachment.kind === 'file') return '已记录文件名，未能保存文件内容；页面可能未提供可用下载地址'
      return '未能复制到插件本地存储；请重新打开原对话后更新'
  }
}

function downloadStoredAttachment(attachment: ConversationAttachment): void {
  if (attachment.status !== 'saved' || attachment.dataUrl === undefined) {
    return
  }
  const anchor = document.createElement('a')
  anchor.href = attachment.dataUrl
  anchor.download = attachment.name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

interface StoredAttachmentCardProps {
  attachment: ConversationAttachment
  settings: AppSettings | null
  saveImages: boolean
  onPreview: (attachment: ConversationAttachment) => void
  onSupplement?: (attachment: ConversationAttachment, file: File) => void
  supplementDisabledReason?: string
  supplementing?: boolean
}

function StoredAttachmentCard({
  attachment,
  settings,
  saveImages,
  onPreview,
  onSupplement,
  supplementDisabledReason,
  supplementing = false,
}: StoredAttachmentCardProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const showsImage = attachment.kind === 'image' && attachment.dataUrl !== undefined
  return (
    <article className={showsImage
      ? 'saved-attachment saved-attachment-inline-image'
      : 'saved-attachment'}>
      {showsImage ? (
        <button
          className="saved-attachment-preview-button"
          type="button"
          aria-label={`放大查看 ${attachment.name}`}
          title="点击放大查看"
          onClick={() => onPreview(attachment)}
        >
          <img src={attachment.dataUrl} alt="" loading="lazy" />
          <span aria-hidden="true">放大</span>
        </button>
      ) : (
        <span className="saved-attachment-icon" aria-hidden="true">
          {attachment.kind === 'image' ? '▧' : '▤'}
        </span>
      )}
      <div>
        <strong title={attachment.name}>{attachment.name}</strong>
        <small>
          {showsImage && attachment.status === 'saved'
            ? `本地图片 · ${formatAttachmentSize(attachment.size)}`
            : getAttachmentStatusLabel(attachment, settings, saveImages)}
        </small>
      </div>
      {canPreviewTextAttachment(attachment) && (
        <button className="saved-attachment-download" type="button" aria-label={`预览 ${attachment.name}`} onClick={() => onPreview(attachment)}>预览</button>
      )}
      {attachment.status === 'saved' && attachment.dataUrl !== undefined && (
        <button
          className={showsImage
            ? 'saved-attachment-download saved-attachment-download-icon'
            : 'saved-attachment-download'}
          type="button"
          aria-label={showsImage ? `下载 ${attachment.name}` : undefined}
          title={showsImage ? '下载到本机' : undefined}
          onClick={() => downloadStoredAttachment(attachment)}
        >
          {showsImage ? '↓' : '下载'}
        </button>
      )}
      {attachment.kind === 'file' && attachment.status !== 'saved' && onSupplement && (
        <>
          <input
            ref={fileInput}
            type="file"
            hidden
            aria-label={`选择 ${attachment.name} 的原始文件`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) onSupplement(attachment, file)
            }}
          />
          <button
            className="saved-attachment-download"
            type="button"
            disabled={supplementDisabledReason !== undefined}
            title={supplementDisabledReason ?? '选择电脑上与此附件同名的原始文件，保存到插件本地'}
            aria-label={`从本地补齐 ${attachment.name}`}
            onClick={() => fileInput.current?.click()}
          >
            {supplementing ? '正在保存…' : '从本地补齐'}
          </button>
        </>
      )}
    </article>
  )
}

export function ConversationDetailPage({
  conversationId,
  sourceEnvironmentId,
  sourceEnvironmentLabel,
  sourceIsLocal,
  sourceAccountLabel,
  onDeleted,
}: ConversationDetailPageProps) {
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [accountLabel, setAccountLabel] = useState('')
  const [editingAccount, setEditingAccount] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [filePermissionDialogOpen, setFilePermissionDialogOpen] = useState(false)
  const [updatingFilePermission, setUpdatingFilePermission] = useState(false)
  const [updatingImagePermission, setUpdatingImagePermission] = useState(false)
  const [preview, setPreview] = useState<{ context: string; attachmentId: string } | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [localSupplement, setLocalSupplement] = useState<{ context: string; attachmentId: string; generation: number } | null>(null)
  const localSupplementContext = `${sourceEnvironmentId}\0${conversationId}\0${sourceIsLocal}`
  const previewAttachment = preview?.context === localSupplementContext && conversation?.id === conversationId
    ? conversation.attachments?.find((attachment) => attachment.id === preview.attachmentId) ?? null : null
  const openAttachmentPreview = useCallback((attachment: ConversationAttachment) => {
    setPreview({ context: localSupplementContext, attachmentId: attachment.id })
  }, [localSupplementContext])
  const closeAttachmentPreview = useCallback(() => setPreview(null), [])
  const supplementingAttachmentId = localSupplement?.context === localSupplementContext ? localSupplement.attachmentId : null
  const supplementGeneration = useRef(0)

  useEffect(() => {
    supplementGeneration.current += 1
    return () => { supplementGeneration.current += 1 }
  }, [conversationId, sourceEnvironmentId, sourceIsLocal])

  useEffect(() => {
    let active = true
    const conversationRequest = sourceIsLocal
      ? getConversation(conversationId)
      : getSharedConversation(sourceEnvironmentId, conversationId)
    const accountsRequest = sourceIsLocal ? getAccounts() : Promise.resolve([])
    void Promise.all([conversationRequest, accountsRequest, getSettings()])
      .then(([nextConversation, nextAccounts, nextSettings]) => {
        if (!active) {
          return
        }
        if (nextConversation === null) {
          setError(sourceIsLocal ? '未找到本地对话' : '未找到已选择环境中的对话')
        } else {
          setConversation(nextConversation)
          const account = nextAccounts.find(
            (candidate) => candidate.id === nextConversation.accountId,
          )
          setAccountLabel(account?.label ?? sourceAccountLabel ?? 'Unknown')
        }
        setAccounts(nextAccounts)
        setSettings(nextSettings)
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
  }, [conversationId, sourceAccountLabel, sourceEnvironmentId, sourceIsLocal])

  useEffect(() => {
    if (!sourceIsLocal) {
      return
    }
    let active = true
    let refreshTimer: number | null = null
    const refreshConversation = (): void => {
      refreshTimer = null
      void getConversation(conversationId).then((updated) => {
        if (active && updated !== null) {
          setConversation(updated)
        }
      }).catch(() => undefined)
    }
    const scheduleRefresh = (): void => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
      }
      refreshTimer = window.setTimeout(refreshConversation, 120)
    }
    const handleRuntimeMessage = (message: unknown): void => {
      if (
        isConversationUpdatedExtensionEvent(message) &&
        message.conversationId === conversationId
      ) {
        scheduleRefresh()
      }
    }
    const handleVisibility = (): void => {
      if (!document.hidden) {
        scheduleRefresh()
      }
    }
    chrome.runtime.onMessage.addListener(handleRuntimeMessage)
    window.addEventListener('focus', scheduleRefresh)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
      }
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage)
      window.removeEventListener('focus', scheduleRefresh)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [conversationId, sourceIsLocal])

  const account = useMemo(
    () => accounts.find((candidate) => candidate.id === conversation?.accountId),
    [accounts, conversation],
  )
  const attachmentPlacement = useMemo(
    () => placeConversationAttachments(
      conversation?.messages ?? [],
      conversation?.attachments ?? [],
    ),
    [conversation],
  )

  const saveAccountLabel = async (): Promise<void> => {
    if (!sourceIsLocal || !conversation || accountLabel.trim() === '') {
      return
    }
    try {
      const updated = await renameAccount(conversation.accountId, accountLabel)
      setAccounts((current) => [
        ...current.filter((candidate) => candidate.id !== updated.id),
        updated,
      ])
      setAccountLabel(updated.label)
      setEditingAccount(false)
    } catch {
      setError('账号标签更新失败')
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!sourceIsLocal || !conversation || deleting) {
      return
    }
    setDeleting(true)
    try {
      await removeConversation(conversation.id)
      setDeleteDialogOpen(false)
      onDeleted()
    } catch {
      setError('删除本地对话失败')
      setDeleteDialogOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  const toggleImportant = async (): Promise<void> => {
    if (!sourceIsLocal || conversation === null) {
      return
    }
    try {
      const updated = await setConversationImportant(
        conversation.id,
        !conversation.important,
      )
      setConversation(updated)
      setNotice(updated.important
        ? '已标记重要；图片与文件保存权限保持不变'
        : '已取消重要标记；图片与文件保存权限保持不变')
    } catch {
      setError('重要标记更新失败')
    }
  }

  const updateFilePermission = async (allowed: boolean): Promise<void> => {
    if (!sourceIsLocal || conversation === null || updatingFilePermission) {
      return
    }
    setUpdatingFilePermission(true)
    setError(null)
    try {
      const updated = await setConversationFileAttachmentPermission(
        conversation.id,
        allowed,
      )
      setConversation(updated)
      setFilePermissionDialogOpen(false)
      if (allowed) {
        setNotice('普通文件权限已开启；请打开原对话并在侧边栏点击更新，以补齐历史附件')
      } else {
        setNotice('已停止这条对话继续保存普通文件；已有本地副本仍保留')
      }
    } catch {
      setError('对话文件权限更新失败')
      setFilePermissionDialogOpen(false)
    } finally {
      setUpdatingFilePermission(false)
    }
  }

  const updateImagePermission = async (allowed: boolean): Promise<void> => {
    if (!sourceIsLocal || conversation === null || updatingImagePermission) {
      return
    }
    setUpdatingImagePermission(true)
    setError(null)
    try {
      const updated = await setConversationImageAttachmentPermission(
        conversation.id,
        allowed,
      )
      setConversation(updated)
      if (allowed) {
        setNotice('图片保存权限已开启；请打开原对话并在侧边栏点击更新，以补齐历史附件')
      } else {
        setNotice('已停止这条对话继续保存图片；已有本地图片仍保留')
      }
    } catch {
      setError('对话图片设置更新失败')
    } finally {
      setUpdatingImagePermission(false)
    }
  }

  const handleLocalSupplement = async (attachment: ConversationAttachment, file: File): Promise<void> => {
    if (!sourceIsLocal || !conversation || conversation.id !== conversationId || !settings || supplementingAttachmentId !== null) return
    const generation = supplementGeneration.current
    const id = conversation.id
    setLocalSupplement({ context: localSupplementContext, attachmentId: attachment.id, generation })
    setError(null)
    setNotice(null)
    try {
      const copy = await readLocalAttachmentFile(file, attachment.name, settings.attachmentMaxSizeMb * BYTES_PER_MEBIBYTE)
      if (generation !== supplementGeneration.current) return
      const updated = await supplementConversationAttachment(id, attachment.id, copy)
      if (generation !== supplementGeneration.current) return
      setConversation(updated)
      setNotice(`已将 ${attachment.name} 保存到插件本地，可直接下载`)
    } catch (error: unknown) {
      if (generation === supplementGeneration.current) setError(error instanceof Error ? error.message : '本地附件保存失败，请重试')
    } finally {
      setLocalSupplement((current) => current?.generation === generation ? null : current)
    }
  }

  if (loading) {
    return (
      <div className="loading-state detail-loading" role="status">
        <span />
        正在读取对话…
      </div>
    )
  }

  if (conversation === null) {
    return <div className="error-page">{error ?? '未找到对话'}</div>
  }
  const conversationSavesImages =
    conversation.imageAttachmentPermission ?? settings?.saveImages ?? true
  const supplementDisabledReason = !settings ? '正在读取附件保存设置'
    : settings.fileSavePolicy !== 'per-conversation' ? '请先在设置中开启普通文件保存'
    : !conversation.fileAttachmentPermission ? '请先开启本页的普通文件保存权限'
    : supplementingAttachmentId !== null ? '正在保存文件，请稍候' : undefined

  return (
    <div className="page detail-page">
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      {conversation.pendingCapture && <section className="controller-pending-card" role="status">
        <strong>待补全 · 异常后经确认保存</strong>
        <p>{conversation.pendingCapture.reason}</p>
        <small>请回原对话使用本页 DOM，或更新分享链接后使用分享页 DOM／接口重新采集。完整核对后才清除此标记。</small>
      </section>}
      <section className="detail-heading">
        <div className="detail-pills">
          <span className="platform-pill">{PLATFORM_LABELS[conversation.platform]}</span>
          <span className={sourceIsLocal ? 'environment-pill environment-pill-local' : 'environment-pill'}>
            {sourceIsLocal ? '本环境' : sourceEnvironmentLabel}
          </span>
        </div>

        {sourceIsLocal && settings !== null && (
          <div className="attachment-permission-row">
            <span>
              <strong>图片</strong>
              <small>
                {conversation.imageAttachmentPermission === null
                  ? `沿用全局默认：${settings.saveImages ? '保存' : '不保存'}`
                  : conversationSavesImages
                    ? '已单独开启这条对话的图片保存'
                    : '已单独关闭这条对话的图片保存'}
              </small>
            </span>
            <button
              className={conversationSavesImages
                ? 'file-permission-button active'
                : 'file-permission-button'}
              type="button"
              disabled={updatingImagePermission}
              onClick={() => void updateImagePermission(!conversationSavesImages)}
            >
              {conversationSavesImages ? '已开启 · 关闭' : '开启保存'}
            </button>
          </div>
        )}
        {sourceIsLocal && settings !== null && (
          <div className="attachment-permission-row">
            <span>
              <strong>普通文件</strong>
              <small>
                {settings.fileSavePolicy === 'never'
                  ? '设置中已关闭普通文件保存'
                  : conversation.fileAttachmentPermission
                    ? '已单独允许这条对话保存文件'
                    : '默认不保存，需要单独授权'}
              </small>
            </span>
            {settings.fileSavePolicy === 'per-conversation' && (
              <button
                className={conversation.fileAttachmentPermission
                  ? 'file-permission-button active'
                  : 'file-permission-button'}
                type="button"
                disabled={updatingFilePermission}
                onClick={() => {
                  if (conversation.fileAttachmentPermission) {
                    void updateFilePermission(false)
                  } else {
                    setFilePermissionDialogOpen(true)
                  }
                }}
              >
                {conversation.fileAttachmentPermission ? '已允许 · 关闭' : '允许保存'}
              </button>
            )}
          </div>
        )}
        <h2>{conversation.title}</h2>
        <dl>
          <div>
            <dt>更新时间</dt>
            <dd>{formatDate(conversation.updatedAt)}</dd>
          </div>
          <div>
            <dt>消息</dt>
            <dd>{conversation.messageCount} 条</dd>
          </div>
          <div>
            <dt>网站置顶</dt>
            <dd>{conversation.pinned ? '已识别置顶' : '未置顶'}</dd>
          </div>
        </dl>

        <div className={sourceIsLocal ? 'account-editor' : 'account-editor account-editor-readonly'}>
          <span>账号标签</span>
          {!sourceIsLocal ? (
            <strong>{sourceAccountLabel || 'Unknown'} · 其他环境只读</strong>
          ) : editingAccount ? (
            <div>
              <input
                value={accountLabel}
                maxLength={100}
                onChange={(event) => setAccountLabel(event.target.value)}
                aria-label="账号标签"
              />
              <button type="button" onClick={() => void saveAccountLabel()}>
                保存
              </button>
              <button type="button" onClick={() => setEditingAccount(false)}>
                取消
              </button>
            </div>
          ) : (
            <button className="label-button" type="button" onClick={() => setEditingAccount(true)}>
              {(account?.label ?? accountLabel) || 'Unknown'} · 编辑
            </button>
          )}
        </div>

        <div className="detail-actions">
          <div>
            <button
              className="primary-button"
              type="button"
              onClick={() => void openConversationUrl(conversation.url).catch(() => setError('无法打开原对话'))}
            >
              打开原对话
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setExportDialogOpen(true)}
            >
              导出对话
            </button>
            {sourceIsLocal ? (
              <button
                className={conversation.important
                  ? 'important-button important-button-active'
                  : 'important-button'}
                type="button"
                onClick={() => void toggleImportant()}
              >
                {conversation.important ? '★ 已标重要' : '☆ 标为重要'}
              </button>
            ) : (
              <span className="readonly-note">其他环境对话只读</span>
            )}
          </div>
          {sourceIsLocal && (
            <button
              className="danger-text-button"
              type="button"
              onClick={() => setDeleteDialogOpen(true)}
            >
              删除
            </button>
          )}
        </div>
      </section>

      {attachmentPlacement.unplaced.length > 0 && (
        <section className="saved-attachments" aria-label="未定位附件">
          <div className="saved-attachments-heading">
            <span>
              <strong>未定位附件</strong>
              <small>{attachmentPlacement.unplaced.length} 个旧附件</small>
            </span>
          </div>
          <div className="saved-attachment-grid">
            {attachmentPlacement.unplaced.map((attachment) => (
              <StoredAttachmentCard
                key={attachment.id}
                attachment={attachment}
                settings={settings}
                saveImages={conversationSavesImages}
                onPreview={openAttachmentPreview}
                onSupplement={sourceIsLocal ? (attachment, file) => void handleLocalSupplement(attachment, file) : undefined}
                supplementDisabledReason={supplementDisabledReason}
                supplementing={supplementingAttachmentId === attachment.id}
              />
            ))}
          </div>
        </section>
      )}

      <section className="message-list" aria-label="消息列表">
        {conversation.messages.map((message, index) => {
          const positionedAttachments = attachmentPlacement.byMessage[index]
          const positionedNames = new Set(
            positionedAttachments.map((attachment) =>
              attachment.name.normalize('NFKC').trim().toLocaleLowerCase(),
            ),
          )
          const metadataOnlyNames = message.attachmentNames?.filter((name) =>
            !positionedNames.has(name.normalize('NFKC').trim().toLocaleLowerCase()),
          ) ?? []
          return (
            <article className={`message message-${message.role}`} key={`${index}-${message.role}`}>
              <div className="message-heading">
                <span className="message-role">{message.role === 'user' ? '用户' : '助手'}</span>
                {message.sentAt !== undefined && (
                  <time
                    dateTime={new Date(message.sentAt).toISOString()}
                    title={message.sentAtPrecision === 'minute'
                      ? 'ChatGPT 回答菜单提供的消息时间（精确到分钟）'
                      : '平台页面提供的消息时间'}
                  >
                    {formatMessageTime(message.sentAt, message.sentAtPrecision)}
                  </time>
                )}
              </div>
              <MessageContent content={message.content} assistantMarkup={conversation.platform === 'chatgpt' && message.role === 'assistant'} />
              {positionedAttachments.length > 0 && (
                <div className="message-saved-attachments">
                  {positionedAttachments.map((attachment) => (
                    <StoredAttachmentCard
                      key={attachment.id}
                      attachment={attachment}
                      settings={settings}
                      saveImages={conversationSavesImages}
                      onPreview={openAttachmentPreview}
                      onSupplement={sourceIsLocal ? (attachment, file) => void handleLocalSupplement(attachment, file) : undefined}
                      supplementDisabledReason={supplementDisabledReason}
                      supplementing={supplementingAttachmentId === attachment.id}
                    />
                  ))}
                </div>
              )}
              {metadataOnlyNames.length > 0 && (
                <div className="attachments">
                  <small>以下附件仅记录了名称，未匹配到本地副本；请打开原对话重新采集以补全。</small>
                  {metadataOnlyNames.map((name) => (
                    <span key={name}>{name}</span>
                  ))}
                </div>
              )}
            </article>
          )
        })}
      </section>

      {previewAttachment?.kind === 'image' && (
        <ImagePreviewDialog
          attachment={previewAttachment}
          onClose={closeAttachmentPreview}
        />
      )}
      {previewAttachment && canPreviewTextAttachment(previewAttachment) && (
        <TextAttachmentPreviewDialog
          key={previewAttachment.id}
          attachment={previewAttachment}
          onClose={closeAttachmentPreview}
          onDownload={() => downloadStoredAttachment(previewAttachment)}
        />
      )}

      {exportDialogOpen && (
        <ConversationExportDialog
          conversation={conversation}
          accountLabel={(account?.label ?? accountLabel) || sourceAccountLabel || 'Unknown'}
          environmentLabel={sourceIsLocal ? '本环境' : sourceEnvironmentLabel}
          onClose={() => setExportDialogOpen(false)}
          onNotice={(message) => {
            setError(null)
            setNotice(message)
          }}
          onError={(message) => {
            setNotice(null)
            setError(message)
          }}
        />
      )}

      {sourceIsLocal && deleteDialogOpen && (
        <ConfirmDialog
          title="删除这条对话？"
          description={
            <>
              {conversation.pinned
                ? `“${conversation.title}”将从当前环境删除，并加入自动保存排除列表；以后即使保持置顶也不会再次自动收录。`
                : `“${conversation.title}”将只从当前环境删除。该记录未置顶，不会加入自动保存排除列表；以后若置顶，仍可重新自动收录。`}
            </>
          }
          confirmLabel="确认删除"
          busy={deleting}
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => void handleDelete()}
        />
      )}

      {sourceIsLocal && filePermissionDialogOpen && (
        <ConfirmDialog
          title="允许这条对话保存普通文件？"
          description={`插件只会在你打开这条原对话时读取文件；单个附件超过 ${settings?.attachmentMaxSizeMb ?? 10} MB 会直接跳过。关闭权限不会删除已经保存的本地副本。`}
          confirmLabel="允许保存"
          busy={updatingFilePermission}
          onCancel={() => setFilePermissionDialogOpen(false)}
          onConfirm={() => void updateFilePermission(true)}
        />
      )}
    </div>
  )
}
