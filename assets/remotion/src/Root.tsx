import React from 'react';
import { Composition } from 'remotion';
import { CrossModelDemo } from './CrossModelDemo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CrossModelDemo"
      component={CrossModelDemo}
      durationInFrames={140}
      fps={20}
      width={800}
      height={450}
    />
  );
};
