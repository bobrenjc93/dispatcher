import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  interpolateColors,
  useCurrentFrame,
} from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

// The attention flow, acted out: tests finish in a background tab and
// its sidebar entry gets the green outline (the app's .needs-attention
// ring). A cursor moves over and clicks the tab — the user "sees" it —
// the outline clears, and the dot eases to brown (acknowledged).
const RING_AT = 90; // background tests finish → green outline appears
const MOVE_AT = 145; // cursor starts moving toward the tab
const CLICK_AT = 185; // click: tab activates, ring clears
const BROWN_AT = 225; // dot eases green → brown

export const StatusDots: React.FC = () => {
  const frame = useCurrentFrame();
  const clicked = frame >= CLICK_AT;

  const ringOpacity = interpolate(
    frame,
    [RING_AT, RING_AT + 10, CLICK_AT, CLICK_AT + 8],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const testDot = interpolateColors(
    frame,
    [BROWN_AT, BROWN_AT + 20],
    [theme.green, theme.brown],
  );

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPrimary,
        padding: "70px 90px",
        flexDirection: "row",
        alignItems: "center",
        gap: 70,
      }}
    >
      <SlideUpWindow delay={5}>
        <div style={{ position: "relative" }}>
          <AppWindow
            width={1180}
            height={820}
            sidebar={
              <Sidebar
                projects={[
                  {
                    name: "my-app",
                    tabs: [
                      { label: "dev server", dot: theme.green, active: !clicked },
                      {
                        label: "test suite",
                        dot: testDot,
                        active: clicked,
                        attention: ringOpacity,
                      },
                      { label: "scratch", dot: theme.gray },
                    ],
                  },
                ]}
              />
            }
          >
            {!clicked ? (
              <TerminalPane
                title="dev server — ~/my-app"
                lines={[
                  { text: prompt("my-app") + "npm run dev", color: theme.textPrimary },
                  { text: "  ready in 312ms", color: theme.green, at: 10 },
                  { text: "  ➜ http://localhost:5173", color: theme.textSecondary, at: 18 },
                  { text: "", at: 30 },
                  { text: "12:04:11 hmr update /src/App.tsx", color: theme.textSecondary, at: 60 },
                  { text: "12:04:38 hmr update /src/Sidebar.tsx", color: theme.textSecondary, at: 130 },
                ]}
              />
            ) : (
              <TerminalPane
                title="test suite — ~/my-app"
                lines={[
                  { text: prompt("my-app") + "npm test", color: theme.textPrimary },
                  { text: " PASS  src/routes/users.test.ts", color: theme.green },
                  { text: " PASS  src/routes/orders.test.ts", color: theme.green },
                  { text: " PASS  src/lib/billing.test.ts", color: theme.green },
                  { text: "", color: theme.textSecondary },
                  { text: "Tests: 48 passed, 48 total", color: theme.textSecondary },
                  { text: "Done in 6.2s", color: theme.textSecondary },
                ]}
              />
            )}
          </AppWindow>
          <Cursor />
        </div>
      </SlideUpWindow>
      <div style={{ width: 480, flexShrink: 0 }}>
        <SceneTitle kicker="Focus" title="Know which terminal needs you" />
        <FadeIn delay={25}>
          <Beat
            dot={theme.green}
            text="A green dot means that terminal is busy doing work."
          />
        </FadeIn>
        <FadeIn delay={RING_AT + 12}>
          <Beat
            dot={theme.green}
            ring
            text="When something finishes in the background, its tab gets a green outline — that's your cue to take a look."
          />
        </FadeIn>
        <FadeIn delay={CLICK_AT + 15}>
          <Beat
            dot={theme.brown}
            text="Take a look, and the dot settles to brown — acknowledged, and out of your way."
          />
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// A macOS-style pointer that glides to the "test suite" tab, dips for
// the click, then fades out. Coordinates are relative to the AppWindow.
const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [MOVE_AT, CLICK_AT], [620, 148], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const y = interpolate(frame, [MOVE_AT, CLICK_AT], [430, 160], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const clickScale = interpolate(
    frame,
    [CLICK_AT, CLICK_AT + 4, CLICK_AT + 9],
    [1, 0.8, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = interpolate(
    frame,
    [MOVE_AT - 8, MOVE_AT, CLICK_AT + 20, CLICK_AT + 32],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  if (opacity <= 0) return null;

  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity,
        transform: `scale(${clickScale})`,
        transformOrigin: "top left",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.6))",
        pointerEvents: "none",
      }}
    >
      <path
        d="M5 3L19 12.5L12.7 13.6L16.3 20.3L13.7 21.6L10.2 14.8L5.6 19.2Z"
        fill="#ffffff"
        stroke="#000000"
        strokeWidth="1.2"
      />
    </svg>
  );
};

const Beat: React.FC<{ dot: string; ring?: boolean; text: string }> = ({
  dot,
  ring,
  text,
}) => (
  <div
    style={{
      marginTop: 26,
      display: "flex",
      alignItems: "flex-start",
      gap: 18,
    }}
  >
    <div
      style={{
        marginTop: 6,
        padding: 6,
        borderRadius: 8,
        boxShadow: ring ? `inset 0 0 0 1px ${theme.green}` : undefined,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: dot,
        }}
      />
    </div>
    <div style={{ fontSize: 23, lineHeight: 1.55, color: theme.textSecondary }}>
      {text}
    </div>
  </div>
);
