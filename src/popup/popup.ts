// src/popup/popup.ts
// =================
//
// popup.ts
// --------
//
// This module implements the Flashback extension popup logic.
//
// It is responsible for wiring the popup button to the active tab
// so the content script can trigger a replay request.
//
// Architecture role
// -----------------
// popup.ts belongs to the extension popup layer.
//
// It is intentionally small and only coordinates:
//
// - popup button interaction
// - status badge updates
// - message sending to the active tab
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - reading popup DOM elements
// - reacting to popup button clicks
// - sending a replay request message to the active tab
// - updating popup-local status feedback
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - implement replay logic
// - own runtime state
// - interact with DVR internals
// - know how playback is attached
//
// Those responsibilities belong to the content script runtime.
//

type PopupReplayRequestMessage = {
  type: "FLASHBACK_TRIGGER_REPLAY";
  payload: {
    seconds: number;
    traceId: string;
    source: "popup";
  };
};

type PopupReplayResponseMessage = {
  ok: boolean;
  error?: string | null;
};

const REPLAY_SECONDS = 25;
const READY_LABEL = "Ready";
const REPLAY_LABEL = "Replay";
const ERROR_LABEL = "Error";

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required popup element: #${id}`);
  }

  return element as T;
}

function setStatus(statusBadge: HTMLElement, text: string): void {
  statusBadge.textContent = text;
}

function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.textContent = busy ? "Replaying..." : "Flashback";
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tabs || tabs.length <= 0) {
    return null;
  }

  return tabs[0] ?? null;
}

function isSendMessageErrorAcceptable(): boolean {
  const lastErrorMessage = chrome.runtime.lastError?.message ?? "";

  return (
    lastErrorMessage.includes("Receiving end does not exist") ||
    lastErrorMessage.includes("Could not establish connection")
  );
}

async function sendReplayRequestToActiveTab(seconds: number): Promise<void> {
  const activeTab = await getActiveTab();

  if (!activeTab?.id) {
    throw new Error("No active tab found.");
  }

  const message: PopupReplayRequestMessage = {
    type: "FLASHBACK_TRIGGER_REPLAY",
    payload: {
      seconds,
      traceId: "popup-trigger",
      source: "popup",
    },
  };

  await new Promise<void>((resolve, reject) => {
    chrome.tabs.sendMessage(
      activeTab.id!,
      message,
      (response?: PopupReplayResponseMessage) => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          if (isSendMessageErrorAcceptable()) {
            reject(
              new Error(
                "Flashback content script is not available on this page."
              )
            );
            return;
          }

          reject(new Error(lastError.message));
          return;
        }

        if (!response) {
          reject(new Error("No response received from content script."));
          return;
        }

        if (!response.ok) {
          reject(new Error(response.error || "Replay request failed."));
          return;
        }

        resolve();
      }
    );
  });
}

async function handleFlashbackClick(args: {
  button: HTMLButtonElement;
  statusBadge: HTMLElement;
}): Promise<void> {
  const { button, statusBadge } = args;

  try {
    setButtonBusy(button, true);
    setStatus(statusBadge, REPLAY_LABEL);

    await sendReplayRequestToActiveTab(REPLAY_SECONDS);

    window.setTimeout(() => {
      setStatus(statusBadge, READY_LABEL);
      setButtonBusy(button, false);
    }, 900);
  } catch (error) {
    console.error("[Flashback][popup] replay request failed", {
      error: String(error),
    });

    setStatus(statusBadge, ERROR_LABEL);
    setButtonBusy(button, false);

    window.setTimeout(() => {
      setStatus(statusBadge, READY_LABEL);
    }, 1600);
  }
}

function main(): void {
  const triggerButton = getRequiredElement<HTMLButtonElement>("btnFlashback");
  const statusBadge = getRequiredElement<HTMLElement>("statusBadge");

  setStatus(statusBadge, READY_LABEL);

  triggerButton.addEventListener("click", () => {
    void handleFlashbackClick({
      button: triggerButton,
      statusBadge,
    });
  });
}

main();