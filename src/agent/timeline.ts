export interface TimelineMessage { id: number; role: 'user' | 'assistant'; photoId: string }
export interface TimelineSuggestion { id: number; photoId: string; parentMessageId?: number; dismissed?: boolean }
export function groupSuggestions<T extends TimelineSuggestion>(messages: TimelineMessage[], suggestions: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const suggestion of suggestions) {
    if (suggestion.dismissed) continue
    const parent = suggestion.parentMessageId === undefined
      ? [...messages].reverse().find((m) => m.role === 'assistant' && m.photoId === suggestion.photoId && m.id < suggestion.id)
      : messages.find((m) => m.id === suggestion.parentMessageId && m.role === 'assistant')
    if (!parent) continue
    grouped.set(parent.id, [...(grouped.get(parent.id) ?? []), suggestion])
  }
  return grouped
}
