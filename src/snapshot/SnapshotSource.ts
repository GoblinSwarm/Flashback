// src/snapshot/SnapshotSource.ts
// ======================================================
//
// SnapshotSource utilities
// ------------------------
//
// This module provides lightweight helpers for working
// with ReplaySnapshotSource objects.
//
// The snapshot is the contract object that travels
// between the DVR layer, the Replay layer and the
// Playback layer.
//
// Typical flow:
//
//   DVR Pipeline
//        ↓
//   DvrSnapshotBuilder
//        ↓
//   ReplaySnapshotSource
//        ↓
//   ReplaySessionManager / ReplayCoordinator
//        ↓
//   PlaybackRouter
//        ↓
//   BlobPlayer / MsePlayer
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - type guards for snapshot variants
// - small helpers for snapshot inspection
// - extracting common snapshot metadata
//
// This module MUST NOT:
//
// - build snapshots
// - read DVR pipeline state
// - perform playback
// - interact with MediaSource
// - attach to HTMLVideoElement
// - contain replay policy
//
// Those responsibilities belong to other layers.
// This file must remain a pure utility module
// with zero side effects.
//

import type {
  BlobSnapshotSource,
  MseSnapshotSource,
  ReplaySnapshotSource,
} from "./SnapshotTypes";

export function isBlobSnapshotSource(
  source: ReplaySnapshotSource
): source is BlobSnapshotSource {
  return source.kind === "blob";
}

export function isMseSnapshotSource(
  source: ReplaySnapshotSource
): source is MseSnapshotSource {
  return source.kind === "mse";
}

export function getSnapshotDurationSec(source: ReplaySnapshotSource): number {
  return source.range.durationSec;
}

export function getSnapshotLabel(source: ReplaySnapshotSource): string {
  const { replayId, snapshotId } = source.identity;
  return `${replayId}:${snapshotId}`;
}

export function hasUsableMseSegments(source: ReplaySnapshotSource): boolean {
  return isMseSnapshotSource(source) && source.mediaSegments.length > 0;
}

export function hasUsableBlob(source: ReplaySnapshotSource): boolean {
  return isBlobSnapshotSource(source) && source.blob.size > 0;
}