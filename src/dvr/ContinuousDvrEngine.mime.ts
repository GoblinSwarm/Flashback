// src/dvr/ContinuousDvrEngine.mime.ts
// ======================================================
//
// Mime helpers for ContinuousDvrEngine.
//
// This file owns mime normalization and init-blob mime adoption rules.
//
// Important:
// - no MediaSource attach logic here
// - no replay policy here
// - no UI logic here
//

export type AnalyzeInitBlobMimeResult = {
  normalizedBlobMimeType: string;
  shouldAdoptBlobMime: boolean;
};

export function normalizeMimeType(value: string | null | undefined): string {
  return String(value || "").trim();
}

export function isGenericWebmMime(value: string): boolean {
  const mime = normalizeMimeType(value).toLowerCase();
  return mime === "video/webm";
}

export function shouldAdoptInitBlobMime(args: {
  currentMimeType: string | null | undefined;
  blobMimeType: string | null | undefined;
}): boolean {
  const currentMimeType = normalizeMimeType(args.currentMimeType);
  const blobMimeType = normalizeMimeType(args.blobMimeType);

  if (!blobMimeType) {
    return false;
  }

  if (!currentMimeType) {
    return true;
  }

  if (isGenericWebmMime(currentMimeType)) {
    return true;
  }

  return currentMimeType !== blobMimeType;
}

export function analyzeInitBlobMime(args: {
  currentMimeType: string | null | undefined;
  blobType: string | null | undefined;
}): AnalyzeInitBlobMimeResult {
  const normalizedBlobMimeType = normalizeMimeType(args.blobType);

  return {
    normalizedBlobMimeType,
    shouldAdoptBlobMime: shouldAdoptInitBlobMime({
      currentMimeType: args.currentMimeType,
      blobMimeType: normalizedBlobMimeType,
    }),
  };
}

export function updateMimeTypeIfNeeded(args: {
  currentMimeType: string;
  nextMimeType: string | null | undefined;
  onChange?: (info: {
    previousMimeType: string;
    nextMimeType: string;
  }) => void;
}): {
  nextMimeType: string;
  changed: boolean;
} {
  const currentMimeType = normalizeMimeType(args.currentMimeType) || "video/webm";
  const candidateMimeType = normalizeMimeType(args.nextMimeType);

  if (!candidateMimeType || candidateMimeType === currentMimeType) {
    return {
      nextMimeType: currentMimeType,
      changed: false,
    };
  }

  args.onChange?.({
    previousMimeType: currentMimeType,
    nextMimeType: candidateMimeType,
  });

  return {
    nextMimeType: candidateMimeType,
    changed: true,
  };
}