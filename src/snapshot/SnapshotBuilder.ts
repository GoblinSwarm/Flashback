// src/snapshot/SnapshotBuilder.ts
// ======================================================
//
// SnapshotBuilder contract
// ------------------------
//
// This module defines the contract used to build
// replay snapshot sources from an internal DVR or
// capture state.
//
// A SnapshotBuilder converts buffered recording data
// into a ReplaySnapshotSource that can later be consumed
// by the Replay and Playback layers.
//
// Typical flow
// ------------
//
//   ContinuousDvrPipeline (or other capture source)
//          ↓
//   SnapshotBuilder implementation
//          ↓
//   ReplaySnapshotSource
//          ↓
//   ReplaySessionManager / ReplayCoordinator
//          ↓
//   PlaybackRouter
//          ↓
//   BlobPlayer / MsePlayer
//
// Architecture role
// -----------------
//
// SnapshotBuilder belongs to the **Snapshot Layer**.
//
// It acts as the transformation boundary between:
//
//   DVR / Capture state
//        ↓
//   Replay snapshot representation
//
// Upper layers should never know how the snapshot
// was constructed internally.
//
// Responsibilities
// ----------------
//
// This module defines ONLY:
//
// - the snapshot build request structure
// - the SnapshotBuilder contract interface
//
// Implementations of this interface are responsible
// for reading capture/DVR state and producing a
// ReplaySnapshotSource.
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - own recording lifecycle
// - own replay session lifecycle
// - attach video elements
// - implement playback
// - manipulate MediaSource
// - interact with HTMLVideoElement
//
// Those responsibilities belong to:
//
//   FlashbackRecorder
//   ReplaySessionManager
//   PlaybackRouter
//   BlobPlayer / MsePlayer
//
// Design rule
// -----------
//
// SnapshotBuilder is a transformation contract.
//
// Concrete implementations may consume:
//
//   • ContinuousDvrPipeline
//   • capture buffers
//   • other stable media sources
//
// but those dependencies must remain inside the
// implementation, not in this contract.
//

import type { ReplaySnapshotSource } from "./SnapshotTypes";

export interface BuildSnapshotRequest {
  replayId: string;
  snapshotId: string;
  seconds: number;
  traceId?: string | null;
}

export interface SnapshotBuilder {
  build(request: BuildSnapshotRequest): Promise<ReplaySnapshotSource>;
}