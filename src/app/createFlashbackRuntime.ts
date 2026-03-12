// src/app/createFlashbackRuntime.ts
// ======================================================
//
// createFlashbackRuntime
// ----------------------
//
// Composition root for the refactored Flashback runtime.
//
// This module is responsible for wiring together the
// main runtime layers:
//
// - Capture layer
// - DVR layer
// - Snapshot layer
// - Replay layer
// - Playback layer
// - UI layer
//
// Architecture role
// -----------------
//
// createFlashbackRuntime belongs to the **Application
// Composition Layer**.
//
// It acts as the assembly boundary for the runtime used
// by the content script. Its job is to instantiate and
// connect the modules that form the Flashback pipeline.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - creating runtime dependencies
// - wiring the runtime layers together
// - returning a structured FlashbackRuntime object
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - implement capture logic
// - implement DVR logic
// - implement snapshot building logic
// - implement replay logic
// - implement playback logic
// - implement UI internals
// - own runtime start/stop lifecycle policy
//
// Those responsibilities belong to the concrete modules
// instantiated here and to the content runtime layer.
//

import { FlashbackRecorder } from "../capture/FlashbackRecorder";
import { ContinuousDvrBridge } from "../dvr/ContinuousDvrBridge";
import { ContinuousDvrPipeline } from "../dvr/ContinuousDvrPipeline";
import { ContinuousDvrRuntime } from "../dvr/ContinuousDvrRuntime";
import { ContinuousDvrEngine } from "../dvr/ContinuousDvrEngine";

import { DvrSnapshotBuilder } from "../snapshot/DvrSnapshotBuilder";

import { ReplaySessionManager } from "../replay/ReplaySessionManager";
import { ReplayCoordinator } from "../replay/ReplayCoordinator";

import { FlashbackController } from "../controller/FlashbackController";

import { BlobPlayer } from "../playback/BlobPlayer";
import { MsePlayer } from "../playback/MsePlayer";
import { PlaybackRouter } from "../playback/PlaybackRouter";
import type { VideoAttachResult } from "../playback/VideoAttach";

import { UIOrchestrator } from "../ui/UIOrchestrator";
import type { ReplaySession } from "../replay/ReplaySession";
import type { BufferedRange } from "../dvr/ContinuousDvrEngine";

export type FlashbackRuntime = {
  recorder: FlashbackRecorder;

  dvrBridge: ContinuousDvrBridge;
  dvrPipeline: ContinuousDvrPipeline;
  dvrEngine: ContinuousDvrEngine;
  dvrRuntime: ContinuousDvrRuntime;

  snapshotBuilder: DvrSnapshotBuilder;

  replaySessionManager: ReplaySessionManager;
  replayCoordinator: ReplayCoordinator;

  controller: FlashbackController;

  blobPlayer: BlobPlayer;
  msePlayer: MsePlayer;
  playbackRouter: PlaybackRouter;

  ui: UIOrchestrator;
};

function createContinuousDvrAttachResult(
  attached: boolean,
  reason?: string | null
): VideoAttachResult {
  return {
    attached,
    path: "continuous_dvr",
    reason: reason ?? null,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function feedPipelineIntoEngine(args: {
  dvrPipeline: ContinuousDvrPipeline;
  dvrEngine: ContinuousDvrEngine;
  debug: boolean;
}): {
  pushedInit: boolean;
  pushedMediaCount: number;
} {
  const { dvrPipeline, dvrEngine, debug } = args;

  const initSegment = dvrPipeline.getInitSegment();
  const mediaEntries = dvrPipeline.getMediaEntries();

  let pushedInit = false;
  let pushedMediaCount = 0;

  if (initSegment) {
    dvrEngine.pushBlob(initSegment, { isInit: true });
    pushedInit = true;
  }

  for (const entry of mediaEntries) {
    dvrEngine.pushBlob(entry.blob, {
      isInit: false,
    });
    pushedMediaCount++;
  }

  if (debug) {
    console.log("[Flashback][createFlashbackRuntime] pipeline fed into engine", {
      pushedInit,
      pushedMediaCount,
      pipelineWindowMs: dvrPipeline.getEstimatedWindowMs(),
      engineDebug: dvrEngine.getDebugState(),
    });
  }

  return {
    pushedInit,
    pushedMediaCount,
  };
}

function getRangeWindowSec(range: BufferedRange | null): number {
  if (!range) return 0;

  const start = Number(range.start);
  const end = Number(range.end);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  return end - start;
}

function computeRequiredWindowSec(args: {
  requestedDurationSec: number;
  pipelineWindowMs: number;
}): number {
  const { requestedDurationSec, pipelineWindowMs } = args;

  const pipelineWindowSec = Math.max(0, Number(pipelineWindowMs || 0) / 1000);

  if (pipelineWindowSec > 0) {
    return Math.max(1.25, Math.min(requestedDurationSec, pipelineWindowSec));
  }

  return Math.max(1.25, requestedDurationSec);
}

async function waitForUsableDvrWindow(args: {
  dvrEngine: ContinuousDvrEngine;
  requestedDurationSec: number;
  pipelineWindowMs: number;
  timeoutMs: number;
  debug: boolean;
  replayId: string;
}): Promise<BufferedRange | null> {
  const {
    dvrEngine,
    requestedDurationSec,
    pipelineWindowMs,
    timeoutMs,
    debug,
    replayId,
  } = args;

  const requiredWindowSec = computeRequiredWindowSec({
    requestedDurationSec,
    pipelineWindowMs,
  });

  const startedAt = Date.now();
  let lastRange: BufferedRange | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const currentRange = dvrEngine.getBufferedRange();
    lastRange = currentRange;

    const currentWindowSec = getRangeWindowSec(currentRange);

    if (debug) {
      console.log("[Flashback][createFlashbackRuntime] waiting DVR window", {
        replayId,
        requiredWindowSec,
        currentWindowSec,
        range: currentRange,
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    if (currentRange && currentWindowSec >= requiredWindowSec) {
      if (debug) {
        console.log("[Flashback][createFlashbackRuntime] usable DVR window ready", {
          replayId,
          requiredWindowSec,
          currentWindowSec,
          range: currentRange,
          engineDebug: dvrEngine.getDebugState(),
        });
      }

      return currentRange;
    }

    await sleepMs(40);
  }

  // 🔧 PATCH: fallback if pipeline already contains enough data
  const fallbackRange = dvrEngine.getBufferedRange();

  if (!fallbackRange && pipelineWindowMs >= requestedDurationSec * 1000) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR window fallback accepted", {
        replayId,
        pipelineWindowMs,
        requestedDurationSec,
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    return {
      start: 0,
      end: pipelineWindowMs / 1000,
    };
  }

  if (debug) {
    console.warn("[Flashback][createFlashbackRuntime] usable DVR window timeout", {
      replayId,
      requiredWindowSec,
      lastRange,
      lastWindowSec: getRangeWindowSec(lastRange),
      requestedDurationSec,
      pipelineWindowMs,
      engineDebug: dvrEngine.getDebugState(),
    });
  }

  return null;
}

function getVideoBufferedRange(video: HTMLVideoElement): BufferedRange | null {
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

async function waitForVideoDecodableState(args: {
  video: HTMLVideoElement;
  replayId: string;
  debug: boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  const {
    video,
    replayId,
    debug,
    timeoutMs = 2500,
  } = args;

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (video.error) {
      if (debug) {
        console.warn("[Flashback][createFlashbackRuntime] video decodable wait aborted: video.error", {
          replayId,
          errorCode: video.error.code,
          errorMessage: video.error.message,
        });
      }
      return false;
    }

    const readyState = Number(video.readyState);
    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    const currentTime = Number(video.currentTime);
    const bufferedRange = getVideoBufferedRange(video);

    const hasDecodedMetadata =
      readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

    const currentTimeInsideBufferedRange =
      !!bufferedRange &&
      Number.isFinite(currentTime) &&
      currentTime >= bufferedRange.start &&
      currentTime <= Math.max(bufferedRange.start, bufferedRange.end - 0.02);

    if (hasDecodedMetadata && currentTimeInsideBufferedRange) {
      if (debug) {
        console.log("[Flashback][createFlashbackRuntime] video decodable state ready", {
          replayId,
          readyState,
          width,
          height,
          currentTime,
          bufferedRange,
        });
      }
      return true;
    }

    if (debug) {
      console.log("[Flashback][createFlashbackRuntime] waiting decodable video state", {
        replayId,
        readyState,
        width,
        height,
        currentTime,
        bufferedRange,
      });
    }

    await sleepMs(40);
  }

  if (debug) {
    console.warn("[Flashback][createFlashbackRuntime] video decodable state timeout", {
      replayId,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      bufferedRange: getVideoBufferedRange(video),
      networkState: video.networkState,
      paused: video.paused,
    });
  }

  return false;
}

async function attachContinuousDvrReplay(args: {
  session: ReplaySession;
  video: HTMLVideoElement;
  dvrPipeline: ContinuousDvrPipeline;
  dvrEngine: ContinuousDvrEngine;
  debug: boolean;
}): Promise<VideoAttachResult> {
  const { session, video, dvrPipeline, dvrEngine, debug } = args;

  if (!session.isContinuousDvrMode()) {
    return createContinuousDvrAttachResult(false, "session_not_continuous_dvr");
  }

  const requestedDurationMs = Math.max(0, session.getRequestedDurationMs());
  const requestedDurationSec = requestedDurationMs / 1000;
  const replayId = session.getReplayId();
  const pipelineWindowMs = dvrPipeline.getEstimatedWindowMs();

  if (debug) {
    console.log("[Flashback] attachContinuousDvr invoked");
  }

  const initSegment = dvrPipeline.getInitSegment();
  const mediaEntries = dvrPipeline.getMediaEntries();

  if (!initSegment) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
        replayId,
        requestedDurationMs,
        reason: "missing_init_segment",
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "missing_init_segment");
  }

  if (mediaEntries.length <= 0) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
        replayId,
        requestedDurationMs,
        reason: "missing_media_segments",
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "missing_media_segments");
  }

  try {
    dvrEngine.attach(video);

    const attachReady = await dvrEngine.waitUntilReady({
      timeoutMs: 2000,
      requireSourceBuffer: false,
    });

    if (!attachReady) {
      if (debug) {
        console.warn("[Flashback][createFlashbackRuntime] dvr attach not ready", {
          replayId,
          requestedDurationMs,
          engineDebug: dvrEngine.getDebugState(),
        });
      }

      try {
        dvrEngine.detach();
      } catch {}

      return createContinuousDvrAttachResult(false, "attach_not_ready");
    }
  } catch (error) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] dvr attach failed", {
        replayId,
        requestedDurationMs,
        error: String(error),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "attach_failed");
  }

  try {
    const feedResult = feedPipelineIntoEngine({
      dvrPipeline,
      dvrEngine,
      debug,
    });

    if (!feedResult.pushedInit || feedResult.pushedMediaCount <= 0) {
      if (debug) {
        console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
          replayId,
          requestedDurationMs,
          reason: "pipeline_feed_incomplete",
          feedResult,
        });
      }

      try {
        dvrEngine.detach();
      } catch {}

      return createContinuousDvrAttachResult(false, "pipeline_feed_incomplete");
    }

    const sourceBufferReady = await dvrEngine.waitUntilReady({
      timeoutMs: 2000,
      requireSourceBuffer: true,
    });

    if (!sourceBufferReady) {
      if (debug) {
        console.warn("[Flashback][createFlashbackRuntime] sourceBuffer not ready after feed", {
          replayId,
          requestedDurationMs,
          engineDebug: dvrEngine.getDebugState(),
        });
      }

      try {
        dvrEngine.detach();
      } catch {}

      return createContinuousDvrAttachResult(false, "sourcebuffer_not_ready");
    }
  } catch (error) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] pipeline feed failed", {
        replayId,
        requestedDurationMs,
        error: String(error),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "pipeline_feed_failed");
  }

  const waitResult = await waitForUsableDvrWindow({
    dvrEngine,
    requestedDurationSec,
    pipelineWindowMs,
    timeoutMs: 5000,
    debug,
    replayId,
  });

  if (!waitResult) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
        replayId,
        requestedDurationMs,
        reason: "no_usable_dvr_window",
        pipelineWindowMs,
        engineRange: dvrEngine.getBufferedRange(),
        playableDurationSec: dvrEngine.getPlayableDurationSec(),
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "no_usable_dvr_window");
  }

  try {
    if (debug) {
      console.log("[Flashback][createFlashbackRuntime] buffer ready before seek", {
        replayId,
        offsetMs: session.getOffsetMs(),
        requestedDurationMs,
        waitResult,
        finalRangeBeforeSeek: dvrEngine.getBufferedRange(),
        playableDurationSec: dvrEngine.getPlayableDurationSec(),
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    dvrEngine.seekBack(session.getOffsetMs());

    await sleepMs(80);

    const rangeAfterInitialSeek = dvrEngine.getBufferedRange();
    const currentTimeAfterInitialSeek = Number(video.currentTime);
    const offsetSec = Math.max(0, session.getOffsetMs()) / 1000;

    if (rangeAfterInitialSeek) {
      const safeStart = rangeAfterInitialSeek.start;
      const safeEnd = Math.max(
        rangeAfterInitialSeek.start,
        rangeAfterInitialSeek.end - 0.05
      );

      const expectedTarget = Math.max(safeStart, safeEnd - offsetSec);
      const driftSec = Math.abs(currentTimeAfterInitialSeek - expectedTarget);

      if (driftSec > 0.75) {
        if (debug) {
          console.warn("[Flashback][createFlashbackRuntime] seek drift detected", {
            replayId,
            offsetMs: session.getOffsetMs(),
            safeStart,
            safeEnd,
            expectedTarget,
            currentTimeAfterInitialSeek,
            driftSec,
          });
        }

        try {
          video.currentTime = expectedTarget;
        } catch (error) {
          if (debug) {
            console.warn("[Flashback][createFlashbackRuntime] corrective seek failed", {
              replayId,
              expectedTarget,
              error: String(error),
            });
          }

          try {
            dvrEngine.detach();
          } catch {}

          return createContinuousDvrAttachResult(false, "corrective_seek_failed");
        }
      }
    }
  } catch (error) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] seekBack failed", {
        replayId,
        requestedDurationMs,
        offsetMs: session.getOffsetMs(),
        bufferedRange: dvrEngine.getBufferedRange(),
        error: String(error),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "seek_back_failed");
  }

  const rangeAfterSeek = dvrEngine.getBufferedRange();
  const playableDurationSec = dvrEngine.getPlayableDurationSec();

  if (!rangeAfterSeek || playableDurationSec <= 0) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
        replayId,
        requestedDurationMs,
        reason: "range_lost_after_seek",
        rangeAfterSeek,
        playableDurationSec,
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "range_lost_after_seek");
  }

  const decodableReady = await waitForVideoDecodableState({
    video,
    replayId,
    debug,
    timeoutMs: 2500,
  });

  if (!decodableReady) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] DVR attach aborted", {
        replayId,
        requestedDurationMs,
        reason: "video_not_decodable_after_seek",
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        bufferedRange: getVideoBufferedRange(video),
        engineDebug: dvrEngine.getDebugState(),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "video_not_decodable_after_seek");
  }

  try {
    await dvrEngine.play();

    await sleepMs(120);

    if (video.error) {
      if (debug) {
        console.warn("[Flashback][createFlashbackRuntime] video entered error after play", {
          replayId,
          errorCode: video.error.code,
          errorMessage: video.error.message,
        });
      }

      try {
        dvrEngine.detach();
      } catch {}

      return createContinuousDvrAttachResult(false, "video_error_after_play");
    }
  } catch (error) {
    if (debug) {
      console.warn("[Flashback][createFlashbackRuntime] dvr play failed", {
        replayId,
        requestedDurationMs,
        error: String(error),
      });
    }

    try {
      dvrEngine.detach();
    } catch {}

    return createContinuousDvrAttachResult(false, "play_failed");
  }

  if (debug) {
    console.log("[Flashback][createFlashbackRuntime] continuous DVR attached", {
      replayId,
      requestedDurationMs,
      offsetMs: session.getOffsetMs(),
      bufferedRange: waitResult,
      finalBufferedRange: dvrEngine.getBufferedRange(),
      playableDurationSec: dvrEngine.getPlayableDurationSec(),
      mediaCount: mediaEntries.length,
      pipelineWindowMs,
      video: {
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        bufferedRange: getVideoBufferedRange(video),
        paused: video.paused,
      },
    });
  }

  return createContinuousDvrAttachResult(true, null);
}

export function createFlashbackRuntime(config?: {
  maxBufferMs?: number;
  debug?: boolean;
}): FlashbackRuntime {
  const maxBufferMs = Math.max(
    1000,
    Math.trunc(Number(config?.maxBufferMs) || 40000)
  );
  const debug = !!config?.debug;

  const recorder = new FlashbackRecorder({
    maxBufferMs,
    debug,
  });

  const dvrBridge = new ContinuousDvrBridge(debug);
  const dvrPipeline = new ContinuousDvrPipeline(debug);
  const dvrEngine = new ContinuousDvrEngine({
    mimeType: recorder.getMimeType(),
    debug,
  });

  const dvrRuntime = new ContinuousDvrRuntime(
    recorder,
    dvrBridge,
    dvrPipeline,
    dvrEngine,
    debug
  );

  const snapshotBuilder = new DvrSnapshotBuilder(dvrPipeline, debug);

  const replaySessionManager = new ReplaySessionManager();

  const blobPlayer = new BlobPlayer();
  const msePlayer = new MsePlayer(debug);
  const playbackRouter = new PlaybackRouter(blobPlayer, msePlayer, debug);

  const ui = new UIOrchestrator();

  const replayCoordinator = new ReplayCoordinator(ui, playbackRouter, debug, {
    onSessionTerminal: (session) => {
      replaySessionManager.releaseSession(session);
    },

    attachContinuousDvr: async (session, video) => {
      return attachContinuousDvrReplay({
        session,
        video,
        dvrPipeline,
        dvrEngine,
        debug,
      });
    },
  });

  const controller = new FlashbackController(replaySessionManager);

  return {
    recorder,

    dvrBridge,
    dvrPipeline,
    dvrEngine,
    dvrRuntime,

    snapshotBuilder,

    replaySessionManager,
    replayCoordinator,

    controller,

    blobPlayer,
    msePlayer,
    playbackRouter,

    ui,
  };
}