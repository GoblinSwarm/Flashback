// src/content/FlashbackContentRuntime.ts
// ======================================================
//
// FlashbackContentRuntime
// -----------------------
//
// Content-script orchestration layer for Flashback.
//
// This module wires together:
//
// - AutoStartManager
// - createFlashbackRuntime()
// - recorder lifecycle
// - basic replay trigger flow
//
// Architecture role
// -----------------
//
// FlashbackContentRuntime belongs to the **Content Runtime Layer**.
//
// It is the top-level lifecycle orchestrator inside the
// content script. It connects browser video discovery
// with the lower Flashback runtime layers.
//
// Important boundary
// ------------------
//
// This module owns **top-level orchestration and trigger
// policy** for the content-script environment.
//
// In this architecture:
//
// - `createFlashbackRuntime()`  = assembles dependencies
// - `FlashbackContentRuntime`   = decides when runtime pieces start/reset/stop
// - `FlashbackController`       = creates replay sessions
// - `ReplaySessionManager`      = owns the active replay slot
// - `ReplayCoordinator`         = attaches replay to playback/UI target
//
// This file is intentionally high-level.
//
// It should coordinate the flow, but it must not absorb
// lower-layer ownership logic or playback internals.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - creating the Flashback runtime inside the content script
// - creating and starting AutoStartManager
// - reacting to stable video lifecycle events
// - starting / restarting / stopping the recorder
// - connecting / disconnecting live DVR runtime wiring
// - resetting downstream DVR state when the source video changes
// - triggering replay flow through controller + coordinator
// - exposing a small content-runtime API
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - implement capture internals
// - implement DVR internals
// - implement playback internals
// - implement replay source building
// - implement UI internals
// - directly own replay session storage/ownership
// - directly replace ReplaySessionManager behavior
// - directly implement snapshot playback logic
//
// Those responsibilities belong to lower layers.
//
// Design rule
// -----------
//
// FlashbackContentRuntime is an orchestration boundary.
//
// It may coordinate:
//
// - when replay is requested
// - when capture restarts
// - when downstream DVR state resets
// - when active replay should be closed because the source changed
//
// But it must not absorb:
//
// - replay ownership internals
// - snapshot building internals
// - playback engine internals
//
// Maintenance note
// ----------------
//
// If a future feature sounds like:
//
// - "what gets reset when the video changes?"
// - "when should the DVR chain connect?"
// - "when should replay close because source video was lost?"
// - "what high-level flow happens when replay is triggered?"
//
// then that logic belongs here or in another orchestration
// layer.
//
// But if it sounds like:
//
// - "who owns the active replay session?"
// - "how do we attach to MediaSource?"
// - "how do we build the replay snapshot?"
// - "which player handles mse vs blob?"
//
// then that logic does NOT belong here.
// It belongs in:
//
//   `ReplaySessionManager`
//   `MsePlayer` / `BlobPlayer`
//   `DvrSnapshotBuilder`
//   `PlaybackRouter`
//
// Trigger note
// ------------
//
// `triggerReplay()` should remain a high-level flow:
//
//   request replay session creation
//        ↓
//   attach created session
//
// It must not become the place where:
//
// - replay ownership rules are reimplemented
// - snapshot validation policy is duplicated
// - playback internals are reimplemented
//

import {
  AutoStartManager,
  type AutoStartConfig,
  type AutoStartWarmupConfig,
} from "../auto-start/AutoStartManager";
import {
  createFlashbackRuntime,
  type FlashbackRuntime,
} from "../app/createFlashbackRuntime";
import type { ReplaySession } from "../replay/ReplaySession";
import type { VideoAttachResult } from "../playback/VideoAttach";

export type FlashbackContentRuntimeConfig = {
  debug?: boolean;
  maxBufferMs?: number;
  timesliceMs?: number;
  autoStart?: AutoStartConfig;
  warmup?: AutoStartWarmupConfig;
};

export class FlashbackContentRuntime {
  private readonly runtime: FlashbackRuntime;
  private readonly autoStartManager: AutoStartManager;
  private readonly debug: boolean;
  private readonly timesliceMs: number;

  private currentVideo: HTMLVideoElement | null = null;

  constructor(config?: FlashbackContentRuntimeConfig) {
    this.debug = !!config?.debug;
    this.timesliceMs = Math.max(
      100,
      Math.trunc(Number(config?.timesliceMs) || 1200)
    );

    this.runtime = createFlashbackRuntime({
      maxBufferMs: config?.maxBufferMs,
      debug: this.debug,
    });

    this.autoStartManager = new AutoStartManager(
      config?.autoStart,
      config?.warmup
    );

    this.autoStartManager.setCallbacks({
      onVideoReady: (video, meta) => {
        void this.handleVideoReady(video, meta.reason);
      },
      onVideoChanged: (video, meta) => {
        void this.handleVideoChanged(video, meta.reason);
      },
      onVideoLost: (meta) => {
        void this.handleVideoLost(meta.reason);
      },
    });
  }

  public start(): void {
    // FlashbackContentRuntime owns live connect/bootstrap policy.
    // Do not move this responsibility into the composition root.
    this.runtime.dvrRuntime.connect();
    this.autoStartManager.start();

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] started");
    }
  }

  public stop(): void {
    this.autoStartManager.stop();

    // High-level orchestration decision:
    // when the content runtime stops, the visible replay should close too.
    // Ownership mechanics remain inside ReplaySessionManager/controller.
    this.runtime.controller.closeActiveReplay();

    this.runtime.recorder.stop();
    this.runtime.dvrRuntime.clearPipeline();
    this.runtime.dvrRuntime.disconnect();

    this.currentVideo = null;

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] stopped");
    }
  }

  public getRuntime(): FlashbackRuntime {
    return this.runtime;
  }

  public getCurrentVideo(): HTMLVideoElement | null {
    return this.currentVideo;
  }

  public async triggerReplay(
    seconds: number,
    traceId?: string
  ): Promise<ReplaySession> {
    // Important:
    // this method coordinates the replay flow, but does not
    // reimplement session ownership or playback internals.
    const session = await this.runtime.controller.requestReplay({
      seconds,
      traceId: traceId ?? null,
    });

    let attachResult: VideoAttachResult | null = null;

    try {
      attachResult = await this.runtime.replayCoordinator.attachSession(session);
    } catch (error) {
      this.handleReplayAttachFailure("attach_exception", session, error);
      throw error;
    }

    if (!attachResult.attached) {
      this.handleReplayAttachFailure(
        attachResult.reason ?? "attach_unattached",
        session
      );
    }

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] replay triggered", {
        replayId: session.getReplayId(),
        mode: session.getMode(),
        seconds,
        attachResult,
      });
    }

    return session;
  }

  public closeReplay(): void {
    // High-level orchestration API only.
    // Actual ownership cleanup remains delegated below this layer.
    this.runtime.controller.closeActiveReplay();

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] replay closed");
    }
  }

  private async handleVideoReady(
    video: HTMLVideoElement,
    reason: string
  ): Promise<void> {
    this.currentVideo = video;

    const stream = this.tryCaptureStream(video);
    if (!stream) {
      if (this.debug) {
        console.warn(
          "[Flashback][ContentRuntime] captureStream unavailable on ready",
          { reason }
        );
      }
      return;
    }

    this.prepareForNewCaptureSession();
    this.runtime.recorder.start(stream, this.timesliceMs, { reset: true });

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] video ready → recorder started", {
        reason,
        timesliceMs: this.timesliceMs,
      });
    }
  }

  private async handleVideoChanged(
    video: HTMLVideoElement,
    reason: string
  ): Promise<void> {
    this.currentVideo = video;

    const stream = this.tryCaptureStream(video);
    if (!stream) {
      if (this.debug) {
        console.warn(
          "[Flashback][ContentRuntime] captureStream unavailable on changed",
          { reason }
        );
      }
      return;
    }

    // High-level orchestration decision:
    // when the underlying source video changes, visible replay should close.
    // Ownership disposal remains handled by the replay/controller layer.
    this.runtime.controller.closeActiveReplay();

    this.prepareForNewCaptureSession();

    await this.runtime.recorder.restartSoft(stream, this.timesliceMs, {
      reset: true,
      delayMs: 100,
    });

    if (this.debug) {
      console.log(
        "[Flashback][ContentRuntime] video changed → recorder restarted",
        {
          reason,
          timesliceMs: this.timesliceMs,
        }
      );
    }
  }

  private async handleVideoLost(reason: string): Promise<void> {
    this.currentVideo = null;

    // Another high-level orchestration rule:
    // if source video is lost, replay should no longer remain visible.
    this.runtime.controller.closeActiveReplay();

    this.runtime.recorder.stop();
    this.runtime.dvrRuntime.clearPipeline();

    if (this.debug) {
      console.log("[Flashback][ContentRuntime] video lost → recorder stopped", {
        reason,
      });
    }
  }

  private prepareForNewCaptureSession(): void {
    // Runtime lifecycle policy lives here:
    // ensure the live DVR chain is connected and clear downstream
    // state before beginning a new capture generation.
    this.runtime.dvrRuntime.connect();
    this.runtime.dvrRuntime.clearPipeline();
  }

  private handleReplayAttachFailure(
    reason: string,
    session: ReplaySession,
    error?: unknown
  ): void {
    // Important:
    // replay attach failure no longer implies that the DVR pipeline
    // snapshot is corrupt.
    //
    // With the current architecture, replay is reconstructed from the
    // coherent pipeline snapshot instead of depending on newly arriving
    // live chunks during attach. Because of that, clearing the pipeline
    // here would be too aggressive and could destroy the last valid
    // snapshot for the next retry.
    //
    // Pipeline reset remains reserved for actual capture-generation
    // boundaries, such as:
    // - video ready
    // - video changed
    // - video lost
    // - content runtime stop
    //
    // This method therefore logs the attach failure but intentionally
    // does NOT clear the pipeline.

    if (this.debug) {
      console.warn("[Flashback][ContentRuntime] replay attach failed", {
        replayId: session.getReplayId(),
        mode: session.getMode(),
        reason,
        error: error ? String(error) : null,
      });
    }
  }

  private tryCaptureStream(video: HTMLVideoElement): MediaStream | null {
    try {
      const candidate = video as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };

      if (typeof candidate.captureStream === "function") {
        return candidate.captureStream();
      }

      if (typeof candidate.mozCaptureStream === "function") {
        return candidate.mozCaptureStream();
      }

      return null;
    } catch (error) {
      if (this.debug) {
        console.warn("[Flashback][ContentRuntime] captureStream failed", {
          error: String(error),
        });
      }
      return null;
    }
  }
}