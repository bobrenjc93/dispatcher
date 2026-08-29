/**
 * Collapsing iOS dictation's repeated re-sends into what was actually said.
 *
 * Dictation revises as it listens: it emits the whole phrase so far on every
 * update, expecting the target to replace its value each time. A text input
 * does exactly that. A terminal cannot — it has no value, only a byte stream —
 * so the updates concatenate and "can you do it for me" arrives as
 * "ccancan ycan youcan you d…".
 *
 * There are no composition events to lean on: iOS dictation does not fire
 * them. What it does do is send a strictly longer string that begins with the
 * previous one, so that is what this looks for.
 */

export interface DictationState {
  /** The full phrase as last seen, not what was emitted. */
  seen: string;
  at: number;
}

/** A revision arriving later than this belongs to a new utterance. */
const DICTATION_WINDOW_MS = 5_000;

export interface DictationResolution {
  /** What to actually send to the terminal. */
  emit: string;
  next: DictationState | null;
}

export function resolveDictationInput(args: {
  data: string;
  previous: DictationState | null;
  now: number;
}): DictationResolution {
  const { data, previous, now } = args;

  // Anything with a control character — Enter, a chord, an escape sequence —
  // ends the utterance and is passed through untouched.
  if (data.length === 0 || /[\x00-\x1f\x7f]/.test(data)) {
    return { emit: data, next: null };
  }

  // Dictation emits the finished phrase twice: once as its last interim guess
  // and again as the final result. Identical, so not a revision — but sending
  // it would double the whole utterance. Length guards typing "aa".
  if (
    previous !== null
    && now - previous.at <= DICTATION_WINDOW_MS
    && data.length > 1
    && data === previous.seen
  ) {
    return { emit: "", next: { seen: data, at: now } };
  }

  const isRevision =
    previous !== null
    && now - previous.at <= DICTATION_WINDOW_MS
    // Strictly longer, so typing the same character twice is never mistaken
    // for a revision and swallowed.
    && data.length > previous.seen.length
    && data.startsWith(previous.seen)
    // A single keystroke is never a revision; it is someone typing.
    && data.length > 1;

  if (isRevision) {
    return {
      emit: data.slice(previous.seen.length),
      next: { seen: data, at: now },
    };
  }

  return { emit: data, next: { seen: data, at: now } };
}
