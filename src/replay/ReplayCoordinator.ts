// src/replay/ReplayCoordinator.ts
// ======================================================
//
// ReplayCoordinator
// -----------------
//
// This module connects replay sessions with playback
// and UI targets.
//
// Architecture role
// -----------------
//
// ReplayCoordinator belongs to the **Replay Layer**.
//
// It sits between:
//
//   ReplaySession
//        ↓
//   replay attach path
//        ↓
//   UIOrchestrator
//
// Its job is to take an already-created ReplaySession,
// resolve the playback target from the UI layer, and
// delegate attach/play to the appropriate replay path.
//
// Important boundary
// -----------------
//
// ReplayCoordinator is responsible for **attaching**
// an already-created replay session.
//
// In this architecture:
//
// - `FlashbackController` = create replay session
// - `ReplayCoordinator`   = attach replay session
//
// This distinction must stay explicit.
//
// If replay creation, snapshot building, or active-session
// ownership logic starts appearing here, this file will
// begin to overlap with:
//
// - `FlashbackController`
// - `SnapshotBuilder`
// - `ReplaySessionManager`
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - taking a ReplaySession
// - resolving the UI video target
// - delegating attach to the appropriate replay path
// - updating replay lifecycle state around attach/play
// - toggling replay UI visibility around attach outcome
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build replay snapshot sources
// - own active replay session management
// - implement DVR internals
// - construct UI
// - manage recording lifecycle
// - create replay identities
// - replace session ownership policy
//
// Those responsibilities belong to:
//
//   FlashbackController
//   ReplaySessionManager
//   ContinuousDvrEngine / DVR runtime
//   PlaybackRouter
//   UIOrchestrator
//
// Design rule
// -----------
//
// ReplayCoordinator connects replay/session state with
// UI target resolution and attach delegation.
//
// If replay creation, snapshot construction, capture
// logic, or engine internals start appearing here,
// the architecture is being violated.
//
// Lifecycle note
// --------------
//
// Attach/playback transitions belong here because this
// is where attach actually happens.
//
// Expected attach-oriented flow:
//
//   idle
//    ↓
//   preparing
//    ↓
//   ready
//    ↓
//   playing
//
// Failure on attach should also be registered here,
// because this is the layer that directly observes the
// attach/playback handoff outcome.
//

import { UIOrchestrator } from "../ui/UIOrchestrator";
import { PlaybackRouter } from "../playback/PlaybackRouter";
import type { VideoAttachPath, VideoAttachResult } from "../playback/VideoAttach";
import { ReplaySession } from "./ReplaySession";

export type ReplayCoordinatorHooks = {
  onSessionTerminal?: (session: ReplaySession) => void;

  // Primary path:
  // attach/play a continuous DVR replay against the current UI video target.
  attachContinuousDvr?: (
    session: ReplaySession,
    video: HTMLVideoElement
  ) => Promise<VideoAttachResult>;
};

type ReplayTerminalListeners = {
  ended: () => void;
  error: () => void;
};

function createUnattachedResult(
  path: VideoAttachPath,
  reason: string
): VideoAttachResult {
  return {
    attached: false,
    path,
    reason,
  };
}

function getBufferedEnd(video: HTMLVideoElement): number | null {
  try {
    if (!video.buffered || video.buffered.length <= 0) {
      return null;
    }

    return video.buffered.end(video.buffered.length - 1);
  } catch {
    return null;
  }
}

function getBufferedStart(video: HTMLVideoElement): number | null {
  try {
    if (!video.buffered || video.buffered.length <= 0) {
      return null;
    }

    return video.buffered.start(0);
  } catch {
    return null;
  }
}

export class ReplayCoordinator {
  private currentTerminalCleanup: (() => void) | null = null;
  private currentTerminalReplayId: string | null = null;

  constructor(
    private readonly ui: UIOrchestrator,
    private readonly playbackRouter: PlaybackRouter,
    private readonly debug = false,
    private readonly hooks?: ReplayCoordinatorHooks
  ) {}

  public async attachSession(
    session: ReplaySession
  ): Promise<VideoAttachResult> {
    const video = this.ui.getVideoElement();

    // Defensive cleanup:
    // if terminal listeners from a previous session survived,
    // remove them before attaching a new session.
    this.clearTerminalListeners();

    // Critical:
    // hard-reset the replay video element before a new attach.
    // This helps avoid carrying a stale HTMLMediaElement.error
    // state into the next replay attach attempt.
    this.prepareVideoForAttach(video);

    session.markPreparing();

    try {
      // UI concern only:
      // make replay tree visible before playback attach.
      this.ui.showReplay();

      let result: VideoAttachResult;

      if (session.isContinuousDvrMode()) {
        console.log("[Flashback] using continuous DVR replay");

        if (!this.hooks?.attachContinuousDvr) {
          result = createUnattachedResult(
            "continuous_dvr",
            "continuous_dvr_attach_not_wired"
          );
        } else {
          result = await this.hooks.attachContinuousDvr(session, video);
        }
      } else if (session.isSnapshotFallbackMode()) {
        // Snapshot fallback is no longer the main replay path.
        // If/when it returns, it should come back through an explicit
        // fallback contract instead of reviving session.getSource().
        result = createUnattachedResult(
          "unknown",
          "snapshot_fallback_not_supported"
        );
      } else {
        result = createUnattachedResult("unknown", "unknown_replay_mode");
      }

      if (!result.attached) {
        this.clearTerminalListeners();
        this.cleanupVideoAfterTerminal(video);
        this.ui.hideReplay();

        session.fail("attach returned unattached", "attach_failed");
        this.notifySessionTerminal(session);

        if (this.debug) {
          console.warn(
            "[Flashback][ReplayCoordinator] attach returned unattached",
            {
              replayId: session.getReplayId(),
              mode: session.getMode(),
              attached: result.attached,
              path: result.path,
              reason: result.reason ?? null,
              result,
            }
          );
        }

        return result;
      }

      session.markReady();
      session.markPlaying();

      this.bindTerminalVideoEvents(video, session);

      if (this.debug) {
        console.log("[Flashback][ReplayCoordinator] session attached", {
          replayId: session.getReplayId(),
          mode: session.getMode(),
          attached: result.attached,
          path: result.path,
          reason: result.reason ?? null,
        });
      }

      return result;
    } catch (error) {
      this.clearTerminalListeners();
      this.cleanupVideoAfterTerminal(video);
      this.ui.hideReplay();

      session.fail(String(error), "attach_failed");
      this.notifySessionTerminal(session);

      if (this.debug) {
        console.warn("[Flashback][ReplayCoordinator] attach failed", {
          replayId: session.getReplayId(),
          mode: session.getMode(),
          error: String(error),
        });
      }

      throw error;
    }
  }

  private prepareVideoForAttach(video: HTMLVideoElement): void {
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

    // Keep the replay element in a neutral baseline state.
    video.muted = true;
    video.autoplay = true;
    video.controls = false;
    video.playsInline = true;

    if (this.debug) {
      console.log("[Flashback][ReplayCoordinator] replay video prepared", {
        currentSrc: video.currentSrc || null,
        readyState: video.readyState,
        networkState: video.networkState,
        hasError: !!video.error,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
      });
    }
  }

  private cleanupVideoAfterTerminal(video: HTMLVideoElement): void {
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

    video.muted = true;
    video.autoplay = true;
    video.controls = false;
    video.playsInline = true;

    if (this.debug) {
      console.log("[Flashback][ReplayCoordinator] replay video cleaned", {
        currentSrc: video.currentSrc || null,
        readyState: video.readyState,
        networkState: video.networkState,
        hasError: !!video.error,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
      });
    }
  }

  private bindTerminalVideoEvents(
    video: HTMLVideoElement,
    session: ReplaySession
  ): void {
    const replayId = session.getReplayId();

    const listeners: ReplayTerminalListeners = {
      ended: () => {
        // Ignore stale callbacks if they survive a session swap.
        if (this.currentTerminalReplayId !== replayId) return;

        const currentTime = Number(video.currentTime);
        const duration = Number(video.duration);
        const readyState = Number(video.readyState);
        const networkState = Number(video.networkState);
        const bufferedStart = getBufferedStart(video);
        const bufferedEnd = getBufferedEnd(video);

        const hasFiniteDuration =
          Number.isFinite(duration) && duration > 0;

        const nearDurationEnd =
          hasFiniteDuration && Number.isFinite(currentTime)
            ? currentTime >= Math.max(0, duration - 0.35)
            : false;

        const nearBufferedEnd =
          bufferedEnd != null && Number.isFinite(currentTime)
            ? currentTime >= Math.max(bufferedStart ?? 0, bufferedEnd - 0.2)
            : false;

        const clearlyPrematureEnded =
          !nearDurationEnd &&
          !nearBufferedEnd &&
          readyState < HTMLMediaElement.HAVE_ENOUGH_DATA;

        if (clearlyPrematureEnded) {
          if (this.debug) {
            console.warn("[Flashback][ReplayCoordinator] premature ended ignored", {
              replayId: session.getReplayId(),
              mode: session.getMode(),
              currentTime,
              duration: hasFiniteDuration ? duration : null,
              readyState,
              networkState,
              bufferedStart,
              bufferedEnd,
            });
          }

          return;
        }

        this.clearTerminalListeners();
        this.cleanupVideoAfterTerminal(video);
        this.ui.hideReplay();

        session.close("playback_ended");
        this.notifySessionTerminal(session);

        if (this.debug) {
          console.log("[Flashback][ReplayCoordinator] playback ended", {
            replayId: session.getReplayId(),
            mode: session.getMode(),
            currentTime,
            duration: hasFiniteDuration ? duration : null,
            readyState,
            networkState,
            bufferedStart,
            bufferedEnd,
          });
        }
      },

      error: () => {
        if (this.currentTerminalReplayId !== replayId) return;

        const mediaError =
          video.error != null
            ? `code=${video.error.code}${
                video.error.message ? ` message=${video.error.message}` : ""
              }`
            : "unknown_media_error";

        this.clearTerminalListeners();
        this.cleanupVideoAfterTerminal(video);
        this.ui.hideReplay();

        session.fail(mediaError, "playback_error");
        this.notifySessionTerminal(session);

        if (this.debug) {
          console.warn("[Flashback][ReplayCoordinator] playback error", {
            replayId: session.getReplayId(),
            mode: session.getMode(),
            mediaError,
            currentTime: video.currentTime,
            duration: video.duration,
          });
        }
      },
    };

    video.addEventListener("ended", listeners.ended);
    video.addEventListener("error", listeners.error);

    this.currentTerminalReplayId = replayId;
    this.currentTerminalCleanup = () => {
      video.removeEventListener("ended", listeners.ended);
      video.removeEventListener("error", listeners.error);
    };
  }

  private notifySessionTerminal(session: ReplaySession): void {
    try {
      this.hooks?.onSessionTerminal?.(session);
    } catch (error) {
      if (this.debug) {
        console.warn("[Flashback][ReplayCoordinator] onSessionTerminal failed", {
          replayId: session.getReplayId(),
          mode: session.getMode(),
          error: String(error),
        });
      }
    }
  }

  private clearTerminalListeners(): void {
    try {
      this.currentTerminalCleanup?.();
    } catch {
      // defensive cleanup
    } finally {
      this.currentTerminalCleanup = null;
      this.currentTerminalReplayId = null;
    }
  }
}