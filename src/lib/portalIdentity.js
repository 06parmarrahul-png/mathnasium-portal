/**
 * portalIdentity.js — the two lines in the top-left corner of the portal.
 *
 * Both were wrong, in the same way: they were constants.
 *
 * The first said "Mathnasium" — the brand, at every centre, to everybody.
 * Nobody works at "Mathnasium"; Rahul works at Mathnasium of Langley, and
 * the moment a second centre exists a flat brand name is the one thing on
 * screen that cannot tell you which set of books you are looking at. The
 * centre's real name lives on its `centers/{id}` identity doc — the same
 * doc the signup picker and Manage Roles already read, and the one the
 * District roll-up had to be pointed at for exactly this reason.
 *
 * The second said "Staff Portal" to an owner. An owner does not open this
 * to find out when their shift is; they open it to run the centre. The
 * word is small and it is the first one they read every morning.
 *
 * Pure on purpose: what the corner says is a question about data and a
 * role, not about React, so it is answerable in a test.
 */

export const BRAND = 'Mathnasium';

/** Working the floor: instructors, leads, hosts, trainees, volunteers. */
export const STAFF_SUBTITLE = 'Staff Portal';
/** Running the place: directors, owners, and the district above them. */
export const OPERATIONS_SUBTITLE = 'Centre Operations Portal';

/**
 * A name worth showing, or ''.
 *
 * The bare word "Mathnasium" is rejected because it is not a name — it is
 * DEFAULT_CENTER_CONFIG's placeholder, which every centre inherits until
 * somebody types over it in Centre Settings. Treating it as an answer is
 * what put the brand in the corner in the first place.
 */
function realName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  return name.toLowerCase() === BRAND.toLowerCase() ? '' : name;
}

/** 'langley' → 'Langley'; 'north-vancouver' → 'North Vancouver'. */
function prettyId(centreId) {
  return String(centreId || '')
    .trim()
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Put a name into the form Mathnasium itself uses: "Mathnasium of X".
 *
 * Three shapes arrive here. "Mathnasium of Langley" is already right.
 * "Mathnasium Langley" is what LANGLEY_DEFAULT_CONFIG seeds and what a
 * hurried hand types, and it is missing one word. "Langley" is the place
 * on its own, which the centre picker shows and which reads as a location
 * rather than a business.
 *
 * The cost of the rule is a centre that deliberately calls itself
 * something with no place in it, which would come out as "Mathnasium of
 * <that>". Centre Settings is the answer there: a name that already says
 * "Mathnasium of …" is passed through untouched.
 */
function branded(name) {
  const rest = /^mathnasium\b[\s,·-]*(.*)$/i.exec(name);
  if (!rest) return `${BRAND} of ${name}`;
  const place = rest[1].trim();
  if (!place) return BRAND;
  return /^of\b/i.test(place) ? `${BRAND} ${place}` : `${BRAND} of ${place}`;
}

/**
 * What to call the centre somebody is looking at.
 *
 * The identity doc wins over the per-centre config for the same reason it
 * does on the District page: config.name defaults to the brand, so
 * preferring it turns every centre into the same anonymous one. If neither
 * has been filled in, the city is a better answer than nothing and the
 * centre id is a better answer than the brand — 'langley' at least names
 * the place.
 */
export function centreDisplayName({ identityName, configName, city, centreId } = {}) {
  const named = realName(identityName) || realName(configName);
  if (named) return branded(named);
  const place = String(city || '').trim() || prettyId(centreId);
  return place ? `${BRAND} of ${place}` : BRAND;
}

/**
 * Staff portal or operations portal, from the role flags AuthContext
 * already resolves.
 *
 * Directors and above, which here means: the centre's director, its
 * owner, the legacy platform admin that predates both, the district
 * manager who answers for several centres, and the super-admin. A Manager
 * or an admin assistant is deliberately not on this list — they are
 * leadership in this app's navigation, but they are not above a director,
 * and the subtitle is a statement about rank rather than about menus.
 */
export function portalSubtitle(auth = {}) {
  const runsTheCentre = Boolean(
    auth.isOwner || auth.isDirector || auth.isAdmin
    || auth.isDistrictManager || auth.isSuperAdmin,
  );
  return runsTheCentre ? OPERATIONS_SUBTITLE : STAFF_SUBTITLE;
}
