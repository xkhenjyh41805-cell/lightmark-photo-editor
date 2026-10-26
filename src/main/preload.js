// Electron 预加载脚本
// 在主进程与渲染进程之间搭桥，向网页暴露安全的能力
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lightmark', {
  version: '0.1.0',

  // 受限窗口控制：不开放任意 IPC 通道。
  windowControl: (action) => ipcRenderer.invoke('window:control', action),

  // 弹出系统文件选择框，返回选中的图片路径数组
  pickImages: () => ipcRenderer.invoke('dialog:openImages'),

  // 把给定路径的图片导入图库（复制原图 + 生成缩略图 + 写索引）
  // 返回新增的照片记录数组
  importImages: (srcPaths) => ipcRenderer.invoke('library:import', srcPaths),

  // 读取整个图库的照片列表
  readLibrary: () => ipcRenderer.invoke('library:read'),

  // 工作组元数据与独立的 Agent 会话记录
  readWorkGroups: () => ipcRenderer.invoke('workgroups:read'),
  saveWorkGroups: (store) => ipcRenderer.invoke('workgroups:save', store),
  readAgentConversation: (workGroupId) => ipcRenderer.invoke('conversation:read', workGroupId),
  saveAgentConversation: (workGroupId, conversation) => ipcRenderer.invoke('conversation:save', workGroupId, conversation),

  // 读取一个文件路径，返回 data URL（给 <img> 用）
  readDataUrl: (filePath) => ipcRenderer.invoke('file:readDataUrl', filePath),

  // 从图库删除一张照片
  removePhoto: (photoId) => ipcRenderer.invoke('library:remove', photoId),

  // 阶段 4：把渲染进程处理好的全分辨率 RGBA 像素编码写文件
  // pixels 是 Uint8ClampedArray，会通过 structured clone 传过来
  exportPixels: (req) => ipcRenderer.invoke('export:pixels', req),
  // 仅按 photoId 覆盖 LightMark 私有图库中的副本，目标路径由主进程解析并保留备份。
  overwriteOriginal: (req) => ipcRenderer.invoke('export:overwriteOriginal', req),

  // 阶段 4：批量导出。先选目录，再把一批像素数组写进去
  exportPickDir: () => ipcRenderer.invoke('export:pickDir'),
  exportBatch: (req) => ipcRenderer.invoke('export:batch', req),

  // 阶段 4：参数持久化 .sidecar
  saveSidecar: (photoId, params) => ipcRenderer.invoke('sidecar:save', photoId, params),
  loadSidecar: (photoId) => ipcRenderer.invoke('sidecar:load', photoId),

  // 阶段 5.4：修图预设（用户预设落盘 presets.json；内置预设在前端常量里）
  loadPresets: () => ipcRenderer.invoke('preset:load'),
  savePreset: (preset) => ipcRenderer.invoke('preset:save', preset),
  deletePreset: (presetId) => ipcRenderer.invoke('preset:delete', presetId),

  // BYOM：主进程负责系统加密存储 API Key；get 仅返回脱敏配置状态。
  getAgentProvider: () => ipcRenderer.invoke('agent:provider:get'),
  saveAgentProvider: (config) => ipcRenderer.invoke('agent:provider:save', config),
  clearAgentApiKey: () => ipcRenderer.invoke('agent:provider:clear-key'),
  forgetAgentImageConsent: () => ipcRenderer.invoke('agent:provider:forget-consent'),
  testAgentImage: (request) => ipcRenderer.invoke('agent:provider:test-image', request),
  askAgent: (request) => ipcRenderer.invoke('agent:ask', request),
  getAgentRequestStatus: (requestId) => ipcRenderer.invoke('agent:request:status', requestId),
  cancelAgentRequest: (requestId) => ipcRenderer.invoke('agent:request:cancel', requestId),
})
