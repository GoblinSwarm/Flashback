// src/dvr/ContinuousDvrEngine.attach.ts
// ======================================================
//
// Attach / detach helpers for ContinuousDvrEngine.
//
// This file owns low-level HTMLVideoElement + MediaSource
// attachment cleanup helpers.
//
// Important:
// - no replay policy here
// - no DVR buffering policy here
// - no UI logic here
// - no session ownership here
//

export type ContinuousDvrAttachState = {
  video: HTMLVideoElement | null;
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  objectUrl: string | null;
};

export type AttachVideoArgs = {
  state: ContinuousDvrAttachState;
  video: HTMLVideoElement;
};

export type DetachVideoArgs = {
  state: ContinuousDvrAttachState;
};

function resetVideoElement(video: HTMLVideoElement): void {
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
    video.currentTime = 0;
  } catch {}

  try {
    video.load();
  } catch {}

  // Keep replay element in a neutral baseline.
  video.muted = true;
  video.autoplay = true;
  video.controls = false;
  video.playsInline = true;
  video.preload = "auto";
}

function prepareVideoForAttach(video: HTMLVideoElement): void {
  // Attach should start from a clean media element baseline.
  resetVideoElement(video);
}

function prepareVideoForDetach(video: HTMLVideoElement): void {
  // Important:
  // detach here should be lighter than attach/terminal cleanup.
  // ReplayCoordinator already performs explicit cleanup around
  // terminal transitions, so we avoid another full reset storm here.
  try {
    video.pause();
  } catch {}

  try {
    video.srcObject = null;
  } catch {}

  video.muted = true;
  video.autoplay = true;
  video.controls = false;
  video.playsInline = true;
  video.preload = "auto";
}

function revokeObjectUrl(objectUrl: string | null): string | null {
  if (!objectUrl) {
    return null;
  }

  try {
    URL.revokeObjectURL(objectUrl);
  } catch {}

  return null;
}

export function attachVideo(args: AttachVideoArgs): ContinuousDvrAttachState {
  const { state, video } = args;

  // Defensive cleanup of any previous attach artifacts.
  if (state.objectUrl) {
    state.objectUrl = revokeObjectUrl(state.objectUrl);
  }

  prepareVideoForAttach(video);

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  state.video = video;
  state.mediaSource = mediaSource;
  state.sourceBuffer = null;
  state.objectUrl = objectUrl;

  try {
    video.src = objectUrl;
  } catch {
    // keep state assigned; caller will fail later if sourceopen never happens
  }

  video.preload = "auto";

  return state;
}

export function detachVideo(args: DetachVideoArgs): ContinuousDvrAttachState {
  const { state } = args;
  const { video, objectUrl } = state;

  if (video) {
    prepareVideoForDetach(video);
  }

  state.objectUrl = revokeObjectUrl(objectUrl);

  state.video = null;
  state.mediaSource = null;
  state.sourceBuffer = null;
  state.objectUrl = null;

  return state;
}