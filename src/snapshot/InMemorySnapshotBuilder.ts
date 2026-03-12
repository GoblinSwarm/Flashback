// src/snapshot/InMemorySnapshotBuilder.ts
// ======================================================
//
// InMemorySnapshotBuilder
// -----------------------
//
// Minimal in-memory SnapshotBuilder implementation.
//
// This builder does NOT read from DVR state and does NOT
// assemble real replay media payloads.
//
// Its purpose is only to provide a structurally valid
// ReplaySnapshotSource for tests, placeholders, or wiring
// scenarios where a concrete DVR-backed snapshot is not
// required.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - implementing the SnapshotBuilder contract
// - returning a structurally valid snapshot object
// - preserving request identity metadata
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - read live DVR state
// - build real init/media payloads
// - perform playback
// - manage replay lifecycle
// - attach HTMLVideoElement
//

import type { SnapshotBuilder, BuildSnapshotRequest } from "./SnapshotBuilder";
import type { ReplaySnapshotSource } from "./SnapshotTypes";

export class InMemorySnapshotBuilder implements SnapshotBuilder {
  public async build(
    request: BuildSnapshotRequest
  ): Promise<ReplaySnapshotSource> {
    const durationSec = Math.max(1, Number(request.seconds) || 0);

    return {
      kind: "mse",
      mimeType: "video/webm",
      range: {
        startSec: 0,
        endSec: durationSec,
        durationSec,
      },
      chunks: {
        chunkCount: 0,
        hasInitSegment: false,
      },
      identity: {
        replayId: request.replayId,
        snapshotId: request.snapshotId,
        traceId: request.traceId ?? null,
      },
      initSegment: new Blob([], { type: "video/webm" }),
      mediaSegments: [],
    };
  }
}