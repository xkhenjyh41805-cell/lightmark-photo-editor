// Electron 主进程入口
// 注意：require('electron') 必须在 electron 运行时环境里才会返回 { app, BrowserWindow }
// 如果在普通 node 下运行，require('electron') 返回的是 electron.exe 的路径字符串
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

// dev 判定：优先看是否加载了 vite dev server（连得上 5173 即 dev），
// 否则回退到环境变量。npm run dev 脚本未设 NODE_ENV，光靠它判断会误判成生产、
// 导致 Electron 加载旧 dist 产物而非 vite dev server（HMR 失效、改动不生效）。
const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL || process.env.LIGHTMARK_DEV === '1'

// 软件自己的数据目录：存原图副本、缩略图、图库索引（library.json）
// Windows 下形如 C:\Users\<用户>\AppData\Roaming\lightmark
function dataDir() {
  return path.join(app.getPath('userData'), 'library')
}
function originalsDir() {
  return path.join(dataDir(), 'originals')
}
function thumbsDir() {
  return path.join(dataDir(), 'thumbs')
}
function sidecarsDir() {
  return path.join(dataDir(), 'sidecars')
}
function libraryFile() {
  return path.join(dataDir(), 'library.json')
}
function presetsFile() {
  return path.join(dataDir(), 'presets.json')
}

// ---- 阶段 5.4：修图预设（presets.json）----
// 读取用户预设文件。读不到返回空数组。结构错也不抛，返回空（渲染层只认 user 预设）。
async function readUserPresets() {
  try {
    const raw = await fsp.readFile(presetsFile(), 'utf-8')
    const data = JSON.parse(raw)
    if (data && Array.isArray(data.presets)) return data.presets
    return []
  } catch (e) {
    if (e.code === 'ENOENT') return []
    return []
  }
}

// 原子写用户预设文件
async function writeUserPresets(presets) {
  await ensureDirs()
  const payload = { version: 1, presets }
  const tmp = presetsFile() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  await fsp.rename(tmp, presetsFile())
}

// 图片类型白名单
const IMAGE_FILTERS = [
  {
    name: '图片',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'],
  },
]

// 确保目录存在
async function ensureDirs() {
  await fsp.mkdir(originalsDir(), { recursive: true })
  await fsp.mkdir(thumbsDir(), { recursive: true })
  await fsp.mkdir(sidecarsDir(), { recursive: true })
}

// 读取图库索引
async function readLibrary() {
  try {
    const raw = await fsp.readFile(libraryFile(), 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    if (e.code === 'ENOENT') return { photos: [] }
    throw e
  }
}

// 写入图库索引（原子写：先写临时文件再改名，避免写到一半损坏）
async function writeLibrary(lib) {
  const tmp = libraryFile() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(lib, null, 2), 'utf-8')
  await fsp.rename(tmp, libraryFile())
}

// 把文件名转成安全的小写扩展名
function extOf(p) {
  return path.extname(p).toLowerCase().replace(/^\./, '')
}

// 生成一个不冲突的文件名
async function uniqueName(dir, base, ext) {
  let name = `${base}.${ext}`
  let n = 1
  while (true) {
    try {
      await fsp.access(path.join(dir, name))
      name = `${base}-${n}.${ext}`
      n++
    } catch {
      return name
    }
  }
}

// 用 sharp 生成缩略图；若 sharp 不可用则回退为复制原图（缩放交给前端 CSS）
async function makeThumb(srcPath, destPath) {
  try {
    const sharp = require('sharp')
    await sharp(srcPath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(destPath.replace(/\.[^.]+$/, '.jpg'))
    return path.basename(destPath.replace(/\.[^.]+$/, '.jpg'))
  } catch (e) {
    // sharp 不可用：直接复制原图当作缩略图
    await fsp.copyFile(srcPath, destPath)
    return path.basename(destPath)
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#18181b',
    title: '光印 LightMark',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../../dist/renderer/index.html'))
  }
}

// IPC：打开文件选择对话框，返回选中的图片路径数组
ipcMain.handle('dialog:openImages', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入照片',
    properties: ['openFile', 'multiSelections'],
    filters: IMAGE_FILTERS,
  })
  if (result.canceled || result.filePaths.length === 0) return []
  return result.filePaths
})

// IPC：导入图片——复制原图到软件目录、生成缩略图、写图库索引
// 返回新增的照片记录数组
ipcMain.handle('library:import', async (_event, srcPaths) => {
  if (!Array.isArray(srcPaths) || srcPaths.length === 0) return []
  await ensureDirs()
  const lib = await readLibrary()

  const added = []
  for (const src of srcPaths) {
    const ext = extOf(src)
    if (!ext) continue
    const baseName = path.basename(src, path.extname(src)).replace(/[^\w一-龥\-]/g, '_')
    const origName = await uniqueName(originalsDir(), baseName, ext)
    const origDest = path.join(originalsDir(), origName)
    await fsp.copyFile(src, origDest)

    const thumbName = await makeThumb(origDest, path.join(thumbsDir(), `${baseName}.${ext}`))
    const thumbDest = path.join(thumbsDir(), thumbName)

    const photo = {
      id: origName, // 用文件名当 id，天然唯一
      name: path.basename(src),
      originalPath: origDest,
      thumbPath: thumbDest,
      ext,
      importedAt: Date.now(),
    }
    lib.photos.push(photo)
    added.push(photo)
  }

  await writeLibrary(lib)
  return added
})

// IPC：读取整个图库
ipcMain.handle('library:read', async () => {
  await ensureDirs()
  const lib = await readLibrary()
  return lib.photos
})

// IPC：读取一张原图或缩略图的二进制，返回 data URL 给前端 <img>
ipcMain.handle('file:readDataUrl', async (_event, filePath) => {
  try {
    const buf = await fsp.readFile(filePath)
    const ext = extOf(filePath)
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
      : ext === 'tiff' ? 'image/tiff'
      : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (e) {
    return null
  }
})

// IPC：从图库删除一张照片（删文件 + 删索引）
ipcMain.handle('library:remove', async (_event, photoId) => {
  const lib = await readLibrary()
  const idx = lib.photos.findIndex((p) => p.id === photoId)
  if (idx === -1) return false
  const photo = lib.photos[idx]
  lib.photos.splice(idx, 1)
  await writeLibrary(lib)
  // 尽量删文件，删不掉不报错
  try { await fsp.unlink(photo.originalPath) } catch {}
  try { await fsp.unlink(photo.thumbPath) } catch {}
  // 顺手清理 sidecar（删不掉不报错）
  try { await fsp.unlink(sidecarPath(photoId)) } catch {}
  return true
})

// ---- 阶段 4：导出 ----
// 渲染进程把处理好的全分辨率 RGBA 像素传过来，主进程用 sharp 编码写文件。
// 方案 A：渲染进程跑 applyAdjustments（纯函数），主进程只负责编码 + 落盘。
function sidecarPath(photoId) {
  // photoId 可能含路径分隔符，做一层转义
  const safe = String(photoId).replace(/[\\/:]/g, '_')
  return path.join(sidecarsDir(), `${safe}.sidecar.json`)
}

// 导出格式扩展名映射
function extForFormat(format) {
  if (format === 'png') return 'png'
  if (format === 'webp') return 'webp'
  return 'jpg'
}

ipcMain.handle('export:pixels', async (_event, req) => {
  const { pixels, width, height, options, suggestedName } = req
  if (!pixels || !width || !height) {
    throw new Error('导出参数缺失：pixels/width/height')
  }

  const ext = extForFormat(options.format)
  const defaultName = `${suggestedName || '光印导出'}.${ext}`

  // 弹出保存对话框
  const result = await dialog.showSaveDialog({
    title: '导出到',
    defaultPath: defaultName,
    filters: [{ name: options.format.toUpperCase(), extensions: [ext] }],
  })
  if (result.canceled || !result.filePath) return null

  await encodeToFile(result.filePath, pixels, width, height, options)
  return result.filePath
})

// 批量导出：选一次目录，每张按 baseName.ext 自动命名写入（重名自动加序号）
ipcMain.handle('export:batch', async (_event, req) => {
  const { dir, items } = req
  if (!dir || !Array.isArray(items) || items.length === 0) return { saved: [], skipped: 0 }

  let sharp
  try {
    sharp = require('sharp')
  } catch (e) {
    throw new Error('sharp 未安装，无法导出')
  }

  const saved = []
  for (const it of items) {
    const ext = extForFormat(it.options.format)
    const finalPath = await uniqueName(dir, it.suggestedName || '光印导出', ext)
    try {
      await encodeToFile(finalPath, it.pixels, it.width, it.height, it.options)
      saved.push(finalPath)
    } catch (e) {
      // 单张失败不中断整批
      console.error('导出失败', it.suggestedName, e)
    }
  }
  return { saved, skipped: items.length - saved.length }
})

// 选导出目录（批量用）
ipcMain.handle('export:pickDir', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// 把 RGBA 像素按 options 编码写到 filePath
async function encodeToFile(filePath, pixels, width, height, options) {
  let sharp
  try {
    sharp = require('sharp')
  } catch (e) {
    throw new Error('sharp 未安装，无法导出')
  }

  let pipeline = sharp(
    Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    { raw: { width, height, channels: 4 } },
  )

  // 尺寸：按长边缩放（不放大）
  if (options.resizeMode === 'longEdge' && options.longEdge > 0) {
    pipeline = pipeline.resize({
      width: options.longEdge,
      height: options.longEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }

  // 格式编码
  if (options.format === 'png') {
    pipeline = pipeline.png()
  } else if (options.format === 'webp') {
    pipeline = pipeline.webp({ quality: options.quality })
  } else {
    // jpeg：去掉 alpha（JPEG 不支持透明），用白底
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({
      quality: options.quality,
      mozjpeg: true,
    })
  }

  await pipeline.toFile(filePath)
}

// ---- 阶段 4/5.2：参数持久化 .sidecar ----
// 阶段 5.2：params 现在是 { global: AdjustParams, masks: LocalMask[] }。
// 主进程不解释内容，原样存取；向后兼容老 sidecar（裸 AdjustParams）由渲染层 normalize。
ipcMain.handle('sidecar:save', async (_event, photoId, adjust) => {
  await ensureDirs()
  const payload = {
    version: 2,
    photoId,
    adjust,
    savedAt: Date.now(),
  }
  const p = sidecarPath(photoId)
  const tmp = p + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  await fsp.rename(tmp, p)
  return true
})

ipcMain.handle('sidecar:load', async (_event, photoId) => {
  try {
    const raw = await fsp.readFile(sidecarPath(photoId), 'utf-8')
    const data = JSON.parse(raw)
    // 新格式 v2：adjust 字段；老格式 v1：params 字段（裸 AdjustParams）。都原样返回，渲染层 normalize。
    if (data.adjust !== undefined) return data.adjust
    if (data.params !== undefined) return data.params
    return data
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
})

// ---- 阶段 5.4：修图预设 IPC ----
// 主进程只管存取 presets.json，不解释内容；容错与类型规整在渲染层。
// preset 结构：{ id, name, kind:'user', desc?, adjust:{global,hsl} }

// 读取所有用户预设
ipcMain.handle('preset:load', async () => {
  return readUserPresets()
})

// 追加一个用户预设（按 id 去重，已存在则覆盖）
ipcMain.handle('preset:save', async (_event, preset) => {
  const list = await readUserPresets()
  const idx = list.findIndex((p) => p && p.id === preset.id)
  if (idx >= 0) {
    list[idx] = preset
  } else {
    list.push(preset)
  }
  await writeUserPresets(list)
  return list
})

// 删除一个用户预设（按 id）。内置预设不在文件里，删不到也无害。
ipcMain.handle('preset:delete', async (_event, presetId) => {
  const list = await readUserPresets()
  const next = list.filter((p) => p && p.id !== presetId)
  await writeUserPresets(next)
  return next
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
