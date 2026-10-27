import { parseMessagePresentation } from '../message-presentation'

export function MessageContent({ content, assistantMarkup = false }: { content: string; assistantMarkup?: boolean }) {
  return (
    <div className="message-content">
      {parseMessagePresentation(content, assistantMarkup).map((part, index) =>
        part.type === 'code' ? (
          <div className="code-block" key={`${index}-${part.value.slice(0, 12)}`}>
            {part.language && <span>{part.language}</span>}
            <pre>
              <code>{part.value}</code>
            </pre>
          </div>
        ) : part.type === 'diagram' ? (
          <img className="message-diagram" key={index} src={part.value} alt={part.label} loading="lazy" />
        ) : (
          <p key={`${index}-${part.value.slice(0, 12)}`}>{part.value}</p>
        ),
      )}
    </div>
  )
}
