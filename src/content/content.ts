// src/content/content.ts
// ======================
//
// Flashback Content Entrypoint
//
// This is the main entrypoint executed by the Chrome MV3 content script.
// It initializes the Flashback content runtime, starts the auto-start
// video detection system, listens for popup replay requests, and exposes
// the final replay shortcut used by the product.
//

import { FlashbackContentRuntime } from "./FlashbackContentRuntime";

type FlashbackTriggerReplayMessage = {
  type: "FLASHBACK_TRIGGER_REPLAY";
  payload?: {
    seconds?: number;
    traceId?: string;
    source?: string;
  };
};

const runtime = new FlashbackContentRuntime({
  debug: false,
  maxBufferMs: 40000,
  timesliceMs: 1200,

  autoStart: {
    enabled: true,
    pollMs: 450,
    stableTicks: 3,
    minVideoWidth: 160,
    minVideoHeight: 90,
    requirePlaying: true,
    requireTimeProgress: true,
    timeProgressWindowMs: 900,
    timeProgressMinDelta: 200,
    debug: false,
  },

  warmup: {
    enabled: true,
    durationMs: 4000,
    stableTicks: 2,
    requirePlaying: false,
    requireTimeProgress: false,
  },
});

try {
  runtime.start();
  console.log("[Flashback] content runtime initialized");
} catch (error) {
  console.error("[Flashback] content runtime failed to initialize", error);
}

// ======================================================
// Replay shortcut
// ------------------------------------------------------
// Shift + R => trigger 25-second replay
//
// This shortcut is part of the final product UX.
//
// It provides a fast keyboard entrypoint for instant
// replay requests while the extension popup provides
// the equivalent pointer-based interaction.
//
// Both inputs must remain aligned and trigger the same
// replay flow.
// ======================================================

document.addEventListener("keydown", async (event) => {
  if (!event.shiftKey || event.code !== "KeyR") {
    return;
  }

  const target = event.target as HTMLElement | null;
  const tagName = (target?.tagName || "").toLowerCase();
  const isEditable =
    !!target?.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select";

  if (isEditable) {
    return;
  }

  try {
    console.log("[Flashback] replay shortcut triggered", {
      seconds: 25,
      traceId: "shortcut-trigger",
    });

    await runtime.triggerReplay(25, "shortcut-trigger");
  } catch (error) {
    console.error("[Flashback] replay shortcut failed", {
      error: String(error),
    });
  }
});

// ------------------------------------------------
// Popup message bridge
// ------------------------------------------------
//
// This listener allows the extension popup to request
// a replay on the active page content runtime.
//

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const typedMessage = message as FlashbackTriggerReplayMessage | undefined;

  if (!typedMessage || typedMessage.type !== "FLASHBACK_TRIGGER_REPLAY") {
    return;
  }

  const seconds = Math.max(1, Math.trunc(typedMessage.payload?.seconds ?? 25));
  const traceId = typedMessage.payload?.traceId ?? "popup-trigger";

  void (async () => {
    try {
      console.log("[Flashback] popup replay request received", {
        seconds,
        traceId,
        source: typedMessage.payload?.source ?? "popup",
      });

      await runtime.triggerReplay(seconds, traceId);

      sendResponse({
        ok: true,
      });
    } catch (error) {
      console.error("[Flashback] popup replay request failed", {
        error: String(error),
      });

      sendResponse({
        ok: false,
        error: String(error),
      });
    }
  })();

  return true;
});

// ------------------------------------------------
// Optional: expose runtime for debugging
// ------------------------------------------------

try {
  (window as any).__flashbackRuntime = runtime;
} catch {}