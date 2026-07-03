import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { Intro } from "./scenes/Intro";
import { Projects } from "./scenes/Projects";
import { Splits } from "./scenes/Splits";
import { StatusDots } from "./scenes/StatusDots";
import { Tmux } from "./scenes/Tmux";
import { Outro } from "./scenes/Outro";
import { theme } from "./theme";

// 30 fps. Scene lengths in frames.
export const SCENES = [
  { component: Intro, duration: 150 }, // 5s
  { component: Projects, duration: 280 }, // 9.3s — notes type out, then collapse
  { component: Splits, duration: 240 }, // 8s
  { component: StatusDots, duration: 300 }, // 10s
  { component: Tmux, duration: 270 }, // 9s
  { component: Outro, duration: 150 }, // 5s
] as const;

export const TOTAL_DURATION = SCENES.reduce((sum, s) => sum + s.duration, 0);

const CROSSFADE = 12;

const SceneFade: React.FC<{
  children: React.ReactNode;
  duration: number;
  isFirst: boolean;
  isLast: boolean;
}> = ({ children, duration, isFirst, isLast }) => {
  const frame = useCurrentFrame();
  const fadeIn = isFirst
    ? 1
    : interpolate(frame, [0, CROSSFADE], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const fadeOut = isLast
    ? 1
    : interpolate(frame, [duration - CROSSFADE, duration], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      {children}
    </AbsoluteFill>
  );
};

export const Showcase: React.FC = () => {
  let offset = 0;
  return (
    <AbsoluteFill style={{ background: theme.bgPrimary }}>
      {SCENES.map((scene, i) => {
        const from = offset;
        offset += scene.duration;
        const Component = scene.component;
        return (
          <Sequence key={i} from={from} durationInFrames={scene.duration}>
            <SceneFade
              duration={scene.duration}
              isFirst={i === 0}
              isLast={i === SCENES.length - 1}
            >
              <Component />
            </SceneFade>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
