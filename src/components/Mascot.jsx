import { mascotDataUrl, mascotFor } from '../lib/mascots';

/**
 * One Cole. `id` is the person's stored pick (`profile.mascot`); anything
 * missing or unknown draws the original. Just the head by default,
 * which is what fits a square icon slot.
 */
export default function Mascot({ id, pose = 'stand', crop = 'head', size = 40, className = '', alt }) {
  const width = size;
  const height = crop === 'head' ? size : Math.round(size * (264 / 200));
  return (
    <img
      src={mascotDataUrl(id, pose, { crop })}
      width={width}
      height={height}
      alt={alt ?? mascotFor(id).name}
      draggable={false}
      className={`select-none ${className}`}
    />
  );
}
