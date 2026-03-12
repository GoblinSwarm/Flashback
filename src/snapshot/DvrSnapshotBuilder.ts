// src/snapshot/DvrSnapshotBuilder.ts
// ======================================================
//
// DvrSnapshotBuilder
// ------------------
//
// Concrete SnapshotBuilder implementation backed by
// ContinuousDvrPipeline.
//
// This builder reads the current DVR state and converts it
// into a ReplaySnapshotSource that can be consumed by the
// Replay and Playback layers.
//
// Typical flow
// ------------
//
//   ContinuousDvrPipeline
//          ↓
//   DvrSnapshotBuilder
//          ↓
//   ReplaySnapshotSource
//          ↓
//   ReplaySessionManager / ReplayCoordinator
//          ↓
//   PlaybackRouter
//          ↓
//   BlobPlayer / MsePlayer
//
// Current scope
// -------------
//
// This implementation builds an MSE-style snapshot source
// using:
//
// - the latest init segment from ContinuousDvrPipeline
// - a recent media window selected from buffered DVR media
//
// It performs lightweight temporal selection based on
// pipeline metadata when available.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - reading DVR state from ContinuousDvrPipeline
// - validating that the DVR payload is usable
// - building a ReplaySnapshotSource
// - assigning snapshot identity and metadata
// - selecting a coherent recent media window for replay
//
// This module MUST NOT:
//
// - perform playback
// - interact with MediaSource directly
// - attach to HTMLVideoElement
// - decide replay policy at runtime
// - manage replay sessions
// - manipulate UI
//
// Those responsibilities belong to:
//
//   ReplaySessionManager
//   ReplayCoordinator
//   PlaybackRouter
//   BlobPlayer / MsePlayer
//
// This file should remain a pure builder for snapshot
// creation from DVR state.
//

import { ContinuousDvrPipeline } from "../dvr/ContinuousDvrPipeline";
import type { BuildSnapshotRequest, SnapshotBuilder } from "./SnapshotBuilder";
import type { ReplaySnapshotSource } from "./SnapshotTypes";
import {
  MseSnapshotSanitizer,
  type SanitizerMediaEntry,
} from "./MseSnapshotSanitizer";

type PipelineMediaEntry = SanitizerMediaEntry;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function toPositiveNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

export class DvrSnapshotBuilder implements SnapshotBuilder {
  private readonly sanitizer: MseSnapshotSanitizer;

  constructor(
    private readonly pipeline: ContinuousDvrPipeline,
    private readonly debug = false
  ) {
    this.sanitizer = new MseSnapshotSanitizer({
      maxRecentEntriesForMse: 24,
      debug,
    });
  }

  public async build(
    request: BuildSnapshotRequest
  ): Promise<ReplaySnapshotSource> {
    const initSegment = this.pipeline.getInitSegment();
    const rawEntries = this.pipeline.getMediaEntries();

    if (!initSegment || initSegment.size <= 0) {
      throw new Error("DVR snapshot build failed: missing init segment");
    }

    if (!rawEntries.length) {
      throw new Error("DVR snapshot build failed: no media segments available");
    }

    const usableEntries = rawEntries.filter(
      (entry) => !!entry?.blob && entry.blob.size > 0
    );

    if (!usableEntries.length) {
      throw new Error("DVR snapshot build failed: media segments are empty");
    }

    // Important:
    // In this pipeline, the first recorder chunk may appear both as:
    // - initSegment
    // - first media segment
    //
    // Re-appending the exact same blob as both init and first media can
    // deform the snapshot timeline for fresh MSE playback.
    const dedupedEntries =
      usableEntries.length > 0 && usableEntries[0].blob === initSegment
        ? usableEntries.slice(1)
        : usableEntries.slice();

    const finalEntries =
      dedupedEntries.length > 0 ? dedupedEntries : usableEntries.slice();

    if (!finalEntries.length) {
      throw new Error("DVR snapshot build failed: no usable media after dedupe");
    }

    const requestedDurationSec = Math.max(0, Number(request.seconds) || 0);
    const requestedDurationMs = requestedDurationSec * 1000;

    const recentWindowEntries = this.selectRecentWindow(
      finalEntries,
      requestedDurationMs
    );

    const sanitized = await this.sanitizer.sanitizeRecentWindow(
      recentWindowEntries
    );

    const selectedEntries = sanitized.selectedEntries;

    if (!selectedEntries.length) {
      throw new Error("DVR snapshot build failed: selected media window is empty");
    }

    const mimeType = this.pickMimeType(
      initSegment,
      selectedEntries.map((entry) => entry.blob)
    );

    const actualDurationMs = this.estimateWindowDurationMs(selectedEntries);
    const actualDurationSec = actualDurationMs / 1000;

    const source: ReplaySnapshotSource = {
      kind: "mse",
      mimeType,
      range: {
        startSec: 0,
        endSec: actualDurationSec,
        durationSec: actualDurationSec,
      },
      chunks: {
        chunkCount: selectedEntries.length,
        hasInitSegment: true,
      },
      identity: {
        replayId: request.replayId,
        snapshotId: request.snapshotId,
        traceId: request.traceId ?? null,
      },
      initSegment,
      mediaSegments: selectedEntries.map((entry) => entry.blob),
    };

    if (this.debug) {
      const totalMediaBytes = selectedEntries.reduce(
        (sum, entry) => sum + (entry?.blob?.size || 0),
        0
      );

      console.log("[Flashback][DvrSnapshotBuilder] build", {
        replayId: request.replayId,
        snapshotId: request.snapshotId,
        traceId: request.traceId ?? null,
        requestedSeconds: request.seconds,
        requestedDurationSec,
        actualDurationSec,
        totalAvailableWindowSec: this.pipeline.getEstimatedWindowMs() / 1000,
        sourceMediaCount: usableEntries.length,
        dedupedMediaCount: finalEntries.length,
        recentWindowCount: sanitized.recentWindowCount,
        cappedRecentCount: sanitized.cappedRecentCount,
        keyframeStartIndex: sanitized.keyframeStartIndex,
        selectedMediaCount: selectedEntries.length,
        totalMediaBytes,
        firstMediaSize: selectedEntries[0]?.blob?.size ?? 0,
        lastMediaSize:
          selectedEntries[selectedEntries.length - 1]?.blob?.size ?? 0,
        mimeType,
        droppedDuplicatedInitAsMedia:
          usableEntries.length > 0 && usableEntries[0].blob === initSegment,
      });
    }

    return source;
  }

  private selectRecentWindow(
    entries: PipelineMediaEntry[],
    requestedDurationMs: number
  ): PipelineMediaEntry[] {
    if (!entries.length) {
      return [];
    }

    // If no specific duration is requested, keep everything.
    if (!Number.isFinite(requestedDurationMs) || requestedDurationMs <= 0) {
      return entries.slice();
    }

    const selected: PipelineMediaEntry[] = [];
    let accumulatedMs = 0;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      selected.unshift(entry);

      accumulatedMs += this.estimateEntryDurationMs(entries, i);

      if (accumulatedMs >= requestedDurationMs) {
        break;
      }
    }

    return selected.length > 0 ? selected : [entries[entries.length - 1]];
  }

  private estimateWindowDurationMs(entries: PipelineMediaEntry[]): number {
    if (!entries.length) {
      return 0;
    }

    let explicitTotalMs = 0;
    let hasExplicit = false;

    for (const entry of entries) {
      const durationMs = toPositiveNumberOrNull(entry.durationMs);
      if (durationMs) {
        explicitTotalMs += durationMs;
        hasExplicit = true;
      }
    }

    if (hasExplicit && explicitTotalMs > 0) {
      return explicitTotalMs;
    }

    if (entries.length === 1) {
      const singleEstimate = toPositiveNumberOrNull(entries[0].durationMs);
      return singleEstimate ?? 0;
    }

    const firstTs = toPositiveNumberOrNull(entries[0].receivedAtMs);
    const lastTs = toPositiveNumberOrNull(
      entries[entries.length - 1].receivedAtMs
    );

    if (firstTs !== null && lastTs !== null && lastTs >= firstTs) {
      const tailPad = this.estimateTailDurationMs(entries);
      return Math.max(0, lastTs - firstTs) + tailPad;
    }

    return entries.reduce((sum, _, index) => {
      return sum + this.estimateEntryDurationMs(entries, index);
    }, 0);
  }

  private estimateEntryDurationMs(
    entries: PipelineMediaEntry[],
    index: number
  ): number {
    const current = entries[index];
    const explicit = toPositiveNumberOrNull(current?.durationMs);
    if (explicit) {
      return explicit;
    }

    const currentTs = toPositiveNumberOrNull(current?.receivedAtMs);

    if (currentTs !== null) {
      const next = entries[index + 1];
      const nextTs = toPositiveNumberOrNull(next?.receivedAtMs);

      if (nextTs !== null && nextTs > currentTs) {
        return nextTs - currentTs;
      }

      const prev = entries[index - 1];
      const prevTs = toPositiveNumberOrNull(prev?.receivedAtMs);

      if (prevTs !== null && currentTs > prevTs) {
        return currentTs - prevTs;
      }
    }

    return 1000;
  }

  private estimateTailDurationMs(entries: PipelineMediaEntry[]): number {
    if (!entries.length) {
      return 0;
    }

    if (entries.length === 1) {
      return this.estimateEntryDurationMs(entries, 0);
    }

    const lastIndex = entries.length - 1;
    return clamp(
      this.estimateEntryDurationMs(entries, lastIndex),
      1,
      5000
    );
  }

  private pickMimeType(initSegment: Blob | null, mediaSegments: Blob[]): string {
    const initType = (initSegment?.type || "").trim();
    if (initType) return initType;

    for (const segment of mediaSegments) {
      const type = (segment?.type || "").trim();
      if (type) return type;
    }

    return "video/webm";
  }
}