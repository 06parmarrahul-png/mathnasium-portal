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
 *      the super-admin record has it lowercase).
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
  if (title && title.toLowerCase() !== 'instructor') return title;
  return PLATFORM_LABEL[platformRole] || 'Instructor';
}
