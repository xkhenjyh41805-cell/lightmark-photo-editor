// 导出相关类型与预设定义
// 阶段 4：能导出与存档
//
// 设计要点：
// - 导出参数独立于 AdjustParams（导出是"怎么输出"，调图是"怎么改图"）
// - 预设把格式/尺寸/画质打包，一键选择（4.5）
// - 渲染进程跑全分辨率 applyAdjustments，把像素通过 IPC 传主进程，主进程 sharp 编码写文件（方案 A）

export type ExportFormat = 'jpeg' | 'png' | 'webp'

// 尺寸策略：原图导出 / 按长边缩放
export type ResizeMode = 'original' | 'longEdge'

export interface ExportOptions {
  format: ExportFormat
  quality: number          // jpeg/webp 1~100；png 忽略
  resizeMode: ResizeMode
  longEdge: number         // resizeMode=longEdge 时的目标长边像素
}

// 导出预设：把常用场景的格式/尺寸/画质打包好
export interface ExportPreset {
  id: string
  label: string
  desc: string
  options: ExportOptions
}

// 预设清单（4.5）。网页要小、打印要大且高画质、社交折中。
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'web',
    label: '网页',
    desc: '长边 2048，JPEG 85，适合上传网站',
    options: { format: 'jpeg', quality: 85, resizeMode: 'longEdge', longEdge: 2048 },
  },
  {
    id: 'social',
    label: '社交',
    desc: '长边 1080，JPEG 90，适合朋友圈微博',
    options: { format: 'jpeg', quality: 90, resizeMode: 'longEdge', longEdge: 1080 },
  },
  {
    id: 'print',
    label: '打印',
    desc: '原图尺寸，JPEG 100，最大画质输出',
    options: { format: 'jpeg', quality: 100, resizeMode: 'original', longEdge: 0 },
  },
  {
    id: 'archive',
    label: '存档',
    desc: '原图尺寸，PNG 无损',
    options: { format: 'png', quality: 100, resizeMode: 'original', longEdge: 0 },
  },
]

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'jpeg',
  quality: 92,
  resizeMode: 'longEdge',
  longEdge: 2048,
}

// 格式中文名
export const FORMAT_LABELS: Record<ExportFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG（无损）',
  webp: 'WebP',
}
