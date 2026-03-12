// src/dvr/ContinuousDvrEngine.video.ts
// ======================================================
//
// Video / MediaSource ownership helpers for ContinuousDvrEngine.
//
// This file contains the low-level attach/detach behavior for the
// live DVR engine target video element.
//
// Important:
// - no replay policy here
// - no snapshot logic here
// - no session ownership here
//

export type ContinuousDvrVideoState = {
  video: HTMLVideoElement | null;
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  objectUrl: string | null;
  attachToken: number;
};

export function revokeObjectUrl(state: ContinuousDvrVideoState): void {
  if (!state.objectUrl) {
    return;
  }

  try {
    URL.revokeObjectURL(state.objectUrl);
  } catch {}

  state.objectUrl = null;
}

export function detachVideo(state: ContinuousDvrVideoState): void {
  state.attachToken++;

  const video = state.video;

  if (video) {
    try {
      video.pause();
    } catch {}

    try {
      video.removeAttribute("src");
    } catch {}

    try {
      video.src = "";
    } catch {}

    try {
      video.srcObject = null;
    } catch {}

    try {
      video.load();
    } catch {}
  }

  revokeObjectUrl(state);

  state.video = null;
  state.mediaSource = null;
  state.sourceBuffer = null;
}

export function attachVideo(
  state: ContinuousDvrVideoState,
  video: HTMLVideoElement
): number {
  detachVideo(state);

  const token = ++state.attachToken;

  state.video = video;

  const mediaSource = new MediaSource();
  state.mediaSource = mediaSource;

  const objectUrl = URL.createObjectURL(mediaSource);
  state.objectUrl = objectUrl;

  try {
    video.pause();
  } catch {}

  try {
    video.srcObject = null;
  } catch {}

  try {
    video.removeAttribute("src");
  } catch {}

  try {
    video.src = "";
  } catch {}

  try {
    video.load();
  } catch {}

  video.src = objectUrl;
  video.preload = "auto";

  return token;
}