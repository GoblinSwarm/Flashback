// src/dvr/ContinuousDvrPipeline.ts
// ======================================================
//
// ContinuousDvrPipeline
// ---------------------
//
// This module owns the internal live DVR state.
//
// It consumes a cleaned live chunk feed coming from
// ContinuousDvrBridge and keeps an ordered DVR buffer
// state ready for future replay / attach.
//
// Architecture role
// -----------------
//
// ContinuousDvrPipeline belongs to the **DVR Layer**.
//
// It sits after the live ingest bridge and before the
// snapshot / replay / playback layers.
//
// Typical flow
// ------------
//
//   FlashbackRecorder live chunks
//            ↓
//   ContinuousDvrBridge
//            ↓
//   ContinuousDvrPipeline
//            ↓
//   DvrSnapshotBuilder
//            ↓
//   Replay / Playback
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - receiving ordered DVR chunks from the bridge
// - storing the latest init segment
// - storing media segments in arrival order
// - maintaining coherent internal DVR state
// - exposing DVR state for upper layers
// - resetting its own internal DVR state when requested
//
// Key guarantees
// --------------
//
// - media is never treated as init
// - init is stored separately from media
// - media segment order is preserved
// - clear() resets the whole DVR pipeline state
// - this module acts as a DVR state holder, not as UI or replay policy
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - receive raw MediaRecorder events directly
// - decide when replay UI opens or closes
// - attach HTMLVideoElement by itself
// - implement replay session ownership
// - decide snapshot fallback policy
// - decide which replay source should be shown
//
// Those responsibilities belong to:
//
//   FlashbackRecorder
//   ContinuousDvrBridge
//   Snapshot layer
//   Replay layer
//   Playback layer
//
// Design rule
// -----------
//
// ContinuousDvrPipeline must remain the live DVR state
// holder.
//
// If UI logic, replay policy, playback logic, or capture
// policy starts appearing here, the architecture is being
// violated.
//
// Invariants
// ----------
//
// - at most one current init segment is considered active
// - media segments are always stored in ingest order
// - init and media are tracked separately
// - this module never owns the visible replay session
//

export type ContinuousDvrPushInfo = {
  isInit?: boolean;
  timestampMs?: number;
  durationMs?: number;
};

export type ContinuousDvrMediaSegment = {
  blob: Blob;
  receivedAtMs: number;
  durationMs: number | null;
};

export type ContinuousDvrPipelineDebugState = {
  hasInit: boolean;
  initBytes: number;
  mediaCount: number;
  mediaBytes: number;
  maxMediaSegments: number;
  estimatedWindowMs: number;
  oldestSegmentAgeMs: number;
  newestSegmentAgeMs: number;
};

function getNowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

export class ContinuousDvrPipeline {
  private initSegment: Blob | null = null;
  private mediaSegments: ContinuousDvrMediaSegment[] = [];
  private mediaBytes = 0;

  private readonly maxMediaSegments: number;

  constructor(
    private readonly debug = false,
    // ~72s DVR window (60 segments × 1.2s)
    // Enough for ~25s replay with safety margin
    maxMediaSegments = 60
  ) {
    this.maxMediaSegments = Math.max(
      1,
      Math.trunc(Number(maxMediaSegments) || 0)
    );
  }

  public pushBlob(blob: Blob, info?: ContinuousDvrPushInfo): void {
    if (!blob || blob.size <= 0) {
      return;
    }

    const isInit = info?.isInit === true;

    if (isInit) {
      this.updateInitSegment(blob);
      return;
    }

    this.appendMediaSegment(blob, info);
  }

  public clear(): void {
    this.initSegment = null;
    this.mediaSegments = [];
    this.mediaBytes = 0;

    if (this.debug) {
      console.log("[Flashback][ContinuousDvrPipeline] cleared");
    }
  }

  public hasInit(): boolean {
    return !!this.initSegment;
  }

  public getInitSegment(): Blob | null {
    return this.initSegment;
  }

  public getMediaSegments(): Blob[] {
    return this.mediaSegments.map((segment) => segment.blob);
  }

  // Return a snapshot clone of the entries to avoid exposing
  // live mutable pipeline objects to upper layers.
  public getMediaEntries(): ContinuousDvrMediaSegment[] {
    return this.mediaSegments.map((segment) => ({
      blob: segment.blob,
      receivedAtMs: segment.receivedAtMs,
      durationMs: segment.durationMs,
    }));
  }

  public getEstimatedWindowMs(): number {
    if (this.mediaSegments.length <= 0) {
      return 0;
    }

    const explicitDurationMs = this.mediaSegments.reduce((acc, segment) => {
      if (
        segment.durationMs &&
        Number.isFinite(segment.durationMs) &&
        segment.durationMs > 0
      ) {
        return acc + segment.durationMs;
      }
      return acc;
    }, 0);

    if (explicitDurationMs > 0) {
      return explicitDurationMs;
    }

    if (this.mediaSegments.length === 1) {
      return 0;
    }

    const first = this.mediaSegments[0];
    const last = this.mediaSegments[this.mediaSegments.length - 1];
    const span = last.receivedAtMs - first.receivedAtMs;

    return Number.isFinite(span) && span > 0 ? span : 0;
  }

  public getDebugState(): ContinuousDvrPipelineDebugState {
    const now = getNowMs();
    const oldest = this.mediaSegments[0] ?? null;
    const newest = this.mediaSegments[this.mediaSegments.length - 1] ?? null;

    return {
      hasInit: !!this.initSegment,
      initBytes: this.initSegment?.size ?? 0,
      mediaCount: this.mediaSegments.length,
      mediaBytes: this.mediaBytes,
      maxMediaSegments: this.maxMediaSegments,
      estimatedWindowMs: this.getEstimatedWindowMs(),
      oldestSegmentAgeMs:
        oldest && Number.isFinite(now - oldest.receivedAtMs)
          ? Math.max(0, now - oldest.receivedAtMs)
          : 0,
      newestSegmentAgeMs:
        newest && Number.isFinite(now - newest.receivedAtMs)
          ? Math.max(0, now - newest.receivedAtMs)
          : 0,
    };
  }

  private updateInitSegment(blob: Blob): void {
    const previousInit = this.initSegment;
    this.initSegment = blob;

    // If the init segment changes, reset previous media to avoid
    // mixing "new init + old media".
    if (previousInit && previousInit !== blob) {
      this.mediaSegments = [];
      this.mediaBytes = 0;

      if (this.debug) {
        console.log(
          "[Flashback][ContinuousDvrPipeline] init replaced → media reset",
          {
            previousInitBytes: previousInit.size,
            nextInitBytes: blob.size,
          }
        );
      }

      return;
    }

    if (this.debug) {
      console.log("[Flashback][ContinuousDvrPipeline] init updated", {
        size: blob.size,
        type: blob.type,
      });
    }
  }

  private appendMediaSegment(blob: Blob, info?: ContinuousDvrPushInfo): void {
    const receivedAtMs =
      Number.isFinite(info?.timestampMs) && (info?.timestampMs ?? 0) >= 0
        ? Number(info?.timestampMs)
        : getNowMs();

    const durationMs =
      Number.isFinite(info?.durationMs) && (info?.durationMs ?? 0) > 0
        ? Number(info?.durationMs)
        : null;

    const last = this.mediaSegments[this.mediaSegments.length - 1];

    let safeTimestampMs = receivedAtMs;

    // Avoid timestamp regressions that could corrupt window estimation.
    // We preserve ingest order and clamp backwards timestamps to the last known time.
    if (last && Number.isFinite(last.receivedAtMs)) {
      if (safeTimestampMs < last.receivedAtMs) {
        safeTimestampMs = last.receivedAtMs;
      }
    }

    this.mediaSegments.push({
      blob,
      receivedAtMs: safeTimestampMs,
      durationMs,
    });

    this.mediaBytes += blob.size;

    while (this.mediaSegments.length > this.maxMediaSegments) {
      const removed = this.mediaSegments.shift();
      if (removed) {
        this.mediaBytes -= removed.blob.size;
      }
    }

    if (this.mediaBytes < 0) {
      this.mediaBytes = 0;
    }

    if (this.debug) {
      console.log("[Flashback][ContinuousDvrPipeline] media appended", {
        mediaCount: this.mediaSegments.length,
        mediaBytes: this.mediaBytes,
        maxMediaSegments: this.maxMediaSegments,
        estimatedWindowMs: this.getEstimatedWindowMs(),
        size: blob.size,
        type: blob.type,
        receivedAtMs: safeTimestampMs,
        originalReceivedAtMs: receivedAtMs,
        durationMs,
      });
    }
  }
}