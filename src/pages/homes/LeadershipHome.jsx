import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ArrowRight, CalendarDays, Users, Clock } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { greeting } from '../../lib/greeting';
import { setNewLook } from '../../lib/newLook';
import { weekAhead, weekWindow } from '../../lib/centreEvents';
import { LEAD_STATUSES } from '../../lib/leads';
import { PAGES } from '../../lib/pageNames';
import { resolveUserForCenter } from '../../lib/centerMembership';
import DeskHomeCard from '../../components/DeskHomeCard';
import Mascot from '../../components/Mascot';
import { mascotFor } from '../../lib/mascots';
import { Card, Btn, Lbl, AllClear, Loading } from '../../components/newlook/ui';
import { gradeLabel, whoFor } from '../../lib/assessments';
import TodaySnapshotCard from '../../components/newlook/TodaySnapshotCard';
import { fmtDay, todayISO } from '../../components/newlook/format';
import { useTimeFormat } from '../../lib/useTimeFormat';

/**
 * The home for people who RUN the centre — owners, directors, the admin
 * assistant, admins and Managers.
 *
 * Their question is not "am I on today". It is "is the floor covered, and
 * what is waiting on me". So the page is a state-of-the-floor headline
 * followed by a stack of things that need a decision, and it is empty when
 * nothing does.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EVERY FIGURE HERE IS A DIRECT READ OF ONE COLLECTION.
 *
 * This board existed once before and was deleted, along with the director
 * and host boards, because its numbers came from live Radius reads and
 * cross-collection maths this app cannot do quickly or completely — they
 * were wrong, and a dashboard that is confidently wrong is worse than no
 * dashboard. The old version led with "hours against budget" and "people
 * on ratio, every open day this month". Both were derived. Both were the
 * reason it went.
 *
 * So: today's shifts, unclaimed open shifts, accounts awaiting approval,
 * time-off requests, booked assessments, the leads funnel, centre events.
 * Seven collections, seven queries, no arithmetic across them.
 *
 * DELIBERATELY ABSENT, and staying absent until the Radius API exists:
 * ratio coverage, hours against budget, enrolment, attendance, revenue.
 * If you are about to add one of those, you are rebuilding the version
 * that got deleted.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ONE PAGE, NOT THREE, AND THE SAME PAGE FOR EVERYONE ON IT. A Manager
 * and a Director carry the same permissions apart from centre.settings,
 * and this page no longer has a card that turns on it — so there is
 * nothing here gated by role any more.
 *
 * WHAT IS NOT HERE, AND WHY. The centre-settings shortcut and the
 * availability-chasing card both went: they are errands, not decisions,
 * and the sidebar already reaches both. A home page earns its place by
 * answering "what is waiting on me", and anything that only answers
 * "where do I click" is competing with the things that do.
 *
 * THE ORDER IS THE POINT. Snapshot, then the desk, then the queue. The
 * snapshot says whether the floor is covered; the desk is what leadership
 * actually come here to read; the queue underneath keeps until both have
 * been looked at.
 */

/** A shift that is neither a draft nor cancelled is a shift someone works. */
const isLive = (s) => s.status !== 'draft' && s.status !== 'cancelled';

export default function LeadershipHome() {
  const auth = useAuth();
  const fmtTime = useTimeFormat();
  const {
    profile, activeCenterId, centerConfig,
  } = auth;

  const today = todayISO();
  const [todayShifts, setTodayShifts] = useState(null);   // null = still loading
  const [openShifts, setOpenShifts] = useState([]);
  const [people, setPeople] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [intakes, setIntakes] = useState([]);
  const [intakesDenied, setIntakesDenied] = useState(false);
  const [leads, setLeads] = useState([]);
  const [events, setEvents] = useState([]);

  // Today's roster. The one figure everyone opens this page for.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'shifts'),
        where('centerId', '==', activeCenterId), where('date', '==', today)),
      snap => setTodayShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setTodayShifts([]),
    );
  }, [activeCenterId, today]);

  // Shifts nobody has picked up. Filtered to today-forward in memory so
  // this needs no composite index.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'openShifts'), where('centerId', '==', activeCenterId)),
      snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setOpenShifts([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setPeople(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
      () => setPeople([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
      snap => setTimeOff(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setTimeOff([]),
    );
  }, [activeCenterId]);

  // Booked assessments. `slot` is a wall-clock string in the centre's own
  // day, so its first ten characters ARE the centre's date — comparing it
  // as text is both correct and index-free.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'centerIntakes'), where('centerId', '==', activeCenterId)),
      snap => { setIntakes(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setIntakesDenied(false); },
      // A REFUSED read is not an empty week. centerIntakes is owner-tier
      // because it carries a parent's name, email and phone — and Managers
      // reach this home. Reporting "none booked" to somebody who simply
      // may not see them is the confidently-wrong figure this whole page
      // exists to avoid.
      () => { setIntakes([]); setIntakesDenied(true); },
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'leads'),
      snap => setLeads(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setLeads([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'events'),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEvents([]),
    );
  }, [activeCenterId]);

  // Volunteers are a tier of their own in the grid, and the flag is
  // per-centre, so it comes off the resolved membership rather than the
  // shift. Same source the classic snapshot uses.
  const volunteerNames = useMemo(() => {
    const set = new Set();
    for (const u of people) {
      const at = resolveUserForCenter(u, activeCenterId);
      if (at?.isVolunteer === true && at.displayName) set.add(at.displayName);
    }
    return set;
  }, [people, activeCenterId]);

  const anyLive = useMemo(
    () => (todayShifts || []).some(isLive), [todayShifts]);

  // ── Things waiting on a decision ───────────────────────────────────────
  const unclaimed = useMemo(
    () => openShifts.filter(s => s.status === 'open' && s.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
    [openShifts, today]);

  const awaitingApproval = useMemo(
    () => people.filter(u => u.approved !== true && u.status !== 'terminated'),
    [people]);

  const pendingTimeOff = useMemo(
    () => timeOff.filter(r => (r.status || 'pending') === 'pending')
      .sort((a, b) => String(a.from || '').localeCompare(String(b.from || ''))),
    [timeOff]);

  // ── Assessments, this week ─────────────────────────────────────────────
  const weekIntakes = useMemo(() => {
    const w = weekWindow(today);
    return intakes
      .filter(i => i.status !== 'cancelled' && typeof i.slot === 'string')
      .map(i => ({ ...i, date: i.slot.slice(0, 10) }))
      .filter(i => i.date >= today && i.date <= w.to)
      .sort((a, b) => a.slot.localeCompare(b.slot));
  }, [intakes, today]);

  // ── The funnel. Straight counts of a status field nobody derives. ──────
  const funnel = useMemo(() => {
    const tally = Object.fromEntries(LEAD_STATUSES.map(k => [k, 0]));
    for (const l of leads) {
      const k = LEAD_STATUSES.includes(l.status) ? l.status : 'new';
      tally[k] += 1;
    }
    return tally;
  }, [leads]);

  const week = useMemo(() => {
    const w = weekWindow(today);
    return weekAhead({ shifts: [], events, from: w.from, to: w.to });
  }, [events, today]);

  const first = (profile?.displayName || '').split(' ')[0] || 'there';
  const nothingWaiting = !unclaimed.length && !awaitingApproval.length && !pendingTimeOff.length;

  return (
    <div className="nl mx-auto w-full max-w-2xl pb-28 md:max-w-5xl lg:pb-4">
      <div className="mb-3.5 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-end gap-2.5">
          <Mascot id={profile?.mascot} pose={mascotFor(profile?.mascot).hero}
            crop="full" size={48} alt=""
            className="-mb-0.5 h-[63px] w-12 shrink-0 sm:h-[84px] sm:w-16" />
          <h1 className="nl-display text-[26px] font-semibold leading-tight">
            {greeting()}, {first}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => { setNewLook(profile?.uid, false); window.location.reload(); }}
          className="-mr-1 mt-1 shrink-0 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold underline underline-offset-2"
          style={{ color: 'var(--nl-muted)' }}>
          Classic view
        </button>
      </div>

      {/* min-w-0 on BOTH columns, and it is load-bearing. A grid item
          defaults to min-width:auto, so its track can never be narrower
          than its min-content — and `truncate` sets white-space:nowrap,
          whose min-content is the WHOLE string. Without this the column
          measured 408px inside a 362px phone and the cards ran off the
          right edge. */}
      {/* Full width, above the split. The grid is nineteen half-hour
          columns wide and cannot live in a 736px half-page. */}
      <div className="mb-3.5">
          {todayShifts === null ? (
          <Loading label="Reading today's roster…" />
        ) : anyLive ? (
          <TodaySnapshotCard
            shifts={todayShifts}
            volunteerNames={volunteerNames}
            centerConfig={centerConfig}
            dateISO={today}
            to={PAGES.staffSchedule.path} />
        ) : (
          <AllClear title="Nobody rostered today"
            note="No live shifts on the sheet for today at this centre." />
        )}
      </div>

      <div className="grid gap-3.5 md:grid-cols-2 md:items-start">
        <div className="min-w-0 space-y-3.5">
          {/* The desk comes first. After the snapshot it is the thing
              leadership are actually here for — everything below it is a
              queue that can wait until the notes have been read. */}
          <DeskHomeCard />

          {/* ── What needs a decision ───────────────────────────────── */}
          <div>
            <Lbl className="mb-1.5">Needs you</Lbl>
            {nothingWaiting ? (
              <AllClear title="Nothing waiting"
                note="No unclaimed shifts, no one waiting to be approved, no time-off to answer." />
            ) : (
              /* Time off, then shifts nobody has taken. Both are somebody
                 waiting on an answer; the time-off request has a person
                 sitting on the other end of it, so it goes first.
                 Approvals last — rarer, and only ever rendered when there
                 is genuinely an account waiting. */
              <div className="space-y-2.5">
                {pendingTimeOff.length > 0 && (
                  <NeedsRow
                    icon={<Clock size={16} />}
                    title={`${pendingTimeOff.length} time-off request${pendingTimeOff.length === 1 ? '' : 's'}`}
                    note={pendingTimeOff.slice(0, 2).map(r => (
                      [r.userName, r.from && fmtDay(r.from, { month: 'short', day: 'numeric' })]
                        .filter(Boolean).join(' · ')
                    )).join('  ·  ')}
                    to={PAGES.staffSchedule.path}
                    cta="Review" />
                )}
                {unclaimed.length > 0 && (
                  <NeedsRow
                    icon={<CalendarDays size={16} />}
                    title={`${unclaimed.length} shift${unclaimed.length === 1 ? '' : 's'} nobody has taken`}
                    note={unclaimed.slice(0, 2).map(s => (
                      `${fmtDay(s.date, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(s.startTime)}`
                    )).join(' · ')}
                    to={PAGES.jobBoard.path}
                    cta={PAGES.jobBoard.name} />
                )}
                {awaitingApproval.length > 0 && (
                  <NeedsRow
                    icon={<Users size={16} />}
                    title={`${awaitingApproval.length} waiting to be approved`}
                    note={awaitingApproval.slice(0, 2).map(u => u.displayName).filter(Boolean).join(' · ')}
                    to={PAGES.manageStaff.path}
                    cta={PAGES.manageStaff.name} />
                )}
              </div>
            )}
          </div>

        </div>

        <div className="min-w-0 space-y-3.5">
          {/* ── Assessments ──────────────────────────────────────────── */}
          <div>
            <Lbl className="mb-1.5">Assessments this week</Lbl>
            {intakesDenied ? (
              <AllClear title="Not shown to you"
                note="Booked assessments carry families’ contact details, so they stay with owners, directors and the admin assistant." />
            ) : weekIntakes.length === 0 ? (
              <AllClear title="None booked this week"
                note="Families book these themselves from your public booking page." />
            ) : (
              <Card className="!p-0 overflow-hidden">
                {weekIntakes.slice(0, 5).map((i, n) => {
                  const who = whoFor(i);
                  const grade = gradeLabel(i.childGrade);
                  return (
                    <div key={i.id} className={`px-4 py-2.5 ${n ? 'border-t' : ''}`}
                      style={{ borderColor: 'var(--nl-rule)' }}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-[13.5px] font-semibold"
                          style={who.named ? undefined : { color: 'var(--nl-muted)', fontWeight: 400 }}>
                          {who.childLabel}
                        </span>
                        {grade && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: 'var(--nl-raised)', color: 'var(--nl-ink2)' }}>
                            {grade}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                        <span style={{ color: 'var(--nl-ink2)' }}>
                          {i.date === today ? 'Today' : fmtDay(i.date, { weekday: 'short' })}
                          {' '}{fmtTime(i.slot.slice(11, 16))}
                        </span>
                        {who.guardian && ` · ${who.guardian}`}
                      </div>
                      {i.notes && (
                        <div className="mt-1 truncate text-[11.5px]" style={{ color: 'var(--nl-muted)' }}
                          title={i.notes}>
                          {i.notes}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="border-t px-4 py-2" style={{ borderColor: 'var(--nl-rule)' }}>
                  <Btn to={PAGES.intakes.path} size="sm" variant="ghost">
                    {weekIntakes.length > 5
                      ? `All ${weekIntakes.length} ${PAGES.intakes.name.toLowerCase()}`
                      : PAGES.intakes.name} <ArrowRight size={13} />
                  </Btn>
                </div>
              </Card>
            )}
          </div>

          {/* ── The funnel ───────────────────────────────────────────── */}
          <div>
            <Lbl className="mb-1.5">New families</Lbl>
            <Card>
              <div className="flex gap-2">
                {LEAD_STATUSES.filter(k => k !== 'lost').map(k => (
                  <div key={k} className="flex-1">
                    <div className="nl-display text-[22px] font-bold leading-none"
                      style={{ color: k === 'enrolled' ? 'var(--nl-ok)' : 'var(--nl-ink)' }}>
                      {funnel[k]}
                    </div>
                    <div className="mt-1 text-[11px] capitalize" style={{ color: 'var(--nl-muted)' }}>
                      {k}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--nl-rule)' }}>
                <Btn to={PAGES.leads.path} size="sm" variant="ghost">
                  {PAGES.leads.name} <ArrowRight size={13} />
                </Btn>
              </div>
            </Card>
          </div>

          {/* ── What's on ────────────────────────────────────────────── */}
          {week.length > 0 && (
            <div>
              <Lbl className="mb-1.5">What&apos;s on</Lbl>
              <Card className="!p-0 overflow-hidden">
                {week.slice(0, 5).map((e, n) => (
                  <div key={e.id || `${e.date}-${n}`}
                    className={`flex items-baseline justify-between gap-3 px-4 py-2.5 ${n ? 'border-t' : ''}`}
                    style={{ borderColor: 'var(--nl-rule)' }}>
                    <span className="text-[13.5px]">
                      <span style={{ color: 'var(--nl-muted)' }}>
                        {fmtDay(e.date, { weekday: 'short', day: 'numeric' })}
                      </span>
                      {' '}{e.title || e.name || 'Event'}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One thing waiting on a decision: what it is, who it is about, and the
 * one place to go and settle it.
 */
function NeedsRow({ icon, title, note, to, cta }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0" style={{ color: 'var(--nl-brand)' }}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold leading-tight">{title}</div>
          {note && (
            <div className="mt-1 truncate text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
              {note}
            </div>
          )}
        </div>
        <Btn to={to} size="sm" variant="ghost" className="shrink-0">
          {cta} <ArrowRight size={13} />
        </Btn>
      </div>
    </Card>
  );
}
