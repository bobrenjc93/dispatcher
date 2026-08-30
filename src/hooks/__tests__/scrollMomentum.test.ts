import { describe, expect, it } from "vitest";
import { isMomentumSpent, stepMomentum } from "../useTerminalBridge";

const FRAME = 1000 / 60;

describe("scroll momentum", () => {
  it("slows down over time", () => {
    const first = stepMomentum({ velocityPxPerMs: 2, elapsedMs: FRAME });
    const second = stepMomentum({ velocityPxPerMs: first.velocityPxPerMs, elapsedMs: FRAME });

    expect(first.velocityPxPerMs).toBeLessThan(2);
    expect(second.velocityPxPerMs).toBeLessThan(first.velocityPxPerMs);
  });

  it("loses the same speed over a dropped frame as over the frames it replaces", () => {
    // Friction is expressed per frame but applied against real elapsed time, so
    // a janky frame must not hand back a faster flick than a smooth one.
    let smooth = 2;
    for (let frame = 0; frame < 4; frame += 1) {
      smooth = stepMomentum({ velocityPxPerMs: smooth, elapsedMs: FRAME }).velocityPxPerMs;
    }
    const dropped = stepMomentum({ velocityPxPerMs: 2, elapsedMs: FRAME * 4 }).velocityPxPerMs;

    expect(dropped).toBeCloseTo(smooth, 10);
  });

  it("travels further the faster it was flicked", () => {
    const gentle = stepMomentum({ velocityPxPerMs: 0.5, elapsedMs: FRAME }).distancePx;
    const hard = stepMomentum({ velocityPxPerMs: 3, elapsedMs: FRAME }).distancePx;

    expect(hard).toBeGreaterThan(gentle);
  });

  it("carries direction, so a flick down does not scroll up", () => {
    const { velocityPxPerMs, distancePx } = stepMomentum({
      velocityPxPerMs: -2,
      elapsedMs: FRAME,
    });

    expect(velocityPxPerMs).toBeLessThan(0);
    expect(distancePx).toBeLessThan(0);
  });

  it("comes to a stop rather than drifting forever", () => {
    let velocity = 3;
    let frames = 0;
    while (!isMomentumSpent(velocity) && frames < 1000) {
      velocity = stepMomentum({ velocityPxPerMs: velocity, elapsedMs: FRAME }).velocityPxPerMs;
      frames += 1;
    }

    expect(isMomentumSpent(velocity)).toBe(true);
    // Roughly a second of coasting: long enough to feel like a flick, short
    // enough that the view is not still creeping when you look back at it.
    expect(frames).toBeLessThan(120);
  });
});
