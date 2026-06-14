// Image attachments: helpers shared by the composer, the message bubbles and the viewer.

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']

/** does this path/name look like an image we can show? */
export function isImagePath(p: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(p)
  return !!m && IMAGE_EXTS.includes(m[1].toLowerCase())
}

/** the just-the-filename tail of a path (handles both slash styles) */
export function imageName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** a renderable src for a local image path, served by the main process over ccg-img:// */
export function imageSrc(p: string): string {
  return 'ccg-img://local/?p=' + encodeURIComponent(p)
}

function extOf(file: File): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]
  if (fromName) return fromName.toLowerCase()
  const fromType = /image\/([a-z0-9.+-]+)/i.exec(file.type)?.[1]
  if (fromType) return (fromType === 'svg+xml' ? 'svg' : fromType === 'jpeg' ? 'jpg' : fromType).toLowerCase()
  return 'png'
}

/**
 * Normalize a drop/paste/picker set of File objects to absolute image paths.
 * A File that exists on disk (dragged from the OS) resolves to its path directly;
 * one without a path (a pasted screenshot, an image dragged from a browser) has its
 * bytes written to a temp file by the main process so it too gets a path.
 */
export async function filesToImagePaths(files: Iterable<File>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const isImage = file.type.startsWith('image/') || isImagePath(file.name)
    if (!isImage) continue
    let p = ''
    try {
      p = window.api.pathForFile(file)
    } catch {
      p = ''
    }
    if (p && isImagePath(p)) {
      out.push(p)
      continue
    }
    try {
      const bytes = await file.arrayBuffer()
      out.push(await window.api.saveImageData(bytes, extOf(file)))
    } catch {
      /* unreadable blob — skip it */
    }
  }
  return out
}
