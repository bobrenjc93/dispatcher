import React from "react";
import { Composition } from "remotion";
import { Showcase, TOTAL_DURATION } from "./Showcase";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Showcase"
    component={Showcase}
    durationInFrames={TOTAL_DURATION}
    fps={30}
    width={1920}
    height={1080}
  />
);
