import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FadeIn } from "../components/Titles";
import { fonts, theme } from "../theme";

const PLATFORMS = ["macOS", "Linux", "Windows"];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const glow = interpolate(frame, [0, 50], [0, 0.3], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bgPrimary,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: fonts.ui,
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 55% 40% at 50% 50%, rgba(0,200,83,${glow * 0.25}), transparent 70%)`,
        }}
      />
      <FadeIn delay={5} duration={22} y={26}>
        <div
          style={{
            fontSize: 84,
            fontWeight: 700,
            letterSpacing: -2.5,
            color: theme.textPrimary,
            textAlign: "center",
          }}
        >
          Every shell, one window.
        </div>
      </FadeIn>
      <FadeIn delay={35} duration={20}>
        <div style={{ marginTop: 36, display: "flex", gap: 16 }}>
          {PLATFORMS.map((p) => (
            <span
              key={p}
              style={{
                fontSize: 24,
                color: theme.textSecondary,
                border: `1px solid ${theme.border}`,
                background: theme.bgSurface,
                borderRadius: 10,
                padding: "10px 26px",
              }}
            >
              {p}
            </span>
          ))}
        </div>
      </FadeIn>
      <FadeIn delay={60} duration={20}>
        <div
          style={{
            marginTop: 52,
            fontFamily: fonts.mono,
            fontSize: 26,
            color: theme.green,
          }}
        >
          dispatcher.sh
        </div>
      </FadeIn>
    </AbsoluteFill>
  );
};
