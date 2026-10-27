import type { ConversationStats } from '../../shared/models'

export function Stats({ total, createdToday }: ConversationStats) {
  return (
    <section className="stats-grid" aria-label="对话统计">
      <div className="stat-card">
        <span>总对话</span>
        <strong>{total}</strong>
      </div>
      <div className="stat-card">
        <span>今日新增</span>
        <strong>{createdToday}</strong>
      </div>
    </section>
  )
}
