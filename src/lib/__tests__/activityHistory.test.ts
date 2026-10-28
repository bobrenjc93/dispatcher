import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HISTORY_BUCKET_MS,
  ACTIVITY_HISTORY_DETAIL_MS,
  ACTIVITY_HISTORY_WINDOW_MS,
  forgetActivityHistory,
  getActivityHistory,
  recordActivityEvent,
  recordActivitySample,
  replayInactivity,
  subscribeActivityHistory,
  type ActivityHistory,
  type ActivitySample,
} from "../activityHistory";

// A 100x50 pane: 5000 cells, so 50 characters is 1%.
const CELLS = 5000;

function sample(at: number, percent: number, overrides: Partial<ActivitySample> = {}): ActivitySample {
  const changedTextChars = Math.round((percent / 100) * CELLS);
  return {
    at,
    kind: percent > 0 ? "work" : "identical",
    percent,
    changedRows: changedTextChars > 0 ? 20 : 0,
    changedTextRows: changedTextChars > 0 ? 20 : 0,
    changedTextChars,
    digitOnlyTextRows: 0,
    cells: CELLS,
    ...overrides,
  };
}

const spinner = (at: number) =>
  sample(at, 0.06, { kind: "small", changedRows: 2, changedTextRows: 2, changedTextChars: 3 });

describe("replayInactivity", () => {
  it("goes inactive once nothing has counted for the duration", () => {
    const history: ActivityHistory = {
      samples: [sample(0, 10), sample(10_000, 8)],
      events: [],
    };
    const replay = replayInactivity({ history, changePercent: 5, inactivityMs: 60_000, now: 30_000 });
    expect(replay.counted).toEqual([true, true]);
    expect(replay.spans).toEqual([]);
    expect(replay.inactiveAt).toBe(70_000);

    const later = replayInactivity({ history, changePercent: 5, inactivityMs: 60_000, now: 90_000 });
    expect(later.spans).toEqual([{ start: 70_000, end: null }]);
    expect(later.inactiveAt).toBeNull();
  });

  it("does not let output under a chosen threshold keep the tab alive", () => {
    // "Below 5% for a minute": two percent every ten seconds is below it, so
    // the minute runs from the last real change regardless.
    const history: ActivityHistory = {
      samples: [sample(0, 20), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => sample(n * 10_000, 2))],
      events: [],
    };
    const replay = replayInactivity({ history, changePercent: 5, inactivityMs: 60_000, now: 80_000 });
    expect(replay.spans).toEqual([{ start: 60_000, end: null }]);
  });

  it("under the built-in rule, a spinner keeps the tab alive but cannot wake it", () => {
    const history: ActivityHistory = {
      samples: [sample(0, 20), spinner(10_000), spinner(20_000), spinner(60_000)],
      events: [],
    };
    const alive = replayInactivity({
      history: { samples: history.samples.slice(0, 3), events: [] },
      changePercent: undefined,
      inactivityMs: 20_000,
      now: 35_000,
    });
    expect(alive.counted).toEqual([true, false, false]);
    // Kept alive until 20s + 20s.
    expect(alive.inactiveAt).toBe(40_000);

    // Gone quiet at 40s; the spinner at 60s does not bring it back.
    const quiet = replayInactivity({ history, changePercent: undefined, inactivityMs: 20_000, now: 70_000 });
    expect(quiet.spans).toEqual([{ start: 40_000, end: null }]);
  });

  it("ends a quiet stretch at the next change that counts", () => {
    const history: ActivityHistory = {
      samples: [sample(0, 10), sample(100_000, 10)],
      events: [],
    };
    const replay = replayInactivity({ history, changePercent: 5, inactivityMs: 30_000, now: 110_000 });
    expect(replay.spans).toEqual([{ start: 30_000, end: 100_000 }]);
    expect(replay.inactiveAt).toBe(130_000);
    expect(replay.lastActivityAt).toBe(100_000);
  });

  it("marks the quiet stretch before each span, as long as the duration", () => {
    const history: ActivityHistory = {
      samples: [sample(0, 10), sample(100_000, 10)],
      events: [],
    };
    // The window before going inactive scales with the setting: double the
    // duration and it doubles.
    expect(replayInactivity({ history, changePercent: 5, inactivityMs: 5_000, now: 102_000 }).waits)
      .toEqual([{ start: 0, end: 5_000 }, { start: 100_000, end: 105_000 }]);
    expect(replayInactivity({ history, changePercent: 5, inactivityMs: 10_000, now: 102_000 }).waits)
      .toEqual([{ start: 0, end: 10_000 }, { start: 100_000, end: 110_000 }]);
  });

  it("counts typing as activity", () => {
    const history: ActivityHistory = {
      samples: [sample(0, 10)],
      events: [{ at: 50_000, kind: "input" }],
    };
    const replay = replayInactivity({ history, changePercent: 5, inactivityMs: 30_000, now: 60_000 });
    expect(replay.spans).toEqual([{ start: 30_000, end: 50_000 }]);
    expect(replay.inactiveAt).toBe(80_000);
  });

  it("replays a different threshold against the same history", () => {
    const history: ActivityHistory = { samples: [sample(0, 3)], events: [] };
    expect(replayInactivity({ history, changePercent: 5, inactivityMs: 1, now: 0 }).counted).toEqual([false]);
    expect(replayInactivity({ history, changePercent: 2, inactivityMs: 1, now: 0 }).counted).toEqual([true]);
  });

  it("never counts what was never news", () => {
    const history: ActivityHistory = {
      samples: [
        sample(0, 50, { kind: "blank" }),
        sample(1, 0, { kind: "identical" }),
        sample(2, 40, { kind: "numbers", digitOnlyTextRows: 20 }),
        sample(3, 0, { kind: "baseline" }),
      ],
      events: [],
    };
    expect(replayInactivity({ history, changePercent: 1, inactivityMs: 1, now: 3 }).counted)
      .toEqual([false, false, false, true]);
  });
});

describe("activity history store", () => {
  it("keeps older samples a day, merged to the strongest in each bucket", () => {
    const id = "history-merge-tab";
    forgetActivityHistory(id);
    const bucket = ACTIVITY_HISTORY_BUCKET_MS;

    // Two samples in one early bucket, one in the next.
    recordActivitySample(id, spinner(0));
    recordActivitySample(id, sample(1_000, 12));
    recordActivitySample(id, spinner(bucket + 1_000));
    // Recent enough to be kept as judged.
    const recentAt = 2 * 60 * 60_000;
    recordActivitySample(id, spinner(recentAt));
    recordActivitySample(id, spinner(recentAt + 1_000));

    // Two hours on, the early buckets are merged, not gone: a two-hour
    // threshold needs them.
    expect(getActivityHistory(id).samples.map((value) => [value.at, value.kind])).toEqual([
      [1_000, "work"],
      [bucket + 1_000, "small"],
      [recentAt, "small"],
      [recentAt + 1_000, "small"],
    ]);

    // A day on, they are dropped.
    recordActivitySample(id, sample(ACTIVITY_HISTORY_WINDOW_MS + bucket + 2_000, 10));
    expect(getActivityHistory(id).samples[0].at).toBeGreaterThan(bucket + 1_000);
    forgetActivityHistory(id);
  });

  it("keeps half an hour in full and tells subscribers", () => {
    const id = "history-test-tab";
    forgetActivityHistory(id);
    let notified = 0;
    const unsubscribe = subscribeActivityHistory(() => {
      notified += 1;
    });

    recordActivitySample(id, sample(0, 10));
    const first = getActivityHistory(id);
    // Stable until something changes, as useSyncExternalStore requires.
    expect(getActivityHistory(id)).toBe(first);

    recordActivityEvent(id, { at: 1_000, kind: "chime" });
    recordActivitySample(id, sample(ACTIVITY_HISTORY_DETAIL_MS + 1, 10));
    const history = getActivityHistory(id);
    expect(history).not.toBe(first);
    // The first sample aged out of the detail window into its own bucket.
    expect(history.samples.map((value) => value.at)).toEqual([0, ACTIVITY_HISTORY_DETAIL_MS + 1]);
    expect(history.events).toEqual([{ at: 1_000, kind: "chime" }]);
    expect(notified).toBe(3);

    unsubscribe();
    forgetActivityHistory(id);
    expect(getActivityHistory(id).samples).toEqual([]);
  });
});
