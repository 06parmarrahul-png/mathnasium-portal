/**
 * The one word under a person's name — "Host", "Lead", "Center Director".
 *
 * It used to read only the PLATFORM role, which is `instructor` for
 * everybody who isn't leadership. So Rahul, whose Langley title is Host,
 * read "Instructor", and so did all five Leads. The platform role is the
 * security boundary; what the team calls somebody is the CENTRE title
 * (`instructorType`, resolved per centre — pass `myInstructorType`).
 *
 * Order, each checked against live Langley data:
 *   1. Volunteer — a per-centre flag, and it is what they are to the team.
 *   2. Enterprise / Owner — the three owners' titles all say "Instructor",
 *      which is a leftover default, not a job.
 *   3. The centre title, unless it is plain "Instructor" (in any case —
 *      the super-admin record has it lowercase), shown as the team says
 *      it (roleDisplayName below).
 *   4. The platform role, as before.
 */
const PLATFORM_LABEL = {
  super_admin: 'Enterprise',
  owner: 'Owner',
  director: 'Director',
  admin_assistant: 'Admin Assistant',
  admin: 'Admin',
  instructor: 'Instructor',
};

export function roleLabelFor({ platformRole, instructorType, isVolunteer } = {}) {
  if (isVolunteer) return 'Volunteer';
  if (platformRole === 'super_admin' || platformRole === 'owner') return PLATFORM_LABEL[platformRole];
  const title = String(instructorType ?? '').trim();
  if (title && title.toLowerCase() !== 'instructor') return roleDisplayName(title);
  return PLATFORM_LABEL[platformRole] || 'Instructor';
}

/**
 * A centre job title as the team says it.
 *
 * The STORED names are abbreviations and old spellings — "Dir. of
 * Education", "Center Director", "Training", "Lead", "Admin" — and they
 * can't simply be renamed: shift documents, payroll buckets, the Firestore
 * rules and several exact-match checks key on them. So they stay as they
 * are underneath, and every place a person reads a title goes through
 * here. Anything not listed (Host, Manager, Instructor, Volunteer, or a
 * role a centre invented) is shown exactly as it was named.
 */
const TITLE_DISPLAY = {
  'center director': 'Centre Director',
  'centre director': 'Centre Director',
  'dir. of education': 'Director of Education',
  'director of education': 'Director of Education',
  'lead': 'Lead Instructor',
  'training': 'Trainee',
  'admin': 'Admin Assistant',
};

export function roleDisplayName(name) {
  const raw = String(name ?? '').trim();
  return TITLE_DISPLAY[raw.toLowerCase()] || raw;
}
