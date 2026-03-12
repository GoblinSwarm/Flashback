// src/auto-start/AutoStartManager.ts
// ======================================================
//
// AutoStartManager
// ----------------
//
// Observes the page and resolves the "main" video element
// for Flashback auto-start behavior on live/video platforms
// (YouTube / Twitch / Kick style).
//
// Architecture role
// -----------------
//
// AutoStartManager belongs to the **Content Orchestration
// Layer**.
//
// It is responsible for:
//
// - resolving a candidate video via VideoResolver
// - requiring stability before notifying "ready"
// - detecting stable video changes
// - detecting stable video loss
// - avoiding flicker / hysteresis loops
//
// Important boundary
// ------------------
//
// In this architecture:
//
// - `VideoResolver`    = discover and rank the best current
//                        candidate video
// - `AutoStartManager` = decide whether that candidate has
//                        been stable enough over time to be
//                        considered ready / changed / lost
//
// This distinction must remain explicit.
//
// VideoResolver answers:
//
// - "what is the best candidate right now?"
//
// AutoStartManager answers:
//
// - "has that candidate been stable long enough?"
// - "did the stable video change?"
// - "did the stable video disappear?"
// - "should we wait a bit more before notifying?"
//
// If ranking/scoring logic starts growing here, this file
// will begin to overlap with `VideoResolver`.
//
// If recorder/runtime boot logic starts growing here, this
// file will begin to overlap with `FlashbackContentRuntime`.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - polling for the best current candidate video
// - applying warmup/stability rules
// - validating that a candidate remains "good enough"
// - emitting stable lifecycle events:
//
//   • onVideoReady
//   • onVideoChanged
//   • onVideoLost
//
// - applying hysteresis / grace periods to reduce flicker
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - start or stop the recorder directly
// - own replay lifecycle
// - own DVR pipeline state
// - attach playback/UI
// - decide how videos are scored globally
// - own DOM candidate ranking policy
// - implement replay/session ownership
//
// Those responsibilities belong to:
//
//   VideoResolver
//   FlashbackContentRuntime
//   Replay layer
//   Playback layer
//
// Design rule
// -----------
//
// AutoStartManager emits stable video lifecycle events only.
//
// If recorder/DVR/playback logic, replay ownership logic,
// or full candidate scoring logic starts appearing here,
// the architecture is being violated.
//
// Maintenance note
// ----------------
//
// This file intentionally contains temporal logic:
//
// - stable tick counting
// - warmup behavior
// - grace periods
// - extra ready delay
// - time-progress validation over a window
//
// That temporal behavior belongs here, not in VideoResolver.
//
// If a future feature sounds like:
//
// - "which video should win right now?"
// - "should replay UI video be excluded?"
// - "how should candidates be ranked?"
//
// then that logic belongs in `VideoResolver`.
//
// But if it sounds like:
//
// - "wait until the candidate is stable"
// - "avoid false lost/change during DOM churn"
// - "emit ready only after extra confirmation"
//
// then that logic belongs here.
//

import { VideoResolver } from "../video/VideoResolver";

export type AutoStartConfig = {
  enabled: boolean;
  pollMs: number;
  stableTicks: number;
  minVideoWidth: number;
  minVideoHeight: number;
  requirePlaying: boolean;
  requireTimeProgress: boolean;
  timeProgressWindowMs: number;
  timeProgressMinDelta: number;
  debug?: boolean;
};

export type AutoStartWarmupConfig = {
  enabled: boolean;
  durationMs: number;
  stableTicks?: number;
  requirePlaying?: boolean;
  requireTimeProgress?: boolean;
};

type VideoReadyCb = (video: HTMLVideoElement, meta: { reason: string }) => void;
type VideoLostCb = (meta: { reason: string }) => void;
type VideoChangedCb = (video: HTMLVideoElement, meta: { reason: string }) => void;

type TimeSample = {
  atMs: number;
  ct: number;
};

const STRONG_TIME_PROGRESS_MIN_DELTA_MS = 350;
const EXTRA_READY_DELAY_MS = 500;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeProgressOk(
  video: HTMLVideoElement,
  history: TimeSample[],
  windowMs: number,
  minDeltaMs: number
): { ok: boolean; reason: string } {
  const now = performance.now();
  const currentTime = Number(video.currentTime || 0);

  history.push({ atMs: now, ct: currentTime });

  const cutoff = now - Math.max(0, windowMs);
  while (history.length > 0 && history[0].atMs < cutoff) {
    history.shift();
  }

  if (history.length < 2) {
    return { ok: false, reason: "time_progress_not_enough_samples" };
  }

  const first = history[0];
  const last = history[history.length - 1];

  const deltaSec = (last.ct ?? 0) - (first.ct ?? 0);
  const deltaMs = deltaSec * 1000;

  if (deltaMs >= minDeltaMs) {
    return { ok: true, reason: `time_progress_ok(delta=${deltaMs.toFixed(0)}ms)` };
  }

  return { ok: false, reason: `time_progress_low(delta=${deltaMs.toFixed(0)}ms)` };
}

function isGoodEnoughVideo(
  video: HTMLVideoElement,
  config: AutoStartConfig,
  timeHistory: TimeSample[]
): { ok: boolean; reason: string } {
  if (!video || !video.isConnected) {
    return { ok: false, reason: "video_not_connected" };
  }

  if ((video.readyState ?? 0) < 4) {
    return { ok: false, reason: `not_ready_enough_data(rs=${video.readyState})` };
  }

  if ((video.videoWidth ?? 0) <= 0 || (video.videoHeight ?? 0) <= 0) {
    return { ok: false, reason: "decoder_not_initialized" };
  }

  try {
    const rect = video.getBoundingClientRect();
    const width = rect.width || 0;
    const height = rect.height || 0;

    if (width < config.minVideoWidth) {
      return { ok: false, reason: `video_too_small_w(${width.toFixed(0)})` };
    }

    if (height < config.minVideoHeight) {
      return { ok: false, reason: `video_too_small_h(${height.toFixed(0)})` };
    }
  } catch {
    return { ok: false, reason: "no_rect" };
  }

  if (config.requirePlaying && video.paused) {
    return { ok: false, reason: "paused" };
  }

  if (config.requireTimeProgress) {
    const minDelta = Math.max(
      STRONG_TIME_PROGRESS_MIN_DELTA_MS,
      config.timeProgressMinDelta | 0
    );

    const progress = isTimeProgressOk(
      video,
      timeHistory,
      config.timeProgressWindowMs,
      minDelta
    );

    if (!progress.ok) {
      return { ok: false, reason: progress.reason };
    }
  }

  return { ok: true, reason: "ok" };
}

export class AutoStartManager {
  private readonly resolver: VideoResolver;
  private readonly config: AutoStartConfig;
  private readonly warmup?: AutoStartWarmupConfig;

  private running = false;
  private loopTid: number | null = null;

  private onVideoReady: VideoReadyCb | null = null;
  private onVideoLost: VideoLostCb | null = null;
  private onVideoChanged: VideoChangedCb | null = null;

  private lastCandidate: HTMLVideoElement | null = null;
  private lastCandidateReason = "";
  private stableCount = 0;

  private currentStable: HTMLVideoElement | null = null;

  private pendingPrevStable: HTMLVideoElement | null = null;
  private pendingKind: "ready" | "changed" | null = null;

  private timeHistory: TimeSample[] = [];
  private startedAtMs = 0;

  private noCandidateCount = 0;
  private readonly lostGraceTicks = 2;

  constructor(config?: AutoStartConfig, warmup?: AutoStartWarmupConfig) {
    this.config =
      config ??
      ({
        enabled: false,
        pollMs: 450,
        stableTicks: 3,
        minVideoWidth: 160,
        minVideoHeight: 90,
        requirePlaying: true,
        requireTimeProgress: true,
        timeProgressWindowMs: 900,
        timeProgressMinDelta: 200,
        debug: true,
      } satisfies AutoStartConfig);

    this.warmup = warmup;

    // Important:
    // resolver debug is intentionally independent from manager debug.
    // The resolver may be noisy, so keep it off unless specifically needed.
    this.resolver = new VideoResolver({ debug: true });
  }

  private logDebug(...args: unknown[]): void {
    if (!this.config.debug) return;
    console.log(...args);
  }

  private warnDebug(...args: unknown[]): void {
    if (!this.config.debug) return;
    console.warn(...args);
  }

  public setCallbacks(callbacks: {
    onVideoReady?: VideoReadyCb;
    onVideoLost?: VideoLostCb;
    onVideoChanged?: VideoChangedCb;
  }): void {
    this.onVideoReady = callbacks.onVideoReady ?? null;
    this.onVideoLost = callbacks.onVideoLost ?? null;
    this.onVideoChanged = callbacks.onVideoChanged ?? null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getCurrentStableVideo(): HTMLVideoElement | null {
    return this.currentStable;
  }

  public start(): void {
    if (!this.config.enabled) return;
    if (this.running) return;

    this.running = true;
    this.startedAtMs = performance.now();
    this.resetState();
    this.kickLoop(0);

    this.logDebug("[Flashback][AutoStartManager] started");
  }

  public stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.loopTid != null) {
      window.clearTimeout(this.loopTid);
      this.loopTid = null;
    }

    this.resetState();

    this.logDebug("[Flashback][AutoStartManager] stopped");
  }

  private resetState(): void {
    this.lastCandidate = null;
    this.lastCandidateReason = "";
    this.stableCount = 0;

    this.currentStable = null;

    this.pendingPrevStable = null;
    this.pendingKind = null;

    this.timeHistory = [];
    this.noCandidateCount = 0;
  }

  private kickLoop(delayMs: number): void {
    if (!this.running) return;
    if (this.loopTid != null) return;

    this.loopTid = window.setTimeout(() => {
      this.loopTid = null;
      void this.loopOnce();
    }, Math.max(0, delayMs | 0));
  }

  private getEffectiveConfig(): AutoStartConfig {
    const warmup = this.warmup;
    if (!warmup || !warmup.enabled) return this.config;

    const now = performance.now();
    const elapsed = now - (this.startedAtMs || now);
    const inWarmup = elapsed >= 0 && elapsed < Math.max(0, warmup.durationMs | 0);

    if (!inWarmup) return this.config;

    return {
      ...this.config,
      stableTicks: Math.max(1, (warmup.stableTicks ?? this.config.stableTicks) | 0),
      requirePlaying: warmup.requirePlaying ?? this.config.requirePlaying,
      requireTimeProgress: warmup.requireTimeProgress ?? this.config.requireTimeProgress,
    };
  }

  private async loopOnce(): Promise<void> {
    if (!this.running) return;

    const effectiveConfig = this.getEffectiveConfig();

    // If the previously stable video was physically removed from the DOM,
    // accelerate the lost path instead of waiting for a long churn cycle.
    if (this.currentStable && !this.currentStable.isConnected) {
      this.noCandidateCount = this.lostGraceTicks;
    }

    try {
      const resolution = await this.resolver.resolve({ dumpCandidates: false });

      const candidate = resolution.video;
      const reason = resolution.reason || "no_reason";

      if (!candidate) {
        this.handleNoCandidate(reason);
        this.kickLoop(effectiveConfig.pollMs);
        return;
      }

      this.noCandidateCount = 0;

      if (this.lastCandidate !== candidate) {
        this.logDebug("[Flashback][AutoStartManager] candidate changed", {
          reason,
        });

        this.lastCandidate = candidate;
        this.lastCandidateReason = reason;
        this.stableCount = 0;
        this.timeHistory = [];

        // Important:
        // a candidate change is NOT immediately a stable change event.
        // We first require the new candidate to prove stability.
        if (this.currentStable && this.currentStable !== candidate) {
          this.pendingPrevStable = this.currentStable;
          this.pendingKind = "changed";
          this.currentStable = null;
        }
      } else {
        this.lastCandidateReason = reason || this.lastCandidateReason;
      }

      const quality = isGoodEnoughVideo(candidate, effectiveConfig, this.timeHistory);

      this.logDebug("[Flashback][AutoStartManager] quality check", {
        sameCandidate: this.lastCandidate === candidate,
        qualityOk: quality.ok,
        qualityReason: quality.reason,
        stableCount: this.stableCount,
        stableTicksRequired: effectiveConfig.stableTicks,
        candidateReason: reason,
        currentStable: this.currentStable === candidate,
        hasCurrentStable: !!this.currentStable,
        noCandidateCount: this.noCandidateCount,
      });

      if (!quality.ok) {
        if (quality.reason === "time_progress_not_enough_samples") {
          this.kickLoop(effectiveConfig.pollMs);
          return;
        }

        // Important:
        // if we are still looking at the SAME candidate, tolerate a small
        // temporary quality fluctuation instead of resetting stabilization
        // immediately. Twitch often micro-stalls during startup.
        if (candidate === this.lastCandidate) {
          this.logDebug("[Flashback][AutoStartManager] candidate temporarily unstable", {
            reason: quality.reason,
            stableCount: this.stableCount,
            candidateReason: this.lastCandidateReason,
          });

          this.kickLoop(effectiveConfig.pollMs);
          return;
        }

        this.handleNoCandidate(`candidate_rejected:${quality.reason} | ${reason}`);
        this.kickLoop(effectiveConfig.pollMs);
        return;
      }

      this.logDebug("[Flashback][AutoStartManager] stable tick", {
        nextStableCount: this.stableCount + 1,
        stableTicksRequired: effectiveConfig.stableTicks,
        candidateReason: this.lastCandidateReason,
      });

      this.stableCount++;

      if (this.stableCount < effectiveConfig.stableTicks) {
        this.kickLoop(effectiveConfig.pollMs);
        return;
      }

      if (!this.currentStable) {
        this.currentStable = candidate;

        const kind = this.pendingKind ?? "ready";
        const prev = this.pendingPrevStable;

        this.pendingKind = null;
        this.pendingPrevStable = null;

        // Extra delay:
        // after stability threshold is reached, wait a little longer to
        // reduce false positives during last-moment DOM churn.
        await sleepMs(EXTRA_READY_DELAY_MS);

        if (!this.running || this.currentStable !== candidate) {
          this.kickLoop(effectiveConfig.pollMs);
          return;
        }

        try {
          if (kind === "changed" && prev) {
            this.logDebug("[Flashback][AutoStartManager] stable changed", {
              reason: this.lastCandidateReason,
            });
            this.onVideoChanged?.(candidate, { reason: this.lastCandidateReason });
          } else {
            this.logDebug("[Flashback][AutoStartManager] stable ready", {
              reason: this.lastCandidateReason,
            });
            this.onVideoReady?.(candidate, { reason: this.lastCandidateReason });
          }
        } catch (error) {
          this.warnDebug(
            "[Flashback][AutoStartManager] callback threw (loop continues)",
            error
          );
        }

        this.kickLoop(effectiveConfig.pollMs);
        return;
      }

      this.kickLoop(effectiveConfig.pollMs);
    } catch (error) {
      // Best-effort loop:
      // a resolver failure should not permanently kill auto-start.
      this.warnDebug("[Flashback][AutoStartManager] loopOnce failed", error);
      this.kickLoop(effectiveConfig.pollMs);
    }
  }

  private handleNoCandidate(reason: string): void {
    this.logDebug("[Flashback][AutoStartManager] handleNoCandidate", {
      reason,
      hadStable: !!this.currentStable || !!this.pendingPrevStable,
      noCandidateCount: this.noCandidateCount,
      stableCount: this.stableCount,
      hadLastCandidate: !!this.lastCandidate,
    });

    const hadStable = !!this.currentStable || !!this.pendingPrevStable;

    if (hadStable) {
      this.noCandidateCount++;

      // Grace period:
      // tolerate a small number of failed polls before declaring the
      // stable video lost. This helps absorb DOM churn / transient stalls.
      if (this.noCandidateCount < this.lostGraceTicks) {
        this.lastCandidate = null;
        this.lastCandidateReason = "";
        this.stableCount = 0;
        this.timeHistory = [];
        return;
      }

      const lostReason = `video_lost:${reason}`;

      this.currentStable = null;
      this.pendingPrevStable = null;
      this.pendingKind = null;

      this.lastCandidate = null;
      this.lastCandidateReason = "";
      this.stableCount = 0;
      this.timeHistory = [];

      this.noCandidateCount = 0;

      this.logDebug("[Flashback][AutoStartManager] stable lost", {
        reason: lostReason,
      });

      try {
        this.onVideoLost?.({ reason: lostReason });
      } catch (error) {
        this.warnDebug(
          "[Flashback][AutoStartManager] onVideoLost callback threw",
          error
        );
      }

      return;
    }

    this.lastCandidate = null;
    this.lastCandidateReason = "";
    this.stableCount = 0;
    this.timeHistory = [];
    this.noCandidateCount = 0;
  }
}