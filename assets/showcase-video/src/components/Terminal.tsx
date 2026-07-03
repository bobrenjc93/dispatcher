import React from "react";
import { useCurrentFrame } from "remotion";
import { fonts, theme } from "../theme";

export type TermLine = {
  text: string;
  color?: string;
  // Frame (relative to the sequence) at which this line appears.
  at?: number;
  // If true, the line is revealed character-by-character starting at `at`.
  typed?: boolean;
  charsPerFrame?: number;
};

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const visible = Math.floor(frame / 15) % 2 === 0;
  return (
    <span
      style={{
        display: "inline-block",
        width: "0.6em",
        height: "1.1em",
        verticalAlign: "text-bottom",
        background: visible ? theme.textPrimary : "transparent",
      }}
    />
  );
};

export const TerminalPane: React.FC<{
  lines: TermLine[];
  title?: string;
  showCursor?: boolean;
  fontSize?: number;
  style?: React.CSSProperties;
}> = ({ lines, title, showCursor = true, fontSize = 15, style }) => {
  const frame = useCurrentFrame();

  const rendered: React.ReactNode[] = [];
  let allDone = true;
  for (const [i, line] of lines.entries()) {
    const at = line.at ?? 0;
    if (frame < at) {
      allDone = false;
      break;
    }
    let text = line.text;
    if (line.typed) {
      const cps = line.charsPerFrame ?? 1;
      const shown = Math.floor((frame - at) * cps);
      if (shown < line.text.length) {
        text = line.text.slice(0, shown);
        allDone = false;
      }
    }
    rendered.push(
      <div key={i} style={{ color: line.color ?? theme.textPrimary }}>
        {text || " "}
        {!allDone && <Cursor />}
      </div>,
    );
    if (!allDone) break;
  }

  return (
    <div
      style={{
        background: theme.bgPrimary,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 12,
            color: theme.textSecondary,
            borderBottom: `1px solid ${theme.border}`,
            fontFamily: fonts.ui,
            flexShrink: 0,
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          padding: 16,
          fontFamily: fonts.mono,
          fontSize,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
        }}
      >
        {rendered}
        {allDone && showCursor && (
          <div>
            <Cursor />
          </div>
        )}
      </div>
    </div>
  );
};

export const prompt = (dir: string) => `~/${dir} $ `;
