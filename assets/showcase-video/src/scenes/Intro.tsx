import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FadeIn } from "../components/Titles";
import { fonts, theme } from "../theme";

const GlowDot: React.FC<{ delay: number }> = ({ delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({
    frame: frame - delay,
    fps,
    config: { damping: 12, stiffness: 120 },
  });
  return (
    <div
      style={{
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: theme.green,
        boxShadow: `0 0 30px ${theme.green}`,
        transform: `scale(${scale})`,
      }}
    />
  );
};

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const glow = interpolate(frame, [0, 60], [0, 0.35], {
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
          background: `radial-gradient(ellipse 60% 45% at 50% 55%, rgba(0,200,83,${glow * 0.25}), transparent 70%)`,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <GlowDot delay={5} />
        <FadeIn delay={10} duration={25} y={30}>
          <div
            style={{
              fontSize: 120,
              fontWeight: 700,
              letterSpacing: -4,
              color: theme.textPrimary,
            }}
          >
            Dispatcher
          </div>
        </FadeIn>
      </div>
      <FadeIn delay={45} duration={25} y={20}>
        <div
          style={{
            marginTop: 24,
            fontSize: 34,
            color: theme.textSecondary,
            fontWeight: 400,
            letterSpacing: -0.5,
          }}
        >
          All your terminals, organized in one window
        </div>
      </FadeIn>
      <FadeIn delay={80} duration={20}>
        <div
          style={{
            marginTop: 48,
            fontSize: 24,
            color: theme.textMuted,
          }}
        >
          Stop hunting through windows. Start shipping.
        </div>
      </FadeIn>
    </AbsoluteFill>
  );
};
