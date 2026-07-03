import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { StatusDot } from "../components/AppWindow";
import { FadeIn, SceneTitle } from "../components/Titles";
import { fonts, theme } from "../theme";

// Walks through Dispatcher's status-dot state machine, one state at a
// time: green → pulsing green → brown → gray.

const STATES = [
  {
    color: theme.green,
    pulse: false,
    name: "Green",
    desc: "The agent is actively making progress.",
  },
  {
    color: theme.green,
    pulse: true,
    name: "Pulsing green",
    desc: "Work went stale in the background — unseen output needs your attention.",
  },
  {
    color: theme.brown,
    pulse: false,
    name: "Brown",
    desc: "You viewed the stale output and acknowledged it. No timer restarts on focus.",
  },
  {
    color: theme.gray,
    pulse: false,
    name: "Gray",
    desc: "Acknowledged and unchanged for the long-inactivity window.",
  },
];

const STEP = 55;

export const StatusDots: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPrimary,
        padding: "80px 120px",
        justifyContent: "center",
        fontFamily: fonts.ui,
      }}
    >
      <SceneTitle
        kicker="Awareness"
        title="Status dots: a state machine, not a blinking light"
      />
      <div style={{ marginTop: 60, display: "flex", flexDirection: "column", gap: 30 }}>
        {STATES.map((state, i) => {
          const start = 25 + i * STEP;
          const pulse = state.pulse
            ? interpolate(Math.sin((frame - start) / 6), [-1, 1], [0.35, 1])
            : 1;
          return (
            <FadeIn key={state.name} delay={start} y={16}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 28,
                  background: theme.bgSurface,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 14,
                  padding: "26px 34px",
                  width: 1250,
                }}
              >
                <StatusDot color={state.color} pulse={pulse} size={22} />
                <div
                  style={{
                    width: 220,
                    fontSize: 26,
                    fontWeight: 600,
                    color: theme.textPrimary,
                    flexShrink: 0,
                  }}
                >
                  {state.name}
                </div>
                <div style={{ fontSize: 23, color: theme.textSecondary, lineHeight: 1.45 }}>
                  {state.desc}
                </div>
              </div>
            </FadeIn>
          );
        })}
      </div>
      <FadeIn delay={25 + STATES.length * STEP} y={12}>
        <div
          style={{
            marginTop: 40,
            fontSize: 22,
            color: theme.textMuted,
            fontStyle: "italic",
          }}
        >
          Focus-only tmux redraws are suppressed, so churn never fakes progress.
        </div>
      </FadeIn>
    </AbsoluteFill>
  );
};
