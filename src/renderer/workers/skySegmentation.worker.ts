/// <reference lib="webworker" />

import { pipeline, RawImage, type ImageSegmentationPipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/segformer-b0-finetuned-ade-512-512'
const MAX_INPUT_EDGE = 512
const MIN_COVERAGE = 0.002

type SegmentRequest = {
  type: 'segment'
  requestId: string
  width: number
  height: number
  rgba: ArrayBuffer
}

type ProgressEvent = { status?: string; file?: string; progress?: number }

let segmenterPromise: Promise<ImageSegmentationPipeline> | null = null

function post(message: Record<string, unknown>, transfer?: Transferable[]) {
  self.postMessage(message, transfer ?? [])
}

async function getSegmenter(requestId: string): Promise<ImageSegmentationPipeline> {
  if (!segmenterPromise) {
    segmenterPromise = pipeline('image-segmentation', MODEL_ID, {
      // CPU/WASM 优先，保证 Windows/Electron 设备的首轮 POC 有稳定回退；不依赖 CUDA 或 Python。
      dtype: 'q8',
      progress_callback: (event: ProgressEvent) => {
        const progress = typeof event.progress === 'number' ? Math.round(event.progress) : undefined
        post({
          type: 'progress',
          requestId,
          stage: event.status === 'progress' ? 'downloading' : 'loading',
          progress,
          detail: event.file ? `正在准备 ${event.file.split('/').pop()}` : '正在准备本地分割模型',
        })
      },
    }) as Promise<ImageSegmentationPipeline>
  }
  return segmenterPromise
}

function downscaleRgba(data: Uint8ClampedArray, width: number, height: number) {
  const scale = Math.min(1, MAX_INPUT_EDGE / Math.max(width, height))
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  if (outWidth === width && outHeight === height) return { data, width, height }
  const out = new Uint8ClampedArray(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outHeight))
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / outWidth))
      const src = (sy * width + sx) * 4
      const dst = (y * outWidth + x) * 4
      out[dst] = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = data[src + 3]
    }
  }
  return { data: out, width: outWidth, height: outHeight }
}

function toSingleChannel(data: Uint8Array | Uint8ClampedArray, channels: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = data[i * channels] ?? 0
  return out
}

function activeCoverage(mask: Uint8Array): number {
  let active = 0
  for (const value of mask) if (value >= 128) active++
  return active / Math.max(1, mask.length)
}

self.addEventListener('message', async (event: MessageEvent<SegmentRequest>) => {
  const request = event.data
  if (request.type !== 'segment') return
  const { requestId } = request
  try {
    if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1) {
      throw new Error('候选蒙版输入尺寸无效。')
    }
    const expectedBytes = request.width * request.height * 4
    if (request.rgba.byteLength !== expectedBytes) throw new Error('候选蒙版输入像素数据不完整。')

    post({ type: 'progress', requestId, stage: 'preparing', detail: '正在在本机准备天空候选' })
    const source = downscaleRgba(new Uint8ClampedArray(request.rgba), request.width, request.height)
    const segmenter = await getSegmenter(requestId)
    post({ type: 'progress', requestId, stage: 'segmenting', detail: '正在本地识别天空区域' })
    const image = new RawImage(source.data, source.width, source.height, 4)
    // SegFormer 模型卡给出的官方 Transformers.js 用法不传 subtask；当前 4.x 运行时会据模型配置解析语义后处理。
    const segments = await segmenter(image)
    const sky = segments.find((item) => item.label?.trim().toLowerCase() === 'sky')
    if (!sky) {
      post({ type: 'empty', requestId, detail: '本地模型没有识别到可用的天空候选；请改用手动蒙版。' })
      return
    }
    const data = toSingleChannel(sky.mask.data, sky.mask.channels, sky.mask.width, sky.mask.height)
    const coverage = activeCoverage(data)
    if (coverage < MIN_COVERAGE) {
      post({ type: 'empty', requestId, detail: '天空候选范围过小，未创建蒙版；请改用手动蒙版。' })
      return
    }
    post({
      type: 'result',
      requestId,
      width: sky.mask.width,
      height: sky.mask.height,
      coverage,
      modelId: MODEL_ID,
      data: data.buffer,
    }, [data.buffer])
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地天空候选生成失败。'
    post({ type: 'error', requestId, message })
  }
})
