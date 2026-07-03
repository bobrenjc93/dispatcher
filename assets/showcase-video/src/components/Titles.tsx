import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts, theme } from "../theme";

export const FadeIn: React.FC<{
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  y?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, duration = 20, y = 24, style }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translate = interpolate(frame, [delay, delay + duration], [y, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ opacity, transform: `translateY(${translate}px)`, ...style }}>
      {children}
    </div>
  );
};

export const SlideUpWindow: React.FC<{
  children: React.ReactNode;
  delay?: number;
}> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, stiffness: 80 },
  });
  const y = interpolate(progress, [0, 1], [80, 0]);
  return (
    <div style={{ opacity: progress, transform: `translateY(${y}px)` }}>
      {children}
    </div>
  );
};

export const SceneTitle: React.FC<{
  kicker?: string;
  title: string;
  delay?: number;
}> = ({ kicker, title, delay = 0 }) => (
  <div style={{ fontFamily: fonts.ui, textAlign: "left" }}>
    {kicker && (
      <FadeIn delay={delay}>
        <div
          style={{
            color: theme.green,
            fontSize: 22,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 4,
            marginBottom: 16,
          }}
        >
          {kicker}
        </div>
      </FadeIn>
    )}
    <FadeIn delay={delay + 6}>
      <div
        style={{
          color: theme.textPrimary,
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: -1.5,
          lineHeight: 1.1,
        }}
      >
        {title}
      </div>
    </FadeIn>
  </div>
);
