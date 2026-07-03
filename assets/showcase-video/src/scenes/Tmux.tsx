import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

// A shell types `tmux -CC`, and tmux windows materialize as native
// Dispatcher tabs in the sidebar.
const ATTACH_AT = 90;

export const Tmux: React.FC = () => {
  const frame = useCurrentFrame();
  const attached = frame >= ATTACH_AT;

  const tmuxTabs = [
    { label: "tmux: build", dot: theme.green, active: true },
    { label: "tmux: repl", dot: theme.green },
    { label: "tmux: logs" },
  ];

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
      <div style={{ width: 480, flexShrink: 0 }}>
        <SceneTitle kicker="Remote" title="tmux -CC, bridged into native tabs" />
        <FadeIn delay={25}>
          <div
            style={{
              marginTop: 28,
              fontSize: 24,
              lineHeight: 1.6,
              color: theme.textSecondary,
            }}
          >
            Run tmux in control mode — locally or over SSH — and tmux windows
            become Dispatcher tabs, tmux panes become splits.
          </div>
        </FadeIn>
        <FadeIn delay={ATTACH_AT + 15}>
          <div
            style={{
              marginTop: 26,
              fontSize: 22,
              lineHeight: 1.6,
              color: theme.textSecondary,
            }}
          >
            ⌘T now creates tmux windows. If Dispatcher restarts, saved tmux tabs
            come back as placeholders — <span style={{ fontFamily: "monospace", color: theme.textPrimary }}>tmux -CC a</span>{" "}
            rehydrates them in place.
          </div>
        </FadeIn>
      </div>
      <SlideUpWindow delay={5}>
        <AppWindow
          width={1180}
          height={820}
          sidebar={
            <Sidebar
              projects={[
                {
                  name: "prod-server",
                  tabs: attached
                    ? [{ label: "ssh shell" }, ...tmuxTabs]
                    : [{ label: "ssh shell", active: true }],
                },
              ]}
            />
          }
        >
          <TerminalPane
            title={attached ? "tmux: build — prod-server" : "ssh shell — prod-server"}
            lines={
              attached
                ? [
                    { text: "[tmux -CC attached — 3 windows mapped to tabs]", color: theme.textMuted },
                    { text: "", at: ATTACH_AT + 5 },
                    {
                      text: prompt("app") + "make build",
                      typed: true,
                      at: ATTACH_AT + 15,
                      charsPerFrame: 1,
                    },
                    { text: "building 214 modules…", color: theme.textSecondary, at: ATTACH_AT + 40 },
                    { text: "✓ build complete in 8.1s", color: theme.green, at: ATTACH_AT + 60 },
                  ]
                : [
                    {
                      text: prompt("") + "ssh prod-server",
                      typed: true,
                      at: 10,
                      charsPerFrame: 1,
                    },
                    { text: "Welcome to prod-server (Ubuntu 24.04)", color: theme.textSecondary, at: 40 },
                    {
                      text: prompt("app") + "tmux -CC new-session -A -s dispatcher",
                      typed: true,
                      at: 52,
                      charsPerFrame: 1.1,
                    },
                  ]
            }
          />
        </AppWindow>
      </SlideUpWindow>
      <AttachFlash />
    </AbsoluteFill>
  );
};

// Brief full-screen pulse when the tmux session attaches.
const AttachFlash: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [ATTACH_AT - 2, ATTACH_AT + 2, ATTACH_AT + 14],
    [0, 0.12, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <AbsoluteFill style={{ background: theme.green, opacity, pointerEvents: "none" }} />
  );
};
