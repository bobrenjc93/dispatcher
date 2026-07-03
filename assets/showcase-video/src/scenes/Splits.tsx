import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

// The right pane slides open at `SPLIT_AT`, then splits vertically at
// `VSPLIT_AT` — animating the divider like a real resize.
const SPLIT_AT = 40;
const VSPLIT_AT = 95;

export const Splits: React.FC = () => {
  const frame = useCurrentFrame();
  const rightWidth = interpolate(frame, [SPLIT_AT, SPLIT_AT + 25], [0, 50], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bottomHeight = interpolate(frame, [VSPLIT_AT, VSPLIT_AT + 25], [0, 45], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
              width={200}
              projects={[
                {
                  name: "backend",
                  tabs: [
                    { label: "api server", dot: theme.green, active: true },
                    { label: "worker queue", dot: theme.green },
                  ],
                },
              ]}
            />
          }
        >
          <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <div
              style={{
                width: `${100 - rightWidth}%`,
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
              }}
            >
              <TerminalPane
                style={{ flex: 1 }}
                lines={[
                  { text: prompt("backend") + "npm run test:watch", color: theme.textPrimary },
                  { text: " PASS  src/routes/users.test.ts", color: theme.green, at: 10 },
                  { text: " PASS  src/routes/orders.test.ts", color: theme.green, at: 20 },
                  { text: "Tests: 48 passed, 48 total", color: theme.textSecondary, at: 30 },
                ]}
              />
            </div>
            {rightWidth > 0 && (
              <>
                <div style={{ width: 1, background: theme.border }} />
                <div
                  style={{
                    width: `${rightWidth}%`,
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                  }}
                >
                  <TerminalPane
                    style={{ height: `${100 - bottomHeight}%` }}
                    lines={[
                      {
                        text: prompt("backend") + "tail -f logs/api.log",
                        typed: true,
                        at: SPLIT_AT + 20,
                        charsPerFrame: 1.2,
                      },
                      { text: "GET /v1/users 200 12ms", color: theme.textSecondary, at: SPLIT_AT + 45 },
                      { text: "POST /v1/orders 201 34ms", color: theme.textSecondary, at: SPLIT_AT + 52 },
                    ]}
                  />
                  {bottomHeight > 0 && (
                    <>
                      <div style={{ height: 1, background: theme.border }} />
                      <TerminalPane
                        style={{ height: `${bottomHeight}%` }}
                        lines={[
                          {
                            text: prompt("backend") + "htop",
                            typed: true,
                            at: VSPLIT_AT + 20,
                            charsPerFrame: 1.5,
                          },
                        ]}
                      />
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </AppWindow>
      </SlideUpWindow>
      <div style={{ width: 480, flexShrink: 0 }}>
        <SceneTitle kicker="Layout" title="Split panes that keep up with you" />
        <FadeIn delay={30}>
          <div
            style={{
              marginTop: 28,
              fontSize: 24,
              lineHeight: 1.6,
              color: theme.textSecondary,
            }}
          >
            See your tests, logs, and monitors side by side. Panes open
            instantly and resize however you like.
          </div>
        </FadeIn>
        <FadeIn delay={SPLIT_AT + 10}>
          <Shortcut label="Split right" keys="⌘ D" />
        </FadeIn>
        <FadeIn delay={VSPLIT_AT + 10}>
          <Shortcut label="Split down" keys="⌘ ⇧ D" />
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

const Shortcut: React.FC<{ label: string; keys: string }> = ({ label, keys }) => (
  <div
    style={{
      marginTop: 22,
      display: "flex",
      alignItems: "center",
      gap: 16,
      fontSize: 22,
      color: theme.textSecondary,
    }}
  >
    <span
      style={{
        fontFamily: "monospace",
        background: theme.bgSurface,
        border: `1px solid ${theme.bgActive}`,
        borderRadius: 8,
        padding: "6px 14px",
        color: theme.textPrimary,
        fontSize: 20,
      }}
    >
      {keys}
    </span>
    {label}
  </div>
);
