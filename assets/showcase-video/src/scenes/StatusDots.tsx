import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

// Shows the real attention flow: a background tab finishes work and its
// sidebar entry gets a green outline (the app's .needs-attention ring).
// Once seen, it settles down to a brown dot.
const RING_AT = 110; // background tests finish → green outline appears
const SEEN_AT = 210; // user checks it → outline clears, dot goes brown

export const StatusDots: React.FC = () => {
  const frame = useCurrentFrame();
  const ringOn = frame >= RING_AT && frame < SEEN_AT;
  const seen = frame >= SEEN_AT;

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
        <AppWindow
          width={1180}
          height={820}
          sidebar={
            <Sidebar
              projects={[
                {
                  name: "my-app",
                  tabs: [
                    { label: "dev server", dot: theme.green, active: true },
                    {
                      label: "test suite",
                      dot: seen ? theme.brown : theme.green,
                      attention: ringOn,
                    },
                    { label: "scratch", dot: theme.gray },
                  ],
                },
              ]}
            />
          }
        >
          <TerminalPane
            title="dev server — ~/my-app"
            lines={[
              { text: prompt("my-app") + "npm run dev", color: theme.textPrimary },
              { text: "  ready in 312ms", color: theme.green, at: 10 },
              { text: "  ➜ http://localhost:5173", color: theme.textSecondary, at: 18 },
              { text: "", at: 30 },
              { text: "12:04:11 hmr update /src/App.tsx", color: theme.textSecondary, at: 60 },
              { text: "12:04:38 hmr update /src/Sidebar.tsx", color: theme.textSecondary, at: 150 },
            ]}
          />
        </AppWindow>
      </SlideUpWindow>
      <div style={{ width: 480, flexShrink: 0 }}>
        <SceneTitle kicker="Focus" title="Know which terminal needs you" />
        <FadeIn delay={25}>
          <Beat
            dot={theme.green}
            text="A green dot means that terminal is busy doing work."
          />
        </FadeIn>
        <FadeIn delay={RING_AT + 10}>
          <Beat
            dot={theme.green}
            ring
            text="When something finishes in the background, its tab gets a green outline — that's your cue to take a look."
          />
        </FadeIn>
        <FadeIn delay={SEEN_AT + 10}>
          <Beat
            dot={theme.brown}
            text="Once you've seen it, the tab settles down and stays out of your way."
          />
        </FadeIn>
      </div>
    </AbsoluteFill>
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
