/**
 * newLook.js — the opt-in phone-first home for floor staff.
 *
 * WHAT THIS IS NOW
 *   A single alternative Home for the people who work shifts: instructors,
 *   leads, trainees and volunteers. Their question is "am I on today, and
 *   does anyone need anything from me?", they are asking it on a phone, and
 *   the classic Home answers it through a sidebar built for an owner's
 *   eighteen links behind a hamburger menu.
 *
 * TWO DOORS, AND THE RULE THAT DECIDES WHAT GOES ON THEM
 *   It started as four — owner, director, host, instructor. Three were
 *   removed after review: their figures depended on live Radius reads and
 *   cross-collection maths this app cannot do quickly or completely, so
 *   the numbers were not trustworthy. A dashboard that is confidently
 *   wrong is worse than no dashboard.
 *
 *   Leadership has a door again, but under that finding rather than
 *   around it: EVERY FIGURE ON IT IS A DIRECT READ of one collection this
 *   app owns — today's shifts, unclaimed open shifts, accounts awaiting
 *   approval, time-off requests, booked assessments, the leads funnel,
 *   centre events. Ratio coverage, hours against budget, enrolment and
 *   revenue are deliberately absent, and stay absent until the Radius API
 *   in Ratio_Radius_API_Request_Brief.docx exists to make them true.
 *
 * ON BY DEFAULT SINCE 2026-09-25, AND THE DEFAULT IS THE POINT
 *   It shipped off by default — nobody should meet a redesigned portal
 *   because a deploy landed — and it stayed that way long enough to be
 *   trusted. Opt-in was the right way to arrive and the wrong way to live:
 *   two homes meant every change to a home was two changes, forever, and
 *   the better of the two was the one most people never saw.
 *
 *   So the check is now "did this person turn it OFF", not "did they turn
 *   it on". Absent, blocked or unreadable storage all mean the new home,
 *   which matters because localStorage is exactly the thing that comes
 *   back empty in a private window or on a borrowed laptop — and the
 *   answer there should be the home everyone else is looking at.
 *
 *   The way back is still there: "Classic view" on the new home, the
 *   toggle in the sidebar, and the error boundary in HomeSwitch, which
 *   writes the explicit 'off' if a new home ever throws. The classic Home
 *   goes when nothing has fallen back to it for a while — not the same day
 *   everyone lands on the new one.
 *
 *   The preference is keyed by uid, so signing out of one account and into
 *   another on the same laptop does not carry it across.
 */

const KEY_PREFIX = 'ratio-new-look:';

/** localStorage, but never throws — private mode and blocked storage exist. */
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function newLookKey(uid) {
  return `${KEY_PREFIX}${uid || 'anon'}`;
}

/**
 * Is it on for this person? ON unless they explicitly turned it off.
 *
 * Only the exact string 'off' opts out. Anything else — never set, storage
 * blocked, a value from an older build — lands on the new home, because a
 * person whose browser forgets things should still see what everyone else
 * sees rather than quietly getting the old portal back.
 */
export function isNewLookOn(uid) {
  return read(newLookKey(uid)) !== 'off';
}

/** Turn it on or off for this person. Returns the new state. */
export function setNewLook(uid, on) {
  write(newLookKey(uid), on ? 'on' : 'off');
  return !!on;
}

/**
 * Which of the two homes this person gets.
 *
 * 'leadership' is for people who open the portal to RUN the centre —
 * owners, directors, the admin assistant, plain admins, and Managers, who
 * became the admin tier in their own right on 2026-09-14. Their question
 * is "is the floor covered and what needs me".
 *
 * 'floor' is for everyone whose job is working shifts: instructors, leads,
 * hosts, trainees, volunteers. Their question is "am I on today".
 *
 * Asked as "is this leadership" rather than as a list of job titles, so a
 * custom centre role invented in Manage Roles lands on the right side
 * without anyone editing this file. A Host carries admin.panel at some
 * centres and is still floor staff — the title is not what decides it.
 */
export function newLookHomeFor(auth = {}) {
  const {
    isOwnerLike, isAdmin, isSuperAdmin, isOwner, isDirector, isAdminAssistant, isManager,
  } = auth;
  const leadership = isOwnerLike
    || isSuperAdmin || isOwner || isDirector || isAdminAssistant || isAdmin || isManager;
  return leadership ? 'leadership' : 'floor';
}

/**
 * Should this person be shown their new home right now? Everyone has one,
 * so this is only ever about whether they opted OUT.
 */
export function newLookActive(auth = {}) {
  return isNewLookOn(auth?.profile?.uid);
}
