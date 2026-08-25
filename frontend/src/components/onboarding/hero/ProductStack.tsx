import { useState } from 'react';

const SHOTS = [
  {
    src: '/onboarding/product-stack-2.png',
    fallback: '/onboarding/product-hero.png',
  },
  {
    src: '/onboarding/product-stack-3.png',
    fallback: '/onboarding/product-hero.png',
  },
  {
    src: '/onboarding/product-stack-1.png',
    fallback: '/onboarding/product-hero.png',
  },
  {
    src: '/onboarding/product-stack-4.png',
    fallback: '/onboarding/product-hero.png',
  },
  {
    src: '/onboarding/product-stack-5.png',
    fallback: '/onboarding/product-hero.png',
  },
];

export function ProductStack() {
  return (
    <div
      className="onboarding-product-stack"
      data-testid="onboarding-product-stack"
      aria-hidden="true"
    >
      <div className="onboarding-product-stage">
        {SHOTS.map((shot, index) => (
          <div
            key={shot.src}
            className={`onboarding-product-shot onboarding-product-shot-${index}`}
          >
            <ShotFrame src={shot.src} fallback={shot.fallback} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ShotFrame({ src, fallback }: { src: string; fallback: string }) {
  const [href, setHref] = useState(src);
  const [dead, setDead] = useState(false);
  if (dead) return <div className="onboarding-product-frame" />;
  return (
    <div className="onboarding-product-frame">
      <img
        src={href}
        alt=""
        onError={() => {
          if (href !== fallback) setHref(fallback);
          else setDead(true);
        }}
      />
    </div>
  );
}
