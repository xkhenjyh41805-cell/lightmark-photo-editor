import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useDataUrl } from '../store/useDataUrl'
import type { Photo } from '../types'
import {
  processPhoto,
  transformGeometry,
  applyAdjustments,
  type AdjustParams,
  type ImageBuf,
  type LocalMask,
  type PhotoAdjust,
  type Geometry,
  type CropRect,
  type BrushStroke,
  DEFAULT_PARAMS,
  buildMask,
} from '../../image'

interface PreviewAreaProps {
  photo: Photo | null
  params: AdjustParams
  // 完整调整（global + masks + geometry）。预览渲染走 processPhoto。
  adjust: PhotoAdjust
  // 处理后的 ImageBuf，提升给直方图组件用（实时）
  onProcessed?: (buf: ImageBuf | null) => void
  showOriginal: boolean
  onShowOriginalChange: (show: boolean) => void

  // 阶段 5.2：局部调整编辑模式
  localMode: boolean
  masks: LocalMask[]
  selectedMaskId: string | null
  onUpdateMaskGeom: (maskId: string, patch: Record<string, number | boolean>) => void
  onSelectMask: (id: string) => void
  // 阶段 5.2b：笔刷绘制
  // 当前选中滤镜是笔刷时，画布进入绘制态。每完成一条笔触（pointerup）回调一次。
  brushErase: boolean  // true=擦除模式，false=绘制
  onBrushStroke: (maskId: string, stroke: BrushStroke) => void

  // 阶段 5.6：裁剪旋转编辑模式
  cropMode: boolean
  geometry: Geometry
  onUpdateGeometry: (patch: Partial<Geometry>) => void
  onExitCrop: () => void
}

const PROXY_MAX = 1200
const MIN_ZOOM = 1
const MAX_ZOOM = 4

function clampPreviewPan(viewport: HTMLElement | null, canvas: HTMLCanvasElement | null, pan: { x: number; y: number }, zoom: number) {
  if (!viewport || !canvas) return pan
  const style = window.getComputedStyle(viewport)
  const width = viewport.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
  const height = viewport.clientHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0)
  const maxX = Math.max(0, (canvas.offsetWidth * zoom - width) / 2)
  const maxY = Math.max(0, (canvas.offsetHeight * zoom - height) / 2)
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  }
}

export function PreviewArea(props: PreviewAreaProps) {
  const { photo, adjust, onProcessed, showOriginal, onShowOriginalChange } = props
  const { localMode, masks, selectedMaskId, onUpdateMaskGeom } = props
  const { brushErase, onBrushStroke } = props
  const { cropMode, geometry, onUpdateGeometry, onExitCrop } = props
  const url = useDataUrl(photo?.originalPath ?? null)
  const viewportRef = useRef<HTMLElement>(null)
  const imageStageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const proxyRef = useRef<ImageData | null>(null)
  const rafRef = useRef<number | null>(null)
  const [showMask, setShowMask] = useState(false)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const spacePanHeldRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('empty')
  // 当前渲染输出的实际像素尺寸（变换后），供 renderMaskOverlay 同步 mask canvas backing store
  const outSizeRef = useRef<{ w: number; h: number } | null>(null)
  // 蒙版预览 overlay canvas
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  // 当前渲染到 canvas 的尺寸，控制点 overlay 用它换算归一化坐标
  const [dispSize, setDispSize] = useState<{ w: number; h: number } | null>(null)
  // overlay 包装盒：跟踪主 canvas 的实际布局盒（px），保证 overlay 的 100% 精确对齐可见图像
  const [overlayBox, setOverlayBox] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    setZoom(MIN_ZOOM)
    setPan({ x: 0, y: 0 })
    setIsPanning(false)
    panDragRef.current = null
  }, [photo?.id])

  useEffect(() => {
    let cancelled = false
    proxyRef.current = null
    onProcessed?.(null)
    if (!url) {
      setStatus('empty')
      return
    }
    setStatus('loading')
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const scale = Math.min(1, PROXY_MAX / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, w, h)
      proxyRef.current = ctx.getImageData(0, 0, w, h)
      setStatus('ready')
    }
    img.onerror = () => { if (!cancelled) setStatus('empty') }
    img.src = url
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, photo?.id])

  const render = useCallback(() => {
    const proxy = proxyRef.current
    const canvas = canvasRef.current
    if (!proxy || !canvas) return

    const ctx = canvas.getContext('2d')!
    const buf: ImageBuf = { width: proxy.width, height: proxy.height, data: proxy.data }

    let out: ImageBuf
    if (showOriginal) {
      // 看原图也走几何变换（方向要对），但不套调整。
      out = adjust.geometry.enabled
        ? transformGeometry(buf, adjust.geometry)
        : applyAdjustments(buf, DEFAULT_PARAMS)
    } else {
      out = processPhoto(buf, adjust)
    }

    // canvas backing store 与 dispSize 必须跟随变换后输出尺寸（90° 旋转交换宽高、
    // 微调旋转扩大包围盒都会改变 out 尺寸），否则 putImageData 不缩放会截断/留透明，
    // 且 CropOverlay 的 viewBox(0 0 dispW dispH) 与可见画面错位。
    canvas.width = out.width
    canvas.height = out.height
    setDispSize({ w: out.width, h: out.height })
    outSizeRef.current = { w: out.width, h: out.height }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0)

    // Holding original comparison must not label unadjusted pixels as the current edit.
    onProcessed?.(showOriginal ? null : out)

    // 蒙版预览 overlay
    renderMaskOverlay()
    // 同步 overlay 包装盒尺寸到主 canvas 的实际布局盒，保证 overlay 100% 对齐可见图像
    const cv = canvasRef.current
    if (cv) {
      const rect = { width: cv.offsetWidth, height: cv.offsetHeight }
      setOverlayBox((cur) =>
        cur && Math.abs(cur.w - rect.width) < 0.5 && Math.abs(cur.h - rect.height) < 0.5
          ? cur
          : { w: rect.width, h: rect.height },
      )
    }
  }, [adjust, showOriginal, onProcessed])

  const renderMaskOverlay = useCallback(() => {
    const mc = maskCanvasRef.current
    const proxy = proxyRef.current
    if (!mc || !proxy) return
    // mask canvas backing store 跟随变换后输出尺寸（与主 canvas 一致），避免错位
    const ow = outSizeRef.current?.w ?? proxy.width
    const oh = outSizeRef.current?.h ?? proxy.height
    mc.width = ow
    mc.height = oh
    const mctx = mc.getContext('2d')!
    mctx.clearRect(0, 0, mc.width, mc.height)
    if (!showMask || localMode === false) return
    // 把选中滤镜的蒙版画成红色半透明叠加
    const sel = masks.find((m) => m.id === selectedMaskId)
    if (!sel) return
    const weight = buildMask(sel.geom, ow, oh)
    const imgData = mctx.createImageData(ow, oh)
    for (let i = 0, p = 0; i < imgData.data.length; i += 4, p++) {
      const wgt = weight[p]
      if (wgt > 0) {
        imgData.data[i] = 255     // R
        imgData.data[i + 1] = 0   // G
        imgData.data[i + 2] = 0   // B
        imgData.data[i + 3] = Math.round(wgt * 140)
      }
    }
    mctx.putImageData(imgData, 0, 0)
  }, [showMask, localMode, masks, selectedMaskId])

  useEffect(() => {
    if (status !== 'ready') return
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      render()
    })
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [render, status])

  // 用 ResizeObserver 跟踪主 canvas 布局盒，保证 overlay 包装盒随窗口/图片尺寸自适应
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const apply = () => {
      const r = { width: cv.offsetWidth, height: cv.offsetHeight }
      setOverlayBox((cur) =>
        cur && Math.abs(cur.w - r.width) < 0.5 && Math.abs(cur.h - r.height) < 0.5
          ? cur
          : { w: r.width, h: r.height },
      )
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [status])

  // mask overlay 单独跟随选中/显示状态重画
  useEffect(() => {
    renderMaskOverlay()
  }, [renderMaskOverlay])

  // 按住 Alt 显示蒙版
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target
      const isTypingTarget = target instanceof HTMLElement && (
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
      )
      if (e.code === 'Space' && !isTypingTarget) {
        spacePanHeldRef.current = true
        e.preventDefault()
      }
      if (e.key === 'Alt' && !e.repeat) setShowMask(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spacePanHeldRef.current = false
      if (e.key === 'Alt') setShowMask(false)
    }
    const clearKeys = () => { spacePanHeldRef.current = false; setShowMask(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clearKeys)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clearKeys)
    }
  }, [])

  const showO = () => onShowOriginalChange(true)
  const hideO = () => onShowOriginalChange(false)
  const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!photo || status !== 'ready') return
    if (!(event.target instanceof Node) || !imageStageRef.current?.contains(event.target)) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
    if (Math.abs(nextZoom - zoom) < 0.001) return
    setZoom(nextZoom)
    setPan((current) => nextZoom <= MIN_ZOOM
      ? { x: 0, y: 0 }
      : clampPreviewPan(viewportRef.current, canvasRef.current, current, nextZoom))
  }
  const handlePanStart = (event: ReactPointerEvent<HTMLElement>) => {
    const spacePan = spacePanHeldRef.current
    if (zoom <= MIN_ZOOM || event.button !== 0 || ((localMode || cropMode) && !spacePan)) return
    if (!(event.target instanceof Node) || !imageStageRef.current?.contains(event.target)) return
    if (!spacePan && !canvasRef.current?.contains(event.target)) return
    if (event.target instanceof Element && event.target.closest('button, input, select, textarea')) return
    event.preventDefault()
    event.stopPropagation()
    panDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
  }
  const handlePanMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = panDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPan(clampPreviewPan(viewportRef.current, canvasRef.current, {
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }, zoom))
  }
  const handlePanEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = panDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    panDragRef.current = null
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const selected = masks.find((m) => m.id === selectedMaskId) ?? null
  const isBrush = selected?.geom.type === 'brush' || selected?.geom.type === 'raster'
  return (
    <main
      ref={viewportRef}
      onWheel={handleWheel}
      onPointerDownCapture={handlePanStart}
      onPointerMove={handlePanMove}
      onPointerUp={handlePanEnd}
      onPointerCancel={handlePanEnd}
      onLostPointerCapture={handlePanEnd}
      aria-label="修图预览；滚动鼠标滚轮缩放，放大后拖动查看"
      title="滚动鼠标滚轮缩放；放大后可拖动查看。局部蒙版或裁剪模式下，按住空格并拖动可平移。"
      className={`lm-preview-viewport relative flex flex-1 items-center justify-center overflow-hidden bg-zinc-900 p-6${zoom > MIN_ZOOM && !localMode && !cropMode ? isPanning ? ' is-panning' : ' is-zoomed' : ''}`}
    >
      {!photo ? (
        <EmptyState />
      ) : status === 'loading' ? (
        <p className="text-sm text-zinc-500">加载中…</p>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center">
          <div ref={imageStageRef} className="relative flex min-h-0 min-w-0 max-w-full flex-1 items-center justify-center" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`, transformOrigin: 'center center', transition: isPanning ? 'none' : 'transform 90ms ease-out' }}>
            {/*
              canvas 作为 well 的直接 flex 子项：well 在两轴都是定尺寸（flex-1 在定高列里，
              main 给了定高/定宽），canvas 的 max-w/h-full 相对真实 px 解析，浏览器按替换
              元素的内在宽高比缩放到 (wellW, wellH) 内，不裁切不变形、居中。
              不用 object-fit：canvas 元素盒 == 显示位图盒。
            */}
            <canvas
              ref={canvasRef}
              onMouseDown={(event) => { if (zoom <= MIN_ZOOM && event.button === 0) showO() }}
              onMouseUp={(event) => { if (zoom <= MIN_ZOOM && event.button === 0) hideO() }}
              onMouseLeave={() => { if (zoom <= MIN_ZOOM) hideO() }}
              aria-label={`${photo.name} 预览，按住查看原图`}
              className="relative max-h-full max-w-full shadow-2xl"
              style={{ lineHeight: 0 }}
            />
            {/*
              overlay 包装盒：宽高用 ResizeObserver 跟踪主 canvas 的实际布局盒（px），
              居中覆盖在 canvas 上。这样 mask canvas / SVG 控制点 / 笔刷层的 100% 始终
              精确等于可见图像盒，不受 well 留白影响，竖图横图都对齐。
            */}
            {overlayBox && (
              <div
                className="pointer-events-none absolute"
                style={{
                  width: overlayBox.w,
                  height: overlayBox.h,
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                }}
              >
                {/* 蒙版预览 overlay：和主 canvas 同尺寸叠加 */}
                <canvas
                  ref={maskCanvasRef}
                  className="pointer-events-none absolute left-0 top-0"
                  style={{ width: '100%', height: '100%' }}
                  aria-hidden="true"
                />
                {/* 局部调整控制点 overlay（渐变/径向）。笔刷滤镜不显示控制点，改为绘制层。 */}
                {localMode && dispSize && selected && !isBrush && (
                  <MaskHandles
                    mask={selected}
                    dispW={dispSize.w}
                    dispH={dispSize.h}
                    onUpdate={(patch) => onUpdateMaskGeom(selected.id, patch)}
                  />
                )}
                {/* 笔刷绘制层：选中笔刷滤镜且在局部模式时启用 */}
                {localMode && dispSize && isBrush && selected && (
                  <BrushCanvas
                    mask={selected}
                    dispW={dispSize.w}
                    dispH={dispSize.h}
                    erase={brushErase}
                    onStroke={(stroke) => onBrushStroke(selected.id, stroke)}
                  />
                )}
                {/* 裁剪旋转 overlay：裁剪模式时覆盖在变换后画面上（只画框/手柄，工具条在顶部独立栏） */}
                {cropMode && dispSize && (
                  <CropOverlay
                    dispW={dispSize.w}
                    dispH={dispSize.h}
                    geometry={geometry}
                    onUpdate={onUpdateGeometry}
                  />
                )}
              </div>
            )}
            {showOriginal && (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-zinc-200">
                原图
              </span>
            )}
            {localMode && showMask && selected && (
              <span className="pointer-events-none absolute right-2 top-2 rounded bg-red-900/70 px-2 py-0.5 text-[11px] text-red-100">
                蒙版预览
              </span>
            )}
            {localMode && (
              <span className="lm-canvas-hint pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2">
                {isBrush ? '按住 Alt 查看蒙版' : '拖动控制点调整范围'}
              </span>
            )}
          </div>
          {cropMode && dispSize && (
            <div className="lm-canvas-tools flex shrink-0 items-center gap-4">
              <CropToolbar
                dispW={dispSize.w}
                dispH={dispSize.h}
                geometry={geometry}
                onUpdate={onUpdateGeometry}
                onExit={onExitCrop}
              />
            </div>
          )}
        </div>
      )}
    </main>
  )
}

// ---- 笔刷绘制层 ----
// 覆盖在 canvas 上的透明绘制层，pointer 事件画笔触。
// 实时显示当前涂抹的红色蒙版（draw 时叠加），pointerup 时把这条笔触交给上层存储。
interface BrushCanvasProps {
  mask: LocalMask
  dispW: number
  dispH: number
  erase: boolean
  onStroke: (stroke: BrushStroke) => void
}

function BrushCanvas({ mask, dispW, dispH, erase, onStroke }: BrushCanvasProps) {
  const drawRef = useRef<HTMLCanvasElement>(null)
  // 当前正在画的这条笔触的归一化点（相对 dispW/dispH）
  const curPtsRef = useRef<{ x: number; y: number }[]>([])
  const drawingRef = useRef(false)

  const g = mask.geom as Extract<LocalMask['geom'], { type: 'brush' | 'raster' }>
  const size = g.size
  const feather = g.feather

  // 重画整层：已有的笔触（红蒙版）+ 当前正在画的这一笔
  const repaint = useCallback(() => {
    const cv = drawRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    const maxSide = Math.max(cv.width, cv.height)
    const r = Math.max(1, size * maxSide)
    const inner = r * (1 - Math.max(0, Math.min(1, feather)))

    // 画一条笔触：沿线段盖软边圆，红色 alpha
    const paintStrokeLocal = (
      pts: { x: number; y: number }[],
      strokeErase: boolean,
    ) => {
      if (pts.length === 0) return
      ctx.save()
      ctx.globalCompositeOperation = strokeErase ? 'destination-out' : 'source-over'
      for (let i = 0; i < pts.length; i++) {
        const cx = pts[i].x * cv.width
        const cy = pts[i].y * cv.height
        const nx = i < pts.length - 1 ? pts[i + 1].x * cv.width : cx
        const ny = i < pts.length - 1 ? pts[i + 1].y * cv.height : cy
        // 沿线段密集采样盖圆，保证连续
        const segLen = Math.hypot(nx - cx, ny - cy)
        const steps = Math.max(1, Math.ceil(segLen / Math.max(1, r * 0.25)))
        for (let s = 0; s <= steps; s++) {
          const t = s / steps
          const px = cx + (nx - cx) * t
          const py = cy + (ny - cy) * t
          const grd = ctx.createRadialGradient(px, py, inner, px, py, r)
          if (strokeErase) {
            // destination-out 模式下 alpha 决定擦除强度
            grd.addColorStop(0, 'rgba(255,0,0,1)')
            grd.addColorStop(1, 'rgba(255,0,0,0)')
          } else {
            grd.addColorStop(0, 'rgba(255,0,0,0.55)')
            grd.addColorStop(1, 'rgba(255,0,0,0)')
          }
          ctx.fillStyle = grd
          ctx.beginPath()
          ctx.arc(px, py, r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.restore()
    }

    // 先画已有笔触（draw 在底，erase 在上）
    for (const st of g.strokes) {
      paintStrokeLocal(st.points, st.erase)
    }
    // 再画当前正在画的这一笔（实时）
    if (curPtsRef.current.length > 0) {
      paintStrokeLocal(curPtsRef.current, erase)
    }
  }, [g.strokes, size, feather, erase])

  // 笔触数据变化（已存储的）或画布尺寸变化时重画
  useEffect(() => {
    const cv = drawRef.current
    if (!cv) return
    cv.width = dispW
    cv.height = dispH
    repaint()
  }, [dispW, dispH, repaint])

  // 把屏幕坐标转成 canvas 内部像素坐标（canvas 用 CSS 拉伸显示，内部分辨率是 dispW×dispH）
  const toCanvas = (e: React.PointerEvent): { x: number; y: number } => {
    const cv = drawRef.current!
    const rect = cv.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * cv.width
    const y = ((e.clientY - rect.top) / rect.height) * cv.height
    return { x, y }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drawingRef.current = true
    const p = toCanvas(e)
    curPtsRef.current = [{ x: p.x / dispW, y: p.y / dispH }]
    repaint()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return
    const p = toCanvas(e)
    const nx = p.x / dispW
    const ny = p.y / dispH
    const last = curPtsRef.current[curPtsRef.current.length - 1]
    // 距离过近不采样，避免点太密
    if (last) {
      const dx = (nx - last.x) * dispW
      const dy = (ny - last.y) * dispH
      if (dx * dx + dy * dy < 2) return
    }
    curPtsRef.current.push({ x: nx, y: ny })
    repaint()
  }

  const finishStroke = (e: React.PointerEvent) => {
    if (!drawingRef.current) return
    drawingRef.current = false
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    const pts = curPtsRef.current
    curPtsRef.current = []
    if (pts.length === 0) return
    onStroke({
      points: pts,
      size,
      feather,
      erase,
    })
  }

  return (
    <canvas
      ref={drawRef}
      className="pointer-events-auto absolute left-0 top-0 max-h-full max-w-full cursor-crosshair"
      style={{ width: '100%', height: '100%' }}
      aria-label="笔刷绘制区域，按住拖动涂抹"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
    />
  )
}

// ---- 蒙版控制点 overlay（SVG 绝对定位，覆盖在 canvas 上）----
// canvas 用 max-h/max-w object-contain 缩放显示，实际渲染像素是 dispW×dispH。
// overlay 容器宽高 100%，SVG viewBox 用 dispW×dispH，坐标和 canvas 像素 1:1。
interface MaskHandlesProps {
  mask: LocalMask
  dispW: number
  dispH: number
  onUpdate: (patch: Record<string, number | boolean>) => void
}

function MaskHandles({ mask, dispW, dispH, onUpdate }: MaskHandlesProps) {
  // 把归一化坐标转成显示坐标
  const px = (nx: number) => nx * dispW
  const py = (ny: number) => ny * dispH

  // 拖拽：mousedown 记起点，mousemove 算 delta 归一化，调对应参数
  const dragRef = useRef<{
    type: 'move' | 'rotate' | 'resize'
    startX: number
    startY: number
    startGeom: LocalMask['geom']
  } | null>(null)

  const onPointerDown = (
    e: React.PointerEvent,
    type: 'move' | 'rotate' | 'resize',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      type,
      startX: e.clientX,
      startY: e.clientY,
      startGeom: { ...mask.geom } as LocalMask['geom'],
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // 用容器实际显示尺寸换算 delta。容器宽=dispW（SVG viewBox 与 canvas 1:1，但 CSS 缩放）。
    // 取 overlay DOM 实际尺寸换算
    const overlay = (e.currentTarget as Element).closest('.lm-mask-overlay') as HTMLElement | null
    const rect = overlay?.getBoundingClientRect()
    const scaleX = rect ? dispW / rect.width : 1
    const scaleY = rect ? dispH / rect.height : 1
    const dx = (e.clientX - d.startX) * scaleX / dispW // 归一化
    const dy = (e.clientY - d.startY) * scaleY / dispH
    const g = d.startGeom

    if (d.type === 'move') {
      onUpdate({ cx: clamp01((g as any).cx + dx), cy: clamp01((g as any).cy + dy) })
    } else if (d.type === 'resize' && g.type === 'radial') {
      // 拖边缘点：沿当前指针方向改 rx/ry。简化：直接按 dx 调 rx、dy 调 ry。
      onUpdate({
        rx: clamp01(g.rx + dx * 2),
        ry: clamp01(g.ry + dy * 2),
      })
    } else if (d.type === 'rotate' && g.type === 'radial') {
      // 旋转手柄：算指针相对中心的角度
      const rect2 = overlay?.getBoundingClientRect()
      if (rect2) {
        const cxScreen = rect2.left + g.cx * rect2.width
        const cyScreen = rect2.top + g.cy * rect2.height
        const ang = (Math.atan2(e.clientY - cyScreen, e.clientX - cxScreen) * 180) / Math.PI
        onUpdate({ rotation: Math.round(ang) })
      }
    } else if (d.type === 'resize' && g.type === 'gradient') {
      // 渐变：拖端点改 range；拖旋转点改 angle
      onUpdate({ range: clamp01(g.range + (Math.abs(dx) + Math.abs(dy)) * 0.5) })
    } else if (d.type === 'rotate' && g.type === 'gradient') {
      const rect2 = overlay?.getBoundingClientRect()
      if (rect2) {
        const cxScreen = rect2.left + g.cx * rect2.width
        const cyScreen = rect2.top + g.cy * rect2.height
        const ang = (Math.atan2(e.clientY - cyScreen, e.clientX - cxScreen) * 180) / Math.PI
        // 渐变 angle：0=从上往下（方向向量 (0,1)），atan2 返回的是相对 x 轴。
        // 方向 (sin,cos)，对应 atan2(cos, sin)。这里近似用 -ang 转换。
        onUpdate({ angle: Math.round((ang + 90 + 360) % 360) })
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    dragRef.current = null
  }

  return (
    <svg
      className="lm-mask-overlay pointer-events-none absolute left-0 top-0"
      width="100%"
      height="100%"
      viewBox={`0 0 ${dispW} ${dispH}`}
      preserveAspectRatio="none"
    >
      {mask.geom.type === 'gradient' ? (
        <GradientHandles mask={mask} dispW={dispW} dispH={dispH} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} px={px} py={py} />
      ) : (
        <RadialHandles mask={mask} dispW={dispW} dispH={dispH} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} px={px} py={py} />
      )}
    </svg>
  )
}

interface HandleCommon {
  mask: LocalMask
  dispW: number
  dispH: number
  onPointerDown: (e: React.PointerEvent, type: 'move' | 'rotate' | 'resize') => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  px: (n: number) => number
  py: (n: number) => number
}

function GradientHandles({ mask, dispW, dispH, onPointerDown, onPointerMove, onPointerUp, px, py }: HandleCommon) {
  const g = mask.geom as Extract<LocalMask['geom'], { type: 'gradient' }>
  const rad = (g.angle * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = Math.cos(rad)
  // 垂直方向（沿绿/红线方向）
  const perpX = -dy
  const perpY = dx
  const cx = px(g.cx)
  const cy = py(g.cy)
  const maxSide = Math.max(dispW, dispH)
  const range = g.range * maxSide
  // 绿线中心点 = 中心 - 方向*range，红线中心点 = 中心 + 方向*range
  const greenCx = cx - dx * range
  const greenCy = cy - dy * range
  const redCx = cx + dx * range
  const redCy = cy + dy * range
  // 三条线的端点（沿垂直方向延伸到图边附近）
  const half = Math.max(dispW, dispH)
  const drawLine = (mx: number, my: number, color: string, key: string) => {
    const x1 = mx - perpX * half
    const y1 = my - perpY * half
    const x2 = mx + perpX * half
    const y2 = my + perpY * half
    return (
      <g key={key}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} strokeOpacity={0.9} />
        <circle
          cx={mx} cy={my} r={8}
          fill={color} fillOpacity={0.5} stroke={color} strokeWidth={2}
          className="lm-handle pointer-events-auto cursor-move"
          onPointerDown={(e) => onPointerDown(e, key === 'green' || key === 'red' ? 'resize' : 'move')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </g>
    )
  }
  return (
    <>
      {drawLine(greenCx, greenCy, '#4ade80', 'green')}
      {drawLine(cx, cy, '#e4e4e7', 'white')}
      {drawLine(redCx, redCy, '#f87171', 'red')}
      {/* 中心拖动整体移动 */}
      <circle
        cx={cx} cy={cy} r={10}
        fill="#fafafa" fillOpacity={0.3} stroke="#fafafa" strokeWidth={2}
        className="lm-handle pointer-events-auto cursor-move"
        onPointerDown={(e) => onPointerDown(e, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </>
  )
}

function RadialHandles({ mask, dispW, dispH, onPointerDown, onPointerMove, onPointerUp, px, py }: HandleCommon) {
  const g = mask.geom as Extract<LocalMask['geom'], { type: 'radial' }>
  const cx = px(g.cx)
  const cy = py(g.cy)
  const rx = g.rx * dispW
  const ry = g.ry * dispH
  const rad = (g.rotation * Math.PI) / 180
  // 椭圆框
  return (
    <>
      <ellipse
        cx={cx} cy={cy} rx={rx} ry={ry}
        fill="none" stroke="#fafafa" strokeWidth={2} strokeOpacity={0.9}
        transform={`rotate(${g.rotation} ${cx} ${cy})`}
      />
      {/* 中心移动点 */}
      <circle
        cx={cx} cy={cy} r={9}
        fill="#fafafa" fillOpacity={0.3} stroke="#fafafa" strokeWidth={2}
        className="lm-handle pointer-events-auto cursor-move"
        onPointerDown={(e) => onPointerDown(e, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {/* 右边缘 resize 点（在椭圆右端，考虑旋转） */}
      {(() => {
        const ex = cx + rx * Math.cos(rad)
        const ey = cy + rx * Math.sin(rad)
        return (
          <circle
            cx={ex} cy={ey} r={8}
            fill="#60a5fa" fillOpacity={0.5} stroke="#60a5fa" strokeWidth={2}
            className="lm-handle pointer-events-auto cursor-nesw-resize"
            onPointerDown={(e) => onPointerDown(e, 'resize')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )
      })()}
      {/* 旋转手柄（上方外延） */}
      {(() => {
        const tx = cx + (rx + 24) * Math.cos(rad - Math.PI / 2)
        const ty = cy + (rx + 24) * Math.sin(rad - Math.PI / 2)
        return (
          <circle
            cx={tx} cy={ty} r={7}
            fill="#fbbf24" fillOpacity={0.5} stroke="#fbbf24" strokeWidth={2}
            className="lm-handle pointer-events-auto cursor-grab"
            onPointerDown={(e) => onPointerDown(e, 'rotate')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )
      })()}
    </>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ---- 阶段 5.6：裁剪旋转 overlay ----
// SVG 覆盖在变换后画面上，viewBox = dispW×dispH 与 canvas 1:1。
// 裁剪框归一化（相对变换后画面），与导出一致。
// 框外区域半透明遮罩，8 个手柄拖 resize，框内拖 move。
// 工具条（旋转/翻转/比例/重置/完成）拆到顶部独立 CropToolbar，不压画面。
interface CropOverlayProps {
  dispW: number
  dispH: number
  geometry: Geometry
  onUpdate: (patch: Partial<Geometry>) => void
}

interface CropToolbarProps {
  dispW: number
  dispH: number
  geometry: Geometry
  onUpdate: (patch: Partial<Geometry>) => void
  onExit: () => void
}

// 裁剪比例预设：null=自由，否则 w/h
const CROP_RATIOS: { label: string; ratio: number | null }[] = [
  { label: '自由', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '16:9', ratio: 16 / 9 },
]

// 顶部独立工具条：90° 左/右、微调角度滑块、水平/垂直翻转、比例预设、重置、完成。
// 不压在画面上，放在预览区顶部固定栏。
function CropToolbar({ dispW, dispH, geometry, onUpdate, onExit }: CropToolbarProps) {
  const crop = geometry.crop
  const cropRatio = (crop.w * dispW) / (crop.h * dispH)
  const activeRatio = (() => {
    const match = CROP_RATIOS.find((r) => {
      if (r.ratio === null) return false
      return Math.abs(r.ratio - cropRatio) < 0.02
    })
    return match?.ratio ?? null
  })()

  const setRatio = (ratio: number | null) => {
    if (ratio === null) return
    const targetPxRatio = ratio
    const cx = crop.x + crop.w / 2
    const cy = crop.y + crop.h / 2
    let w = crop.w
    let h = (w * dispW / targetPxRatio) / dispH
    if (cy - h / 2 < 0 || cy + h / 2 > 1) {
      h = Math.min(cy, 1 - cy) * 2
      w = (h * dispH * targetPxRatio) / dispW
    }
    if (cx - w / 2 < 0) w = cx * 2
    if (cx + w / 2 > 1) w = (1 - cx) * 2
    h = (w * dispW / targetPxRatio) / dispH
    onUpdate({ crop: { x: cx - w / 2, y: cy - h / 2, w, h } })
  }

  const rotate90 = (dir: 1 | -1) => {
    const next = ((((geometry.rotation90 + dir * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270
    onUpdate({ rotation90: next, crop: { x: 0, y: 0, w: 1, h: 1 } })
  }

  const btnBase =
    'rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500'

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 rounded bg-zinc-800/80 px-2 py-1.5 backdrop-blur">
      <button onClick={() => rotate90(-1)} title="逆时针旋转 90°" className={`${btnBase} text-zinc-200 hover:bg-zinc-700`}>
        ↺ 90°
      </button>
      <button onClick={() => rotate90(1)} title="顺时针旋转 90°" className={`${btnBase} text-zinc-200 hover:bg-zinc-700`}>
        90° ↻
      </button>
      <div className="mx-1 h-4 w-px bg-zinc-700" />
      <label className="flex items-center gap-1 text-[10px] text-zinc-400">
        <span>微调</span>
        <input
          type="range"
          min={-45}
          max={45}
          step={0.5}
          value={geometry.fineAngle}
          onChange={(e) => onUpdate({ fineAngle: Number(e.target.value) })}
          className="h-1 w-20 accent-zinc-400"
          aria-label="微调旋转角度"
        />
        <span className="w-8 tabular-nums text-zinc-500">{geometry.fineAngle}°</span>
      </label>
      <div className="mx-1 h-4 w-px bg-zinc-700" />
      <button
        onClick={() => onUpdate({ flipH: !geometry.flipH })}
        aria-pressed={geometry.flipH}
        title="水平翻转"
        className={`${btnBase} ${geometry.flipH ? 'bg-zinc-600 text-white' : 'text-zinc-300 hover:bg-zinc-700'}`}
      >
        ⇄
      </button>
      <button
        onClick={() => onUpdate({ flipV: !geometry.flipV })}
        aria-pressed={geometry.flipV}
        title="垂直翻转"
        className={`${btnBase} ${geometry.flipV ? 'bg-zinc-600 text-white' : 'text-zinc-300 hover:bg-zinc-700'}`}
      >
        ⇅
      </button>
      <div className="mx-1 h-4 w-px bg-zinc-700" />
      {CROP_RATIOS.map((r) => (
        <button
          key={r.label}
          onClick={() => setRatio(r.ratio)}
          aria-pressed={activeRatio === r.ratio}
          className={[
            'rounded px-1.5 py-1 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
            activeRatio === r.ratio ? 'bg-zinc-600 text-white' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
          ].join(' ')}
        >
          {r.label}
        </button>
      ))}
      <div className="mx-1 h-4 w-px bg-zinc-700" />
      <button
        onClick={() => onUpdate({ rotation90: 0, fineAngle: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, w: 1, h: 1 } })}
        title="重置几何"
        className={`${btnBase} text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200`}
      >
        重置
      </button>
      <button
        onClick={onExit}
        className="rounded bg-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
      >
        完成
      </button>
    </div>
  )
}

function CropOverlay({ dispW, dispH, geometry, onUpdate }: CropOverlayProps) {
  const crop = geometry.crop
  const px = (nx: number) => nx * dispW
  const py = (ny: number) => ny * dispH

  // 当前锁定的比例（输出像素宽高比与预设匹配）——仅用于角手柄拖拽时锁比例
  const cropRatio = (crop.w * dispW) / (crop.h * dispH)
  const activeRatio = (() => {
    const match = CROP_RATIOS.find((r) => {
      if (r.ratio === null) return false
      return Math.abs(r.ratio - cropRatio) < 0.02
    })
    return match?.ratio ?? null
  })()

  // 拖拽状态
  const dragRef = useRef<{
    type: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e'
    startClientX: number
    startClientY: number
    startCrop: CropRect
  } | null>(null)

  const onHandleDown = (
    e: React.PointerEvent,
    type: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      type,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCrop: { ...crop },
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // 用 overlay 实际显示尺寸换算归一化 delta
    const overlay = (e.currentTarget as Element).closest('.lm-crop-overlay') as HTMLElement | null
    const rect = overlay?.getBoundingClientRect()
    const scaleX = rect ? 1 / rect.width : 1 / dispW
    const scaleY = rect ? 1 / rect.height : 1 / dispH
    const dx = (e.clientX - d.startClientX) * scaleX
    const dy = (e.clientY - d.startClientY) * scaleY
    const s = d.startCrop
    let { x, y, w, h } = s

    const clampCrop = (c: CropRect): CropRect => {
      // 钳到合法范围，保持宽高 ≥ 1e-3
      let nx = Math.max(0, Math.min(1, c.x))
      let ny = Math.max(0, Math.min(1, c.y))
      let nw = Math.max(1e-3, Math.min(1 - nx, c.w))
      let nh = Math.max(1e-3, Math.min(1 - ny, c.h))
      return { x: nx, y: ny, w: nw, h: nh }
    }

    if (d.type === 'move') {
      x = Math.max(0, Math.min(1 - s.w, s.x + dx))
      y = Math.max(0, Math.min(1 - s.h, s.y + dy))
    } else {
      // resize：按拖的手柄改对应边
      const minSize = 0.05
      if (d.type.includes('w')) {
        const newX = Math.max(0, Math.min(s.x + s.w - minSize, s.x + dx))
        w = s.w + (s.x - newX)
        x = newX
      }
      if (d.type.includes('e')) {
        w = Math.max(minSize, Math.min(1 - s.x, s.w + dx))
      }
      if (d.type.includes('n')) {
        const newY = Math.max(0, Math.min(s.y + s.h - minSize, s.y + dy))
        h = s.h + (s.y - newY)
        y = newY
      }
      if (d.type.includes('s')) {
        h = Math.max(minSize, Math.min(1 - s.y, s.h + dy))
      }
      // 锁比例（仅角手柄且当前有比例锁）
      if (activeRatio !== null && (d.type === 'nw' || d.type === 'ne' || d.type === 'sw' || d.type === 'se')) {
        // 按画面比例换算：目标 crop 像素宽高比 = activeRatio
        const targetPxRatio = activeRatio
        const newWpx = w * dispW
        const newHpx = newWpx / targetPxRatio
        h = newHpx / dispH
        // 若超界则按 h 反推 w
        if (y + h > 1) {
          h = 1 - y
          w = (h * dispH * targetPxRatio) / dispW
        }
        if (x + w > 1) {
          w = 1 - x
          h = (w * dispW / targetPxRatio) / dispH
        }
      }
    }
    onUpdate({ crop: clampCrop({ x, y, w, h }) })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    dragRef.current = null
  }

  const x0 = px(crop.x), y0 = py(crop.y), x1 = px(crop.x + crop.w), y1 = py(crop.y + crop.h)
  const handleSize = Math.max(8, Math.min(dispW, dispH) * 0.025)

  return (
    <div className="lm-crop-overlay pointer-events-none absolute left-0 top-0" style={{ width: '100%', height: '100%' }}>
      {/* SVG 框 + 遮罩 + 手柄 */}
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width="100%"
        height="100%"
        viewBox={`0 0 ${dispW} ${dispH}`}
        preserveAspectRatio="none"
      >
        {/* 框外四块遮罩 */}
        <rect x={0} y={0} width={dispW} height={y0} fill="black" fillOpacity={0.5} />
        <rect x={0} y={y1} width={dispW} height={dispH - y1} fill="black" fillOpacity={0.5} />
        <rect x={0} y={y0} width={x0} height={y1 - y0} fill="black" fillOpacity={0.5} />
        <rect x={x1} y={y0} width={dispW - x1} height={y1 - y0} fill="black" fillOpacity={0.5} />
        {/* 框线 */}
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke="#fafafa" strokeWidth={Math.max(1, dispW * 0.002)} strokeOpacity={0.9} />
        {/* 三分线 */}
        <line x1={x0 + (x1 - x0) / 3} y1={y0} x2={x0 + (x1 - x0) / 3} y2={y1} stroke="#fafafa" strokeOpacity={0.3} strokeWidth={1} />
        <line x1={x0 + 2 * (x1 - x0) / 3} y1={y0} x2={x0 + 2 * (x1 - x0) / 3} y2={y1} stroke="#fafafa" strokeOpacity={0.3} strokeWidth={1} />
        <line x1={x0} y1={y0 + (y1 - y0) / 3} x2={x1} y2={y0 + (y1 - y0) / 3} stroke="#fafafa" strokeOpacity={0.3} strokeWidth={1} />
        <line x1={x0} y1={y0 + 2 * (y1 - y0) / 3} x2={x1} y2={y0 + 2 * (y1 - y0) / 3} stroke="#fafafa" strokeOpacity={0.3} strokeWidth={1} />

        {/* 框内 move 区 */}
        <rect
          x={x0} y={y0} width={x1 - x0} height={y1 - y0}
          fill="transparent"
          className="pointer-events-auto cursor-move"
          onPointerDown={(e) => onHandleDown(e, 'move')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {/* 8 个手柄 */}
        {([
          ['nw', x0, y0, 'nwse-resize'],
          ['n', (x0 + x1) / 2, y0, 'ns-resize'],
          ['ne', x1, y0, 'nesw-resize'],
          ['e', x1, (y0 + y1) / 2, 'ew-resize'],
          ['se', x1, y1, 'nwse-resize'],
          ['s', (x0 + x1) / 2, y1, 'ns-resize'],
          ['sw', x0, y1, 'nesw-resize'],
          ['w', x0, (y0 + y1) / 2, 'ew-resize'],
        ] as const).map(([type, hx, hy, cur]) => (
          <rect
            key={type}
            x={hx - handleSize / 2}
            y={hy - handleSize / 2}
            width={handleSize}
            height={handleSize}
            fill="#fafafa"
            stroke="#18181b"
            strokeWidth={1}
            className={`lm-handle pointer-events-auto cursor-${cur}`}
            onPointerDown={(e) => onHandleDown(e, type)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
      </svg>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="text-center">
      <h1 className="text-xl font-light text-zinc-400">还没有打开照片</h1>
      <p className="mt-2 text-sm text-zinc-600">
        点左侧「导入照片」，选一张图片开始。
      </p>
    </div>
  )
}
