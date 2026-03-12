// src/dvr/ContinuousDvrEngine.types.ts
// ======================================================
//
// Types for ContinuousDvrEngine.
//
// This file contains only shared type definitions used by
// the live DVR engine. Keeping these types separate helps
// reduce noise in the engine implementation file and makes
// future refactors safer.
//

export type BufferedRange = {
  start: number;
  end: number;
};

export type ContinuousDvrEngineOptions = {
  mimeType: string;
  maxQueue?: number;
  debug?: boolean;
};

export type ContinuousDvrEngineDebugState = {
  hasVideo: boolean;
  hasMediaSource: boolean;
  hasSourceBuffer: boolean;
  queuedCount: number;
  appendedCount: number;
  hasInitSegment: boolean;
  bufferedRange: BufferedRange | null;
  mimeType: string;
};