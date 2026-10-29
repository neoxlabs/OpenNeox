import React, { useCallback, useRef, useState } from 'react';
import MascotEyes from './MascotEyes';
import catBase from '../../assets/mascots/cat-base-v2.webp';
import corgiBase from '../../assets/mascots/corgi-base-v2.webp';
import catBody from '../../assets/mascots/cat-rig-body.webp';
import catHead from '../../assets/mascots/cat-rig-head.webp';
import catLeftArm from '../../assets/mascots/cat-rig-leftArm.webp';
import catLeftHand from '../../assets/mascots/cat-rig-leftHand.webp';
import catRightArm from '../../assets/mascots/cat-rig-rightArm.webp';
import catRightHand from '../../assets/mascots/cat-rig-rightHand.webp';
import corgiBody from '../../assets/mascots/corgi-rig-body.webp';
import corgiHead from '../../assets/mascots/corgi-rig-head.webp';
import corgiLeftArm from '../../assets/mascots/corgi-rig-leftArm.webp';
import corgiLeftHand from '../../assets/mascots/corgi-rig-leftHand.webp';
import corgiRightArm from '../../assets/mascots/corgi-rig-rightArm.webp';
import corgiRightHand from '../../assets/mascots/corgi-rig-rightHand.webp';
import SpineMascotCanvas from './SpineMascotCanvas';

const ART = {
  cat: {
    base: catBase, body: catBody, head: catHead,
    leftArm: catLeftArm, leftHand: catLeftHand, rightArm: catRightArm, rightHand: catRightHand,
  },
  corgi: {
    base: corgiBase, body: corgiBody, head: corgiHead,
    leftArm: corgiLeftArm, leftHand: corgiLeftHand, rightArm: corgiRightArm, rightHand: corgiRightHand,
  },
};

/** Key this component by species so partially loaded rigs never mix identities. */
export default function MascotRig({ species }: { species: 'cat' | 'corgi' }) {
  const loaded = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [spineReady, setSpineReady] = useState(false);
  const art = ART[species];
  const onLoad = useCallback((part: string) => {
    loaded.current.add(part);
    if (loaded.current.size === 6) setReady(true);
  }, []);
  const onSpineReady = useCallback(() => setSpineReady(true), []);
  const onSpineUnavailable = useCallback(() => setSpineReady(false), []);
  const image = (part: 'body' | 'head' | 'leftArm' | 'leftHand' | 'rightArm' | 'rightHand') => (
    <img className="neox-mascot__layer" src={art[part]} alt="" draggable={false}
      onLoad={() => onLoad(part)} />
  );
  return (
    <div
      className="neox-mascot__art"
      data-rig-ready={ready ? 'yes' : 'no'}
      data-renderer={spineReady ? 'spine' : 'layers'}
      aria-hidden="true"
    >
      <SpineMascotCanvas
        species={species}
        onReady={onSpineReady}
        onUnavailable={onSpineUnavailable}
      />
      <div className="neox-mascot__fallback">
        <img className="neox-mascot__base" src={art.base} alt="" draggable={false} />
        <MascotEyes species={species} />
      </div>
      <div className="neox-mascot__rig">
        {image('body')}
        <div className="neox-mascot__head-look">
          <div className="neox-mascot__head-act">
            {image('head')}
            <MascotEyes species={species} />
          </div>
        </div>
        <div className="neox-mascot__arm neox-mascot__arm--left">
          {image('leftArm')}
          <div className="neox-mascot__hand neox-mascot__hand--left">{image('leftHand')}</div>
        </div>
        <div className="neox-mascot__arm neox-mascot__arm--right">
          {image('rightArm')}
          <div className="neox-mascot__hand neox-mascot__hand--right">{image('rightHand')}</div>
        </div>
      </div>
    </div>
  );
}
