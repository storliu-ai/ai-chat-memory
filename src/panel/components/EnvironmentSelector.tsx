import type { SharedDirectoryStatus } from '../../shared/models'

interface EnvironmentSelectorProps {
  status: SharedDirectoryStatus
  busy: boolean
  onChange: (environmentIds: string[]) => void
}

export function EnvironmentSelector({
  status,
  busy,
  onChange,
}: EnvironmentSelectorProps) {
  const directoryReady = status.state === 'granted'
  const environmentIds = status.otherEnvironments.map((environment) => environment.id)
  const availableIds = new Set(environmentIds)
  const selectedIds = status.visibleEnvironmentIds.filter((id) => availableIds.has(id))
  const allSelected = environmentIds.length > 1 && selectedIds.length === environmentIds.length
  const selectedValue = allSelected
    ? 'all'
    : selectedIds.length === 1
      ? selectedIds[0]
      : selectedIds.length > 1
        ? 'custom'
        : 'local'

  const changeEnvironment = (value: string): void => {
    if (value === 'local') {
      onChange([])
      return
    }
    if (value === 'all') {
      onChange(environmentIds)
      return
    }
    if (value !== 'custom' && availableIds.has(value)) {
      onChange([value])
    }
  }

  return (
    <label
      className="environment-filter"
      title={`本环境：${status.currentEnvironment.label}。环境管理请前往设置页。`}
    >
      <span>显示环境</span>
      <select
        value={selectedValue}
        disabled={busy || !directoryReady || environmentIds.length === 0}
        aria-label="显示环境"
        aria-busy={busy}
        onChange={(event) => changeEnvironment(event.target.value)}
      >
        <option value="local">仅本环境</option>
        {status.otherEnvironments.map((environment) => (
          <option key={environment.id} value={environment.id}>
            本环境 + {environment.label}（{environment.conversationCount}）
          </option>
        ))}
        {environmentIds.length > 1 && (
          <option value="all">全部环境（{environmentIds.length + 1}）</option>
        )}
        {selectedValue === 'custom' && (
          <option value="custom" disabled>
            本环境 + 已选 {selectedIds.length} 个环境
          </option>
        )}
      </select>
    </label>
  )
}
