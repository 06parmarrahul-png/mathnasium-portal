import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { AlertTriangle, Building2, Users, ShieldAlert } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Card, Lbl, Pill, AllClear, Loading } from '../components/newlook/ui';
import { fmtDay, todayISO } from '../components/newlook/format';
import { useTimeFormat } from '../lib/useTimeFormat';
import {
  readVitals, ageInDays, freshnessOf, asOfLabel, rollUp, staffAt,
} from '../lib/district';
import { rollUpLeads, monthlyTrend } from '../lib/leadAnalytics';
import LeadsPanel from '../components/district/LeadsPanel';

/**
 * The district roll-up — several centres, for the person who answers for
 * all of them and runs none of them.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A COPY OF RADIUS.
 *
 * A district manager already has enrolment and billing in Radius, and will
 * spot a wrong figure there faster than anyone. Competing with it would
 * lose the account on the first number that disagreed. So the live half of
 * this page is deliberately the half Radius CANNOT answer — who is on the
 * floor tomorrow, which shifts nobody has taken, how each centre is
 * staffed, when they are open, what is on.
 *
 * The four figures Radius owns — active, inactive and on-hold students,
 * and money — are typed in by each centre, and every one of them carries
 * the date it was typed. A figure nobody has entered says so; it is never
 * quietly counted as zero. See the banner in src/lib/district.js, and the
 * scar in LeadershipHome.jsx left by the dashboard that was deleted for
 * doing the opposite.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * READ-ONLY BY CONSTRUCTION. The page writes nothing, and the permission
 * behind it (`district.view`) grants nothing at any individual centre.
 */

/** Amber once a monthly figure has missed a month, red once it never came. */
const FRESH_TONE = { fresh: null, ageing: 'warn', stale: 'warn', never: 'warn' };

function Figure({ label, value, note, tone }) {
  return (
    <div className="min-w-0">
      <div className="nl-display text-[26px] font-bold leading-none"
        style={{ color: value === null ? 'var(--nl-muted)' : 'var(--nl-ink)' }}>
        {value === null ? '—' : value}
      </div>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--nl-muted)' }}>{label}</div>
      {note && (
        <div className="mt-0.5 text-[10.5px]"
          style={{ color: tone === 'warn' ? 'var(--nl-warn)' : 'var(--nl-muted)' }}>
          {note}
        </div>
      )}
    </div>
  );
}

const money = (n) => (n === null ? null : `$${Math.round(n).toLocaleString('en-CA')}`);

export default function District() {
  const { profile, can } = useAuth();
  const fmtTime = useTimeFormat();
  const today = todayISO();
  const allowed = can('district.view');

  // Which centres are his is the ordinary multi-centre array. There is no
  // second notion of a district to fall out of sync with the first.
  const centreIds = useMemo(
    () => [...new Set(profile?.centerIds || [])].sort(), [profile?.centerIds]);

  const [centres, setCentres] = useState({});   // id → { name, city, province }
  const [configs, setConfigs] = useState({});   // id → config doc
  const [staff, setStaff] = useState([]);
  const [rostered, setRostered] = useState({}); // id → today's shifts
  const [leadsBy, setLeadsBy] = useState({});   // id → that centre's leads
  const [now, setNow] = useState(() => Date.now());

  // One listener per centre for the two per-centre docs. Equality-only
  // queries throughout, which is what the rest of the app already indexes.
  useEffect(() => {
    if (!allowed || centreIds.length === 0) return undefined;
    const stops = [];
    for (const id of centreIds) {
      stops.push(onSnapshot(doc(db, 'centers', id),
        snap => setCentres(prev => ({ ...prev, [id]: snap.exists() ? snap.data() : {} })),
        () => setCentres(prev => ({ ...prev, [id]: {} }))));
      stops.push(onSnapshot(doc(db, 'centers', id, 'config', 'main'),
        snap => setConfigs(prev => ({ ...prev, [id]: snap.exists() ? snap.data() : {} })),
        () => setConfigs(prev => ({ ...prev, [id]: {} }))));
      stops.push(onSnapshot(
        query(collection(db, 'shifts'), where('centerId', '==', id), where('date', '==', today)),
        snap => setRostered(prev => ({ ...prev, [id]: snap.docs.map(d => d.data()) })),
        () => setRostered(prev => ({ ...prev, [id]: [] }))));
      // The funnel. Read straight off each centre's own lead documents —
      // one collection, no arithmetic across any other. A refusal here is
      // an empty funnel for that centre rather than a broken page: the
      // rules only opened leads to a district manager at the centres on
      // their own account.
      stops.push(onSnapshot(
        collection(db, 'centers', id, 'leads'),
        snap => setLeadsBy(prev => ({
          ...prev,
          [id]: snap.docs.map(d => ({ id: d.id, centreId: id, ...d.data() })),
        })),
        () => setLeadsBy(prev => ({ ...prev, [id]: [] }))));
    }
    return () => stops.forEach(stop => stop());
  }, [allowed, centreIds, today]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Staff across the whole district in one read. array-contains-any takes
  // thirty values, which is more centres than a district has.
  useEffect(() => {
    if (!allowed || centreIds.length === 0) return undefined;
    return onSnapshot(
      query(collection(db, 'users'),
        where('centerIds', 'array-contains-any', centreIds.slice(0, 30))),
      snap => setStaff(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setStaff([]),
    );
  }, [allowed, centreIds]);

  // Derived rather than flagged in an effect: a centre has arrived when its
  // config listener has said something, even if what it said was "empty".
  const loaded = centreIds.length === 0 || centreIds.every(id => configs[id] !== undefined);

  const rows = useMemo(() => centreIds.map(id => {
    const config = configs[id] || {};
    const vitals = readVitals(config);
    const live = (rostered[id] || []).filter(s => s.status !== 'draft' && s.status !== 'cancelled');
    return {
      centreId: id,
      // The centres/{id} doc holds the centre's real name — "Mathnasium of
      // Langley". config.name is a per-centre setting that DEFAULTS to the
      // bare word "Mathnasium", so preferring it turned every centre in the
      // district into the same anonymous row. The identity doc wins, which
      // is the order Manage Roles and the signup picker already use.
      name: centres[id]?.name || config.name || id,
      city: config.city || centres[id]?.city || '',
      province: config.province || centres[id]?.province || '',
      vitals,
      age: ageInDays(vitals),
      freshness: freshnessOf(ageInDays(vitals)),
      staff: staffAt(staff, id),
      onToday: live.length,
      hoursToday: config.instructionalHours || null,
    };
  }), [centreIds, configs, centres, staff, rostered]);

  const totals = useMemo(() => rollUp(rows), [rows]);

  // One reading of the clock for every age on the page, so two figures
  // rendered in the same pass cannot disagree about what "3 days" means —
  // and taken at mount rather than during render, so ages do not jitter
  // every time something re-renders. Re-read every ten minutes, because a
  // district dashboard is the kind of page that stays open all day.
  const funnel = useMemo(() => rollUpLeads(leadsBy, now), [leadsBy, now]);
  const trend = useMemo(
    () => monthlyTrend(Object.values(leadsBy).flat(), 6, now), [leadsBy, now]);
  const centreNames = useMemo(
    () => Object.fromEntries(rows.map(r => [r.centreId, r.name])), [rows]);
  const districtStaff = useMemo(
    () => new Set(staff.filter(u => u.approved === true && u.status !== 'terminated').map(u => u.uid || u.id)).size,
    [staff]);

  // The district's name, if every centre agrees on one province. Otherwise
  // it is just "your centres" — inventing a label for a mixed set would be
  // the first wrong thing on the page.
  const provinces = useMemo(
    () => [...new Set(rows.map(r => r.province).filter(Boolean))], [rows]);
  const districtName = provinces.length === 1 ? provinces[0] : 'Your centres';

  // What needs him. Every one of these is a live read — the half of the
  // page Radius cannot produce.
  const quiet = rows.filter(r => r.onToday === 0);
  const silent = rows.filter(r => !r.vitals.reported);
  const stale = rows.filter(r => r.vitals.reported && r.freshness === 'stale');

  if (!allowed) {
    return (
      <div className="nl mx-auto w-full max-w-2xl">
        <Card tone="warn">
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} style={{ color: 'var(--nl-warn)' }} className="mt-0.5 shrink-0" />
            <div>
              <b className="block text-[14.5px]">Not your page</b>
              <p className="mt-1 text-[13px]" style={{ color: 'var(--nl-ink2)' }}>
                The district roll-up is for accounts that answer for more than one centre.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!loaded) return <div className="nl"><Loading label="Reading your centres…" /></div>;

  if (centreIds.length === 0) {
    return (
      <div className="nl mx-auto w-full max-w-2xl">
        <AllClear title="No centres on this account"
          note="A district account lists its centres the same way multi-centre staff do. Ask an owner to add them." />
      </div>
    );
  }

  return (
    <div className="nl mx-auto w-full max-w-5xl space-y-3.5 pb-28 lg:pb-6">

      {/* ── The band ─────────────────────────────────────────────── */}
      <div className="rounded-2xl p-5" style={{ background: 'var(--nl-brand)', color: '#fff' }}>
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-85">
          District · {fmtDay(today, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        <div className="mt-2 nl-display text-[34px] font-bold leading-none sm:text-[42px]">
          {districtName}
        </div>
        <div className="mt-2 text-[13.5px] opacity-90">
          {rows.length} centre{rows.length === 1 ? '' : 's'} · {districtStaff} staff on the books
        </div>
      </div>

      {/* ── What each centre reports ─────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Reported by the centres</Lbl>
        <Card>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure label="Active students" value={totals.activeStudents}
              note={`${totals.reporting} of ${totals.total} reporting`}
              tone={totals.complete ? null : 'warn'} />
            <Figure label="Inactive" value={totals.inactiveStudents} />
            <Figure label="On hold" value={totals.onHoldStudents} />
            <Figure label="Monthly revenue" value={money(totals.monthlyRevenue)} />
          </div>
          <p className="mt-3 border-t pt-2.5 text-[11.5px]" style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)' }}>
            These four are typed in by each centre — Ratio has no feed for them yet. A centre that
            has not entered a figure is left out of the total rather than counted as zero, which is
            why the count above says how many answered.
          </p>
        </Card>
      </div>

      {/* ── Exceptions ───────────────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Needs you</Lbl>
        {quiet.length === 0 && silent.length === 0 && stale.length === 0 ? (
          <AllClear title="Nothing standing out"
            note="Every centre is staffed today and the reported figures are current." />
        ) : (
          <div className="space-y-2.5">
            {quiet.length > 0 && (
              <Exception icon={<Users size={16} />}
                title={`${quiet.length} centre${quiet.length === 1 ? '' : 's'} with nobody rostered today`}
                note={quiet.map(r => r.name).join(' · ')} />
            )}
            {silent.length > 0 && (
              <Exception icon={<AlertTriangle size={16} />}
                title={`${silent.length} centre${silent.length === 1 ? '' : 's'} have never reported their numbers`}
                note={silent.map(r => r.name).join(' · ')} />
            )}
            {stale.length > 0 && (
              <Exception icon={<AlertTriangle size={16} />}
                title={`${stale.length} centre${stale.length === 1 ? '' : 's'} are overdue an update`}
                note={stale.map(r => `${r.name} (${asOfLabel(r.age)})`).join(' · ')} />
            )}
          </div>
        )}
      </div>

      {/* ── The funnel ───────────────────────────────────────────── */}
      <LeadsPanel funnel={funnel} trend={trend} centreNames={centreNames} now={now} />

      {/* ── Centre by centre ─────────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Centre by centre</Lbl>
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr style={{ background: 'var(--nl-raised)', color: 'var(--nl-muted)' }}>
                  <th className="px-4 py-2 text-left font-bold uppercase tracking-wider text-[10px]">Centre</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">Active</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">Inactive</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">On hold</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">Revenue</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">Staff</th>
                  <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-[10px]">On today</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.centreId} className="border-t" style={{ borderColor: 'var(--nl-rule)' }}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Building2 size={14} style={{ color: 'var(--nl-muted)' }} className="shrink-0" />
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{r.name}</div>
                          <div className="text-[11px]" style={{ color: 'var(--nl-muted)' }}>
                            {[r.city, asOfLabel(r.age)].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        {r.freshness !== 'fresh' && (
                          <Pill tone={FRESH_TONE[r.freshness] || 'flat'} className="shrink-0">
                            {r.freshness === 'never' ? 'no figures' : 'overdue'}
                          </Pill>
                        )}
                      </div>
                    </td>
                    <Cell v={r.vitals.activeStudents} />
                    <Cell v={r.vitals.inactiveStudents} />
                    <Cell v={r.vitals.onHoldStudents} />
                    <Cell v={money(r.vitals.monthlyRevenue)} />
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.staff.count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.onToday}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ── Opening hours ────────────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">When they are open</Lbl>
        <Card className="!p-0 overflow-hidden">
          {rows.map((r, i) => (
            <div key={r.centreId}
              className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 ${i ? 'border-t' : ''}`}
              style={{ borderColor: 'var(--nl-rule)' }}>
              <span className="text-[13.5px] font-semibold">{r.name}</span>
              <span className="text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
                {r.hoursToday
                  ? Object.entries(r.hoursToday)
                      .map(([day, h]) => `${day.slice(0, 3)} ${fmtTime.short(h.start)}–${fmtTime.short(h.end)}`)
                      .join(' · ')
                  : 'Hours not set'}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function Cell({ v }) {
  return (
    <td className="px-3 py-2.5 text-right tabular-nums"
      style={{ color: v === null || v === undefined ? 'var(--nl-muted)' : 'inherit' }}>
      {v === null || v === undefined ? '—' : v}
    </td>
  );
}

/** One thing across the district that wants looking at. */
function Exception({ icon, title, note }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0" style={{ color: 'var(--nl-brand)' }}>{icon}</span>
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold leading-tight">{title}</div>
          {note && <div className="mt-1 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>{note}</div>}
        </div>
      </div>
    </Card>
  );
}
