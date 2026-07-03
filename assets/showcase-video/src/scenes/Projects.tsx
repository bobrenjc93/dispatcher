import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { ExpandButton, NotesPanel } from "../components/NotesPanel";
import { TerminalPane, prompt } from "../components/Terminal";
import { FadeIn, SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

const NOTES_TYPE_AT = 60; // notes text starts typing
const COLLAPSE_AT = 200; // panel collapses to the chevron button
const PANEL_WIDTH = 240;

const NOTES_TEXT = `deploy checklist:
- bump version
- run migrations on staging
- ping alice before prod push

api key lives in 1password
under "my-app deploy"`;

export const Projects: React.FC = () => {
  const frame = useCurrentFrame();
  const panelWidth = interpolate(
    frame,
    [COLLAPSE_AT, COLLAPSE_AT + 18],
    [PANEL_WIDTH, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const collapsed = panelWidth <= 0;

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
        <SceneTitle
          kicker="Organize"
          title="Projects, tabs, and notes — one tree for everything"
        />
        <FadeIn delay={30}>
          <div
            style={{
              marginTop: 28,
              fontSize: 24,
              lineHeight: 1.6,
              color: theme.textSecondary,
            }}
          >
            Group terminals by project and drag them wherever they belong.
            Every tab has its own notes, so your checklists and reminders stay
            right next to the work.
          </div>
        </FadeIn>
        <FadeIn delay={COLLAPSE_AT + 8}>
          <div
            style={{
              marginTop: 26,
              fontSize: 22,
              lineHeight: 1.6,
              color: theme.textSecondary,
            }}
          >
            Need the room back? Collapse the notes with one click — they're a
            click away when you want them again.
          </div>
        </FadeIn>
      </div>
      <SlideUpWindow delay={12}>
        <AppWindow
          width={1180}
          height={820}
          sidebar={
            <Sidebar
              projects={[
                {
                  name: "my-app",
                  tabs: [
                    { label: "deploy", dot: theme.green, active: true },
                    { label: "dev server", dot: theme.green },
                    { label: "db migrations" },
                  ],
                },
                {
                  name: "side project",
                  tabs: [{ label: "playground" }],
                },
              ]}
            />
          }
        >
          <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <NotesPanel
              title="deploy"
              notes={NOTES_TEXT}
              notesTypedAt={NOTES_TYPE_AT}
              width={panelWidth}
            />
            {collapsed && <ExpandButton />}
            <TerminalPane
              style={{ flex: 1 }}
              title="deploy — ~/my-app"
              lines={[
                {
                  text: prompt("my-app") + "./scripts/deploy.sh staging",
                  typed: true,
                  at: 25,
                  charsPerFrame: 1.1,
                },
                { text: "→ building release…", color: theme.textSecondary, at: 62 },
                { text: "→ running migrations…", color: theme.textSecondary, at: 100 },
                { text: "✓ staging deploy complete", color: theme.green, at: 150 },
              ]}
            />
          </div>
        </AppWindow>
      </SlideUpWindow>
    </AbsoluteFill>
  );
};
