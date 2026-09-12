/**
 * deskLink.js — working out who an old note is about.
 *
 * WHAT THE ARCHIVE ACTUALLY LOOKS LIKE, measured across all 1,750:
 *   15.5%  name a student Ratio holds
 *   32.2%  are person-shaped but in NO roster Ratio has
 *   51.1%  are not a person at all — "Blog Post Reminder", "DWPs"
 *
 * That middle third is the finding. They are overwhelmingly PARENTS —
 * Manjeet Kaur, Jenny Mao, Ravinder Raju — and Ratio holds no parent or
 * account list to match them against. Only the children are on file.
 *
 * SO THIS DOES TWO DIFFERENT THINGS, AND SAYS WHICH.
 *   A name that matches a student is LINKED: same spelling every time, so
 *   every note about that child groups together.
 *   A name that matches nothing is still KEPT, as written. "Manjeet Kaur"
 *   on the note is most of the value — the note says who it is about and
 *   searching her name finds it — and pretending it is linked when it is
 *   not would be worse than admitting it.
 *
 * IT NEVER GUESSES BETWEEN TWO PEOPLE. An abbreviation or a bare first
 * name that fits more than one student resolves to nobody; a wrong family
 * on a note about money is worse than no family at all.
 */

const norm = (s) => String(s ?? '')
  .toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

/** "Account: Manjeet Kaur" → "Manjeet Kaur". The sheet's own prefixes. */
export function stripPrefix(subject) {
  return String(subject ?? '')
    .replace(/^\s*(account|student|acct|applicant|family|parent|staff|lead|re)\s*[:-]\s*/i, '')
    .trim();
}

/**
 * Words that appear in person-SHAPED subjects but are not names.
 *
 * "Blog Post Reminder" and "Manjeet Kaur" are the same shape — two or
 * three capitalised words — so shape alone cannot tell them apart. This
 * list is read off the 760 person-shaped subjects in the archive: the
 * centre's own vocabulary plus the generic nouns that turn up in a title.
 *
 * It is a heuristic and it will be wrong sometimes, which is why every
 * note carries a control to set who it is about by hand. A blank is
 * honest; "Blog Post Reminder" filed as a family is not.
 */
const NOT_A_NAME = new Set([
  'dwp', 'dwps', 'wop', 'wops', 'ect', 'afu', 'swt', 'gc',
  'note', 'notes', 'reminder', 'reminders', 'post', 'blog', 'request',
  'report', 'reports', 'update', 'updates', 'policy', 'list', 'meeting',
  'schedule', 'email', 'e-mail', 'footer', 'photo', 'fun', 'day', 'days',
  'camp', 'summer', 'offer', 'letter', 'employee', 'month', 'week', 'year',
  'lead', 'leads', 'account', 'accounts', 'family', 'families', 'prize',
  'gift', 'card', 'cards', 'referral', 'rally', 'hold', 'holds', 'session',
  'sessions', 'assessment', 'newsletter', 'progress', 'student', 'students',
  'instructor', 'instructors', 'training', 'machine', 'claw', 'math',
  'new', 'old', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'winwin', 'staff', 'centre', 'center', 'parent',
  'parents', 'applicant', 'applicants', 'interview', 'tour', 'trial',
]);

/**
 * Looks like somebody's name, rather than "Blog Post Reminder".
 *
 * Two to four capitalised words, none of which is a word the centre uses
 * for a thing rather than a person.
 */
export function looksLikeName(s) {
  const v = String(s ?? '').trim();
  if (!/^[A-Z][A-Za-z'-]+(\s+[A-Z][A-Za-z'.-]*){1,3}$/.test(v)) return false;
  return !v.split(/\s+/).some(w => NOT_A_NAME.has(w.toLowerCase().replace(/[.,]/g, '')));
}

function indexStudents(students) {
  const full = new Map();
  const firstInitial = new Map();
  const first = new Map();
  for (const name of students || []) {
    const n = norm(name);
    if (!n) continue;
    if (!full.has(n)) full.set(n, name);
    const parts = n.split(' ');
    if (parts.length >= 2) {
      const k = `${parts[0]} ${parts[parts.length - 1][0]}`;
      if (!firstInitial.has(k)) firstInitial.set(k, []);
      firstInitial.get(k).push(name);
    }
    if (!first.has(parts[0])) first.set(parts[0], []);
    first.get(parts[0]).push(name);
  }
  return { full, firstInitial, first };
}

/**
 * Who is this note about?
 *
 * @returns { about, linked, how } — `linked` true only when it resolved to
 *          a real student record. `how` says why, which is what makes the
 *          result reviewable rather than magic.
 */
export function linkAbout(subject, body, students = []) {
  const idx = indexStudents(students);
  const subj = stripPrefix(subject);
  const s = norm(subj);

  if (s) {
    if (idx.full.has(s)) return { about: idx.full.get(s), linked: true, how: 'exact' };

    // "Ranbir R." — 48 of the archive's subjects are written this way.
    const abbr = s.match(/^([a-z'-]+)\s+([a-z])$/);
    if (abbr) {
      const hits = idx.firstInitial.get(`${abbr[1]} ${abbr[2]}`) || [];
      if (hits.length === 1) return { about: hits[0], linked: true, how: 'abbreviated' };
      if (hits.length > 1) return { about: subj, linked: false, how: 'ambiguous' };
    }

    // A bare first name, only when exactly one student has it.
    const one = idx.first.get(s) || [];
    if (one.length === 1) return { about: one[0], linked: true, how: 'first-name' };
    if (one.length > 1) return { about: subj, linked: false, how: 'ambiguous' };

    // A name sitting inside a topic subject: "$15 Starbucks for Ananya B".
    const inside = (students || []).find(n => norm(n) && s.includes(norm(n)));
    if (inside) return { about: inside, linked: true, how: 'in-subject' };

    // Person-shaped but unknown to Ratio. Keep it: it is almost always a
    // parent, and the note still has to say who it is about.
    if (looksLikeName(subj)) return { about: subj, linked: false, how: 'unmatched-name' };
  }

  // The subject is a topic. Does the BODY name a student? 53 notes do.
  const b = norm(body);
  if (b) {
    const inBody = (students || []).find(n => norm(n) && b.includes(norm(n)));
    if (inBody) return { about: inBody, linked: true, how: 'in-body' };
  }

  return { about: null, linked: false, how: 'none' };
}

/** Students whose name starts with what has been typed. For the picker. */
export function suggestStudents(query, students = [], limit = 6) {
  const q = norm(query);
  if (q.length < 2) return [];
  const starts = [];
  const contains = [];
  for (const n of students) {
    const v = norm(n);
    if (!v) continue;
    if (v.startsWith(q)) starts.push(n);
    else if (v.includes(q)) contains.push(n);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
