import { clonePhotoAdjust, type PhotoAdjust } from '../image/index.ts'

export interface HistoryEntry { id: string | null; adjust: PhotoAdjust }
export interface EditHistory {
  past: HistoryEntry[]
  future: HistoryEntry[]
  currentId: string | null
}
export type TransactionStatus = 'applied' | 'undone' | 'unavailable'
export function emptyHistory(): EditHistory { return { past: [], future: [], currentId: null } }

export function commitEdit(history: EditHistory, before: PhotoAdjust, id: string, coalesce = false): EditHistory {
  // Any new edit cuts the redo branch, including a coalesced slider edit.
  const past = coalesce && history.currentId ? history.past : [
    ...history.past, { id: history.currentId, adjust: clonePhotoAdjust(before) },
  ].slice(-50)
  return { past, future: [], currentId: coalesce && history.currentId ? history.currentId : id }
}
export function undoEdit(history: EditHistory, current: PhotoAdjust): { history: EditHistory; adjust: PhotoAdjust } | null {
  const target = history.past.at(-1)
  if (!target) return null
  return {
    adjust: clonePhotoAdjust(target.adjust),
    history: { past: history.past.slice(0, -1), future: [...history.future, { id: history.currentId, adjust: clonePhotoAdjust(current) }], currentId: target.id },
  }
}
export function redoEdit(history: EditHistory, current: PhotoAdjust): { history: EditHistory; adjust: PhotoAdjust } | null {
  const target = history.future.at(-1)
  if (!target) return null
  return {
    adjust: clonePhotoAdjust(target.adjust),
    history: { past: [...history.past, { id: history.currentId, adjust: clonePhotoAdjust(current) }].slice(-50), future: history.future.slice(0, -1), currentId: target.id },
  }
}
export function transactionStatus(history: EditHistory, id: string): TransactionStatus {
  if (history.currentId === id || history.past.some((entry) => entry.id === id)) return 'applied'
  if (history.future.some((entry) => entry.id === id)) return 'undone'
  return 'unavailable'
}
export function canUndoTransaction(history: EditHistory, id: string): boolean {
  return history.currentId === id && history.past.length > 0
}
export function canRedoTransaction(history: EditHistory, id: string): boolean {
  return history.future.at(-1)?.id === id
}
