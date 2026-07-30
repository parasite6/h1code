// Non-text tab host: HTML5 audio, image preview, or a safe "can't preview" pane.
//
// Linux WebKitGTK cannot play <audio>/<video> from the Tauri `asset://` protocol
// (GStreamer has no handler for custom schemes). Images often work via
// convertFileSrc, but audio must use a blob: URL from jailed IPC bytes.

import { convertFileSrc } from "@tauri-apps/api/core";
import { extensionOf, type FileKind } from "./fileKind";
import { ipc } from "./ipc";
import type { Tab } from "./tabs";

export interface MediaViewerBinding {
  show(tab: Tab): void;
  hide(): void;
}

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  weba: "audio/webm",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  wma: "audio/x-ms-wma",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function mimeForPath(path: string, kind: "audio" | "image"): string {
  const ext = extensionOf(path);
  return MIME_BY_EXT[ext] ?? (kind === "audio" ? "audio/mpeg" : "image/png");
}

function toUint8Array(data: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

async function blobUrlForPath(path: string, kind: "audio" | "image"): Promise<string> {
  const raw = await ipc.fsReadBytes(path);
  const bytes = toUint8Array(raw);
  // Copy into a fresh ArrayBuffer-backed view so Blob accepts the type cleanly
  // when the IPC payload was a number[]-derived Uint8Array.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)], {
    type: mimeForPath(path, kind),
  });
  return URL.createObjectURL(blob);
}

function mediaErrorLabel(el: HTMLMediaElement | HTMLImageElement): string {
  if ("error" in el && el.error) {
    const code = el.error.code;
    const names: Record<number, string> = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    return names[code] ?? `media error ${code}`;
  }
  return "load failed";
}

function showLoadError(host: HTMLElement, detail: string) {
  const err = document.createElement("div");
  err.className = "media-viewer-error";
  err.textContent = detail;
  host.appendChild(err);
}

export function mountMediaViewer(host: HTMLElement): MediaViewerBinding {
  let objectUrl: string | null = null;
  let loadGen = 0;

  function revokeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function clear() {
    loadGen += 1;
    revokeObjectUrl();
    host.innerHTML = "";
  }

  async function renderAudio(tab: Tab) {
    const wrap = document.createElement("div");
    wrap.className = "media-viewer-inner media-viewer-audio";

    const title = document.createElement("div");
    title.className = "media-viewer-filename";
    title.textContent = tab.name;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";

    wrap.appendChild(title);
    wrap.appendChild(audio);
    host.appendChild(wrap);

    const gen = loadGen;
    const asset = convertFileSrc(tab.path);
    try {
      // Prefer jailed blob on all platforms: asset:// media is broken on Linux
      // WebKitGTK, and blob keeps loads inside the workspace jail.
      const url = await blobUrlForPath(tab.path, "audio");
      if (gen !== loadGen) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      audio.src = url;
      audio.addEventListener("error", () => {
        showLoadError(
          wrap,
          `Couldn't play audio (${mediaErrorLabel(audio)}). Tried blob URL; asset URL was ${asset}`
        );
      });
    } catch (e) {
      if (gen !== loadGen) return;
      showLoadError(
        wrap,
        `Couldn't load audio: ${String(e)}. Asset URL (unsupported for media on Linux): ${asset}`
      );
    }
  }

  async function renderImage(tab: Tab) {
    const wrap = document.createElement("div");
    wrap.className = "media-viewer-inner media-viewer-image";

    const img = document.createElement("img");
    img.alt = tab.name;
    img.title = tab.path;

    const caption = document.createElement("div");
    caption.className = "media-viewer-filename";
    caption.textContent = tab.name;

    wrap.appendChild(img);
    wrap.appendChild(caption);
    host.appendChild(wrap);

    const gen = loadGen;
    const asset = convertFileSrc(tab.path);

    const attachBlob = async () => {
      const url = await blobUrlForPath(tab.path, "image");
      if (gen !== loadGen) {
        URL.revokeObjectURL(url);
        return;
      }
      revokeObjectUrl();
      objectUrl = url;
      img.addEventListener(
        "error",
        () => {
          if (gen !== loadGen) return;
          showLoadError(
            wrap,
            `Couldn't load image from blob (${mediaErrorLabel(img)}). Asset URL was ${asset}`
          );
        },
        { once: true }
      );
      img.src = url;
    };

    // Try asset protocol first (works for images on WebKit); fall back to
    // jailed blob if the asset load fails (scope/CSP/protocol issues).
    img.src = asset;
    img.addEventListener(
      "error",
      () => {
        if (gen !== loadGen) return;
        attachBlob().catch((e) => {
          if (gen !== loadGen) return;
          showLoadError(
            wrap,
            `Couldn't load image (${mediaErrorLabel(img)}). Asset URL: ${asset}. Blob fallback: ${String(e)}`
          );
        });
      },
      { once: true }
    );
  }

  function renderBinary(tab: Tab) {
    const wrap = document.createElement("div");
    wrap.className = "media-viewer-inner media-viewer-binary";

    const title = document.createElement("div");
    title.className = "media-viewer-title";
    title.textContent = "This file can't be previewed";

    const detail = document.createElement("div");
    detail.className = "media-viewer-detail";
    detail.textContent = `${tab.name} is a binary or unrecognized file type and won't be opened in the text editor.`;

    wrap.appendChild(title);
    wrap.appendChild(detail);
    host.appendChild(wrap);
  }

  function renderForKind(tab: Tab, kind: FileKind) {
    clear();
    if (kind === "audio") void renderAudio(tab);
    else if (kind === "image") void renderImage(tab);
    else renderBinary(tab);
  }

  return {
    show(tab: Tab) {
      host.classList.remove("hidden");
      renderForKind(tab, tab.kind);
    },
    hide() {
      host.classList.add("hidden");
      clear();
    },
  };
}
