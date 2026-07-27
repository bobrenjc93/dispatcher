import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { debugLogError } from "./debugLog";

type AudioContextConstructor = new () => AudioContext;

let notificationAudioContext: AudioContext | null = null;

function getNotificationAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (notificationAudioContext?.state === "closed") {
    notificationAudioContext = null;
  }
  if (notificationAudioContext) {
    return notificationAudioContext;
  }

  const audioWindow = window as Window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  const AudioContextClass = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  notificationAudioContext = new AudioContextClass();
  return notificationAudioContext;
}

export function prepareInactionNotificationSound() {
  const context = getNotificationAudioContext();
  if (context?.state === "suspended") {
    void context.resume().catch((error) => {
      debugLogError("status.notification", "failed to prepare notification sound", error);
    });
  }
}

async function playInactionNotificationSound() {
  const context = getNotificationAudioContext();
  if (!context) {
    return;
  }
  if (context.state === "suspended") {
    await context.resume();
  }

  const startAt = context.currentTime + 0.01;
  for (const [index, frequency] of [659.25, 880].entries()) {
    const noteStart = startAt + index * 0.13;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.14, noteStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.13);
  }
}

export function shouldNotifyOnInaction(args: {
  enabled: boolean;
  wasEnabled: boolean;
  hasDetectedActivity: boolean;
  now: number;
  staleStartedAt: number;
  effectiveChangedAt: number;
  lastNotifiedChangedAt: number;
}): boolean {
  return (
    args.enabled
    && args.wasEnabled
    && args.hasDetectedActivity
    && args.now >= args.staleStartedAt
    && args.effectiveChangedAt > args.lastNotifiedChangedAt
  );
}

export async function notifyTerminalInaction() {
  await Promise.all([
    playInactionNotificationSound().catch((error) => {
      debugLogError("status.notification", "failed to play notification sound", error);
    }),
    getCurrentWindow()
      .requestUserAttention(UserAttentionType.Informational)
      .catch((error) => {
        debugLogError("status.notification", "failed to request app attention", error);
      }),
  ]);
}
