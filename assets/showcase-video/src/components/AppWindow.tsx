import React from "react";
import { fonts, theme } from "../theme";

// A stylized recreation of the Dispatcher app chrome: macOS traffic
// lights, project sidebar, tab strip, and a content area supplied by
// the caller.

export const StatusDot: React.FC<{
  color: string;
  pulse?: number; // 0..1 opacity multiplier for pulsing
  size?: number;
}> = ({ color, pulse = 1, size = 8 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      backgroundColor: color,
      opacity: pulse,
      flexShrink: 0,
    }}
  />
);

export type SidebarTab = {
  label: string;
  active?: boolean;
  dot?: string;
  dotPulse?: number;
};

export type SidebarProject = {
  name: string;
  expanded?: boolean;
  tabs: SidebarTab[];
};

export const Sidebar: React.FC<{
  projects: SidebarProject[];
  width?: number;
}> = ({ projects, width = 240 }) => (
  <div
    style={{
      width,
      background: theme.bgSecondary,
      borderRight: `1px solid ${theme.border}`,
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
      fontFamily: fonts.ui,
    }}
  >
    <div
      style={{
        height: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        borderBottom: `1px solid ${theme.border}`,
      }}
    >
      <span
        style={{
          fontWeight: 600,
          fontSize: 14,
          color: theme.textPrimary,
          letterSpacing: -0.3,
        }}
      >
        Dispatcher
      </span>
      <span style={{ color: theme.textSecondary, fontSize: 16 }}>+</span>
    </div>
    <div style={{ padding: "8px 0" }}>
      {projects.map((project) => (
        <div key={project.name}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 16px",
              color: theme.textSecondary,
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            <span
              style={{
                display: "inline-block",
                transform: project.expanded === false ? "rotate(-90deg)" : "none",
                fontSize: 9,
              }}
            >
              ▾
            </span>
            {project.name}
          </div>
          {project.expanded !== false &&
            project.tabs.map((tab) => (
              <div
                key={tab.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  margin: "1px 8px",
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 13,
                  background: tab.active ? theme.bgActive : "transparent",
                  color: tab.active ? theme.textPrimary : theme.textSecondary,
                }}
              >
                {tab.dot ? (
                  <StatusDot color={tab.dot} pulse={tab.dotPulse} />
                ) : (
                  <div style={{ width: 8 }} />
                )}
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {tab.label}
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  </div>
);

export const AppWindow: React.FC<{
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}> = ({ children, sidebar, width = 1520, height = 860, style }) => (
  <div
    style={{
      width,
      height,
      background: theme.bgPrimary,
      borderRadius: 12,
      border: `1px solid ${theme.bgActive}`,
      boxShadow: "0 40px 120px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      fontFamily: fonts.ui,
      ...style,
    }}
  >
    <div
      style={{
        height: 40,
        background: theme.bgSecondary,
        borderBottom: `1px solid ${theme.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 8,
        flexShrink: 0,
      }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <div
          key={c}
          style={{ width: 12, height: 12, borderRadius: "50%", background: c }}
        />
      ))}
    </div>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {sidebar}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  </div>
);
