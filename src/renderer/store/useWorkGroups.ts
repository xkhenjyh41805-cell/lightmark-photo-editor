import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Photo, WorkGroup, WorkGroupStore } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validGroupId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

function uniquePhotoIds(value: unknown, knownIds: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && knownIds.has(id)))].slice(0, 10000)
}

function makeGroupId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `workgroup_${uuid ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`}`
}

function makeLegacyGroup(photos: Photo[], selectedId: string | null): WorkGroup | null {
  if (photos.length === 0) return null
  const now = Date.now()
  const photoIds = photos.map((photo) => photo.id)
  return {
    id: 'legacy_workgroup',
    name: '旧版照片工作组',
    photoIds,
    currentPhotoId: selectedId && photoIds.includes(selectedId) ? selectedId : photoIds[0],
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeWorkGroupStore(raw: unknown, photos: Photo[], selectedId: string | null): WorkGroupStore {
  const knownIds = new Set(photos.map((photo) => photo.id))
  const record = isRecord(raw) && raw.version === 1 && Array.isArray(raw.groups) ? raw : null
  const groups: WorkGroup[] = []
  const savedGroups = record && Array.isArray(record.groups) ? record.groups : []

  for (const item of savedGroups) {
    if (!isRecord(item) || !validGroupId(item.id)) continue
    const photoIds = uniquePhotoIds(item.photoIds, knownIds)
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim().slice(0, 80)
      : '未命名工作组'
    const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
    groups.push({
      id: item.id,
      name,
      photoIds,
      currentPhotoId: typeof item.currentPhotoId === 'string' && photoIds.includes(item.currentPhotoId)
        ? item.currentPhotoId
        : photoIds[0] ?? null,
      createdAt,
      updatedAt,
    })
  }

  if (groups.length === 0) {
    const legacy = makeLegacyGroup(photos, selectedId)
    if (legacy) groups.push(legacy)
  }

  const requestedActiveId = isRecord(record) && typeof record.activeGroupId === 'string'
    ? record.activeGroupId
    : null
  const activeGroupId = groups.some((group) => group.id === requestedActiveId)
    ? requestedActiveId
    : groups[0]?.id ?? null

  return { version: 1, activeGroupId, groups }
}

function formatGroupName(index: number): string {
  const now = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(now)
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  return `工作组 ${index} · ${date} ${time}`
}

interface UseWorkGroupsResult {
  groups: WorkGroup[]
  activeGroup: WorkGroup | null
  activeGroupId: string | null
  groupPhotos: Photo[]
  loading: boolean
  error: string
  selectGroup: (id: string) => void
  createGroup: (photos: Photo[]) => string | null
  renameGroup: (id: string, name: string) => void
  rememberPhoto: (photoId: string | null) => void
}

export function useWorkGroups(
  photos: Photo[],
  libraryLoading: boolean,
  selectedId: string | null,
  setSelectedId: (id: string | null) => void,
): UseWorkGroupsResult {
  const [groups, setGroups] = useState<WorkGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedStore, setSavedStore] = useState<unknown>(null)
  const [storeLoaded, setStoreLoaded] = useState(false)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    let alive = true
    void window.lightmark.readWorkGroups()
      .then((store) => {
        if (!alive) return
        setSavedStore(store)
        setStoreLoaded(true)
      })
      .catch((reason) => {
        if (!alive) return
        setError(reason instanceof Error ? reason.message : '读取工作组失败。')
        setStoreLoaded(true)
      })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!storeLoaded || libraryLoading || initialized) return
    if (error) {
      setLoading(false)
      return
    }
    const normalized = normalizeWorkGroupStore(savedStore, photos, selectedId)
    setGroups(normalized.groups)
    setActiveGroupId(normalized.activeGroupId)
    const active = normalized.groups.find((group) => group.id === normalized.activeGroupId)
    if (active?.currentPhotoId) setSelectedId(active.currentPhotoId)
    setInitialized(true)
    setLoading(false)
  }, [storeLoaded, libraryLoading, initialized, savedStore, photos, selectedId, setSelectedId, error])

  useEffect(() => {
    if (!initialized || error) return
    const timer = window.setTimeout(() => {
      void window.lightmark.saveWorkGroups({ version: 1, activeGroupId, groups })
        .then(() => setError(''))
        .catch((reason) => setError(reason instanceof Error ? reason.message : '保存工作组失败。'))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [initialized, activeGroupId, groups, error])

  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos])
  const groupPhotos = useMemo(
    () => activeGroup?.photoIds.map((id) => photoById.get(id)).filter((photo): photo is Photo => Boolean(photo)) ?? [],
    [activeGroup, photoById],
  )

  const selectGroup = useCallback((id: string) => {
    const group = groups.find((candidate) => candidate.id === id)
    if (!group) return
    setActiveGroupId(id)
    const photoId = group.currentPhotoId && group.photoIds.includes(group.currentPhotoId)
      ? group.currentPhotoId
      : group.photoIds[0] ?? null
    setSelectedId(photoId)
  }, [groups, setSelectedId])

  const createGroup = useCallback((newPhotos: Photo[]) => {
    if (!initialized || newPhotos.length === 0) return null
    const now = Date.now()
    const group: WorkGroup = {
      id: makeGroupId(),
      name: formatGroupName(groups.length + 1),
      photoIds: [...new Set(newPhotos.map((photo) => photo.id))],
      currentPhotoId: newPhotos[0].id,
      createdAt: now,
      updatedAt: now,
    }
    setGroups((current) => [group, ...current])
    setActiveGroupId(group.id)
    setSelectedId(group.currentPhotoId)
    return group.id
  }, [groups.length, initialized, setSelectedId])

  const renameGroup = useCallback((id: string, name: string) => {
    const normalizedName = name.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (!normalizedName) return
    setGroups((current) => current.map((group) => group.id === id
      ? { ...group, name: normalizedName, updatedAt: Date.now() }
      : group))
  }, [])

  const rememberPhoto = useCallback((photoId: string | null) => {
    if (!activeGroupId) return
    setGroups((current) => current.map((group) => {
      if (group.id !== activeGroupId || group.currentPhotoId === photoId ||
          (photoId && !group.photoIds.includes(photoId))) return group
      return { ...group, currentPhotoId: photoId }
    }))
  }, [activeGroupId])

  return {
    groups,
    activeGroup,
    activeGroupId,
    groupPhotos,
    loading,
    error,
    selectGroup,
    createGroup,
    renameGroup,
    rememberPhoto,
  }
}
