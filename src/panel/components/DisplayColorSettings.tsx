import type {
  Account,
  EnvironmentSummary,
} from '../../shared/models'
import {
  DISPLAY_COLOR_OPTIONS,
  type DisplayColorAssignments,
  type DisplayColorToken,
} from '../../shared/display-colors'
import { PLATFORM_LABELS } from '../../shared/models'
import { getManagerColorSwatchStyle } from '../conversation-colors'

interface ColorAssignmentRowProps {
  id: string
  label: string
  description: string
  color: DisplayColorToken | undefined
  busy: boolean
  onChange: (id: string, color: DisplayColorToken | undefined) => void
}

function ColorAssignmentRow({
  id,
  label,
  description,
  color,
  busy,
  onChange,
}: ColorAssignmentRowProps) {
  const colorLabel = DISPLAY_COLOR_OPTIONS.find(
    (option) => option.id === color,
  )?.label
  return (
    <details className="color-assignment-row">
      <summary>
        <span>
          <strong title={label}>{label}</strong>
          <small>{description}</small>
        </span>
        <span className="color-assignment-current">
          <i
            className={color === undefined ? 'color-dot color-dot-none' : 'color-dot'}
            style={color === undefined ? undefined : getManagerColorSwatchStyle(color)}
            aria-hidden="true"
          />
          {colorLabel ?? '未指定'}
        </span>
      </summary>
      <div className="display-color-grid" role="group" aria-label={`设置${label}的颜色`}>
        <button
          className={color === undefined ? 'display-color-none selected' : 'display-color-none'}
          type="button"
          disabled={busy}
          aria-pressed={color === undefined}
          title="不使用颜色"
          onClick={() => onChange(id, undefined)}
        >
          无
        </button>
        {DISPLAY_COLOR_OPTIONS.map((option) => (
          <button
            key={option.id}
            className={color === option.id ? 'display-color-swatch selected' : 'display-color-swatch'}
            style={getManagerColorSwatchStyle(option.id)}
            type="button"
            disabled={busy}
            aria-label={option.label}
            aria-pressed={color === option.id}
            title={option.label}
            onClick={() => onChange(id, option.id)}
          >
            <span aria-hidden="true">{color === option.id ? '✓' : ''}</span>
          </button>
        ))}
      </div>
    </details>
  )
}

interface DisplayColorSettingsProps {
  accounts: Account[]
  environments: EnvironmentSummary[]
  currentEnvironmentId: string | null
  accountColors: DisplayColorAssignments
  environmentColors: DisplayColorAssignments
  busy: boolean
  onAccountColorChange: (
    accountId: string,
    color: DisplayColorToken | undefined,
  ) => void
  onEnvironmentColorChange: (
    environmentId: string,
    color: DisplayColorToken | undefined,
  ) => void
}

export function DisplayColorSettings({
  accounts,
  environments,
  currentEnvironmentId,
  accountColors,
  environmentColors,
  busy,
  onAccountColorChange,
  onEnvironmentColorChange,
}: DisplayColorSettingsProps) {
  return (
    <section className="settings-section display-color-settings">
      <div className="setting-row">
        <span>
          <strong>账户与环境颜色</strong>
          <small>16 种颜色仅用于 Manager 视觉归类；选择相同颜色不会合并数据</small>
        </span>
      </div>
      <div className="color-assignment-group">
        <h3>账户标签</h3>
        {accounts.length === 0 ? (
          <p>保存对话后可为账户指定标签颜色。</p>
        ) : accounts.map((account) => (
          <ColorAssignmentRow
            key={account.id}
            id={account.id}
            label={account.label}
            description={`${PLATFORM_LABELS[account.platform]} · 颜色只跟随账户`}
            color={accountColors[account.id]}
            busy={busy}
            onChange={onAccountColorChange}
          />
        ))}
      </div>
      <div className="color-assignment-group">
        <h3>环境卡片背景</h3>
        {environments.map((environment) => (
          <ColorAssignmentRow
            key={environment.id}
            id={environment.id}
            label={environment.label}
            description={environment.id === currentEnvironmentId
              ? '本环境 · 单独显示时不应用背景色'
              : `${environment.conversationCount} 条对话`}
            color={environmentColors[environment.id]}
            busy={busy}
            onChange={onEnvironmentColorChange}
          />
        ))}
      </div>
    </section>
  )
}
