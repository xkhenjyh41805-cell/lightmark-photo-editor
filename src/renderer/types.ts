// 全局类型定义
import type { ProviderDraft, ProviderPublicConfig } from '../agent/provider'

// 一张照片在图库里的记录
export interface Photo {
  id: string
  name: string
  originalPath: string
  thumbPath: string
  ext: string
  importedAt: number
}

export interface WorkGroup {
  id: string
  name: string
  photoIds: string[]
  currentPhotoId: string | null
  createdAt: number
  updatedAt: number
}

export interface WorkGroupStore {
  version: 1
  activeGroupId: string | null
  groups: WorkGroup[]
}

export interface AgentRequestStatus {
  requestId: string
  running: boolean
  phase: 'preparing' | 'waiting_response' | 'reading_response' | 'parsing_response' | 'completed' | 'failed' | 'cancelled'
  elapsedMs: number
  timeoutSeconds: number
  receivedBytes: number
  httpStatus?: number
  errorCode?: string
  failedPhase?: string
}

// preload.js 通过 contextBridge 暴露到 window.lightmark 的能力
export interface LightMarkApi {
  version: string
  windowControl: (action: 'minimize' | 'toggleMaximize' | 'close') => Promise<boolean>
  pickImages: () => Promise<string[]>
  importImages: (srcPaths: string[]) => Promise<Photo[]>
  readLibrary: () => Promise<Photo[]>
  readDataUrl: (filePath: string) => Promise<string | null>
  removePhoto: (photoId: string) => Promise<boolean>
  readWorkGroups: () => Promise<unknown>
  saveWorkGroups: (store: WorkGroupStore) => Promise<boolean>
  readAgentConversation: (workGroupId: string) => Promise<unknown>
  saveAgentConversation: (workGroupId: string, conversation: unknown) => Promise<boolean>

  // 阶段 4：导出
  // 渲染进程把处理好的全分辨率 RGBA 像素传过来，主进程用 sharp 编码写文件
  // 返回保存路径，取消返回 null
  exportPixels: (req: {
    pixels: Uint8ClampedArray  // 处理后的 RGBA
    width: number
    height: number
    options: import('./export').ExportOptions
    suggestedName: string      // 建议文件名（不含扩展名）
  }) => Promise<string | null>

  // 覆盖 LightMark 私有图库中的原图副本；主进程按 photoId 解析路径并保留原副本备份。
  overwriteOriginal: (req: {
    photoId: string
    pixels: Uint8ClampedArray
    width: number
    height: number
    options: import('./export').ExportOptions
  }) => Promise<Photo>

  // 选导出目录（批量用）
  exportPickDir: () => Promise<string | null>

  // 批量导出：一批像素数组写进指定目录
  exportBatch: (req: {
    dir: string
    items: {
      pixels: Uint8ClampedArray
      width: number
      height: number
      options: import('./export').ExportOptions
      suggestedName: string
    }[]
  }) => Promise<{ saved: string[]; skipped: number }>

  // 阶段 4/5.2：参数持久化 .sidecar
  // 阶段 5.2：存取的是 PhotoAdjust（{ global, masks }）。渲染层 normalize 兼容老 sidecar。
  saveSidecar: (photoId: string, adjust: import('../image').PhotoAdjust) => Promise<boolean>
  loadSidecar: (photoId: string) => Promise<unknown>

  // 阶段 5.4：修图预设（用户预设落盘 presets.json）
  // 预设只含 global + hsl，不含 masks。容错在渲染层 normalizePresetList。
  loadPresets: () => Promise<unknown[]>
  savePreset: (preset: import('./presets').Preset) => Promise<unknown[]>
  deletePreset: (presetId: string) => Promise<unknown[]>

  // BYOM：密钥只可写入，读取配置时只返回 apiKeyConfigured 状态。
  getAgentProvider: () => Promise<ProviderPublicConfig>
  saveAgentProvider: (config: ProviderDraft) => Promise<ProviderPublicConfig>
  clearAgentApiKey: () => Promise<ProviderPublicConfig>
  forgetAgentImageConsent: () => Promise<ProviderPublicConfig>
  testAgentImage: (request: {
    requestId?: string
    provider: ProviderDraft
    previewDataUrl: string
    consentMode?: 'once' | 'remember'
  }) => Promise<string>
  askAgent: (request: {
    requestId?: string
    prompt: string
    previewDataUrl: string
    history: { role: 'user' | 'assistant'; content: string }[]
    currentAdjustments: Pick<import('../image').PhotoAdjust, 'global' | 'hsl'>
    localMasks: { id: string; name: string; type: 'gradient' | 'radial' | 'brush' | 'raster' }[]
    consentMode?: 'once' | 'remember'
  }) => Promise<string>
  getAgentRequestStatus: (requestId: string) => Promise<AgentRequestStatus | null>
  cancelAgentRequest: (requestId: string) => Promise<boolean>
}

declare global {
  interface Window {
    lightmark: LightMarkApi
  }
}

export {}
