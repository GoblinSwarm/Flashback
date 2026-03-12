// src/playback/BlobPlayer.ts
// ======================================================
//
// BlobPlayer
// ----------
//
// Playback implementation for blob-based replay sources.
//
// Architecture role
// -----------------
//
// BlobPlayer belongs to the **Playback Layer**.
//
// It is responsible for attaching a blob-based snapshot
// source to an HTMLVideoElement using an object URL.
//
// Typical flow
// ------------
//
//   ReplaySnapshotSource(kind="blob")
//              ↓
//         PlaybackRouter
//              ↓
//           BlobPlayer
//              ↓
//       HTMLVideoElement
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - validating blob snapshot sources
// - attaching blob snapshots to an HTMLVideoElement
// - managing object URL lifecycle
// - optionally starting playback
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build snapshot sources
// - own replay session lifecycle
// - own UI orchestration
// - implement routing policy
// - manipulate DVR state
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   ReplayCoordinator
//   PlaybackRouter
//   UI layer
//
// Design rule
// -----------
//
// BlobPlayer is a concrete playback implementation.
//
// If snapshot construction, replay ownership, routing
// policy, or UI construction starts appearing here,
// the architecture is being violated.
//

import type {
  VideoAttach,
  VideoAttachRequest,
  VideoAttachResult,
} from "./VideoAttach";

import { isBlobSnapshotSource } from "../snapshot/SnapshotSource";

export class BlobPlayer implements VideoAttach {
  private currentObjectUrl: string | null = null;

  public async attach(
    request: VideoAttachRequest
  ): Promise<VideoAttachResult> {
    const { video } = request.target;
    const { source, autoplay = true, muted = true } = request;

    if (!isBlobSnapshotSource(source)) {
      throw new Error("BlobPlayer can only attach blob snapshot sources");
    }

    this.revokeCurrentObjectUrl();
    this.resetVideoElement(video);

    const objectUrl = URL.createObjectURL(source.blob);
    this.currentObjectUrl = objectUrl;

    video.src = objectUrl;
    video.muted = muted;

    if (autoplay) {
      try {
        await video.play();
      } catch {
        // autoplay is best-effort only
      }
    }

    return {
      attached: true,
      path: "snapshot_blob",
      reason: null,
    };
  }

  private revokeCurrentObjectUrl(): void {
    if (!this.currentObjectUrl) {
      return;
    }

    try {
      URL.revokeObjectURL(this.currentObjectUrl);
    } catch {}

    this.currentObjectUrl = null;
  }

  private resetVideoElement(video: HTMLVideoElement): void {
    try {
      video.pause();
    } catch {}

    try {
      video.removeAttribute("src");
    } catch {}

    try {
      video.load();
    } catch {}
  }
}