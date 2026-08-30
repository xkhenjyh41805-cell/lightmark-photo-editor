import { useCallback, useEffect, useState } from 'react'
import {
  BUILTIN_PRESETS,
  normalizePresetList,
  newPresetId,
  makePresetAdjust,
  type Preset,
  type PresetAdjust,
} from '../presets'

// 阶段 5.4：修图预设状态管理。
// 内置预设（builtin）常驻内存不可删；用户预设（user）从主进程 presets.json 加载，可增删。
// 对外暴露：所有预设（内置 + 用户）、保存当前为预设、删除、套用回调由 App 传入。
//
// 套用逻辑不放这里（套用要改某张照片的 adjust，那是 useAdjustments 的职责）。
// 这里只管预设列表本身的增删查。

export function usePresets() {
  const [userPresets, setUserPresets] = useState<Preset[]>([])
  const [loaded, setLoaded] = useState(false)

  // 启动时从主进程读用户预设
  useEffect(() => {
    let alive = true
    window.lightmark
      .loadPresets()
      .then((raw) => {
        if (!alive) return
        const list = normalizePresetList(raw)
        setUserPresets(list)
        setLoaded(true)
      })
      .catch(() => {
        if (!alive) return
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // 所有预设：内置在前（固定顺序），用户在后
  const presets: Preset[] = [...BUILTIN_PRESETS, ...userPresets]

  // 保存当前调整为命名预设。返回新预设（含生成的 id）。
  const savePreset = useCallback(
    async (name: string, adjust: PresetAdjust): Promise<Preset> => {
      const preset: Preset = {
        id: newPresetId(),
        name: name.trim() || '未命名预设',
        kind: 'user',
        adjust,
      }
      const next = await window.lightmark.savePreset(preset)
      setUserPresets(normalizePresetList(next))
      return preset
    },
    [],
  )

  // 删除用户预设（内置删不掉，按钮也只对 user 预设出现）
  const deletePreset = useCallback(async (presetId: string) => {
    const next = await window.lightmark.deletePreset(presetId)
    setUserPresets(normalizePresetList(next))
  }, [])

  // 给定一个 Preset 拿到它的 PresetAdjust（深拷贝，套用时再拷一次也行）
  const getPresetAdjust = useCallback((preset: Preset): PresetAdjust => {
    return makePresetAdjust(preset.adjust.global, preset.adjust.hsl)
  }, [])

  return {
    presets,
    userPresets,
    loaded,
    savePreset,
    deletePreset,
    getPresetAdjust,
  }
}
