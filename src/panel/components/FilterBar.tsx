import {
  PLATFORM_LABELS,
  type LibraryAccount,
  type EnvironmentSummary,
  type Platform,
} from '../../shared/models'

export type TimeFilter = 'all' | 'today' | '7days' | '30days'
export type ImportanceFilter = 'all' | 'important' | 'normal'

interface FilterBarProps {
  platform: 'all' | Platform
  accountId: string
  environmentId: string
  environments: EnvironmentSummary[]
  time: TimeFilter
  importance: ImportanceFilter
  accounts: LibraryAccount[]
  onEnvironmentChange: (value: string) => void
  onPlatformChange: (value: 'all' | Platform) => void
  onAccountChange: (value: string) => void
  onTimeChange: (value: TimeFilter) => void
  onImportanceChange: (value: ImportanceFilter) => void
}

export function FilterBar({
  platform,
  accountId,
  environmentId,
  environments,
  time,
  importance,
  accounts,
  onPlatformChange,
  onAccountChange,
  onEnvironmentChange,
  onTimeChange,
  onImportanceChange,
}: FilterBarProps) {
  const visibleAccounts = platform === 'all'
    ? accounts
    : accounts.filter((account) => account.platform === platform)

  return (
    <div className="filter-grid" aria-label="对话筛选">
      <label>
        <span>环境</span>
        <select value={environmentId} onChange={(event) => onEnvironmentChange(event.target.value)}>
          <option value="all">全部显示环境</option>
          {environments.map((environment) => (
            <option key={environment.id} value={environment.id}>{environment.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>平台</span>
        <select
          value={platform}
          onChange={(event) => onPlatformChange(event.target.value as 'all' | Platform)}
        >
          <option value="all">全部平台</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="gemini">Gemini</option>
          <option value="deepseek">DeepSeek</option>
        </select>
      </label>
      <label>
        <span>账号</span>
        <select value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
          <option value="all">全部账号</option>
          {visibleAccounts.map((account) => (
            <option key={JSON.stringify([account.sourceEnvironmentId, account.id])} value={JSON.stringify([account.sourceEnvironmentId, account.id])}>
              {platform === 'all'
                ? `${PLATFORM_LABELS[account.platform]} · ${account.label}`
                : account.label} · {account.sourceEnvironmentLabel}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>重要标记</span>
        <select
          value={importance}
          onChange={(event) =>
            onImportanceChange(event.target.value as ImportanceFilter)
          }
        >
          <option value="all">全部标记</option>
          <option value="important">重要对话</option>
          <option value="normal">普通对话</option>
        </select>
      </label>
      <label>
        <span>时间</span>
        <select
          value={time}
          onChange={(event) => onTimeChange(event.target.value as TimeFilter)}
        >
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="7days">近 7 天</option>
          <option value="30days">近 30 天</option>
        </select>
      </label>
    </div>
  )
}
