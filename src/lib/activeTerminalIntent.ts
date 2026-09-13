/**
 * A replica's choice of tab, held until the desktop agrees.
 *
 * Which tab is active belongs to the desktop, and a replica adopts whatever
 * the desktop's next snapshot says. That is right in the steady state and
 * wrong the moment the replica itself picks a tab: snapshots published before
 * the desktop heard about the choice still name the old tab, and applying one
 * puts the phone straight back where it was.
 *
 * How often that happens depends on something unrelated — how busy the tab you
 * were on is. A busy tab changes the workspace document constantly, so there
 * is nearly always a snapshot in flight to undo the choice; a quiet one
 * publishes nothing, so the choice sticks. Which is why tapping a push
 * notification worked or did not depending on what the *other* tab was doing.
 *
 * So a replica remembers what it asked for and keeps it until a snapshot
 * arrives that agrees. The intent expires, because a request that never
 * reaches the desktop must not strand the replica on a tab of its own
 * choosing forever.
 */

/** Long enough for the desktop to hear, act, and publish; short enough to not strand. */
export const ACTIVE_TERMINAL_INTENT_TTL_MS = 10_000;

interface ActiveTerminalIntent {
  terminalId: string;
  at: number;
}

let intent: ActiveTerminalIntent | null = null;

export function noteActiveTerminalIntent(terminalId: string | null, now: number = Date.now()) {
  intent = terminalId === null ? null : { terminalId, at: now };
}

export function clearActiveTerminalIntent() {
  intent = null;
}

export function getActiveTerminalIntent(): ActiveTerminalIntent | null {
  return intent;
}

/**
 * Which tab a replica should show once a snapshot arrives.
 *
 * Returns the incoming value unless it contradicts a choice this client has
 * made and the desktop has not acknowledged yet.
 */
export function resolveAdoptedActiveTerminal(args: {
  incoming: string | null;
  intent: ActiveTerminalIntent | null;
  now: number;
  ttlMs?: number;
}): { activeTerminalId: string | null; intentSettled: boolean } {
  const { incoming, intent: pending, now } = args;
  if (!pending) {
    return { activeTerminalId: incoming, intentSettled: false };
  }
  if (now - pending.at >= (args.ttlMs ?? ACTIVE_TERMINAL_INTENT_TTL_MS)) {
    // Nothing came back in time. The desktop is the authority, so defer to it
    // rather than holding a tab open on a request that evidently went nowhere.
    return { activeTerminalId: incoming, intentSettled: true };
  }
  if (incoming === pending.terminalId) {
    // The desktop has caught up; there is nothing left to protect.
    return { activeTerminalId: incoming, intentSettled: true };
  }
  return { activeTerminalId: pending.terminalId, intentSettled: false };
}
