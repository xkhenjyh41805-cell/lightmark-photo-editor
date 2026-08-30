import { useEffect, useRef, useState } from 'react'
import { computeHistogram, type ImageBuf } from '../../image'

interface HistogramViewProps {
  imageBuf: ImageBuf | null
}

// 三段区域：暗部 / 中间调 / 高光。悬停显示该区域说明（3.6 会说话的直方图）。
const ZONES = [
  { key: 'shadows', label: '暗部', hint: '阴影与最暗处。这里堆积说明死黑。', from: 0, to: 85 },
  { key: 'midtones', label: '中间调', hint: '画面主体亮度。理想分布集中在这一段。', from: 85, to: 170 },
  { key: 'highlights', label: '高光', hint: '亮部与最亮处。右侧顶到边说明高光溢出。', from: 170, to: 256 },
] as const

export function HistogramView({ imageBuf }: HistogramViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoverZone, setHoverZone] = useState<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageBuf) return

    const ctx = canvas.getContext('2d')!
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    const hist = computeHistogram(imageBuf)

    let maxVal = 0
    for (let i = 5; i < 251; i++) {
      maxVal = Math.max(maxVal, hist.r[i], hist.g[i], hist.b[i])
    }
    if (maxVal === 0) maxVal = 1

    const drawChannel = (data: Uint32Array, color: string) => {
      ctx.beginPath()
      ctx.moveTo(0, H)
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * W
        const barH = (data[i] / maxVal) * H * 0.95
        ctx.lineTo(x, H - barH)
      }
      ctx.lineTo(W, H)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }

    drawChannel(hist.r, 'rgba(220,80,80,0.45)')
    drawChannel(hist.g, 'rgba(80,200,80,0.45)')
    drawChannel(hist.b, 'rgba(80,120,220,0.45)')

    const lum = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      lum[i] = Math.round(hist.r[i] * 0.299 + hist.g[i] * 0.587 + hist.b[i] * 0.114)
    }
    drawChannel(lum, 'rgba(200,200,200,0.2)')

    // 区域分隔线（暗部/中间调/高光边界）
    ctx.strokeStyle = 'rgba(120,120,120,0.25)'
    ctx.lineWidth = 1
    for (const z of ZONES) {
      if (z.from === 0) continue
      const x = (z.from / 256) * W
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
  }, [imageBuf])

  if (!imageBuf) {
    return (
      <div className="flex h-[88px] items-center justify-center rounded bg-zinc-900/50">
        <span className="text-[10px] text-zinc-600">选择照片后显示直方图</span>
      </div>
    )
  }

  const activeZone = hoverZone != null ? ZONES[hoverZone] : null

  return (
    <div className="rounded bg-zinc-900/50">
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={256}
          height={120}
          aria-label="实时直方图，从左到右为暗部、中间调、高光"
          className="block w-full"
          style={{ imageRendering: 'pixelated' }}
        />
        {/* 三段透明热区，覆盖在 canvas 上做悬停 */}
        <div className="absolute inset-0 flex">
          {ZONES.map((z, idx) => (
            <div
              key={z.key}
              onMouseEnter={() => setHoverZone(idx)}
              onMouseLeave={() => setHoverZone(null)}
              className={[
                'h-full flex-1 transition-colors',
                hoverZone === idx ? 'bg-zinc-200/10' : '',
              ].join(' ')}
              title={`${z.label}：${z.hint}`}
            />
          ))}
        </div>
      </div>
      {/* 当前悬停区域的文字说明，不靠颜色单一传达 */}
      <div className="px-2 py-1">
        {activeZone ? (
          <p className="text-[10px] leading-tight text-zinc-300">
            <span className="font-medium">{activeZone.label}</span>
            <span className="text-zinc-500"> · {activeZone.hint}</span>
          </p>
        ) : (
          <p className="text-[10px] text-zinc-600">
            鼠标移到暗部 / 中间调 / 高光查看说明
          </p>
        )}
      </div>
    </div>
  )
}
