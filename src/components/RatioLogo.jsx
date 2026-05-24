import { useEffect, useState } from 'react';

/**
 * Ratio logo — the software platform's brand mark.
 *
 * Tries to load the production logo from /public first. If you drop the
 * designer-exported file at:
 *
 *   /public/ratio-logo.png   (or .svg / .jpg / .webp)
 *
 * this component will render that file as an <img> at pixel accuracy.
 * Until the file is in place, it falls back to a hand-drawn SVG
 * approximation (red angular bowl, white diagonal leg, black rounded
 * square background) — close enough to recognize but not a perfect
 * match for the brand kit. Replace the file and this auto-upgrades.
 */
export default function RatioLogo({ size = 32, alt = 'Ratio' }) {
  // Probe the public folder once on mount for the real logo file.
  // Image() check is cheap and lets us silently fall back if no file
  // has been added yet.
  const [src, setSrc] = useState(null);

  useEffect(() => {
    const candidates = ['/ratio-logo.png', '/ratio-logo.svg', '/ratio-logo.jpg', '/ratio-logo.webp'];
    let cancelled = false;
    (async () => {
      for (const url of candidates) {
        const ok = await new Promise(res => {
          const img = new Image();
          img.onload = () => res(true);
          img.onerror = () => res(false);
          img.src = url;
        });
        if (cancelled) return;
        if (ok) { setSrc(url); return; }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (src) {
    // The shipped /ratio-logo.png has a small white border around the
    // black rounded square. Rather than asking for a re-export, we
    // clip it: a same-size wrapper with overflow:hidden and a slightly
    // up-scaled image pushes the white edge off-frame, leaving just
    // the black-rounded-square mark visible.
    return (
      <span
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          overflow: 'hidden',
          lineHeight: 0,
        }}
      >
        <img
          src={src}
          alt={alt}
          width={size}
          height={size}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            transform: 'scale(1.18)',
            transformOrigin: 'center',
            objectFit: 'cover',
          }}
        />
      </span>
    );
  }

  // Fallback approximation. Replace the two <path> elements with the
  // production geometry when it arrives.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={alt}
    >
      <rect width="100" height="100" rx="22" ry="22" fill="#111111" />
      {/* Red angular bowl — wraps from top-left around to mid-right. */}
      <path
        d="M16 14 L64 14 L82 28 L82 40 L64 54 L18 54 Z"
        fill="#E31E24"
      />
      {/* White diagonal leg — thin parallelogram slashing down-right. */}
      <path
        d="M58 36 L80 36 L42 86 L18 86 Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}
