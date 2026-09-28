/**
 * homeFor.js — which of the two home pages a person gets.
 *
 * There used to be a third: the classic Home, shared by everybody, with
 * these two behind a per-person opt-in. They shipped off by default
 * (2026-08), became the default (2026-09-25) and the classic one was
 * deleted on 2026-09-28 once nothing had fallen back to it. What is left
 * is the only question that still matters — leadership or floor.
 *
 *   'leadership'  people who open the portal to RUN the centre: owners,
 *                 directors, the admin assistant, plain admins, and
 *                 Managers, who became the admin tier in their own right
 *                 on 2026-09-14. Their question is "is the floor covered
 *                 and what needs me".
 *
 *   'floor'       everyone whose job is working shifts: instructors,
 *                 leads, hosts, trainees, volunteers. Their question is
 *                 "am I on today".
 *
 *   'district'    answers for several centres and runs none of them. Their
 *                 question is "which of my centres needs me". Checked
 *                 AFTER leadership, because an owner of two centres is
 *                 both, and the centre they run is the one they open the
 *                 portal for — the roll-up is a page they visit, not the
 *                 page they land on.
 *
 * ASKED AS "IS THIS LEADERSHIP" RATHER THAN AS A LIST OF JOB TITLES, so a
 * custom centre role invented in Manage Roles lands on the right side with
 * nobody editing this file. A Host carries admin.panel at some centres and
 * is still floor staff — the title is not what decides it.
 */

export function homeFor(auth = {}) {
  const {
    isOwnerLike, isAdmin, isSuperAdmin, isOwner, isDirector, isAdminAssistant, isManager,
  } = auth;
  const leadership = isOwnerLike
    || isSuperAdmin || isOwner || isDirector || isAdminAssistant || isAdmin || isManager;
  if (leadership) return 'leadership';
  const district = typeof auth.can === 'function' && auth.can('district.view');
  return district ? 'district' : 'floor';
}
