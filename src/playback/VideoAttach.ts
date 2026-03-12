// src/playback/VideoAttach.ts
// ======================================================
//
// VideoAttach
// -----------
//
// This module defines the playback attachment contract
// between a replay path and a target HTMLVideoElement.
//
// Architecture role
// -----------------
//
// VideoAttach belongs to the **Playback Layer**.
//
// It is the contract boundary between:
//
// - replay/session state
// - playback coordination
// - concrete playback implementations
//
// Typical flow
// ------------
//
//   ReplaySession
//        ↓
//   ReplayCoordinator
//        ↓
//   PlaybackRouter / DVR attach path
//        ↓
//   VideoAttach contract
//        ↓
//   BlobPlayer / MsePlayer / Continuous DVR path
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - defining the target video contract
// - defining the attach request contract
// - defining the attach result contract
// - defining the playback attachment interface
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build replay sources
// - own replay session lifecycle
// - own UI lifecycle
// - decide replay policy
// - implement playback internals
// - manipulate MediaSource directly
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   ReplayCoordinator
//   BlobPlayer / MsePlayer
//   UI layer
//
// Design rule
// -----------
//
// VideoAttach is a pure playback boundary contract.
//
// If replay/session logic, UI construction, or playback
// engine internals start appearing here, the architecture
// is being violated.
//

import type { ReplaySnapshotSource } from "../snapshot/SnapshotTypes";

export interface VideoAttachTarget {
  video: HTMLVideoElement;
}

export interface VideoAttachRequest {
  target: VideoAttachTarget;
  source: ReplaySnapshotSource;
  autoplay?: boolean;
  muted?: boolean;
}

export type VideoAttachPath =
  | "snapshot_blob"
  | "snapshot_mse"
  | "continuous_dvr"
  | "unknown";

export interface VideoAttachResult {
  attached: boolean;
  path: VideoAttachPath;
  reason?: string | null;
}

export interface VideoAttach {
  attach(request: VideoAttachRequest): Promise<VideoAttachResult>;
}