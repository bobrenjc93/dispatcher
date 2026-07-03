import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { AppWindow, Sidebar } from "../components/AppWindow";
import { TerminalPane, prompt } from "../components/Terminal";
import { SceneTitle, SlideUpWindow } from "../components/Titles";
import { theme } from "../theme";

export const Projects: React.FC = () => (
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
      <Sequence from={30} layout="none">
        <SceneTitleBody />
      </Sequence>
    </div>
    <SlideUpWindow delay={12}>
      <AppWindow
        width={1180}
        height={820}
        sidebar={
          <Sidebar
            projects={[
              {
                name: "backend",
                tabs: [
                  { label: "api server", dot: theme.green, active: true },
                  { label: "worker queue", dot: theme.green },
                  { label: "db migrations" },
                ],
              },
              {
                name: "frontend",
                tabs: [
                  { label: "vite dev", dot: theme.green },
                  { label: "storybook" },
                ],
              },
              {
                name: "infra",
                tabs: [{ label: "prod ssh", dot: theme.brown }],
              },
            ]}
          />
        }
      >
        <TerminalPane
          title="api server — ~/backend"
          lines={[
            { text: prompt("backend") + "cargo run", typed: true, at: 20, charsPerFrame: 0.8 },
            { text: "   Compiling api v0.4.2", color: theme.textSecondary, at: 55 },
            { text: "    Finished dev [unoptimized] in 3.42s", color: theme.textSecondary, at: 70 },
            { text: "     Running `target/debug/api`", color: theme.textSecondary, at: 78 },
            { text: "INFO  listening on 0.0.0.0:8080", color: theme.green, at: 90 },
          ]}
        />
      </AppWindow>
    </SlideUpWindow>
  </AbsoluteFill>
);

const SceneTitleBody: React.FC = () => (
  <div
    style={{
      marginTop: 28,
      fontSize: 24,
      lineHeight: 1.6,
      color: theme.textSecondary,
    }}
  >
    Group shells by project in a drag-and-drop sidebar. Every tab keeps its own
    notes, so context lives next to the terminal doing the work.
  </div>
);
