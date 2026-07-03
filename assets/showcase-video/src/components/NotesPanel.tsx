import React from "react";
import { useCurrentFrame } from "remotion";
import { fonts, theme } from "../theme";
import { StatusDot } from "./AppWindow";

// Recreates the app's detail panel (DetailPanel.tsx): status dot +
// title, a collapse chevron, and the NOTES textarea. `width` is
// animated by the caller; at 0 the caller renders ExpandButton instead.

const Chevron: React.FC<{ direction: "left" | "right" }> = ({ direction }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d={direction === "left" ? "M9 3L5 7L9 11" : "M5 3L9 7L5 11"}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const NotesPanel: React.FC<{
  title: string;
  notes: string;
  // Frame at which the notes text starts typing (chars per frame ~1.2).
  notesTypedAt?: number;
  width: number;
}> = ({ title, notes, notesTypedAt, width }) => {
  const frame = useCurrentFrame();
  let shownNotes = notes;
  if (notesTypedAt !== undefined) {
    const chars = Math.max(0, Math.floor((frame - notesTypedAt) * 1.2));
    shownNotes = notes.slice(0, chars);
  }

  if (width <= 0) return null;

  return (
    <>
      <div
        style={{
          width,
          minWidth: 0,
          background: theme.bgSecondary,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: 12,
          overflow: "hidden",
          fontFamily: fonts.ui,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
            minWidth: 216,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusDot color={theme.green} />
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: theme.textPrimary,
                letterSpacing: -0.3,
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
          </div>
          <span style={{ color: theme.textMuted, display: "flex", padding: 4 }}>
            <Chevron direction="left" />
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            flex: 1,
            minHeight: 0,
            minWidth: 216,
          }}
        >
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              color: theme.textMuted,
              fontWeight: 500,
            }}
          >
            Notes
          </div>
          <div
            style={{
              flex: 1,
              background: theme.bgPrimary,
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 12,
              lineHeight: 1.5,
              color: theme.textSecondary,
              whiteSpace: "pre-wrap",
            }}
          >
            {shownNotes}
          </div>
        </div>
      </div>
      <div style={{ width: 1, background: theme.border, flexShrink: 0 }} />
    </>
  );
};

// The small chevron button shown where the panel used to be (the app's
// .detail-expand-btn) once notes are collapsed.
export const ExpandButton: React.FC = () => (
  <div
    style={{
      alignSelf: "flex-start",
      margin: 6,
      padding: 4,
      borderRadius: 4,
      color: theme.textMuted,
      display: "flex",
      flexShrink: 0,
    }}
  >
    <Chevron direction="right" />
  </div>
);
