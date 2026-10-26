// 图像处理核心模块 —— 与 UI 完全分离
// 这里只放：调整参数类型定义、像素级算法、直方图计算。
// 渲染层（Canvas）在 src/renderer 里调用本模块。

// 用一个最小接口而非直接依赖 DOM 的 ImageData，
// 这样算法既能在渲染进程的 Canvas ImageData 上跑，也能在 Node 测试里跑。
export interface ImageBuf {
  width: number
  height: number
  data: Uint8ClampedArray // RGBA
}

// 一组完整的调整参数。所有滑块默认 0 = 原图不变。
// 范围统一 -100 ~ 100（白平衡的色温/色调也是，但语义不同）。
export interface AdjustParams {
  // 基础校正
  exposure: number      // 曝光：-100~100，整体亮度
  contrast: number      // 对比度：-100~100

  // 影调
  highlights: number    // 高光：负值压暗亮部
  shadows: number       // 阴影：正值提亮暗部
  whites: number        // 白色：影响最亮端
  blacks: number        // 黑色：影响最暗端

  // 色彩
  saturation: number    // 饱和度：整体
  vibrance: number      // 自然饱和度：低饱和度像素加权更多

  // 细节
  sharpness: number     // 锐化：0~100（卷积强度）
  noiseReduction: number// 降噪：0~100

  // 白平衡
  temperature: number   // 色温：负冷正暖
  tint: number          // 色调：负绿正品红
}

export const DEFAULT_PARAMS: AdjustParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  sharpness: 0,
  noiseReduction: 0,
  temperature: 0,
  tint: 0,
}

// 是否所有参数都是默认（等于没调）
export function isDefaultParams(p: AdjustParams): boolean {
  return (Object.keys(DEFAULT_PARAMS) as (keyof AdjustParams)[]).every(
    (k) => p[k] === 0,
  )
}

// 钳制到 0~255
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

// smoothstep 在文件后部定义（函数声明会提升），这里直接用。

// ---- 阶段 5.2：局部调整（蒙版） ----
// 局部滤镜 = 一张蒙版（权重图 0~1）+ 一组完整的 AdjustParams。
// 蒙版形状的几何参数全部归一化（0~1，相对图片宽高），
// 这样预览代理图与全分辨率导出位置一致，旋转/缩放都不影响。

// 线性渐变：三段式（绿线 100% → 白线 50% → 红线 0%）。
// 用「中心点 + 方向角 + 总半宽」定义一条垂直于方向的渐变带。
export interface GradientGeom {
  type: 'gradient'
  cx: number       // 渐变中心 x（归一化），落在白线上
  cy: number       // 渐变中心 y
  angle: number    // 渐变方向角（度）。0=从上往下渐变，顺时针为正。
                   // 方向指「从绿线指向红线」的方向。
  range: number    // 绿线到红线的总半宽（归一化，0~1）。绿/红线各距中心 range。
  feather: number  // 0~1，绿→红之间过渡的平滑度，1=全程软过渡，0=硬边
}

// 径向椭圆：圈内全影响，按羽化向外衰减；invert 时只影响圈外。
export interface RadialGeom {
  type: 'radial'
  cx: number        // 椭圆中心 x（归一化）
  cy: number        // 椭圆中心 y
  rx: number        // 长半轴（归一化，相对图片宽）
  ry: number        // 短半轴（归一化，相对图片高）
  rotation: number  // 椭圆旋转角（度）
  feather: number   // 0~1，边缘羽化宽度占半轴的比例
  invert: boolean   // true=影响圈外，false=影响圈内
}

// 笔刷蒙版：一条或多条手绘笔触（每条是归一化点序列），沿路径盖软边圆。
// 大小 size 是笔刷半径（归一化，相对图片最大边）。
// feather 0~1：圆心 1、边缘按 feather 比例过渡到 0。
// eraseMode=true 时该笔刷从蒙版里减掉（擦除），即把经过的像素权重压低。
export interface BrushStroke {
  points: { x: number; y: number }[]  // 归一化坐标 0~1
  size: number      // 笔刷半径（归一化，相对最大边）
  feather: number   // 0~1 边缘软度
  erase: boolean    // true=擦除（减权重），false=绘制（加权重）
}

export interface BrushGeom {
  type: 'brush'
  strokes: BrushStroke[]  // 多条笔触
  // 默认绘制半径（新建笔刷时用，也作为「正在画」时的笔刷粗细）
  size: number
  feather: number
}

// 栅格候选蒙版：由本地语义分割模型输出的低分辨率权重图。
// data 是单通道 0~255 的 base64 编码；坐标仍随图片宽高归一化，因此预览和全分辨率导出一致。
// strokes 叠加用户的绘制／擦除笔触，候选不能绕过人工校正。
export interface RasterGeom {
  type: 'raster'
  width: number
  height: number
  data: string
  strokes: BrushStroke[]
  size: number
  feather: number
}

export type MaskGeom = GradientGeom | RadialGeom | BrushGeom | RasterGeom

export interface AutoMaskCandidate {
  source: 'local-semantic-sky-v1'
  target: 'sky'
  status: 'pending'
  modelId: string
}

// 一个局部滤镜
export interface LocalMask {
  id: string
  /** 用户命名的语义区域，例如“天空”“黑猫主体”。空字符串代表未命名，Agent 不可引用。 */
  name?: string
  enabled: boolean
  geom: MaskGeom
  adjust: AdjustParams  // 复用全局 12 滑块，完整版
  /** 候选状态下仅供用户检查，不能发送给 Agent 或参与实际修图。 */
  candidate?: AutoMaskCandidate
}

export function normalizeMaskName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 32)
}

export function localMaskTypeLabel(mask: Pick<LocalMask, 'geom'>): string {
  if (mask.geom.type === 'gradient') return '渐变蒙版'
  if (mask.geom.type === 'radial') return '径向蒙版'
  if (mask.geom.type === 'raster') return 'AI 候选蒙版'
  return '笔刷蒙版'
}

export function localMaskDisplayName(mask: Pick<LocalMask, 'name' | 'geom'>): string {
  return normalizeMaskName(mask.name) || `未命名${localMaskTypeLabel(mask)}`
}

/** 候选蒙版必须先由用户采纳，才能作为 Agent 可调用的语义区域。 */
export function isMaskAgentAvailable(mask: LocalMask): boolean {
  return mask.enabled && !mask.candidate && Boolean(normalizeMaskName(mask.name))
}

const RASTER_MASK_MAX_EDGE = 512

export function encodeRasterMaskData(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunk, data.length)))
  }
  return btoa(binary)
}

function decodeRasterMaskData(data: string, expectedLength: number): Uint8Array | null {
  if (typeof data !== 'string' || data.length > Math.ceil(expectedLength * 4 / 3) + 16) return null
  try {
    const binary = atob(data)
    if (binary.length !== expectedLength) return null
    const bytes = new Uint8Array(expectedLength)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function isValidRasterGeom(value: unknown): value is RasterGeom {
  if (!value || typeof value !== 'object') return false
  const raster = value as Partial<RasterGeom>
  return raster.type === 'raster'
    && Number.isInteger(raster.width) && Number.isInteger(raster.height)
    && raster.width! >= 8 && raster.height! >= 8
    && raster.width! <= RASTER_MASK_MAX_EDGE && raster.height! <= RASTER_MASK_MAX_EDGE
    && typeof raster.data === 'string'
    && Array.isArray(raster.strokes)
    && typeof raster.size === 'number' && typeof raster.feather === 'number'
}

// ---- 阶段 5.3：HSL 分色调色（global-only）----
// 8 个色相段，每段可独立调色相/饱和度/明度。参数全 0 = 不变。
// HSL 作为全局 base 之上的独立像素 pass，不进局部滤镜（mask 路径调 applyPixel，
// 不调 applyHslPixel），保证局部调整 HSL-free。
export type HslColorId =
  | 'red' | 'orange' | 'yellow' | 'green'
  | 'cyan' | 'blue' | 'purple' | 'magenta'

// 每段三项：hue/saturation/luminance，范围 -100~100，0=无变化
export interface HslColorAdjust {
  hue: number
  saturation: number
  luminance: number
}

export type HslParams = Record<HslColorId, HslColorAdjust>

// 8 段顺序（色相环顺时针），UI 色块顺序与边界权重遍历都用它
export const HSL_COLOR_IDS: HslColorId[] = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta',
]

// 每段中心色相（度，0~360）。用于边界权重计算。
// magenta(300) → red(360/0) 跨 0 度，权重计算用环形距离处理。
export const HSL_CENTERS: Record<HslColorId, number> = {
  red: 0, orange: 30, yellow: 60, green: 120,
  cyan: 180, blue: 240, purple: 270, magenta: 300,
}

export const DEFAULT_HSL: HslParams = {
  red: { hue: 0, saturation: 0, luminance: 0 },
  orange: { hue: 0, saturation: 0, luminance: 0 },
  yellow: { hue: 0, saturation: 0, luminance: 0 },
  green: { hue: 0, saturation: 0, luminance: 0 },
  cyan: { hue: 0, saturation: 0, luminance: 0 },
  blue: { hue: 0, saturation: 0, luminance: 0 },
  purple: { hue: 0, saturation: 0, luminance: 0 },
  magenta: { hue: 0, saturation: 0, luminance: 0 },
}

export function isDefaultHsl(h: HslParams | undefined): boolean {
  if (!h) return true
  for (const id of HSL_COLOR_IDS) {
    const c = h[id]
    if (!c) continue
    if (c.hue !== 0 || c.saturation !== 0 || c.luminance !== 0) return false
  }
  return true
}

// 钳制单值到 -100~100
function clampHslVal(v: number): number {
  return v < -100 ? -100 : v > 100 ? 100 : v
}

// 把任意（可能残缺/越界/含未知键）的 sidecar hsl 规整成完整 HslParams
export function normalizeHsl(raw: unknown): HslParams {
  const out: HslParams = {
    red: { ...DEFAULT_HSL.red },
    orange: { ...DEFAULT_HSL.orange },
    yellow: { ...DEFAULT_HSL.yellow },
    green: { ...DEFAULT_HSL.green },
    cyan: { ...DEFAULT_HSL.cyan },
    blue: { ...DEFAULT_HSL.blue },
    purple: { ...DEFAULT_HSL.purple },
    magenta: { ...DEFAULT_HSL.magenta },
  }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const id of HSL_COLOR_IDS) {
    const c = obj[id]
    if (!c || typeof c !== 'object') continue
    const co = c as Record<string, unknown>
    out[id] = {
      hue: typeof co.hue === 'number' ? clampHslVal(co.hue) : 0,
      saturation: typeof co.saturation === 'number' ? clampHslVal(co.saturation) : 0,
      luminance: typeof co.luminance === 'number' ? clampHslVal(co.luminance) : 0,
    }
  }
  return out
}

// ---- 阶段 5.6：几何变换（裁剪/旋转/翻转）----
// 几何在管线最前：先对原图做翻转→整档旋转→微调旋转→裁剪，得到变换后画布，
// 再套影调/色彩/HSL/蒙版。直方图与蒙版坐标都基于变换后画面。
// 所有坐标归一化（0~1），预览代理图与全分辨率导出共用，与蒙版几何归一化思路一致。
export interface CropRect {
  x: number   // 左上 x（归一化，相对变换后画面）
  y: number   // 左上 y
  w: number   // 宽
  h: number   // 高
}

export interface Geometry {
  rotation90: 0 | 90 | 180 | 270  // 整档旋转（顺时针）
  fineAngle: number               // 微调角度（度，-45~45），在 rotation90 之后顺时针
  flipH: boolean                  // 水平翻转
  flipV: boolean                  // 垂直翻转
  crop: CropRect                  // 裁剪框，归一化，相对最终变换后的画面
  enabled: boolean                // 是否应用几何（全默认时 false，便于短路）
}

export const DEFAULT_GEOMETRY: Geometry = {
  rotation90: 0,
  fineAngle: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  enabled: false,
}

// 几何是否全默认（没翻转、没旋转、裁满全图）
export function isDefaultGeometry(g: Geometry | undefined): boolean {
  if (!g) return true
  return (
    !g.flipH &&
    !g.flipV &&
    g.rotation90 === 0 &&
    g.fineAngle === 0 &&
    g.crop.x === 0 &&
    g.crop.y === 0 &&
    g.crop.w === 1 &&
    g.crop.h === 1
  )
}

// 把任意（可能残缺/越界）的 sidecar geometry 规整成完整 Geometry
export function normalizeGeometry(raw: unknown): Geometry {
  const out: Geometry = { ...DEFAULT_GEOMETRY }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  if (obj.rotation90 === 90 || obj.rotation90 === 180 || obj.rotation90 === 270) {
    out.rotation90 = obj.rotation90
  }
  if (typeof obj.fineAngle === 'number') {
    out.fineAngle = Math.max(-45, Math.min(45, obj.fineAngle))
  }
  if (typeof obj.flipH === 'boolean') out.flipH = obj.flipH
  if (typeof obj.flipV === 'boolean') out.flipV = obj.flipV
  if (obj.crop && typeof obj.crop === 'object') {
    const c = obj.crop as Record<string, unknown>
    const x = typeof c.x === 'number' ? c.x : 0
    const y = typeof c.y === 'number' ? c.y : 0
    const w = typeof c.w === 'number' ? c.w : 1
    const h = typeof c.h === 'number' ? c.h : 1
    // 钳到合法范围，宽高不小于一个小值
    out.crop = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.max(1e-3, Math.min(1, w)),
      h: Math.max(1e-3, Math.min(1, h)),
    }
  }
  out.enabled = !isDefaultGeometry(out)
  return out
}

// 翻转一张图（水平/垂直）。逐像素镜像，纯函数。
function flipBuf(img: ImageBuf, flipH: boolean, flipV: boolean): ImageBuf {
  if (!flipH && !flipV) return img
  const { width: w, height: h, data: src } = img
  const out = new Uint8ClampedArray(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = flipH ? w - 1 - x : x
      const sy = flipV ? h - 1 - y : y
      const di = (y * w + x) * 4
      const si = (sy * w + sx) * 4
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
      out[di + 3] = src[si + 3]
    }
  }
  return { width: w, height: h, data: out }
}

// 整档旋转（顺时针 90/180/270）。180 时宽高不变，90/270 宽高交换。
function rotate90Buf(img: ImageBuf, rotation90: 0 | 90 | 180 | 270): ImageBuf {
  if (rotation90 === 0) return img
  const { width: w, height: h, data: src } = img
  if (rotation90 === 180) {
    return flipBuf(img, true, true)
  }
  // 90 顺时针：(x,y) -> (h-1-y, x)；输出宽=h 高=w
  // 270 顺时针 = 90 逆时针：(x,y) -> (y, w-1-x)
  const outW = h
  const outH = w
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      let dx: number, dy: number
      if (rotation90 === 90) {
        dx = h - 1 - y
        dy = x
      } else {
        // 270
        dx = y
        dy = w - 1 - x
      }
      const di = (dy * outW + dx) * 4
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
      out[di + 3] = src[si + 3]
    }
  }
  return { width: outW, height: outH, data: out }
}

// 微调旋转（任意角度，顺时针为正）。画布取旋转后包围盒，背景填黑。
// 旋转会留黑角，靠裁剪框去掉。这里保持原图全部可见。
function rotateFineBuf(img: ImageBuf, angleDeg: number): ImageBuf {
  if (angleDeg === 0) return img
  const { width: w, height: h, data: src } = img
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  // 旋转后包围盒尺寸
  const outW = Math.round(w * cos + h * sin)
  const outH = Math.round(w * sin + h * cos)
  const out = new Uint8ClampedArray(outW * outH * 4)
  // 背景填黑（alpha=255），让黑角可见、便于裁掉
  for (let i = 3; i < out.length; i += 4) out[i] = 255

  // 逆变换：对输出每个像素 (ox,oy)，算它在原图的采样位置。
  // 输出中心 = 原图中心。顺时针旋转 angleDeg = 逆时针采样 -angleDeg。
  const cxOut = outW / 2
  const cyOut = outH / 2
  const cxIn = w / 2
  const cyIn = h / 2
  const cosR = Math.cos(-rad)
  const sinR = Math.sin(-rad)
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const dx = ox - cxOut
      const dy = oy - cyOut
      const ix = cosR * dx - sinR * dy + cxIn
      const iy = sinR * dx + cosR * dy + cyIn
      const six = Math.floor(ix)
      const siy = Math.floor(iy)
      if (six < 0 || six >= w || siy < 0 || siy >= h) continue
      const si = (siy * w + six) * 4
      const di = (oy * outW + ox) * 4
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
      out[di + 3] = 255
    }
  }
  return { width: outW, height: outH, data: out }
}

// 按归一化 crop 取子区域
function cropBuf(img: ImageBuf, crop: CropRect): ImageBuf {
  if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return img
  const { width: w, height: h, data: src } = img
  const sx = Math.round(crop.x * w)
  const sy = Math.round(crop.y * h)
  const sw = Math.max(1, Math.round(crop.w * w))
  const sh = Math.max(1, Math.round(crop.h * h))
  const out = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = ((sy + y) * w + (sx + x)) * 4
      const di = (y * sw + x) * 4
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
      out[di + 3] = src[si + 3]
    }
  }
  return { width: sw, height: sh, data: out }
}

// 完整几何变换：翻转 → 整档旋转 → 微调旋转 → 裁剪。顺序固定。
export function transformGeometry(img: ImageBuf, geo: Geometry): ImageBuf {
  let out = img
  if (geo.flipH || geo.flipV) out = flipBuf(out, geo.flipH, geo.flipV)
  if (geo.rotation90 !== 0) out = rotate90Buf(out, geo.rotation90)
  if (geo.fineAngle !== 0) out = rotateFineBuf(out, geo.fineAngle)
  out = cropBuf(out, geo.crop)
  return out
}

// 给 UI 算「内接矩形」当默认裁剪框：微调旋转 angleDeg 后无黑角的最大矩形（归一化）。
// 公式：旋转矩形后内接矩形 = (w*cos - h*sin, h*cos - w*sin)（取绝对值，针对锐角）。
export function cropInteriorRect(angleDeg: number): CropRect {
  const a = Math.abs(angleDeg)
  if (a < 1e-3) return { x: 0, y: 0, w: 1, h: 1 }
  const rad = (a * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // 假设输入是正方形 1x1 算比例（归一化坐标与宽高比无关，用 1:1 近似）
  // 实际比例不同时 UI 会再按宽高比修正；这里给一个合理的默认起点。
  const w = Math.max(0, cos - sin)
  const h = Math.max(0, cos - sin)
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

// 一张照片的完整调整 = 几何 + 全局参数 + HSL 分色 + 局部滤镜列表。
// sidecar 持久化用这个结构（向后兼容老 sidecar：纯 AdjustParams 视为 global）。
export interface PhotoAdjust {
  geometry: Geometry   // 阶段 5.6 新增
  global: AdjustParams
  hsl: HslParams        // 阶段 5.3 新增
  masks: LocalMask[]
}

export const DEFAULT_PHOTO_ADJUST: PhotoAdjust = {
  geometry: { ...DEFAULT_GEOMETRY },
  global: { ...DEFAULT_PARAMS },
  hsl: { ...DEFAULT_HSL },
  masks: [],
}

// 深拷贝一份 PhotoAdjust（避免历史栈与当前状态共享引用）。
// masks 的 geom 要逐个拷，笔刷 strokes 数组也要拷，否则撤销时会被原地改坏。
// geometry 是值类型（无嵌套引用对象），浅拷即可。
// 容错 a.geometry 可能为空（老测试数据），用 normalizeGeometry 兜底。
export function clonePhotoAdjust(a: PhotoAdjust): PhotoAdjust {
  return {
    geometry: normalizeGeometry(a.geometry),
    global: { ...a.global },
    hsl: {
      red: { ...a.hsl.red },
      orange: { ...a.hsl.orange },
      yellow: { ...a.hsl.yellow },
      green: { ...a.hsl.green },
      cyan: { ...a.hsl.cyan },
      blue: { ...a.hsl.blue },
      purple: { ...a.hsl.purple },
      magenta: { ...a.hsl.magenta },
    },
    masks: a.masks.map((m) => {
      if (m.geom.type === 'brush') {
        return {
          ...m,
          name: normalizeMaskName(m.name),
          geom: {
            type: 'brush',
            size: m.geom.size,
            feather: m.geom.feather,
            strokes: m.geom.strokes.map((s) => ({
              size: s.size,
              feather: s.feather,
              erase: s.erase,
              points: s.points.map((p) => ({ x: p.x, y: p.y })),
            })),
          },
          adjust: { ...m.adjust },
        }
      }
      if (m.geom.type === 'raster') {
        return {
          ...m,
          name: normalizeMaskName(m.name),
          candidate: m.candidate ? { ...m.candidate } : undefined,
          geom: {
            type: 'raster',
            width: m.geom.width,
            height: m.geom.height,
            data: m.geom.data,
            size: m.geom.size,
            feather: m.geom.feather,
            strokes: m.geom.strokes.map((s) => ({
              size: s.size,
              feather: s.feather,
              erase: s.erase,
              points: s.points.map((p) => ({ x: p.x, y: p.y })),
            })),
          },
          adjust: { ...m.adjust },
        }
      }
      return { ...m, name: normalizeMaskName(m.name), geom: { ...m.geom } as MaskGeom, adjust: { ...m.adjust } }
    }),
  }
}

// 把老 sidecar（可能是裸 AdjustParams，也可能是 {global, masks}）规整成 PhotoAdjust
export function normalizePhotoAdjust(raw: unknown): PhotoAdjust {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PHOTO_ADJUST }
  const obj = raw as Record<string, unknown>
  // 新格式
  if (obj.global && typeof obj.global === 'object') {
    const masks = Array.isArray(obj.masks)
      ? (obj.masks as LocalMask[]).filter((m) => {
        if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.geom || typeof m.geom !== 'object') return false
        return (m.geom as MaskGeom).type !== 'raster' || isValidRasterGeom(m.geom)
      }).map((m) => ({ ...m, name: normalizeMaskName(m.name) }))
      : []
    return {
      geometry: normalizeGeometry(obj.geometry),
      global: { ...DEFAULT_PARAMS, ...(obj.global as Partial<AdjustParams>) },
      hsl: normalizeHsl(obj.hsl),
      masks,
    }
  }
  // 老格式：整个对象就是 AdjustParams
  return {
    geometry: { ...DEFAULT_GEOMETRY },
    global: { ...DEFAULT_PARAMS, ...(obj as Partial<AdjustParams>) },
    hsl: { ...DEFAULT_HSL },
    masks: [],
  }
}

// 生成蒙版权重图（0~1），与图片同尺寸。单通道 Float32Array，长度 = width*height。
export function buildMask(geom: MaskGeom, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)
  if (geom.type === 'gradient') {
    buildGradientMask(geom, width, height, out)
  } else if (geom.type === 'radial') {
    buildRadialMask(geom, width, height, out)
  } else if (geom.type === 'raster') {
    buildRasterMask(geom, width, height, out)
  } else {
    buildBrushMask(geom, width, height, out)
  }
  return out
}

// 渐变蒙版：
// 把每像素投到「方向轴」上，得到沿轴的坐标 t（以中心为 0）。
// 绿线在 t=-range（权重 1），红线在 t=+range（权重 0），白线在 t=0（权重 0.5）。
// feather 控制过渡区相对宽度（0~1）：
//   过渡发生在 [-range*feather, +range*feather]，过渡区外是恒定的 1 或 0。
//   feather=1 → 整段 [-range,range] 都在过渡（最软，但绿/红线端无平台）。
//   feather=0 → 过渡坍缩到中心点（绿线一侧全 1、红线一侧全 0，硬边）。
//   折中默认 feather=0.5 → 端部各 50% 是平台、中间 50% 过渡，最符合视觉直觉。
// range 是绿/红线到中心的距离，按图片最大边归一化（0~1 = 0~最大边）。
function buildGradientMask(g: GradientGeom, w: number, h: number, out: Float32Array) {
  const rad = (g.angle * Math.PI) / 180
  // 方向单位向量（从绿线指向红线）
  const dx = Math.sin(rad)
  const dy = Math.cos(rad)
  const ccx = g.cx * w
  const ccy = g.cy * h
  const maxSide = Math.max(w, h)
  const range = Math.max(1e-4, g.range) * maxSide
  // 过渡半宽 trans：相对 range 的比例 = feather，clamp 到不重叠
  const trans = Math.min(range, Math.max(1e-4, range * g.feather))
  const greenSoft = -trans  // t ≤ greenSoft → 全绿(1)
  const redSoft = trans     // t ≥ redSoft → 全红(0)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x - ccx) * dx + (y - ccy) * dy
      // 先按 range 钳到 [-range, range]，再判过渡区
      let wgt: number
      if (t <= greenSoft) {
        wgt = 1
      } else if (t >= redSoft) {
        wgt = 0
      } else {
        wgt = 1 - smoothstep(greenSoft, redSoft, t)
      }
      out[y * w + x] = wgt
    }
  }
}

// 径向蒙版：椭圆方程 e = (x'/rx)² + (y'/ry)²。e<1 圈内。
// 圈内权重 1，e 从 1 到 (1+feather) 衰减到 0。invert 取反。
function buildRadialMask(r: RadialGeom, w: number, h: number, out: Float32Array) {
  const rad = (r.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ccx = r.cx * w
  const ccy = r.cy * h
  const rx = Math.max(1e-4, r.rx) * w
  const ry = Math.max(1e-4, r.ry) * h
  const feather = Math.max(0, Math.min(1, r.feather))
  // 羽化：e 从 1 到 1+feather 之间衰减
  const edge1 = 1 + feather

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 平移到椭圆中心
      const px = x - ccx
      const py = y - ccy
      // 旋转到椭圆局部坐标（反向旋转）
      const lx = px * cos + py * sin
      const ly = -px * sin + py * cos
      const e = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry)
      let wgt: number
      if (e <= 1) {
        wgt = 1
      } else if (e >= edge1) {
        wgt = 0
      } else {
        wgt = 1 - smoothstep(1, edge1, e)
      }
      if (r.invert) wgt = 1 - wgt
      out[y * w + x] = wgt
    }
  }
}

// 笔刷蒙版：沿每条笔触的点连线，盖软边圆。
// 绘制笔触（erase=false）：对该像素取所有圆的最大权重 → 1，叠加越多越满。
// 擦除笔触（erase=true）：用 (1-圆权重) 乘进去，把经过区域压低。
// 两类笔触顺序应用：先叠加所有绘制笔触，再用擦除笔触减。
function buildBrushMask(b: BrushGeom, w: number, h: number, out: Float32Array) {
  applyBrushStrokes(b.strokes, w, h, out)
}

function applyBrushStrokes(strokes: BrushStroke[], w: number, h: number, out: Float32Array) {
  const maxSide = Math.max(w, h)
  for (const stroke of strokes) {
    const r = Math.max(1e-4, stroke.size) * maxSide
    const feather = Math.max(0, Math.min(1, stroke.feather))
    // 软边：圆心权重 1，到 r(1+0) 过渡。feather 控制过渡区宽度。
    // 实心半径 = r * (1 - feather)，过渡到 r。feather=0 硬边，feather=1 全程软。
    const inner = r * (1 - feather)
    paintStroke(stroke, w, h, r, inner, stroke.erase, out)
  }
}

function buildRasterMask(raster: RasterGeom, w: number, h: number, out: Float32Array) {
  const raw = isValidRasterGeom(raster)
    ? decodeRasterMaskData(raster.data, raster.width * raster.height)
    : null
  if (!raw) return

  // 候选以最多 512px 的边长存储；插值到预览或全分辨率导出，归一化坐标保持一致。
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) * raster.height) / h - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(raster.height - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) * raster.width) / w - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(raster.width - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))
      const a = raw[y0 * raster.width + x0] / 255
      const b = raw[y0 * raster.width + x1] / 255
      const c = raw[y1 * raster.width + x0] / 255
      const d = raw[y1 * raster.width + x1] / 255
      out[y * w + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    }
  }
  applyBrushStrokes(raster.strokes, w, h, out)
}

// 把一条笔触画到权重图上。points 连成线段，沿段插值盖圆。
// erase=false 时取 max（绘制，越涂越满）；erase=true 时取 min 与 (1-w) 做减法。
function paintStroke(
  stroke: BrushStroke,
  w: number,
  h: number,
  r: number,
  inner: number,
  erase: boolean,
  out: Float32Array,
) {
  const pts = stroke.points
  if (pts.length === 0) return

  // 把归一化点转成像素坐标的序列
  const px = pts.map((p) => p.x * w)
  const py = pts.map((p) => p.y * h)

  // 单个软边圆在该像素的权重（0~1）
  const diskWeight = (dx: number, dy: number): number => {
    const d2 = dx * dx + dy * dy
    if (d2 >= r * r) return 0
    if (inner <= 0 || d2 <= inner * inner) return 1
    // inner ~ r 之间 smoothstep 过渡
    const d = Math.sqrt(d2)
    return 1 - smoothstep(inner, r, d)
  }

  // 遍历每个像素，判断是否落在该笔触任意一段的圆范围内（用包围盒裁剪加速）
  for (let i = 0; i < pts.length; i++) {
    const cx = px[i]
    const cy = py[i]
    // 这段：从 i 到 i+1（最后一点只有它自己）
    const nx = i < pts.length - 1 ? px[i + 1] : cx
    const ny = i < pts.length - 1 ? py[i + 1] : cy
    // 包围盒：线段两端各扩 r
    const minX = Math.max(0, Math.floor(Math.min(cx, nx) - r))
    const maxX = Math.min(w - 1, Math.ceil(Math.max(cx, nx) + r))
    const minY = Math.max(0, Math.floor(Math.min(cy, ny) - r))
    const maxY = Math.min(h - 1, Math.ceil(Math.max(cy, ny) + r))

    // 线段方向与长度（用于点到线段距离）
    const segDx = nx - cx
    const segDy = ny - cy
    const segLen2 = segDx * segDx + segDy * segDy

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // 点到线段的最近距离
        let t = segLen2 > 0 ? ((x - cx) * segDx + (y - cy) * segDy) / segLen2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const closestX = cx + segDx * t
        const closestY = cy + segDy * t
        const dx = x - closestX
        const dy = y - closestY
        const wgt = diskWeight(dx, dy)
        if (wgt <= 0) continue
        const idx = y * w + x
        if (erase) {
          // 擦除：把权重压低，按 (1-wgt) 乘
          out[idx] = out[idx] * (1 - wgt)
        } else {
          // 绘制：取 max，叠加越多越满
          if (wgt > out[idx]) out[idx] = wgt
        }
      }
    }
  }
}
// 曝光/对比度/白平衡这些全局变换可以先算成 256 项 LUT，
// 再逐像素查表，比每像素算三角函数快得多。
interface GlobalLut {
  r: Float32Array // 0~255 -> 输出（先做曝光/对比度/白平衡，未钳制）
  g: Float32Array
  b: Float32Array
}

function buildGlobalLut(p: AdjustParams): GlobalLut {
  const r = new Float32Array(256)
  const g = new Float32Array(256)
  const b = new Float32Array(256)

  // 曝光：每 100 单位约 1 EV，用 2^(ev) 倍率
  const expGain = Math.pow(2, (p.exposure / 100) * 1.0)

  // 对比度：围绕 128 的非线性拉伸
  // v' = 128 + (v - 128) * (1 + c/100 * k)，再用 tanh 软钳制端点
  const cAmount = p.contrast / 100 // -1~1
  const contrastCurve = (v: number) => {
    const centered = (v - 128) / 128 // -1~1
    // 对比度用 S 形：tanh 放大斜率
    const shaped = Math.tanh(centered * (1 + cAmount * 1.5))
    return 128 + shaped * 128
  }

  // 白平衡：色温调整 R/B 通道，色调调整 G 通道
  // 色温 +100（暖）：R 升 B 降；色温 -100（冷）：R 降 B 升
  const tempAmt = p.temperature / 100 // -1~1
  const tintAmt = p.tint / 100
  const rTemp = 1 + tempAmt * 0.2
  const bTemp = 1 - tempAmt * 0.2
  const gTint = 1 - tintAmt * 0.2 // 色调正向=品红，所以压绿
  const rTint = 1 + tintAmt * 0.1
  const bTint = 1 + tintAmt * 0.1

  for (let i = 0; i < 256; i++) {
    let rv = i
    let gv = i
    let bv = i
    // 白平衡（在曝光前做，避免亮度放大色温偏移感）
    rv *= rTemp * rTint
    gv *= gTint
    bv *= bTemp * bTint
    // 曝光
    rv *= expGain
    gv *= expGain
    bv *= expGain
    // 对比度
    rv = contrastCurve(rv)
    gv = contrastCurve(gv)
    bv = contrastCurve(bv)
    r[i] = rv
    g[i] = gv
    b[i] = bv
  }
  return { r, g, b }
}

// 单像素调整：给定输入 RGB + 参数 + 预计算 LUT/影调系数，返回输出 RGB（未钳制）。
// 抽出来供 applyAdjustments（全局）与 applyWithMasks（局部）共用，保证效果一致。
interface PixelCtx {
  lut: GlobalLut
  hl: number
  sh: number
  wh: number
  bk: number
  satAmt: number
  vibAmt: number
}

function buildPixelCtx(p: AdjustParams): PixelCtx {
  return {
    lut: buildGlobalLut(p),
    hl: p.highlights / 100,
    sh: p.shadows / 100,
    wh: p.whites / 100,
    bk: p.blacks / 100,
    satAmt: p.saturation / 100,
    vibAmt: p.vibrance / 100,
  }
}

function applyPixel(R: number, G: number, B: number, ctx: PixelCtx): [number, number, number] {
  R = ctx.lut.r[R]
  G = ctx.lut.g[G]
  B = ctx.lut.b[B]

  const lum = 0.299 * R + 0.587 * G + 0.114 * B

  const hlMask = smoothstep(140, 255, lum)
  R -= ctx.hl * hlMask * 80
  G -= ctx.hl * hlMask * 80
  B -= ctx.hl * hlMask * 80

  const shMask = 1 - smoothstep(40, 140, lum)
  R += ctx.sh * shMask * 80
  G += ctx.sh * shMask * 80
  B += ctx.sh * shMask * 80

  const whMask = smoothstep(200, 255, lum)
  R += ctx.wh * whMask * 60
  G += ctx.wh * whMask * 60
  B += ctx.wh * whMask * 60

  const bkMask = 1 - smoothstep(0, 55, lum)
  R += ctx.bk * bkMask * 60
  G += ctx.bk * bkMask * 60
  B += ctx.bk * bkMask * 60

  if (ctx.satAmt !== 0) {
    const avg = (R + G + B) / 3
    R = avg + (R - avg) * (1 + ctx.satAmt)
    G = avg + (G - avg) * (1 + ctx.satAmt)
    B = avg + (B - avg) * (1 + ctx.satAmt)
  }

  if (ctx.vibAmt !== 0) {
    const mx = Math.max(R, G, B)
    const mn = Math.min(R, G, B)
    const curSat = (mx - mn) / 255
    const factor = ctx.vibAmt * (1 - curSat)
    const avg = (R + G + B) / 3
    R = avg + (R - avg) * (1 + factor)
    G = avg + (G - avg) * (1 + factor)
    B = avg + (B - avg) * (1 + factor)
  }

  return [R, G, B]
}

// 逐像素调整的核心。直接改 ImageData.data（就地，RGBA）。
// 顺序：全局 LUT（曝光/对比度/白平衡）→ 影调（高光/阴影/白色/黑色）
//      → 色彩（饱和度/自然饱和度）→ HSL 分色（阶段 5.3）
// 锐化/降噪需要邻域，单独做卷积，放在最后。
export function applyAdjustments(img: ImageBuf, p: AdjustParams, hsl: HslParams = DEFAULT_HSL): ImageBuf {
  const out: ImageBuf = {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  }
  const data = out.data
  const ctx = buildPixelCtx(p)
  const hslActive = !isDefaultHsl(hsl)

  const len = data.length
  for (let i = 0; i < len; i += 4) {
    let [R, G, B] = applyPixel(data[i], data[i + 1], data[i + 2], ctx)
    if (hslActive) {
      ;[R, G, B] = applyHslPixel(R, G, B, hsl)
    }
    data[i] = clamp8(R)
    data[i + 1] = clamp8(G)
    data[i + 2] = clamp8(B)
    // alpha 不动
  }

  // 细节：锐化（卷积），降噪（模糊）在 sharpness/noiseReduction > 0 时做
  if (p.sharpness > 0) {
    sharpen(out, p.sharpness / 100)
  }
  if (p.noiseReduction > 0) {
    denoise(out, p.noiseReduction / 100)
  }

  return out
}

// 全局 + 局部滤镜一起应用。
// 1. 先算全局结果 base（原图套 globalParams）。
// 2. 对每个 enabled 的 mask：原图套该 mask 的 adjust 得到局部结果，
//    按蒙版权重在 base 和局部结果之间线性混合，写回 base。
// 3. 锐化/降噪用全局参数（局部不重复卷积，避免多次邻域运算累积伪影）。
export function applyWithMasks(
  img: ImageBuf,
  globalParams: AdjustParams,
  masks: LocalMask[],
  hsl: HslParams = DEFAULT_HSL,
): ImageBuf {
  // base = 全局调整后的图（含 HSL 分色）
  const base = applyAdjustments(img, globalParams, hsl)
  const enabled = masks.filter((m) => m.enabled && !isDefaultParams(m.adjust))
  if (enabled.length === 0) return base

  const data = base.data
  const w = base.width
  const h = base.height

  for (const mask of enabled) {
    const weight = buildMask(mask.geom, w, h)
    const ctx = buildPixelCtx(mask.adjust)
    // 局部结果与原 base 按权重混合：weight=1 完全用局部结果，weight=0 保留 base
    const len = data.length
    for (let i = 0, p = 0; i < len; i += 4, p++) {
      const wgt = weight[p]
      if (wgt <= 0) continue
      // 原始像素（未调）套局部参数
      const [rL, gL, bL] = applyPixel(img.data[i], img.data[i + 1], img.data[i + 2], ctx)
      if (wgt >= 1) {
        data[i] = clamp8(rL)
        data[i + 1] = clamp8(gL)
        data[i + 2] = clamp8(bL)
      } else {
        data[i] = clamp8(data[i] * (1 - wgt) + rL * wgt)
        data[i + 1] = clamp8(data[i + 1] * (1 - wgt) + gL * wgt)
        data[i + 2] = clamp8(data[i + 2] * (1 - wgt) + bL * wgt)
      }
    }
  }

  return base
}

// 阶段 5.6：完整照片处理 = 几何变换（最前）→ 影调/色彩/HSL/蒙版。
// 几何在最前，直方图与蒙版坐标都基于变换后画面。
// 不改 applyWithMasks / applyAdjustments 签名，靠这里拼接，保持 5.2a/5.3/5.5 测试不动。
export function processPhoto(img: ImageBuf, pa: PhotoAdjust): ImageBuf {
  const transformed =
    pa.geometry.enabled && !isDefaultGeometry(pa.geometry)
      ? transformGeometry(img, pa.geometry)
      : img
  return applyWithMasks(transformed, pa.global, pa.masks, pa.hsl)
}
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  let t = (x - edge0) / (edge1 - edge0)
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

// ---- RGB ↔ HSL 转换 ----
// h 单位度（0~360），s 和 l 为 0~1

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255
  const gf = g / 255
  const bf = b / 255
  const mx = Math.max(rf, gf, bf)
  const mn = Math.min(rf, gf, bf)
  const l = (mx + mn) / 2
  let h = 0
  let s = 0
  const d = mx - mn
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60
    else if (mx === gf) h = ((bf - rf) / d + 2) * 60
    else h = ((rf - gf) / d + 4) * 60
  }
  return [h, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = (((h % 360) + 360) % 360) / 360
  return [
    hue2rgb(p, q, hk + 1 / 3) * 255,
    hue2rgb(p, q, hk) * 255,
    hue2rgb(p, q, hk - 1 / 3) * 255,
  ]
}

// 8 段边界平滑权重：给定色相 h(0~360)，返回每段权重（归一化和为 1）。
// 三角衰减：环形距离 d<60 度才非零，d=0 时权重 1。
// 60 度半宽是 8 段均分视角的折中，简单稳定，可替换为按相邻中心真实距离的可变半宽。
function hslWeights(h: number): Float32Array {
  h = ((h % 360) + 360) % 360
  const weights = new Float32Array(8)
  let sum = 0
  for (let i = 0; i < 8; i++) {
    const center = HSL_CENTERS[HSL_COLOR_IDS[i]]
    let d = Math.abs(h - center)
    if (d > 180) d = 360 - d // 环形距离
    const w = d >= 60 ? 0 : 1 - d / 60
    weights[i] = w
    sum += w
  }
  if (sum > 0) {
    for (let i = 0; i < 8; i++) weights[i] /= sum
  }
  return weights
}

// HSL 单像素处理。灰像素（s<1e-3）直接返回，hue 无意义且 luminance 也不动灰像素。
function applyHslPixel(
  R: number, G: number, B: number,
  hsl: HslParams,
): [number, number, number] {
  const [h, s, l] = rgbToHsl(R, G, B)
  if (s < 1e-3) return [R, G, B] // 灰像素：色相无意义，亮度归影调滑块管
  const w = hslWeights(h)
  // 用未归一化的原始权重：段中心权重=1，相邻段有过渡贡献。
  // 色相按权重和做加权平均（归一化），饱和度/明度用加性偏移（不归一化，
  // 这样段中心 sat=-100 能完全去饱和，重叠区会累加是预期行为）。
  let hueShift = 0       // 度
  let satShift = 0       // 0~1 量级
  let lumShift = 0       // 0~1 量级
  let weightSum = 0
  for (let i = 0; i < 8; i++) {
    const wi = w[i]
    if (wi === 0) continue
    const c = hsl[HSL_COLOR_IDS[i]]
    hueShift += wi * (c.hue / 100) * 60
    satShift += wi * (c.saturation / 100)
    lumShift += wi * (c.luminance / 100) * 0.5
    weightSum += wi
  }
  // 色相按权重和归一化（加权平均），饱和度/明度用累加偏移
  const newH = weightSum > 0
    ? (h + hueShift / weightSum + 360) % 360
    : h
  const newS = Math.max(0, Math.min(1, s + satShift))
  const newL = Math.max(0, Math.min(1, l + lumShift))
  return hslToRgb(newH, newS, newL)
}

// 锐化：unsharp mask。amount 0~1
function sharpen(img: ImageBuf, amount: number) {
  const w = img.width
  const h = img.height
  const src = img.data
  // 复制一份原始数据用于卷积
  const copy = new Uint8ClampedArray(src)
  const strength = amount * 1.5 // 锐化强度系数

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const i = idx + c
        // 3x3 均值
        const sum =
          copy[i - 4 - w * 4] + copy[i - w * 4] + copy[i + 4 - w * 4] +
          copy[i - 4] + copy[i] + copy[i + 4] +
          copy[i - 4 + w * 4] + copy[i + w * 4] + copy[i + 4 + w * 4]
        const blurred = sum / 9
        // unsharp = original + strength * (original - blurred)
        src[i] = clamp8(copy[i] + strength * (copy[i] - blurred))
      }
    }
  }
}

// 降噪：简单 box blur，amount 0~1
function denoise(img: ImageBuf, amount: number) {
  const w = img.width
  const h = img.height
  const src = img.data
  const copy = new Uint8ClampedArray(src)
  const mix = amount * 0.6 // 混合比例，避免完全糊掉

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const i = idx + c
        const sum =
          copy[i - 4 - w * 4] + copy[i - w * 4] + copy[i + 4 - w * 4] +
          copy[i - 4] + copy[i] + copy[i + 4] +
          copy[i - 4 + w * 4] + copy[i + w * 4] + copy[i + 4 + w * 4]
        const blurred = sum / 9
        src[i] = clamp8(copy[i] * (1 - mix) + blurred * mix)
      }
    }
  }
}

// ---- 直方图计算 ----
// 返回 R/G/B 三个通道各 256 桶的计数。给直方图组件用。
export interface Histogram {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
}

export function computeHistogram(img: ImageBuf): Histogram {
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const data = img.data
  const len = data.length
  for (let i = 0; i < len; i += 4) {
    r[data[i]]++
    g[data[i + 1]]++
    b[data[i + 2]]++
  }
  return { r, g, b }
}
