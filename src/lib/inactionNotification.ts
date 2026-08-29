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

/** How long the alert should last. Short enough not to be a nuisance, long
 *  enough to notice from another room. */
export const INACTION_CHIME_SECONDS = 3;

const CHIME_PITCHES = [659.25, 880];
const NOTE_LENGTH = 0.13;
const MOTIF_GAP = 0.5;

export interface ChimeNote {
  /** Seconds from the start of the alert. */
  offset: number;
  frequency: number;
  duration: number;
}

/**
 * A repeating two-note motif spanning the full alert.
 *
 * Repeating rather than holding one long tone: a sustained note reads as a
 * fault, and a pattern is easier to notice without being startling. The last
 * note is stretched so the alert ends exactly when it should rather than
 * trailing off early.
 */
export function buildInactionChime(seconds: number = INACTION_CHIME_SECONDS): ChimeNote[] {
  const notes: ChimeNote[] = [];
  for (let motif = 0; motif * MOTIF_GAP < seconds; motif += 1) {
    for (const [index, frequency] of CHIME_PITCHES.entries()) {
      const offset = motif * MOTIF_GAP + index * NOTE_LENGTH;
      if (offset >= seconds) {
        break;
      }
      notes.push({ offset, frequency, duration: Math.min(NOTE_LENGTH, seconds - offset) });
    }
  }

  const last = notes[notes.length - 1];
  if (last) {
    last.duration = Math.max(last.duration, seconds - last.offset);
  }
  return notes;
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
  for (const note of buildInactionChime()) {
    const noteStart = startAt + note.offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.14, noteStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration - 0.01);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + note.duration);
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
