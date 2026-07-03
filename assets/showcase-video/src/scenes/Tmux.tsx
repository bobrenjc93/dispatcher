import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { fonts, theme } from "../theme";

// The disconnect/reconnect story:
//   1. Tailing logs on a remote server through a tmux tab.
//   2. You step away — no internet. The tab becomes a saved placeholder
//      (the app's real "Reconnect to hydrate this tab" card).
//   3. Re-ssh, run `tmux -CC a`.
//   4. The tab hydrates and the logs are still streaming.
const DISCONNECT_AT = 110;
const RECONNECT_AT = 230;
const HYDRATE_AT = 320;

export const Tmux: React.FC = () => {
  const frame = useCurrentFrame();
  const phase =
    frame < DISCONNECT_AT
      ? "live"
      : frame < RECONNECT_AT
        ? "away"
        : frame < HYDRATE_AT
          ? "reconnect"
          : "back";

  const logsTab =
    phase === "away"
      ? [{ label: "prod logs", active: true }]
      : phase === "reconnect"
        ? [{ label: "prod logs" }, { label: "terminal", active: true }]
        : [{ label: "prod logs", dot: theme.green, active: true }];

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
        <SceneTitle kicker="Remote" title="Step away. Your session doesn't." />
        <FadeIn delay={20}>
          <Caption>
            Tail logs on a server over SSH, in a tab that lives on the server —
            not on your laptop.
          </Caption>
        </FadeIn>
        <FadeIn delay={DISCONNECT_AT + 15}>
          <Caption>
            Close the laptop, lose your connection — the tab stays put, with its
            name and notes saved.
          </Caption>
        </FadeIn>
        <FadeIn delay={RECONNECT_AT + 15}>
          <Caption>
            Back online? Re-ssh and run{" "}
            <code
              style={{
                fontFamily: fonts.mono,
                color: theme.textPrimary,
                background: theme.bgActive,
                borderRadius: 6,
                padding: "1px 8px",
                fontSize: 20,
              }}
            >
              tmux -CC a
            </code>
            …
          </Caption>
        </FadeIn>
        <FadeIn delay={HYDRATE_AT + 15}>
          <Caption>
            …and everything is exactly where you left it — logs still streaming,
            nothing lost.
          </Caption>
        </FadeIn>
      </div>
      <SlideUpWindow delay={5}>
        <AppWindow
          width={1180}
          height={820}
          sidebar={<Sidebar projects={[{ name: "prod-server", tabs: logsTab }]} />}
        >
          {phase === "live" && (
            <TerminalPane
              title="prod logs — prod-server"
              lines={[
                { text: prompt("app") + "tail -f logs/api.log", color: theme.textPrimary },
                { text: "09:12:04 GET /v1/users 200 12ms", color: theme.textSecondary, at: 15 },
                { text: "09:12:09 POST /v1/orders 201 34ms", color: theme.textSecondary, at: 35 },
                { text: "09:12:15 GET /v1/health 200 1ms", color: theme.textSecondary, at: 60 },
                { text: "09:12:22 POST /v1/payments 201 87ms", color: theme.textSecondary, at: 90 },
              ]}
            />
          )}
          {phase === "away" && (
            <Sequence from={DISCONNECT_AT} layout="none">
              <PlaceholderView />
            </Sequence>
          )}
          {phase === "reconnect" && (
            <Sequence from={RECONNECT_AT} layout="none">
              <TerminalPane
                title="terminal"
                lines={[
                  { text: prompt("") + "ssh prod-server", typed: true, at: 5, charsPerFrame: 1.2 },
                  {
                    text: prompt("app") + "tmux -CC a",
                    typed: true,
                    at: 45,
                    charsPerFrame: 1,
                  },
                ]}
              />
            </Sequence>
          )}
          {phase === "back" && (
            <Sequence from={HYDRATE_AT} layout="none">
              <TerminalPane
                title="prod logs — prod-server"
                lines={[
                  { text: prompt("app") + "tail -f logs/api.log", color: theme.textPrimary },
                  { text: "09:12:22 POST /v1/payments 201 87ms", color: theme.textSecondary },
                  { text: "09:26:41 GET /v1/users 200 11ms", color: theme.textSecondary, at: 8 },
                  { text: "09:26:48 POST /v1/orders 201 29ms", color: theme.textSecondary, at: 30 },
                  { text: "09:26:55 GET /v1/health 200 1ms", color: theme.textSecondary, at: 55 },
                ]}
              />
            </Sequence>
          )}
        </AppWindow>
      </SlideUpWindow>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      marginTop: 24,
      fontSize: 22,
      lineHeight: 1.55,
      color: theme.textSecondary,
    }}
  >
    {children}
  </div>
);

// The app's real disconnected-tmux placeholder card
// (.tmux-placeholder-card in App.css / ProjectView.tsx).
const PlaceholderView: React.FC = () => (
  <div
    style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      background: `radial-gradient(circle at top left, rgba(0,200,83,0.10), transparent 34%), linear-gradient(180deg, #090909, ${theme.bgPrimary})`,
      fontFamily: fonts.ui,
    }}
  >
    <FadeIn delay={5} y={14}>
      <div
        style={{
          width: 560,
          display: "grid",
          gap: 14,
          padding: 28,
          border: `1px solid #1d2a1f`,
          borderRadius: 16,
          background: "#0d0d0d",
          boxShadow: "0 18px 48px rgba(0,0,0,0.28)",
        }}
      >
        <div
          style={{
            width: "fit-content",
            padding: "5px 10px",
            borderRadius: 999,
            background: "rgba(0,200,83,0.14)",
            color: "#4fd882",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.8,
            textTransform: "uppercase",
          }}
        >
          tmux -CC
        </div>
        <div
          style={{
            fontSize: 22,
            lineHeight: 1.1,
            letterSpacing: "-0.03em",
            color: theme.textPrimary,
            fontWeight: 600,
          }}
        >
          Reconnect to hydrate this tab
        </div>
        <div style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 1.6 }}>
          Press <Kbd>Cmd</Kbd>+<Kbd>T</Kbd> to open a normal terminal, re-ssh if
          needed, then run{" "}
          <span
            style={{
              fontFamily: fonts.mono,
              padding: "1px 6px",
              borderRadius: 6,
              background: "#0f0f0f",
              color: theme.textPrimary,
            }}
          >
            tmux -CC a
          </span>
          . Dispatcher will reconnect and hydrate this saved tmux tab.
        </div>
        <code
          style={{
            fontFamily: fonts.mono,
            width: "fit-content",
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid ${theme.border}`,
            background: "#000000",
            color: "#4fd882",
            fontSize: 13,
          }}
        >
          tmux -CC a
        </code>
      </div>
    </FadeIn>
  </div>
);

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "1.6em",
      padding: "0 0.4em",
      margin: "0 0.12em",
      borderRadius: 6,
      border: `1px solid ${theme.border}`,
      background: "#161616",
      color: theme.textPrimary,
      fontSize: 12,
      lineHeight: 1.8,
    }}
  >
    {children}
  </span>
);
