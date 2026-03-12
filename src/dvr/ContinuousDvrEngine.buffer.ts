// src/dvr/ContinuousDvrEngine.buffer.ts
// ======================================================
//
// Buffer / append helpers for ContinuousDvrEngine.
//
// This file owns the low-level SourceBuffer append/reset helpers used by the
// live DVR engine.
//
// Important:
// - no replay policy here
// - no UI logic here
// - no session ownership here
//

export type BufferedRange = {
  start: number;
  end: number;
};

export type ContinuousDvrBufferState = {
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  video: HTMLVideoElement | null;

  queue: Blob[];
  flushing: boolean;
  resetting: boolean;

  initSegment: Blob | null;
  initAppended: boolean;
  appendedCount: number;
};

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function waitForSourceBufferUpdateEnd(
  sourceBuffer: SourceBuffer
): Promise<void> {
  if (!sourceBuffer.updating) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handler = () => {
      sourceBuffer.removeEventListener("updateend", handler);
      resolve();
    };

    sourceBuffer.addEventListener("updateend", handler);
  });
}

export function getSourceBufferRange(
  sourceBuffer: SourceBuffer
): BufferedRange | null {
  try {
    const buffered = sourceBuffer.buffered;
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

/**
 * Conservative duration sync for MSE live/DVR mode.
 *
 * Important rule:
 * - NEVER shrink duration here.
 *
 * Why:
 * In live DVR flows, Chrome/MSE may reject duration reductions with:
 * "Failed to set the 'duration' property on 'MediaSource':
 *  Setting duration below highest presentation timestamp..."
 *
 * For this engine we only want a best-effort forward sync, never an aggressive
 * clamp to buffered.end on every append.
 */
export function syncDurationToBufferedEnd(args: {
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  log?: (...args: unknown[]) => void;
}): void {
  const { mediaSource, sourceBuffer, log } = args;

  if (!mediaSource || !sourceBuffer) {
    return;
  }

  if (mediaSource.readyState !== "open") {
    return;
  }

  const range = getSourceBufferRange(sourceBuffer);
  if (!range) {
    return;
  }

  const targetDuration = range.end;

  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    return;
  }

  try {
    const currentDuration = mediaSource.duration;

    // If duration is NaN/Infinity/invalid, allow bootstrap set once.
    if (!Number.isFinite(currentDuration) || currentDuration <= 0) {
      mediaSource.duration = targetDuration;
      return;
    }

    // Critical fix:
    // never attempt to reduce duration here.
    // Only grow it if buffered end clearly surpassed current duration.
    if (targetDuration > currentDuration + 0.25) {
      mediaSource.duration = targetDuration;
    }
  } catch (error) {
    log?.("syncDurationToBufferedEnd failed", { error, targetDuration });
  }
}

function isSameBlob(
  a: Blob | null | undefined,
  b: Blob | null | undefined
): boolean {
  return !!a && !!b && a === b;
}

function describeAppendError(error: unknown): {
  name: string;
  message: string;
  retryable: boolean;
} {
  const name =
    error instanceof DOMException
      ? error.name
      : error instanceof Error
      ? error.name
      : "UnknownError";

  const message =
    error instanceof DOMException || error instanceof Error
      ? error.message
      : String(error);

  // These tend to be transient / lifecycle-related and are usually
  // safe to retry later without consuming queue order.
  const retryable =
    name === "InvalidStateError" ||
    name === "QuotaExceededError" ||
    name === "OperationError" ||
    name === "AbortError";

  return { name, message, retryable };
}

export async function flushBuffer(args: {
  state: ContinuousDvrBufferState;
  token: number;
  isSuperseded: (token: number) => boolean;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const { state, token, isSuperseded, log } = args;

  // requestFlush() already owns flush concurrency.
  // Do not abort just because state.flushing is true here.
  if (state.resetting) {
    return;
  }

  const sourceBuffer = state.sourceBuffer;
  const mediaSource = state.mediaSource;

  if (!sourceBuffer || !mediaSource) {
    return;
  }

  if (mediaSource.readyState !== "open") {
    log?.("flush aborted: mediaSource not open", {
      readyState: mediaSource.readyState,
      queueLength: state.queue.length,
    });
    return;
  }

  state.flushing = true;

  try {
    while (state.queue.length > 0) {
      /*console.error("[FB-TRACE] flush loop", {
        queueLength: state.queue.length,
        appendedCount: state.appendedCount,
        hasInit: !!state.initSegment,
        initAppended: state.initAppended,
        sourceBufferUpdating: state.sourceBuffer?.updating ?? null,
      });
      */

      if (isSuperseded(token)) {
        return;
      }

      const currentMediaSource = state.mediaSource;
      const currentSourceBuffer = state.sourceBuffer;

      if (!currentMediaSource || !currentSourceBuffer) {
        log?.("flush aborted during loop: missing mediaSource/sourceBuffer", {
          hasMediaSource: !!currentMediaSource,
          hasSourceBuffer: !!currentSourceBuffer,
          queueLength: state.queue.length,
        });
        return;
      }

      if (currentMediaSource.readyState !== "open") {
        log?.("flush aborted during loop: mediaSource not open", {
          readyState: currentMediaSource.readyState,
          queueLength: state.queue.length,
        });
        return;
      }

      const video = state.video;
      if (video?.error) {
        log?.("flush aborted: video.error present", {
          code: video.error.code,
          message: video.error.message,
          queueLength: state.queue.length,
          currentTime: video.currentTime,
          readyState: video.readyState,
        });
        return;
      }

      await waitForSourceBufferUpdateEnd(currentSourceBuffer);

      if (isSuperseded(token)) {
        return;
      }

      const afterWaitMediaSource = state.mediaSource;
      const afterWaitSourceBuffer = state.sourceBuffer;

      if (!afterWaitMediaSource || !afterWaitSourceBuffer) {
        log?.("flush aborted after wait: missing mediaSource/sourceBuffer", {
          hasMediaSource: !!afterWaitMediaSource,
          hasSourceBuffer: !!afterWaitSourceBuffer,
          queueLength: state.queue.length,
        });
        return;
      }

      if (afterWaitMediaSource.readyState !== "open") {
        log?.("flush aborted after wait: mediaSource not open", {
          readyState: afterWaitMediaSource.readyState,
          queueLength: state.queue.length,
        });
        return;
      }

      if (afterWaitSourceBuffer.updating) {
        log?.("flush deferred: sourceBuffer still updating after wait", {
          queueLength: state.queue.length,
          appendedCount: state.appendedCount,
        });
        return;
      }

      const blob = state.queue[0];
      if (!blob) {
        break;
      }

      const isInitBlob = isSameBlob(blob, state.initSegment);

      if (isInitBlob && state.initAppended) {
        state.queue.shift();

        log?.("duplicate init dropped from queue", {
          blobSize: blob.size,
          queueLength: state.queue.length,
        });

        continue;
      }

      const bytes = await blob.arrayBuffer();

      if (isSuperseded(token)) {
        return;
      }

      const recheckMediaSource = state.mediaSource;
      const recheckSourceBuffer = state.sourceBuffer;

      if (!recheckMediaSource || !recheckSourceBuffer) {
        log?.("append aborted after blob read: missing mediaSource/sourceBuffer", {
          queueLength: state.queue.length,
        });
        return;
      }

      if (recheckMediaSource.readyState !== "open") {
        log?.("append aborted after blob read: mediaSource not open", {
          readyState: recheckMediaSource.readyState,
          queueLength: state.queue.length,
        });
        return;
      }

      if (recheckSourceBuffer.updating) {
        log?.("append aborted after blob read: sourceBuffer updating", {
          queueLength: state.queue.length,
          appendedCount: state.appendedCount,
        });
        return;
      }

      const currentVideo = state.video;
      if (currentVideo?.error) {
        log?.("append skipped: video.error present before append", {
          code: currentVideo.error.code,
          message: currentVideo.error.message,
          blobSize: blob.size,
          isInit: isInitBlob,
          currentTime: currentVideo.currentTime,
          readyState: currentVideo.readyState,
        });
        return;
      }

      const beforeAppendMediaSource = state.mediaSource;
      const beforeAppendSourceBuffer = state.sourceBuffer;

      if (!beforeAppendMediaSource || !beforeAppendSourceBuffer) {
        log?.("append skipped: missing mediaSource/sourceBuffer before append", {
          hasMediaSource: !!beforeAppendMediaSource,
          hasSourceBuffer: !!beforeAppendSourceBuffer,
          blobSize: blob.size,
          isInit: isInitBlob,
        });
        return;
      }

      if (beforeAppendMediaSource.readyState !== "open") {
        log?.("append skipped: mediaSource not open before append", {
          readyState: beforeAppendMediaSource.readyState,
          blobSize: blob.size,
          isInit: isInitBlob,
        });
        return;
      }

      if (beforeAppendSourceBuffer.updating) {
        log?.("append skipped: sourceBuffer updating before append", {
          blobSize: blob.size,
          isInit: isInitBlob,
          queueLength: state.queue.length,
          appendedCount: state.appendedCount,
        });
        return;
      }
      /*
      console.error("[FB-TRACE] append attempt", {
        blobSize: blob.size,
        isInit: isInitBlob,
        queueLength: state.queue.length,
        appendedCount: state.appendedCount,
      });
      */
      try {
        beforeAppendSourceBuffer.appendBuffer(bytes);
      } catch (error) {
        const described = describeAppendError(error);

        console.warn("[Flashback][DvrEngine] appendBuffer failed", {
          ...described,
          blobSize: blob.size,
          isInit: isInitBlob,
          queueLength: state.queue.length,
          appendedCount: state.appendedCount,
        });

        log?.("appendBuffer failed: blob kept in queue", {
          blobSize: blob.size,
          isInit: isInitBlob,
          queueLength: state.queue.length,
          appendedCount: state.appendedCount,
          errorName: described.name,
          errorMessage: described.message,
          retryable: described.retryable,
          mediaSourceReadyState: beforeAppendMediaSource.readyState,
          sourceBufferUpdating: beforeAppendSourceBuffer.updating,
          rangeBeforeFailure: getSourceBufferRange(beforeAppendSourceBuffer),
        });

        return;
      }

      await waitForSourceBufferUpdateEnd(beforeAppendSourceBuffer);

      if (isSuperseded(token)) {
        return;
      }

      state.queue.shift();

      if (isInitBlob) {
        state.initAppended = true;

        log?.("init segment appended", {
          size: blob.size,
          type: blob.type,
          queueLength: state.queue.length,
        });
      } else {
        state.appendedCount++;

        log?.("media segment appended", {
          size: blob.size,
          type: blob.type,
          appendedCount: state.appendedCount,
          queueLength: state.queue.length,
        });
      }
      /*
      console.error("[FB-TRACE] append success", {
        isInit: isInitBlob,
        appendedCount: state.appendedCount,
        queueLength: state.queue.length,
      });
      */
      syncDurationToBufferedEnd({
        mediaSource: state.mediaSource,
        sourceBuffer: state.sourceBuffer,
        log,
      });

      const rangeAfterAppend =
        state.sourceBuffer ? getSourceBufferRange(state.sourceBuffer) : null;

      log?.("buffer range after append", {
        isInit: isInitBlob,
        range: rangeAfterAppend,
        appendedCount: state.appendedCount,
        queueLength: state.queue.length,
      });
    }
  } finally {
    state.flushing = false;
  }
}

export async function resetBufferedState(args: {
  state: ContinuousDvrBufferState;
  token: number;
  reason: string;
  isSuperseded: (token: number) => boolean;
  onAfterReset?: () => Promise<void> | void;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const { state, token, reason, isSuperseded, onAfterReset, log } = args;

  if (state.resetting) {
    return;
  }

  const sourceBuffer = state.sourceBuffer;
  const mediaSource = state.mediaSource;

  if (!sourceBuffer || !mediaSource) {
    await onAfterReset?.();
    return;
  }

  state.resetting = true;

  try {
    await waitForSourceBufferUpdateEnd(sourceBuffer);

    if (isSuperseded(token)) {
      return;
    }

    const currentMediaSource = state.mediaSource;
    const currentSourceBuffer = state.sourceBuffer;

    if (!currentMediaSource || !currentSourceBuffer) {
      state.initAppended = false;
      state.appendedCount = 0;

      log?.("buffered state reset skipped: missing mediaSource/sourceBuffer", {
        reason,
        hasMediaSource: !!currentMediaSource,
        hasSourceBuffer: !!currentSourceBuffer,
        hasInitSegment: !!state.initSegment,
        queueLength: state.queue.length,
      });

      return;
    }

    if (currentMediaSource.readyState !== "open") {
      state.initAppended = false;
      state.appendedCount = 0;

      log?.("buffered state reset skipped: mediaSource not open", {
        reason,
        readyState: currentMediaSource.readyState,
        hasInitSegment: !!state.initSegment,
        queueLength: state.queue.length,
      });

      return;
    }

    const range = getSourceBufferRange(currentSourceBuffer);

    if (range) {
      try {
        currentSourceBuffer.remove(range.start, range.end);
        await waitForSourceBufferUpdateEnd(currentSourceBuffer);
      } catch (error) {
        console.warn("[Flashback][DvrEngine] buffered remove failed", {
          reason,
          error,
        });
      }
    }

    if (isSuperseded(token)) {
      return;
    }

    try {
      if (currentMediaSource.readyState === "open") {
        // Defensive:
        // duration reset is best-effort only. After removals, some browsers
        // may still reject hard duration changes depending on internal MSE state.
        currentMediaSource.duration = 0;
      }
    } catch (error) {
      log?.("duration reset failed", { reason, error });
    }

    state.initAppended = false;
    state.appendedCount = 0;

    log?.("buffered state reset", {
      reason,
      hasInitSegment: !!state.initSegment,
      queueLength: state.queue.length,
    });
  } finally {
    state.resetting = false;
  }

  await onAfterReset?.();
}