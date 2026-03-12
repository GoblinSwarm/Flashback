// src/replay/ReplaySession.ts
// ======================================================
//
// ReplaySession
// -------------
//
// This module represents a single replay session instance.
//
// ReplaySession is the logical replay unit that binds
// together:
//
// - replay identity
// - replay mode
// - replay request timing
// - replay lifecycle state
//
// Typical flow
// ------------
//
//   FlashbackController
//        ↓
//   ReplaySession
//        ↓
//   ReplaySessionManager / ReplayCoordinator
//        ↓
//   Continuous DVR path (primary)
//        ↓
//   Snapshot fallback path (secondary, only if needed)
//
// Architecture role
// -----------------
//
// ReplaySession belongs to the **Replay Layer**.
//
// It exists to encapsulate the runtime state of one
// replay attempt without leaking playback, source
// construction, or UI concerns into the session object
// itself.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - storing replay identity
// - storing replay mode
// - storing requested replay timing
// - tracking replay lifecycle transitions
// - exposing basic lifecycle state helpers
//
// This module MUST NOT:
//
// - build snapshot sources
// - implement playback
// - attach HTMLVideoElement
// - interact with MediaSource
// - manage UI lifecycle
// - manage active session ownership
//
// Those responsibilities belong to:
//
//   FlashbackController
//   ReplayCoordinator
//   PlaybackRouter
//   BlobPlayer / MsePlayer
//   ContinuousDvrEngine
//   UI layer
//   ReplaySessionManager
//
// Design rule
// -----------
//
// ReplaySession is a logical runtime replay container.
//
// If playback logic, UI logic, snapshot construction,
// or MediaSource logic starts appearing here, the
// architecture is being violated.
//

import type { ReplayMode } from "./ReplayMode";
import {
  closeReplayLifecycle,
  createInitialReplayLifecycle,
  disposeReplayLifecycle,
  failReplayLifecycle,
  transitionReplayLifecycle,
  type ReplayCloseReason,
  type ReplayLifecycleSnapshot,
} from "./ReplayLifecycle";

export type { ReplayCloseReason };

export type ReplaySessionParams = {
  replayId: string;
  mode: ReplayMode;
  offsetMs: number;
  requestedDurationMs: number;
  fallbackAllowed?: boolean;
};

function clampNonNegativeInt(value: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export class ReplaySession {
  private lifecycle: ReplayLifecycleSnapshot;

  private readonly replayId: string;
  private readonly mode: ReplayMode;
  private readonly offsetMs: number;
  private readonly requestedDurationMs: number;
  private readonly fallbackAllowed: boolean;

  constructor(params: ReplaySessionParams) {
    this.replayId = String(params.replayId || "").trim();
    this.mode = params.mode;
    this.offsetMs = clampNonNegativeInt(params.offsetMs);
    this.requestedDurationMs = clampNonNegativeInt(params.requestedDurationMs);
    this.fallbackAllowed = params.fallbackAllowed !== false;

    this.lifecycle = createInitialReplayLifecycle();
  }

  public getReplayId(): string {
    return this.replayId;
  }

  public getMode(): ReplayMode {
    return this.mode;
  }

  public isContinuousDvrMode(): boolean {
    return this.mode === "continuous_dvr";
  }

  public isSnapshotFallbackMode(): boolean {
    return this.mode === "snapshot_fallback";
  }

  public getOffsetMs(): number {
    return this.offsetMs;
  }

  public getRequestedDurationMs(): number {
    return this.requestedDurationMs;
  }

  public isFallbackAllowed(): boolean {
    return this.fallbackAllowed;
  }

  public getLifecycle(): ReplayLifecycleSnapshot {
    return this.lifecycle;
  }

  public markPreparing(): void {
    this.lifecycle = transitionReplayLifecycle(this.lifecycle, "preparing");
  }

  public markReady(): void {
    this.lifecycle = transitionReplayLifecycle(this.lifecycle, "ready");
  }

  public markPlaying(): void {
    this.lifecycle = transitionReplayLifecycle(this.lifecycle, "playing");
  }

  public close(reason: ReplayCloseReason): void {
    this.lifecycle = closeReplayLifecycle(this.lifecycle, reason);
  }

  public fail(
    message: string,
    reason: ReplayCloseReason = "internal_error"
  ): void {
    this.lifecycle = failReplayLifecycle(this.lifecycle, message, reason);
  }

  public dispose(): void {
    this.lifecycle = disposeReplayLifecycle(this.lifecycle);
  }

  public isClosed(): boolean {
    return this.lifecycle.state === "closed";
  }

  public isDisposed(): boolean {
    return this.lifecycle.state === "disposed";
  }

  public isErrored(): boolean {
    return this.lifecycle.state === "error";
  }
}