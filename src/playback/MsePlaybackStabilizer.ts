// src/playback/MsePlaybackStabilizer.ts
// ======================================================
//
// MsePlaybackStabilizer
// --------------------
//
// Lightweight post-attach playback stabilizer for MSE
// snapshot playback.
//
// Architecture role
// -----------------
//
// This helper belongs to the Playback Layer, but it is
// intentionally narrow.
//
// It exists ONLY to stabilize an already-attached
// HTMLVideoElement after MSE snapshot append has finished.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - waiting for basic ready events after attach
// - reading buffered ranges from the HTMLVideoElement
// - choosing a safe initial seek target
// - attempting autoplay best-effort
// - verifying that playback actually progresses
// - applying a small recovery kick if playback stalls
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - create MediaSource
// - create or manage SourceBuffer
// - append init/media segments
// - own replay lifecycle
// - implement live DVR ingest
// - perform routing decisions
//
// Those responsibilities belong to:
//
//   MsePlayer
//   PlaybackRouter
//   Replay / Session layer
//
// Design rule
// -----------
//
// This helper is strictly a post-attach stabilizer.
// If MediaSource lifecycle or append orchestration starts
// appearing here, the architecture is being violated.
//

export type BufferedRange = {
  start: number;
  end: number;
};

export type MsePlaybackStabilizerOptions = {
  autoplay?: boolean;
  debug?: boolean;
  waitForReadyTimeoutMs?: number;
  progressTimeoutMs?: number;
  kickFreezeMs?: number;
  minUsableWindowSec?: number;
  liveEdgeEpsilonSec?: number;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readBufferedTailRange(video: HTMLVideoElement): BufferedRange | null {
  try {
    const ranges = video.buffered;
    if (!ranges || ranges.length <= 0) {
      return null;
    }

    let index = ranges.length - 1;
    let start = ranges.start(index);
    let end = ranges.end(index);

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }

    if (start < 0) start = 0;
    if (end <= start) return null;

    const minWindowSec = 0.08;
    let windowSec = end - start;

    if (windowSec < minWindowSec && index > 0) {
      try {
        const prevStart = ranges.start(index - 1);
        const prevEnd = ranges.end(index - 1);

        if (
          Number.isFinite(prevStart) &&
          Number.isFinite(prevEnd) &&
          prevEnd > prevStart
        ) {
          start = prevStart;
          end = prevEnd;
          windowSec = end - start;
        }
      } catch {}
    }

    if (!Number.isFinite(windowSec) || windowSec < minWindowSec) {
      return null;
    }

    return { start, end };
  } catch {
    return null;
  }
}

function waitForAnyEvent(
  target: EventTarget,
  eventNames: string[],
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const cleanups: Array<() => void> = [];

    const finish = (eventName: string | null) => {
      if (done) return;
      done = true;

      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {}
      }

      if (timer != null) {
        window.clearTimeout(timer);
      }

      resolve(eventName);
    };

    for (const eventName of eventNames) {
      const handler = () => finish(eventName);
      target.addEventListener(eventName, handler, { once: true });
      cleanups.push(() => {
        try {
          target.removeEventListener(eventName, handler);
        } catch {}
      });
    }

    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => finish(null), timeoutMs)
        : null;
  });
}

async function waitForReadyStateOrEvents(
  video: HTMLVideoElement,
  timeoutMs: number
): Promise<void> {
  const readyState = Number(video.readyState || 0);
  if (readyState >= 1) {
    return;
  }

  await waitForAnyEvent(
    video,
    ["loadedmetadata", "loadeddata", "canplay"],
    timeoutMs
  );
}

async function waitForUsableBufferedRange(
  video: HTMLVideoElement,
  minUsableWindowSec: number,
  timeoutMs: number
): Promise<BufferedRange | null> {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    const range = readBufferedTailRange(video);
    if (range && range.end - range.start >= minUsableWindowSec) {
      return range;
    }

    await sleepMs(40);
  }

  const finalRange = readBufferedTailRange(video);
  if (finalRange && finalRange.end - finalRange.start > 0) {
    return finalRange;
  }

  return null;
}

function pickSafeStartTime(
  range: BufferedRange,
  liveEdgeEpsilonSec: number
): number {
  const window = range.end - range.start;

  // snapshot playback → prefer start of window
  if (window > 0.5) {
    const target = range.start + 0.02;
    return clamp(target, range.start, range.end);
  }

  // tiny windows fallback
  const safeTarget = Math.max(range.start, range.end - liveEdgeEpsilonSec);

  if (!Number.isFinite(safeTarget)) {
    return range.start;
  }

  return clamp(safeTarget, range.start, range.end);
}

function seekIntoRange(
  video: HTMLVideoElement,
  range: BufferedRange,
  liveEdgeEpsilonSec: number
): void {
  const safeTarget = pickSafeStartTime(range, liveEdgeEpsilonSec);

  try {
    const currentTime = video.currentTime;
    if (
      Number.isFinite(currentTime) &&
      currentTime >= range.start &&
      currentTime <= range.end
    ) {
      return;
    }
  } catch {}

  try {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = safeTarget;
    } else {
      video.currentTime = Math.max(range.start, Math.min(safeTarget, 0.001));
    }
  } catch {}
}

async function verifyPlaybackProgress(
  video: HTMLVideoElement,
  range: BufferedRange,
  progressTimeoutMs: number,
  debug = false
): Promise<boolean> {
  const startedAt = performance.now();

  const initialTime = (() => {
    try {
      const currentTime = video.currentTime;
      return Number.isFinite(currentTime) ? currentTime : range.start;
    } catch {
      return range.start;
    }
  })();

  while (performance.now() - startedAt < progressTimeoutMs) {
    await sleepMs(80);

    try {
      const currentTime = video.currentTime;
      const readyState = Number(video.readyState || 0);

      if (Number.isFinite(currentTime) && currentTime > initialTime + 0.02) {
        return true;
      }

      if (
        !video.paused &&
        readyState >= 3 &&
        Number.isFinite(currentTime) &&
        currentTime >= range.start &&
        currentTime <= range.end
      ) {
        return true;
      }
    } catch {}
  }

  if (debug) {
    try {
      console.warn("[Flashback][MsePlaybackStabilizer] progress timeout", {
        initialTime,
        currentTime: (() => {
          try {
            return video.currentTime;
          } catch {
            return NaN;
          }
        })(),
        readyState: (() => {
          try {
            return video.readyState;
          } catch {
            return 0;
          }
        })(),
        range,
      });
    } catch {}
  }

  return false;
}

function tryKickPlayback(
  video: HTMLVideoElement,
  range: BufferedRange,
  liveEdgeEpsilonSec: number,
  debug = false
): void {
  const target = pickSafeStartTime(range, liveEdgeEpsilonSec);

  try {
    const currentTime = video.currentTime;

    if (
      !Number.isFinite(currentTime) ||
      currentTime < range.start ||
      currentTime > range.end
    ) {
      video.currentTime = target;
      return;
    }

    if (range.end - currentTime < 0.01) {
      video.currentTime = target;
    }
  } catch {}

  if (debug) {
    try {
      console.log("[Flashback][MsePlaybackStabilizer] kick", {
        target,
        range,
      });
    } catch {}
  }
}

export async function stabilizeMsePlayback(
  video: HTMLVideoElement,
  options?: MsePlaybackStabilizerOptions
): Promise<void> {
  const autoplay = options?.autoplay ?? true;
  const debug = options?.debug ?? false;
  const waitForReadyTimeoutMs = Math.max(
    250,
    Math.min(5000, options?.waitForReadyTimeoutMs ?? 2500)
  );
  const progressTimeoutMs = Math.max(
    400,
    Math.min(6000, options?.progressTimeoutMs ?? 1400)
  );
  const kickFreezeMs = Math.max(
    250,
    Math.min(5000, options?.kickFreezeMs ?? 900)
  );
  const minUsableWindowSec = clamp(
    options?.minUsableWindowSec ?? 0.2,
    0.08,
    3
  );
  const liveEdgeEpsilonSec = clamp(
    options?.liveEdgeEpsilonSec ?? 0.08,
    0.02,
    0.25
  );

  await waitForReadyStateOrEvents(video, waitForReadyTimeoutMs);

  const range = await waitForUsableBufferedRange(
    video,
    minUsableWindowSec,
    waitForReadyTimeoutMs
  );

  if (!range) {
    if (debug) {
      try {
        console.warn(
          "[Flashback][MsePlaybackStabilizer] no usable buffered range"
        );
      } catch {}
    }
    return;
  }

  seekIntoRange(video, range, liveEdgeEpsilonSec);

  if (!autoplay) {
    return;
  }

  try {
    await video.play();
  } catch {
    // best-effort autoplay only
  }

  const progressed = await verifyPlaybackProgress(
    video,
    range,
    progressTimeoutMs,
    debug
  );

  if (progressed) {
    return;
  }

  tryKickPlayback(video, range, liveEdgeEpsilonSec, debug);

  await sleepMs(kickFreezeMs);

  try {
    await video.play();
  } catch {
    // best-effort autoplay only
  }

  await verifyPlaybackProgress(video, range, progressTimeoutMs, debug);
}