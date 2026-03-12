// src/playback/PlaybackRouter.ts
// ======================================================
//
// PlaybackRouter
// --------------
//
// This module routes replay sources to the correct
// playback implementation.
//
// Architecture role
// -----------------
//
// PlaybackRouter belongs to the Playback Layer.
//
// It sits between:
//
//   ReplaySession / ReplayCoordinator
//        ↓
//   PlaybackRouter
//        ↓
//   BlobPlayer / MsePlayer
//
// The router does not implement playback itself.
// It only selects the correct player implementation
// based on the snapshot source type.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - receiving a VideoAttachRequest
// - selecting the correct playback implementation
// - delegating attach() to the selected player
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build replay sources
// - own replay session lifecycle
// - own UI lifecycle
// - implement playback internals
// - manipulate MediaSource
// - attach HTMLVideoElement directly
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   ReplayCoordinator
//   BlobPlayer
//   MsePlayer
//   UI layer
//
// Design rule
// -----------
//
// PlaybackRouter is a routing boundary.
//
// If replay/session logic or playback engine internals
// start appearing here, the architecture is being violated.
//

import type {
  VideoAttach,
  VideoAttachRequest,
  VideoAttachResult,
} from "./VideoAttach";

export class PlaybackRouter implements VideoAttach {
  constructor(
    private readonly blobPlayer: VideoAttach,
    private readonly msePlayer: VideoAttach,
    private readonly debug = false
  ) {}

  public async attach(
    request: VideoAttachRequest
  ): Promise<VideoAttachResult> {
    const kind = request.source.kind;

    if (this.debug) {
      console.log("[Flashback][PlaybackRouter] attach", {
        sourceKind: kind,
        mimeType: request.source.mimeType,
        autoplay: request.autoplay ?? true,
        muted: request.muted ?? true,
      });
    }

    if (kind === "blob") {
      return await this.blobPlayer.attach(request);
    }

    if (kind === "mse") {
      return await this.msePlayer.attach(request);
    }

    throw new Error(
      `[Flashback][PlaybackRouter] Unsupported playback source kind: ${String(
        kind
      )}`
    );
  }
}