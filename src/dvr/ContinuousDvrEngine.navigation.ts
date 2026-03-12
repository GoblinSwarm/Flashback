// src/dvr/ContinuousDvrEngine.navigation.ts
// ======================================================
//
// Navigation / buffered-window helpers for ContinuousDvrEngine.
//
// This file owns the buffered-range queries and time navigation helpers
// used by the live DVR engine.
//
// Architecture role
// -----------------
//
// This module belongs to the **DVR / Playback boundary**.
//
// It exists ONLY to provide:
//
// - buffered range reads
// - buffered window waiting
// - safe DVR seeking helpers
// - playable-duration helpers
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - attach MediaSource
// - create SourceBuffer
// - append blobs
// - own replay session lifecycle
// - own UI logic
// - choose replay policy
//
// Those responsibilities belong elsewhere.
//
// Design rule
// -----------
//
// Keep this file focused on read/navigation helpers over an already
// existing live DVR buffer state.
//
// If MediaSource construction, append policy, replay orchestration,
// or UI work starts appearing here, the architecture is being violated.
//

import {
  getSourceBufferRange,
  sleepMs,
  type BufferedRange,
} from "./ContinuousDvrEngine.buffer";

export type ContinuousDvrNavigationState = {
  video: HTMLVideoElement | null;
  sourceBuffer: SourceBuffer | null;
};

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function getVideoBufferedRange(video: HTMLVideoElement | null): BufferedRange | null {
  if (!video) {
    return null;
  }

  try {
    const buffered = video.buffered;
    if (!buffered || buffered.length <= 0) {
      return null;
    }

    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    return { start, end };
  } catch {
    return null;
  }
}

function getSafeEnd(range: BufferedRange, endSafetyPadSec: number): number {
  return Math.max(range.start, range.end - Math.max(0, endSafetyPadSec));
}

function getSafeStart(range: BufferedRange, startSafetyLeadSec: number): number {
  return Math.min(
    range.end,
    Math.max(range.start, range.start + Math.max(0, startSafetyLeadSec))
  );
}

export function getBufferedRange(args: {
  state: ContinuousDvrNavigationState;
}): BufferedRange | null {
  const { state } = args;

  const sourceBufferRange = state.sourceBuffer
    ? getSourceBufferRange(state.sourceBuffer)
    : null;

  if (sourceBufferRange) {
    return sourceBufferRange;
  }

  return getVideoBufferedRange(state.video);
}

export function computeSeekBackTarget(args: {
  range: BufferedRange;
  ms: number;
  endSafetyPadSec?: number;
  startSafetyLeadSec?: number;
}): number | null {
  const {
    range,
    ms,
    endSafetyPadSec = 0.05,
    startSafetyLeadSec = 0.1,
  } = args;

  const normalizedMs = Math.max(0, Number(ms) || 0);
  const seconds = normalizedMs / 1000;

  const safeStart = getSafeStart(range, startSafetyLeadSec);
  const safeEnd = getSafeEnd(range, endSafetyPadSec);

  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
    return null;
  }

  if (safeEnd <= safeStart) {
    return safeStart;
  }

  const usableWindow = safeEnd - safeStart;
  if (!Number.isFinite(usableWindow) || usableWindow <= 0) {
    return safeStart;
  }

  let target = safeEnd - seconds;

  // If the requested offset does not fit in the current buffer,
  // land on the safe start instead of the raw start edge.
  if (target < safeStart) {
    target = safeStart;
  }

  // Avoid landing too close to the exact buffered end.
  const maxTarget = Math.max(
    safeStart,
    safeEnd - Math.min(0.05, Math.max(0.01, usableWindow * 0.02))
  );

  return clamp(target, safeStart, maxTarget);
}

export function seekBack(args: {
  state: ContinuousDvrNavigationState;
  ms: number;
  endSafetyPadSec?: number;
  startSafetyLeadSec?: number;
}): void {
  const {
    state,
    ms,
    endSafetyPadSec = 0.05,
    startSafetyLeadSec = 0.1,
  } = args;

  const video = state.video;
  if (!video) {
    return;
  }

  if (video.error) {
    return;
  }

  let range = getBufferedRange({ state });

  // ------------------------------------------------------------------
  // PATCH: tolerate early seek before buffered range exists
  // ------------------------------------------------------------------
  if (!range) {
    try {
      const buffered = video.buffered;
      if (buffered && buffered.length > 0) {
        const start = buffered.start(0);
        const end = buffered.end(buffered.length - 1);

        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          range = { start, end };
        }
      }
    } catch {}
  }

  // If still no range, seek to 0 to kick playback bootstrap.
  if (!range) {
    try {
      video.currentTime = 0;
    } catch {}
    return;
  }

  const target = computeSeekBackTarget({
    range,
    ms,
    endSafetyPadSec,
    startSafetyLeadSec,
  });

  if (target == null || !Number.isFinite(target)) {
    return;
  }

  try {
    video.currentTime = target;
  } catch {
    // defensive: do nothing
  }
}

export function seekToSec(args: {
  state: ContinuousDvrNavigationState;
  sec: number;
  endSafetyPadSec?: number;
  startSafetyLeadSec?: number;
}): void {
  const {
    state,
    sec,
    endSafetyPadSec = 0.05,
    startSafetyLeadSec = 0.1,
  } = args;

  const video = state.video;
  if (!video) {
    return;
  }

  if (video.error) {
    return;
  }

  const range = getBufferedRange({ state });
  if (!range) {
    return;
  }

  const safeStart = getSafeStart(range, startSafetyLeadSec);
  const safeEnd = getSafeEnd(range, endSafetyPadSec);
  const target = clamp(Number(sec), safeStart, safeEnd);

  try {
    video.currentTime = target;
  } catch {
    // defensive: do nothing
  }
}

export async function waitForBufferedWindow(args: {
  state: ContinuousDvrNavigationState;
  token: number;
  minWindowSec: number;
  isSuperseded: (token: number) => boolean;
  timeoutMs?: number;
}): Promise<BufferedRange | null> {
  const {
    state,
    token,
    minWindowSec,
    isSuperseded,
    timeoutMs = 6000
  } = args;

  const normalizedTimeoutMs = Math.max(
    200,
    Math.min(15000, Math.trunc(Number(timeoutMs) || 6000))
  );

  const minWindow = Math.max(0.05, Number(minWindowSec) || 0);
  const startedAt = Date.now();

  while (Date.now() - startedAt < normalizedTimeoutMs) {
    if (isSuperseded(token)) {
      return null;
    }

    const video = state.video;
    if (video?.error) {
      return null;
    }

    const range = getBufferedRange({ state });

    if (
      range &&
      Number.isFinite(range.start) &&
      Number.isFinite(range.end) &&
      range.end > range.start
    ) {
      const windowSec = range.end - range.start;

      if (windowSec >= minWindow) {
        return range;
      }
    }

    await sleepMs(40);
  }

  return null;
}

export function getPlayableDurationSec(args: {
  state: ContinuousDvrNavigationState;
}): number {
  const { state } = args;

  const video = state.video;
  if (video?.error) {
    return 0;
  }

  const range = getBufferedRange({ state });
  if (!range) {
    return 0;
  }

  const duration = range.end - range.start;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export type { BufferedRange };