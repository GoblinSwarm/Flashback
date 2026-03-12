// src/snapshot/SnapshotTypes.ts
// ======================================================
//
// Snapshot source types
// ---------------------
//
// This file defines the canonical snapshot types used
// across the Flashback replay pipeline.
//
// A snapshot represents a **stable replayable view**
// of the DVR buffer at a specific moment in time.
//
// These types act as the **contract between layers**:
//
//   DVR Layer
//        ↓
//   DvrSnapshotBuilder
//        ↓
//   ReplaySnapshotSource
//        ↓
//   ReplaySession / ReplayCoordinator
//        ↓
//   PlaybackRouter
//        ↓
//   BlobPlayer / MsePlayer
//
// Design goals
// ------------
//
// - Immutable snapshot description
// - Transport-agnostic replay source
// - Stable cross-layer contract
// - Clear identity for tracing/debugging
//
// ------------------------------------------------------
// Responsibilities
// ------------------------------------------------------
//
// This module defines ONLY:
//
// - snapshot structural types
// - snapshot metadata
// - snapshot identity information
//
// These types are used to transport replay data
// across layers without leaking internal state.
//
// ------------------------------------------------------
// What this module MUST NOT do
// ------------------------------------------------------
//
// This module must NEVER:
//
// - build snapshots
// - inspect DVR buffers
// - implement playback logic
// - manipulate MediaSource
// - interact with HTMLVideoElement
// - contain replay policy
//
// Snapshot construction belongs to:
//
//   DvrSnapshotBuilder
//
// Snapshot consumption belongs to:
//
//   PlaybackRouter
//   BlobPlayer
//   MsePlayer
//
// This file must remain **pure type definitions**
// with zero runtime logic.
//

export type SnapshotSourceKind = "blob" | "mse";

export interface SnapshotTimeRange {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface SnapshotChunkInfo {
  chunkCount: number;
  hasInitSegment: boolean;
}

export interface SnapshotIdentity {
  replayId: string;
  snapshotId: string;
  traceId?: string | null;
}

export interface SnapshotSource {
  kind: SnapshotSourceKind;
  mimeType: string;
  range: SnapshotTimeRange;
  chunks: SnapshotChunkInfo;
  identity: SnapshotIdentity;
}

export interface BlobSnapshotSource extends SnapshotSource {
  kind: "blob";
  blob: Blob;
}

export interface MseSnapshotSource extends SnapshotSource {
  kind: "mse";

  // Initialization segment required for MediaSource playback
  initSegment: Blob;

  // Ordered media segments
  mediaSegments: Blob[];
}

export type ReplaySnapshotSource =
  | BlobSnapshotSource
  | MseSnapshotSource;