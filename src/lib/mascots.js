/**
 * Cole — Ratio's mascot, in six outfits. Each person picks one when they
 * sign up (and can change it on Account); it replaces the A+ at the top of
 * their own sidebar and phone header.
 *
 * Cole is the ratio sign as a character: a head floating just above a
 * body, like the colon in 1:4. Every outfit shares that silhouette and one
 * rig (outline, shaded ball, face, gloves), and adds one signature thing,
 * so all six read as the same character at 40px.
 *
 * That signature has to live at HEAD height, because the 40px icon in the
 * sidebar draws the head crop in the neutral 'stand' pose — anything held
 * in a hand is out of frame there. Hence the headset on Gamer Cole and the
 * wired eyes on Cole-feine: the controller and the cup are for the big
 * views only.
 *
 * The artwork is built as SVG markup here, in plain strings, and shown
 * through an <img> data URL (components/Mascot.jsx). Two reasons:
 *   - An <img> is its own document, so the clip-path ids inside one
 *     drawing can never collide with another drawing on the same page.
 *   - No markup is injected into the page. Nothing in here comes from a
 *     user; the only input is a mascot id checked against MASCOTS.
 */

export const MASCOTS = [
  { id: 'classic', name: 'Cole', tagline: 'The original', hero: 'thumbs' },
  { id: 'coach', name: 'Coach Cole', tagline: 'Runs the floor', hero: 'coach' },
  { id: 'cool', name: 'Cool Cole', tagline: 'Too cool for the desk', hero: 'peace' },
  { id: 'bot', name: 'Cole-bot', tagline: 'Ratio’s software side', hero: 'wave' },
  { id: 'gamer', name: 'Gamer Cole', tagline: 'One more round', hero: 'game' },
  { id: 'coffee', name: 'Cole-feine', tagline: 'Three cups deep', hero: 'sip' },
];

/** Everyone who signed up before there was a choice gets the original. */
export const DEFAULT_MASCOT = 'classic';

const IDS = new Set(MASCOTS.map(m => m.id));

/** A stored value → a mascot id that exists. Unknown or missing → default. */
export function resolveMascotId(id) {
  return IDS.has(id) ? id : DEFAULT_MASCOT;
}

export function mascotFor(id) {
  return MASCOTS.find(m => m.id === resolveMascotId(id));
}

// ── palette ─────────────────────────────────────────────────────────────
const INK = '#1B1216', RED = '#E31E24', SHADE = '#B0121A', WHITE = '#FFFFFF';
const BLUSH = '#FF7F8E', GOLD = '#FFC83D', STEEL = '#C9CED6', VISOR = '#20232B', CAPEDGE = '#3D3136';
const SLEEVE = '#A9713F', STAIN = '#7A4A22', BAG = '#8A5F4B';
const OUT = 4;

const n = (v) => Math.round(v * 100) / 100;
const S = (w = 3.5) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

/**
 * Builds one drawing. Ids come from a counter that starts again for every
 * drawing, so the same mascot and pose always produce the same markup —
 * which is what lets the data URL be cached.
 */
function drawing(prefix) {
  let uid = 0;
  const nid = (p) => `${prefix}-${p}${++uid}`;

  // A ball with a shaded crescent, a shine and an outline — the whole
  // difference between "a red circle" and "a head".
  function ball(cx, cy, r) {
    const id = nid('b');
    const hx = n(cx - r * 0.45), hy = n(cy - r * 0.45);
    return `<defs><clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SHADE}"/>`
      + `<circle cx="${n(cx - r * 0.12)}" cy="${n(cy - r * 0.14)}" r="${n(r * 0.97)}" fill="${RED}" clip-path="url(#${id})"/>`
      + `<ellipse cx="${hx}" cy="${hy}" rx="${n(r * 0.2)}" ry="${n(r * 0.11)}" transform="rotate(-40 ${hx} ${hy})" fill="#fff" opacity=".5"/>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK}" stroke-width="${OUT}"/>`;
  }

  function openMouth(d, tx, ty, trx, tr) {
    const id = nid('m');
    return `<defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs>`
      + `<path d="${d}" fill="#5A0E14"/>`
      + `<ellipse cx="${tx}" cy="${ty}" rx="${trx}" ry="${tr}" fill="#FF6F7D" clip-path="url(#${id})"/>`
      + `<path d="${d}" fill="none" ${S(3.5)}/>`;
  }

  return { ball, openMouth };
}

// ── face ────────────────────────────────────────────────────────────────
const EYE_L = 80, EYE_R = 120, EYE_Y = 84;

function eyeOpen(x, y, [lx, ly] = [0, 0]) {
  return `<ellipse cx="${x}" cy="${y}" rx="11" ry="14" fill="#fff" ${S(3)}/>`
    + `<ellipse cx="${x + lx}" cy="${y + ly + 2}" rx="6" ry="8" fill="${INK}"/>`
    + `<circle cx="${x + lx + 2.5}" cy="${y + ly - 2}" r="2.6" fill="#fff"/>`;
}
const eyeShut = (x, y) =>
  `<path d="M${x - 10} ${y + 4} Q${x} ${y - 11} ${x + 10} ${y + 4}" stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;

function eyes(kind) {
  if (kind === 'wink') return eyeOpen(EYE_L, EYE_Y) + eyeShut(EYE_R, EYE_Y);
  if (kind === 'closed') return eyeShut(EYE_L, EYE_Y) + eyeShut(EYE_R, EYE_Y);
  if (kind === 'look') return eyeOpen(EYE_L, EYE_Y, [3, -5]) + eyeOpen(EYE_R, EYE_Y, [3, -5]);
  return eyeOpen(EYE_L, EYE_Y) + eyeOpen(EYE_R, EYE_Y);
}

function brow(x, kind, side) {
  const t = EYE_Y - 22;
  const st = `stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"`;
  if (kind === 'up') return `<path d="M${x - 9} ${t - 3} Q${x} ${t - 11} ${x + 9} ${t - 4}" ${st}/>`;
  if (kind === 'determined') {
    const inner = side < 0 ? x + 9 : x - 9, outer = side < 0 ? x - 9 : x + 9;
    return `<path d="M${outer} ${t - 5} L${inner} ${t + 1}" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  }
  if (kind === 'raised' && side > 0) return `<path d="M${x - 9} ${t - 6} Q${x} ${t - 14} ${x + 9} ${t - 8}" ${st}/>`;
  return `<path d="M${x - 9} ${t} Q${x} ${t - 6} ${x + 9} ${t - 1}" ${st}/>`;
}
const brows = (kind) => brow(EYE_L, kind, -1) + brow(EYE_R, kind, 1);

function mouth(kind, d) {
  const st = `stroke="${INK}" stroke-width="4.5" fill="none" stroke-linecap="round"`;
  if (kind === 'big') return d.openMouth('M80 104 Q100 140 120 104 Z', 100, 123, 10, 6);
  if (kind === 'grin') return `<path d="M84 108 Q100 123 116 108" ${st}/>`;
  if (kind === 'smirk') return `<path d="M88 114 Q104 120 117 106" ${st}/>`;
  if (kind === 'o') return `<ellipse cx="106" cy="114" rx="4.5" ry="5.5" fill="${INK}"/>`;
  return d.openMouth('M86 106 Q100 125 114 106 Z', 100, 117, 7, 4.5);
}
const cheeks = () =>
  `<ellipse cx="64" cy="106" rx="8" ry="5" fill="${BLUSH}" opacity=".6"/><ellipse cx="136" cy="106" rx="8" ry="5" fill="${BLUSH}" opacity=".6"/>`;

// ── gloves & feet ───────────────────────────────────────────────────────
function glove(type, x, y, rot = 0, mirror = false, fill = WHITE) {
  const cuff = `<rect x="-11" y="11" width="22" height="9" rx="4.5" fill="${fill}" ${S()}/>`;
  const crease = (p) => `<path d="${p}" stroke="${INK}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
  let g;
  if (type === 'open') {
    g = `<ellipse cx="-13" cy="1" rx="5.5" ry="9" transform="rotate(-35 -13 1)" fill="${fill}" ${S()}/>`
      + `<path d="M-12 8 Q-15 -13 -7 -17 Q0 -21 7 -17 Q15 -13 12 8 Q11 14 0 14 Q-11 14 -12 8 Z" fill="${fill}" ${S()}/>`
      + crease('M-3.5 -18 V-8 M3.5 -18 V-8') + cuff;
  } else if (type === 'thumb') {
    g = `<rect x="-5" y="-31" width="11" height="25" rx="5.5" fill="${fill}" ${S()}/>`
      + `<rect x="-13" y="-11" width="26" height="24" rx="10" fill="${fill}" ${S()}/>`
      + crease('M-13 -2 H3 M-13 5 H3') + cuff;
  } else if (type === 'peace') {
    g = `<rect x="-10" y="-35" width="9" height="27" rx="4.5" transform="rotate(-13 -5.5 -10)" fill="${fill}" ${S()}/>`
      + `<rect x="1" y="-35" width="9" height="27" rx="4.5" transform="rotate(13 5.5 -10)" fill="${fill}" ${S()}/>`
      + `<rect x="-12" y="-12" width="24" height="24" rx="10" fill="${fill}" ${S()}/>`
      + crease('M-7 -2 H6') + cuff;
  } else {
    g = `<rect x="-13" y="-12" width="26" height="25" rx="11" fill="${fill}" ${S()}/>`
      + crease('M-13 -1 Q-4 -5 5 -1') + cuff;
  }
  return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${mirror ? -1 : 1} 1)">${g}</g>`;
}

function sneaker(x, y, mirror) {
  return `<g transform="translate(${x} ${y}) scale(${mirror ? -1 : 1} 1)">`
    + `<path d="M-16 4 Q-19 -11 -3 -13 Q9 -13 14 -4 Q22 -1 22 4 Z" fill="#fff" ${S()}/>`
    + `<path d="M-8 -3 Q3 -2 13 -7" stroke="${RED}" stroke-width="4" fill="none" stroke-linecap="round"/>`
    + `<rect x="-19" y="3" width="44" height="9" rx="4.5" fill="${INK}"/></g>`;
}

function thruster(x, y) {
  return `<g transform="translate(${x} ${y})">`
    + `<path d="M-7 8 Q0 32 7 8 Z" fill="${GOLD}" opacity=".95"/>`
    + `<path d="M-3.5 8 Q0 21 3.5 8 Z" fill="#FF8A3D"/>`
    + `<path d="M-11 -6 H11 L8 8 H-8 Z" fill="${STEEL}" ${S()}/></g>`;
}

function clipboard(fill) {
  return `<g transform="rotate(-10 48 196)">`
    + `<rect x="22" y="166" width="48" height="58" rx="5" fill="#9A6440" ${S()}/>`
    + `<rect x="27" y="175" width="38" height="44" rx="2" fill="#fff"/>`
    + `<text x="46" y="197" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="800" font-size="15" fill="${INK}">1:4</text>`
    + `<path d="M33 206 H59 M33 212 H52" stroke="#9AA0AA" stroke-width="2.5" stroke-linecap="round"/>`
    + `<rect x="37" y="161" width="18" height="10" rx="3" fill="${STEEL}" ${S(3)}/></g>`
    + glove('fist', 68, 202, 4, true, fill);
}

/** A gamepad across the belly, gripped with both hands. */
function controller(fill) {
  return `<path d="M64 172 Q52 176 56 196 Q60 210 72 206 Q80 202 84 194 H116 Q120 202 128 206 Q140 210 144 196 Q148 176 136 172 Q120 166 100 167 Q80 166 64 172 Z" fill="${STEEL}" ${S()}/>`
    + `<rect x="72" y="182" width="18" height="6" rx="2.5" fill="${INK}"/>`
    + `<rect x="78" y="176" width="6" height="18" rx="2.5" fill="${INK}"/>`
    + `<circle cx="112" cy="180" r="4" fill="${RED}"/><circle cx="122" cy="188" r="4" fill="${RED}"/>`
    + glove('fist', 58, 196, -16, true, fill)
    + glove('fist', 142, 196, 16, false, fill);
}

/**
 * A takeaway cup, held up by the face rather than down at the hip — held
 * low it would fall outside the head crop, and half the point of the cup
 * is that you can see it. The sleeve wears the colon, like the chest
 * emblem does.
 */
function cup(fill) {
  return `<path d="M159 88 Q152 79 159 70 M177 88 Q184 79 177 70" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".55"/>`
    + `<rect x="146" y="96" width="40" height="10" rx="5" fill="${INK}" ${S(3)}/>`
    + `<path d="M150 106 H182 L177 150 Q166 155 155 150 Z" fill="#fff" ${S(3.5)}/>`
    + `<rect x="152" y="117" width="28" height="18" rx="4" fill="${SLEEVE}" ${S(3)}/>`
    + `<circle cx="166" cy="122" r="2.8" fill="#fff"/><circle cx="166" cy="130" r="2.8" fill="#fff"/>`
    + glove('fist', 146, 138, -10, false, fill);
}

/**
 * Things a pose can hold. Each draws its own glove(s), so a pose naming
 * one leaves that hand — and for the controller, both — empty.
 */
const PROPS = { clipboard, controller, cup };

// ── poses & outfits ─────────────────────────────────────────────────────
const POSES = {
  stand:  { L: ['fist', 44, 198, -8], R: ['fist', 156, 198, 8], eyes: 'open', brows: 'normal', mouth: 'smile' },
  thumbs: { L: ['fist', 44, 198, -8], R: ['thumb', 158, 178, 6], eyes: 'open', brows: 'normal', mouth: 'smile' },
  wave:   { L: ['fist', 44, 198, -8], R: ['open', 164, 116, 16], eyes: 'wink', brows: 'up', mouth: 'grin', marks: true },
  cheer:  { L: ['open', 36, 118, -20], R: ['open', 164, 118, 20], eyes: 'closed', brows: 'up', mouth: 'big' },
  think:  { L: ['fist', 44, 198, -8], R: ['fist', 128, 146, -8], eyes: 'look', brows: 'raised', mouth: 'o' },
  peace:  { L: ['fist', 44, 198, -8], R: ['peace', 160, 126, 12], eyes: 'open', brows: 'raised', mouth: 'smirk' },
  coach:  { L: 'clipboard', R: ['thumb', 158, 178, 6], eyes: 'open', brows: 'determined', mouth: 'grin' },
  // The controller fills both hands, so the right one is empty rather than
  // a fist that would land on top of it.
  game:   { L: 'controller', R: null, eyes: 'open', brows: 'determined', mouth: 'smirk' },
  sip:    { L: ['fist', 44, 198, -8], R: 'cup', eyes: 'open', brows: 'up', mouth: 'o' },
};
export const MASCOT_POSES = Object.keys(POSES);

const OUTFITS = {
  classic: {
    // A cowlick, and the colon on its chest like a superhero emblem.
    back: () => `<path d="M92 38 Q84 14 104 9 Q97 22 113 25 Q104 30 108 38 Z" fill="${RED}" ${S()}/>`,
    body: () => `<circle cx="100" cy="190" r="13.5" fill="#fff" ${S(3)}/>`
      + `<circle cx="100" cy="184.5" r="3.4" fill="${RED}"/><circle cx="100" cy="195.5" r="3.4" fill="${RED}"/>`,
  },
  coach: {
    // Mathnasium is a gym for math: a whistle, and a sideways cap with the colon on it.
    body: () => `<path d="M70 166 Q100 198 130 166" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>`
      + `<path d="M70 166 Q100 198 130 166" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>`
      + `<rect x="103" y="180" width="13" height="7" rx="2" fill="${STEEL}" ${S(3)}/>`
      + `<rect x="88" y="176" width="20" height="14" rx="7" fill="${GOLD}" ${S(3)}/>`
      + `<circle cx="94" cy="183" r="2.2" fill="${INK}"/>`,
    hat: () => `<path d="M138 56 Q168 46 184 60 Q170 70 144 68 Z" fill="${INK}" ${S(3)}/>`
      + `<path d="M144 64 Q166 62 180 61" stroke="${CAPEDGE}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
      + `<path d="M49 66 Q45 25 100 23 Q155 25 151 66 Q100 44 49 66 Z" fill="${INK}" ${S(3)}/>`
      + `<path d="M100 25 Q95 38 97 50" stroke="${CAPEDGE}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
      + `<circle cx="100" cy="24" r="4" fill="${INK}" ${S(2.5)}/>`
      + `<circle cx="80" cy="38" r="3.4" fill="#fff"/><circle cx="80" cy="49" r="3.4" fill="#fff"/>`,
  },
  cool: {
    // A hood bunched at the collar. (A kangaroo pocket read as a second mouth.)
    body: () => `<path d="M68 166 Q100 146 132 166 Q100 160 68 166 Z" fill="${SHADE}" ${S(3)}/>`
      + `<path d="M92 154 L89 180 M108 154 L111 180" stroke="${INK}" stroke-width="6.5" fill="none" stroke-linecap="round"/>`
      + `<path d="M92 154 L89 180 M108 154 L111 180" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    hat: () => `<path d="M47 86 Q45 20 100 20 Q155 20 153 86" stroke="${INK}" stroke-width="9" fill="none" stroke-linecap="round"/>`
      + `<path d="M58 58 Q64 30 100 28" stroke="#5A4D52" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
      + `<rect x="34" y="66" width="24" height="42" rx="11" fill="${INK}"/><rect x="40" y="75" width="12" height="24" rx="6" fill="${RED}"/>`
      + `<rect x="142" y="66" width="24" height="42" rx="11" fill="${INK}"/><rect x="148" y="75" width="12" height="24" rx="6" fill="${RED}"/>`,
    // Shades cover the eyes in every pose; the brows and mouth do the acting.
    eyes: () => `<path d="M60 77 H140" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`
      + `<path d="M66 74 H95 Q98 74 97.5 78 L95 93 Q94 99 88 99 H75 Q68 99 67 93 L64.5 78 Q64 74 66 74 Z" fill="${INK}" ${S(3)}/>`
      + `<path d="M134 74 H105 Q102 74 102.5 78 L105 93 Q106 99 112 99 H125 Q132 99 133 93 L135.5 78 Q136 74 134 74 Z" fill="${INK}" ${S(3)}/>`
      + `<path d="M72 80 L79 92 M111 80 L118 92" stroke="#fff" stroke-width="3" opacity=".75" stroke-linecap="round"/>`,
  },
  bot: {
    back: () => `<circle cx="100" cy="13" r="13" fill="${GOLD}" opacity=".25"/>`
      + `<path d="M100 36 V16" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`
      + `<circle cx="100" cy="13" r="7" fill="${GOLD}" ${S(3)}/>`,
    body: () => `<rect x="80" y="172" width="40" height="32" rx="8" fill="${VISOR}" ${S(3)}/>`
      + `<circle cx="100" cy="182" r="3.4" fill="${GOLD}"/><circle cx="100" cy="194" r="3.4" fill="${GOLD}"/>`
      + `<circle cx="70" cy="188" r="2.6" fill="${STEEL}" ${S(1.5)}/><circle cx="130" cy="188" r="2.6" fill="${STEEL}" ${S(1.5)}/>`,
    hat: () => `<path d="M58 56 Q100 38 142 56" stroke="${SHADE}" stroke-width="3" fill="none" stroke-linecap="round"/>`
      + `<circle cx="47" cy="88" r="9" fill="${STEEL}" ${S(3.5)}/><path d="M43 88 H51" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`
      + `<circle cx="153" cy="88" r="9" fill="${STEEL}" ${S(3.5)}/><path d="M149 88 H157" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`,
    eyes: (kind) => {
      const led = (x, [lx, ly] = [0, 0]) =>
        `<rect x="${x - 10 + lx}" y="${73 + ly}" width="20" height="24" rx="10" fill="${GOLD}" opacity=".28"/>`
        + `<rect x="${x - 7 + lx}" y="${76 + ly}" width="14" height="18" rx="7" fill="${GOLD}"/>`;
      const shut = (x) => `<path d="M${x - 9} 90 Q${x} 75 ${x + 9} 90" stroke="${GOLD}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
      const visor = `<rect x="58" y="64" width="84" height="42" rx="21" fill="${VISOR}" ${S()}/>`
        + `<path d="M68 72 Q72 67 82 67" stroke="#fff" stroke-width="3" opacity=".3" fill="none" stroke-linecap="round"/>`;
      if (kind === 'wink') return visor + led(EYE_L) + shut(EYE_R);
      if (kind === 'closed') return visor + shut(EYE_L) + shut(EYE_R);
      if (kind === 'look') return visor + led(EYE_L, [3, -3]) + led(EYE_R, [3, -3]);
      return visor + led(EYE_L) + led(EYE_R);
    },
    feet: () => thruster(80, 236) + thruster(120, 236),
    gloveFill: '#E6E9EE',
    noBrows: true, noCheeks: true, mouthDrop: 10,
  },
  gamer: {
    // A headset. Cool Cole already owns "something on the ears", so the
    // telling detail is the boom mic swung down across the jaw — a hood
    // has no arm reaching for your mouth. The band also hugs the crown
    // where the hood stands well clear of it.
    hat: () => `<path d="M52 88 Q50 30 100 30 Q150 30 148 88" stroke="${INK}" stroke-width="11" fill="none" stroke-linecap="round"/>`
      + `<path d="M64 60 Q72 42 100 40 Q128 42 136 60" stroke="${RED}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`
      + `<circle cx="50" cy="94" r="17" fill="${INK}" ${S(3.5)}/><circle cx="50" cy="94" r="7.5" fill="${RED}"/>`
      + `<circle cx="150" cy="94" r="17" fill="${INK}" ${S(3.5)}/><circle cx="150" cy="94" r="7.5" fill="${RED}"/>`
      + `<path d="M50 112 Q48 136 68 135" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>`
      + `<ellipse cx="71" cy="134" rx="7.5" ry="6" transform="rotate(-14 71 134)" fill="${INK}" ${S(2.5)}/>`,
    // The 8-bit health heart, where the original wears the colon. Hidden
    // behind the controller in his own pose; there for every other one.
    // Seven cells across, not five: five reads as a plus sign.
    body: () => ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...']
      .map((row, y) => [...row].map((c, x) => (c === 'X'
        // 5.2 rather than 5 so the cells overlap and leave no hairlines.
        ? `<rect x="${82 + x * 5}" y="${173 + y * 5}" width="5.2" height="5.2" fill="#fff"/>`
        : '')).join('')).join(''),
  },
  coffee: {
    // Wired. The eyes carry him: huge whites, pinprick pupils, and the
    // bags underneath. They are the signature because they are the part
    // still on screen at 40px, where the cup is out of frame.
    // A ring he put down on himself. Tilted and splattered, because a true
    // circle reads as a logo rather than a spill.
    body: () => `<g transform="rotate(-12 102 190)">`
      + `<ellipse cx="102" cy="190" rx="15" ry="12.5" fill="none" stroke="#fff" stroke-width="7" opacity=".85"/>`
      + `<ellipse cx="102" cy="190" rx="15" ry="12.5" fill="none" stroke="${STAIN}" stroke-width="3.5"/></g>`
      + `<circle cx="82" cy="204" r="4.5" fill="#fff" opacity=".85"/><circle cx="82" cy="204" r="2.6" fill="${STAIN}"/>`
      + `<circle cx="120" cy="174" r="3" fill="#fff" opacity=".8"/><circle cx="120" cy="174" r="1.7" fill="${STAIN}"/>`,
    eyes: (kind) => {
      // Drawn first, so the lower lid sits over the top of them and only
      // the crescent below shows — which is how a bag reads. They have to
      // clear y=100 to show at all, which is what sets the eye's ry.
      const bag = (x, side) => {
        const a = x + side * -12, b = x + side * 8;
        return `<path d="M${a} ${EYE_Y + 19} Q${(a + b) / 2} ${EYE_Y + 26} ${b} ${EYE_Y + 18}" stroke="${BAG}" stroke-width="3.5" fill="none" stroke-linecap="round" opacity=".85"/>`;
      };
      const bags = bag(EYE_L, 1) + bag(EYE_R, -1);
      const wide = (x, [lx, ly] = [0, 0]) =>
        `<ellipse cx="${x}" cy="${EYE_Y}" rx="14" ry="16.5" fill="#fff" ${S(3)}/>`
        + `<circle cx="${x + lx}" cy="${EYE_Y + ly + 1}" r="4" fill="${INK}"/>`
        + `<circle cx="${x + lx + 1.8}" cy="${EYE_Y + ly - 2}" r="1.7" fill="#fff"/>`;
      if (kind === 'wink') return bags + wide(EYE_L) + eyeShut(EYE_R, EYE_Y);
      if (kind === 'closed') return bags + eyeShut(EYE_L, EYE_Y) + eyeShut(EYE_R, EYE_Y);
      if (kind === 'look') return bags + wide(EYE_L, [4, -6]) + wide(EYE_R, [4, -6]);
      return bags + wide(EYE_L) + wide(EYE_R);
    },
    // Blush would fight the eye whites for the same few pixels, and a
    // person three cups deep is not rosy.
    noCheeks: true,
  },
};

/**
 * Just the head, for the 40px icon. Stops above the body (which starts at
 * y=150) — a sliver of it read as a nub under the chin — and sits a little
 * right of centre so most of Coach Cole's brim fits.
 */
const HEAD_VIEWBOX = '30 0 148 148';
const FULL_VIEWBOX = '0 0 200 264';

/**
 * The SVG markup for one mascot in one pose.
 * @param {string} id    mascot id — unknown values fall back to the default
 * @param {string} pose  one of MASCOT_POSES — unknown falls back to 'stand'
 * @param {{ crop?: 'head' | 'full' }} opts
 */
export function mascotSvg(id, pose = 'stand', { crop = 'full' } = {}) {
  const outfit = resolveMascotId(id);
  const poseKey = POSES[pose] ? pose : 'stand';
  const o = OUTFITS[outfit];
  const p = POSES[poseKey];
  const d = drawing(`${outfit}-${poseKey}`);
  const hand = (h, mirror) => (Array.isArray(h) ? glove(h[0], h[1], h[2], h[3], mirror, o.gloveFill) : '');

  let s = '';
  s += o.back ? o.back() : '';
  s += d.ball(100, 188, 38);
  s += o.body ? o.body() : '';
  s += o.feet ? o.feet() : sneaker(78, 244, true) + sneaker(122, 244, false);
  s += d.ball(100, 86, 52);
  s += o.hat ? o.hat() : '';
  s += o.noCheeks ? '' : cheeks();
  s += o.eyes ? o.eyes(p.eyes) : eyes(p.eyes);
  s += o.noBrows ? '' : brows(p.brows);
  s += o.mouthDrop
    ? `<g transform="translate(0 ${o.mouthDrop})">${mouth(p.mouth, d)}</g>`
    : mouth(p.mouth, d);
  const held = (k) => (PROPS[k] ? PROPS[k](o.gloveFill) : '');
  s += typeof p.L === 'string' ? held(p.L) : hand(p.L, true);
  s += typeof p.R === 'string' ? held(p.R) : hand(p.R, false);
  if (p.marks) {
    s += `<path d="M180 98 Q186 110 181 122 M189 92 Q197 110 190 128" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".55"/>`;
  }
  const vb = crop === 'head' ? HEAD_VIEWBOX : FULL_VIEWBOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${s}</svg>`;
}

const urlCache = new Map();

/** The same drawing as a data URL, for an <img>. Cached: the markup never changes. */
export function mascotDataUrl(id, pose = 'stand', opts = {}) {
  const key = `${resolveMascotId(id)}|${pose}|${opts.crop || 'full'}`;
  if (!urlCache.has(key)) {
    urlCache.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvg(id, pose, opts))}`);
  }
  return urlCache.get(key);
}
