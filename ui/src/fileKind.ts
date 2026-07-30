// Classify on-disk files so binaries/media never enter the text editor.

import { ipc } from "./ipc";

export type FileKind = "text" | "audio" | "image" | "binary";

const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "flac",
  "aac",
  "opus",
  "wma",
  "aiff",
  "aif",
  "weba",
]);

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tif",
  "tiff",
]);

/** Known non-previewable binaries — never attempt a text read. */
const BINARY_EXTS = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wasm",
  "bin",
  "dat",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "class",
  "jar",
  "pyc",
  "pyo",
  "pyd",
  "node",
  "sqlite",
  "db",
  "mp4",
  "mkv",
  "webm",
  "mov",
  "avi",
  "wmv",
  "flv",
  "m4v",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "pak",
  "dmg",
  "iso",
  "img",
  "apk",
  "deb",
  "rpm",
]);

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Pure extension map. Returns null when the extension is unrecognized. */
export function fileKindFromExtension(path: string): FileKind | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (BINARY_EXTS.has(ext)) return "binary";
  return null;
}

export function isTextTabKind(kind: FileKind): boolean {
  return kind === "text";
}

/**
 * Resolve how a real on-disk path should open.
 * Extension wins; unknown extensions get a cheap binary/media sniff, then
 * fall through to a normal text read (caller still handles NotTextFile).
 */
export async function classifyOpenPath(path: string): Promise<FileKind> {
  const fromExt = fileKindFromExtension(path);
  if (fromExt) return fromExt;

  try {
    const sniff = await ipc.fsSniff(path);
    if (sniff.media === "audio") return "audio";
    if (sniff.media === "image") return "image";
    if (sniff.looks_binary) return "binary";
  } catch {
    // Sniff failures (missing workspace jail, IO, …) fall through to text open.
  }
  return "text";
}
