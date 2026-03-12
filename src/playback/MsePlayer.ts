// src/playback/MsePlayer.ts
// ======================================================
//
// MsePlayer
// ---------
//
// Playback implementation for MSE-based replay sources.
//
// Architecture role
// -----------------
//
// MsePlayer belongs to the Playback Layer.
//
// It is responsible for attaching an MSE-style replay
// snapshot to an HTMLVideoElement by creating a dedicated
// MediaSource, creating a SourceBuffer, appending the
// init segment first, then appending media segments in
// order.
//
// Very important boundary
// -----------------------
//
// `MsePlayer` is the canonical player for snapshot-based
// MSE replay.
//
// In this architecture:
//
// - `MsePlayer`           = closed snapshot playback
// - `ContinuousDvrEngine` = live DVR engine
//
// Even though both use MediaSource / SourceBuffer, they
// must not absorb each other's responsibilities.
//
// This file should never start consuming live recorder-fed
// DVR streams directly. That would make it overlap with
// `ContinuousDvrEngine`.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - validating mse snapshot sources
// - creating MediaSource / SourceBuffer
// - appending init first, then appending media segments in order
// - attaching the generated object URL to the video
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
// - perform DVR ingest
// - decide playback routing policy
// - behave like a live DVR engine
// - consume recorder/live bridge events directly
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   ReplayCoordinator
//   PlaybackRouter
//   ContinuousDvrEngine
//   UI layer
//
// Design rule
// -----------
//
// MsePlayer is a concrete snapshot playback implementation.
//
// If live ingest, DVR window maintenance, replay ownership,
// routing policy, or UI construction starts appearing here,
// the architecture is being violated.
//
// Maintenance note
// ----------------
//
// If a future feature sounds like:
//
// - "keep appending live chunks"
// - "maintain rolling DVR buffer"
// - "seek within the live DVR window"
//
// then that logic does NOT belong here.
// That belongs in `ContinuousDvrEngine`.
//

import type {
  VideoAttach,
  VideoAttachRequest,
  VideoAttachResult,
} from "./VideoAttach";

import {
  hasUsableMseSegments,
  isMseSnapshotSource,
} from "../snapshot/SnapshotSource";

import { stabilizeMsePlayback } from "./MsePlaybackStabilizer";

function waitForEvent(
  target: EventTarget,
  eventName: string,
  timeoutMs = 4000
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        target.removeEventListener(eventName, onEvent);
      } catch {}
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };

    const onEvent = () => {
      cleanup();
      resolve();
    };

    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            cleanup();
            resolve();
          }, timeoutMs)
        : null;

    target.addEventListener(eventName, onEvent, { once: true });
  });
}

function waitForSourceBufferIdleOrError(
  sourceBuffer: SourceBuffer,
  timeoutMs = 4000
): Promise<"updateend" | "error" | "abort" | "timeout"> {
  if (!sourceBuffer.updating) {
    return Promise.resolve("updateend");
  }

  return new Promise((resolve) => {
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;

      try {
        sourceBuffer.removeEventListener("updateend", onUpdateEnd);
      } catch {}
      try {
        sourceBuffer.removeEventListener("error", onError);
      } catch {}
      try {
        sourceBuffer.removeEventListener("abort", onAbort);
      } catch {}

      if (timer != null) {
        window.clearTimeout(timer);
      }
    };

    const finish = (result: "updateend" | "error" | "abort" | "timeout") => {
      cleanup();
      resolve(result);
    };

    const onUpdateEnd = () => finish("updateend");
    const onError = () => finish("error");
    const onAbort = () => finish("abort");

    sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    sourceBuffer.addEventListener("abort", onAbort, { once: true });

    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => finish("timeout"), timeoutMs)
        : null;
  });
}

export class MsePlayer implements VideoAttach {
  private currentObjectUrl: string | null = null;
  private attachToken = 0;
  private readonly maxOffsetAttempts = 4;
  private readonly debug: boolean;

  constructor(debug = false) {
    this.debug = !!debug;
  }

  public async attach(
    request: VideoAttachRequest
  ): Promise<VideoAttachResult> {
    const token = ++this.attachToken;

    const { video } = request.target;
    const { source, autoplay = true, muted = true } = request;

    if (!isMseSnapshotSource(source)) {
      throw new Error("MsePlayer can only attach mse snapshot sources");
    }

    if (!source.initSegment || source.initSegment.size <= 0) {
      throw new Error("MsePlayer received an mse snapshot without init segment");
    }

    if (!hasUsableMseSegments(source)) {
      throw new Error("MsePlayer received an unusable mse snapshot source");
    }

    if (typeof MediaSource === "undefined") {
      throw new Error("MediaSource is not available in this environment");
    }

    if (!MediaSource.isTypeSupported(source.mimeType)) {
      throw new Error(`MSE mime type not supported: ${source.mimeType}`);
    }

    video.autoplay = autoplay;
    video.muted = muted;
    video.playsInline = true;
    video.controls = false;

    const attemptCount = Math.min(
      this.maxOffsetAttempts,
      source.mediaSegments.length
    );

    let lastError: unknown = null;

    for (let offset = 0; offset < attemptCount; offset++) {
      if (this.isSuperseded(token)) {
        return {
          attached: false,
          path: "snapshot_mse",
          reason: "attach_superseded",
        };
      }

      try {
        await this.attachWithOffset({
          video,
          source,
          token,
          autoplay,
          offset,
        });

        await stabilizeMsePlayback(video, {
          autoplay,
          debug: this.debug,
        });

        return {
          attached: true,
          path: "snapshot_mse",
          reason: null,
        };
      } catch (error) {
        lastError = error;

        if (this.debug) {
          try {
            console.warn("[Flashback][MsePlayer] attach attempt failed", {
              offset,
              error: String(error),
            });
          } catch {}
        }

        this.revokeCurrentObjectUrl();
        this.resetVideoElement(video);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("MSE attach failed after offset retries");
  }

  private async attachWithOffset(args: {
    video: HTMLVideoElement;
    source: Extract<VideoAttachRequest["source"], { kind: "mse" }>;
    token: number;
    autoplay: boolean;
    offset: number;
  }): Promise<void> {
    const { video, source, token, offset } = args;

    this.revokeCurrentObjectUrl();
    this.resetVideoElement(video);
    this.throwIfVideoHasError(video, `after resetVideoElement(offset=${offset})`);

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    this.currentObjectUrl = objectUrl;

    try {
      video.srcObject = null;
    } catch {}

    video.src = objectUrl;

    this.throwIfVideoHasError(video, `after assigning object URL(offset=${offset})`);

    await waitForEvent(mediaSource, "sourceopen", 4000);

    if (this.isSuperseded(token)) {
      this.cleanupSupersededVideo(video, objectUrl);
      throw new Error(`MSE attach superseded before sourceopen(offset=${offset})`);
    }

    this.throwIfVideoHasError(video, `before addSourceBuffer(offset=${offset})`);

    const sourceBuffer = mediaSource.addSourceBuffer(source.mimeType);

    await this.appendBlobToSourceBuffer(
      source.initSegment,
      sourceBuffer,
      video,
      token,
      objectUrl,
      `init(offset=${offset})`
    );

    for (let i = offset; i < source.mediaSegments.length; i++) {
      const segment = source.mediaSegments[i];
      if (!segment || segment.size <= 0) {
        continue;
      }

      await this.appendBlobToSourceBuffer(
        segment,
        sourceBuffer,
        video,
        token,
        objectUrl,
        `media[${i}]`
      );
    }

    try {
      if (mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
    } catch {}

    this.seekVideoToBufferedStart(video);

    if (this.debug) {
      try {
        console.log("[Flashback][MsePlayer] buffered_after_attach", {
          offset,
          ranges: video.buffered?.length ?? 0,
          start:
            video.buffered && video.buffered.length > 0
              ? video.buffered.start(0)
              : null,
          end:
            video.buffered && video.buffered.length > 0
              ? video.buffered.end(0)
              : null,
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : null,
        });
      } catch {}
    }

    if (this.isSuperseded(token)) {
      this.cleanupSupersededVideo(video, objectUrl);
      throw new Error(`MSE attach superseded after append(offset=${offset})`);
    }
  }

  private async appendBlobToSourceBuffer(
    blob: Blob,
    sourceBuffer: SourceBuffer,
    video: HTMLVideoElement,
    token: number,
    objectUrl: string,
    label: string
  ): Promise<void> {
    if (this.isSuperseded(token)) {
      this.cleanupSupersededVideo(video, objectUrl);
      throw new Error(`MSE attach superseded before append: ${label}`);
    }

    this.throwIfVideoHasError(video, `before append ${label}`);

    const bytes = await blob.arrayBuffer();

    if (this.isSuperseded(token)) {
      this.cleanupSupersededVideo(video, objectUrl);
      throw new Error(`MSE attach superseded after arrayBuffer: ${label}`);
    }

    this.throwIfVideoHasError(video, `before appendBuffer ${label}`);

    try {
      sourceBuffer.appendBuffer(bytes);
    } catch (error) {
      this.throwIfVideoHasError(video, `appendBuffer threw for ${label}`);
      throw error;
    }

    const state = await waitForSourceBufferIdleOrError(sourceBuffer, 4000);

    if (state === "error") {
      throw new Error(`SourceBuffer error while appending ${label}`);
    }

    if (state === "abort") {
      throw new Error(`SourceBuffer abort while appending ${label}`);
    }

    if (state === "timeout") {
      throw new Error(`SourceBuffer update timeout while appending ${label}`);
    }

    this.throwIfVideoHasError(video, `after append ${label}`);
  }

  private seekVideoToBufferedStart(video: HTMLVideoElement): void {
    try {
      const buffered = video.buffered;

      if (!buffered || buffered.length === 0) {
        return;
      }

      const start = buffered.start(0);

      if (Number.isFinite(start) && start > 0) {
        video.currentTime = start + 0.001;
      } else {
        video.currentTime = 0;
      }
    } catch {}
  }

  private throwIfVideoHasError(video: HTMLVideoElement, stage: string): void {
    const mediaError = video.error;
    if (!mediaError) {
      return;
    }

    const code =
      typeof mediaError.code === "number" ? mediaError.code : "unknown";

    throw new Error(
      `HTMLVideoElement entered error state at stage="${stage}" (code=${code})`
    );
  }

  private isSuperseded(token: number): boolean {
    return token !== this.attachToken;
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

  private cleanupSupersededVideo(
    video: HTMLVideoElement,
    objectUrl: string
  ): void {
    try {
      if (video.src === objectUrl) {
        video.pause();
      }
    } catch {}

    try {
      if (video.src === objectUrl) {
        video.removeAttribute("src");
      }
    } catch {}

    try {
      if (video.src === objectUrl || !video.getAttribute("src")) {
        video.load();
      }
    } catch {}

    try {
      URL.revokeObjectURL(objectUrl);
    } catch {}

    if (this.currentObjectUrl === objectUrl) {
      this.currentObjectUrl = null;
    }
  }

  private resetVideoElement(video: HTMLVideoElement): void {
    try {
      video.pause();
    } catch {}

    try {
      video.removeAttribute("src");
    } catch {}

    try {
      video.srcObject = null;
    } catch {}

    try {
      video.load();
    } catch {}
  }
}