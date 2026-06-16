// Owner onboarding wizard.
//
// Activated for any owner whose centre has `completedOnboarding !== true`.
// Runs full-screen (no sidebar) so the owner can't side-quest into other
// pages and abandon the flow before the dashboard works.
//
// Why this exists: today, after super-admin provisions a centre, the new
// owner has to discover settings across five different pages to get to a
// working Today schedule. That gap is where post-pitch sales convert
// best go to die. The wizard collapses it into one linear flow.
//
// Scope, deliberately tight:
//   1. Welcome      → confirms which centre they're setting up
//   2. iCal         → connect Acuity/Radius (so appointments appear)
//   3. Ratio        → set students-per-instructor (so staffing math works)
//   4. Tracker      → optional Google Sheets sync (so students auto-import)
//   5. Done         → "view today's schedule" CTA
//
// Staff invites, holidays, payroll codes, etc. are intentionally OUT.
// They can be done later from Manage Staff / Centre Settings. The
// wizard's only job is "from blank account to working dashboard ≤ 10 min."

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { getSettings, saveSettings, enableSheetSync } from '../lib/scheduler-data';
import { toast } from '../lib/notify';
import {
  CheckCircle2, ArrowRight, ArrowLeft, ExternalLink,
  CalendarDays, Users, Sheet, PartyPopper, Copy,
} from 'lucide-react';
import RatioLogo from '../components/RatioLogo';

const STEPS = [
  { key: 'welcome', label: 'Welcome',         icon: PartyPopper },
  { key: 'ical',    label: 'Connect schedule', icon: CalendarDays },
  { key: 'ratio',   label: 'Set your ratio',  icon: Users },
  { key: 'tracker', label: 'Student tracker', icon: Sheet },
  { key: 'done',    label: 'Done',            icon: CheckCircle2 },
];

export default function Onboarding() {
  const { profile, activeCenterId: centerId, isOwner, isSuperAdmin, isAdminAssistant } = useAuth();
  const navigate = useNavigate();
  const allowed = isOwner || isSuperAdmin || isAdminAssistant;

  const [stepIdx, setStepIdx] = useState(0);
  const [centreName, setCentreName] = useState('your centre');
  const [settings, setSettings] = useState(null);
  const [icalDraft, setIcalDraft] = useState('');
  const [savingIcal, setSavingIcal] = useState(false);
  const [ratioDraft, setRatioDraft] = useState(4);
  const [savingRatio, setSavingRatio] = useState(false);
  const [syncToken, setSyncToken] = useState(null);
  const [enablingSync, setEnablingSync] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Load the existing centre + settings so steps prefill instead of
  // wiping anything the owner already configured (relevant if they
  // bounce out of onboarding and come back).
  useEffect(() => {
    if (!centerId || !allowed) return;
    let cancelled = false;
    (async () => {
      const [centreSnap, configSnap, s] = await Promise.all([
        getDoc(doc(db, 'centers', centerId)),
        getDoc(doc(db, 'centers', centerId, 'config', 'main')),
        getSettings(centerId),
      ]);
      if (cancelled) return;
      if (centreSnap.exists()) {
        setCentreName(centreSnap.data().name || centerId);
      }
      // If onboarding was already completed, kick straight to Home so a
      // typo'd URL doesn't dump them back into a setup flow they've finished.
      if (configSnap.exists() && configSnap.data().completedOnboarding === true) {
        navigate('/', { replace: true });
      }
      setSettings(s);
      setIcalDraft((s.icalUrls || []).join('\n'));
      setRatioDraft(s.studentsPerInstructor || 4);
      if (s.sheetSync?.token) {
        // Already enabled — show as connected.
        setSyncToken(s.sheetSync.token);
      }
    })();
    return () => { cancelled = true; };
  }, [centerId, allowed, navigate]);

  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center text-sm text-gray-500">
        Onboarding is for centre owners.
      </div>
    );
  }

  const step = STEPS[stepIdx];

  const goNext = () => setStepIdx(i => Math.min(STEPS.length - 1, i + 1));
  const goBack = () => setStepIdx(i => Math.max(0, i - 1));

  const saveIcal = async () => {
    const urls = icalDraft.split('\n').map(s => s.trim()).filter(Boolean);
    setSavingIcal(true);
    try {
      await saveSettings(centerId, { icalUrls: urls });
      toast.success(urls.length ? `Saved ${urls.length} iCal URL${urls.length === 1 ? '' : 's'}.` : 'iCal skipped.');
      goNext();
    } catch (e) { toast.error(e.message); }
    finally { setSavingIcal(false); }
  };

  const saveRatio = async () => {
    setSavingRatio(true);
    try {
      await saveSettings(centerId, { studentsPerInstructor: Number(ratioDraft) || 4 });
      toast.success(`Ratio set to 1:${ratioDraft}.`);
      goNext();
    } catch (e) { toast.error(e.message); }
    finally { setSavingRatio(false); }
  };

  const enableSync = async () => {
    setEnablingSync(true);
    try {
      const token = await enableSheetSync(centerId);
      setSyncToken(token);
      toast.success('Sync enabled. Token copied below — paste it into your Apps Script.');
    } catch (e) { toast.error(e.message); }
    finally { setEnablingSync(false); }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      // Write to config/main (NOT the top-level centre doc) so AuthContext's
      // existing centerConfig subscription picks it up reactively. RootGate
      // reads centerConfig.completedOnboarding to decide whether to redirect.
      await setDoc(doc(db, 'centers', centerId, 'config', 'main'), {
        completedOnboarding: true,
        onboardingCompletedAt: new Date().toISOString(),
      }, { merge: true });
      toast.success('Setup complete. Welcome to Ratio.');
      navigate('/scheduler-creation', { replace: true });
    } catch (e) {
      toast.error(e.message);
      setFinishing(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-gray-50 to-white">
      {/* Top bar — minimal so the wizard feels like a flow, not the full app */}
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-5 py-3">
        <RatioLogo size={28} />
        <span className="text-sm font-semibold text-gray-900">Ratio setup</span>
        <span className="ml-auto text-xs text-gray-500">
          Hi {profile?.firstName || profile?.displayName || 'there'} — setting up <b className="text-gray-700">{centreName}</b>
        </span>
      </header>

      {/* Progress strip */}
      <div className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
          {STEPS.map((s, i) => {
            const StepIcon = s.icon;
            const done = i < stepIdx;
            const active = i === stepIdx;
            return (
              <div key={s.key} className="flex items-center flex-1">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done   ? 'bg-emerald-600 text-white' :
                  active ? 'bg-red-600 text-white' :
                           'bg-gray-200 text-gray-500'
                }`}>
                  {done ? <CheckCircle2 size={14} /> : <StepIcon size={14} />}
                </div>
                <div className={`mx-2 text-xs ${active ? 'font-semibold text-gray-900' : 'text-gray-500'} hidden sm:block`}>
                  {s.label}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-px ${i < stepIdx ? 'bg-emerald-600' : 'bg-gray-200'}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <main className="flex-1 overflow-y-auto px-5 py-8">
        <div className="mx-auto max-w-2xl">
          {step.key === 'welcome' && (
            <StepCard title={`Welcome to Ratio, ${profile?.firstName || profile?.displayName || ''}!`}
              subtitle={`Let's get ${centreName} running in under 10 minutes. We'll connect your appointment source, set your staffing ratio, and optionally hook up your Student Assessment Tracker.`}>
              <div className="space-y-2 text-sm text-gray-700">
                <Bullet>Most setup is reversible — change anything later from Centre Settings.</Bullet>
                <Bullet>You can skip any step and finish it from inside the app.</Bullet>
                <Bullet>By the end, your Today dashboard will be live with real students.</Bullet>
              </div>
              <Actions
                right={<Btn onClick={goNext}>Let's start <ArrowRight size={14} /></Btn>}
              />
            </StepCard>
          )}

          {step.key === 'ical' && (
            <StepCard title="Connect your appointment source"
              subtitle="Ratio reads your Acuity (or Radius) schedule via iCal. Once connected, today's appointments appear on the dashboard automatically — no manual data entry.">
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="block text-xs font-medium text-gray-700 mb-1">iCal URL(s) — one per line</span>
                  <textarea rows={3} value={icalDraft}
                    onChange={e => setIcalDraft(e.target.value)}
                    placeholder="https://acuityscheduling.com/ical.php?owner=…&calendarID=…"
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs font-mono focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400" />
                </label>
                <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                  <div className="mb-1 font-semibold text-gray-900">How to find your Acuity iCal URL</div>
                  <ol className="ml-4 list-decimal space-y-0.5">
                    <li>Acuity → <b>Calendars</b></li>
                    <li>Click the calendar you want to sync</li>
                    <li><b>Sync with Other Calendars</b> → <b>1-way Calendar Sync</b></li>
                    <li>Copy the URL it shows you, paste above</li>
                  </ol>
                  <a href="https://help.acuityscheduling.com/hc/en-us/articles/4408373091341" target="_blank" rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-red-600 hover:underline">
                    Acuity docs <ExternalLink size={10} />
                  </a>
                </div>
              </div>
              <Actions
                left={<Btn ghost onClick={goNext}>Skip for now</Btn>}
                right={<Btn onClick={saveIcal} loading={savingIcal}>Save & continue <ArrowRight size={14} /></Btn>}
              />
            </StepCard>
          )}

          {step.key === 'ratio' && (
            <StepCard title="Set your staffing ratio"
              subtitle="How many students does one instructor handle? Mathnasium's standard is 1:4. Ratio uses this to compute under/overstaffing in real time on the Today dashboard.">
              <div className="rounded-lg border border-gray-200 bg-white p-5">
                <label className="block">
                  <span className="block text-xs font-medium text-gray-700">Students per instructor</span>
                  <div className="mt-2 flex items-center gap-3">
                    <input type="range" min="2" max="8" step="1" value={ratioDraft}
                      onChange={e => setRatioDraft(Number(e.target.value))}
                      className="flex-1 accent-red-600" />
                    <div className="w-16 rounded bg-gray-100 px-3 py-2 text-center font-mono text-lg font-bold">
                      1:{ratioDraft}
                    </div>
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-gray-400">
                    <span>1:2 (intensive)</span>
                    <span>1:4 (standard)</span>
                    <span>1:8 (large rooms)</span>
                  </div>
                </label>
                <p className="mt-3 text-xs text-gray-500">
                  You can adjust this any time under Centre Settings.
                </p>
              </div>
              <Actions
                left={<Btn ghost onClick={goBack}><ArrowLeft size={14} /> Back</Btn>}
                right={<Btn onClick={saveRatio} loading={savingRatio}>Save & continue <ArrowRight size={14} /></Btn>}
              />
            </StepCard>
          )}

          {step.key === 'tracker' && (
            <StepCard title="Sync your Student Assessment Tracker (optional)"
              subtitle="If your students live in a Google Sheet, Ratio can auto-import them in real time. You'll never paste a CSV again. You can also do this later under Student Scheduler → Setup.">
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                {!syncToken ? (
                  <>
                    <p className="text-sm text-gray-700 mb-3">
                      Click below and Ratio will generate a one-time token. You paste that token + a small script into your sheet,
                      and from then on every edit in the sheet pushes to Ratio within seconds. Sheet stays private — no
                      service account, no published URL.
                    </p>
                    <Btn onClick={enableSync} loading={enablingSync}>Enable Google Sheets sync</Btn>
                  </>
                ) : (
                  <>
                    <div className="mb-3 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      <CheckCircle2 size={12} /> Token generated
                    </div>
                    <p className="text-sm text-gray-700 mb-3">
                      Copy the token below + paste the Apps Script from{' '}
                      <code className="rounded bg-gray-100 px-1 text-xs">scripts/google-sheets-sync/RatioSync.gs</code>{' '}
                      into your sheet's <b>Extensions → Apps Script</b>. Detailed steps live on Student Scheduler → Setup —
                      you can finish this after onboarding.
                    </p>
                    <CopyRow label="CENTER_ID"  value={centerId} />
                    <CopyRow label="SYNC_TOKEN" value={syncToken} mono />
                  </>
                )}
              </div>
              <Actions
                left={<Btn ghost onClick={goBack}><ArrowLeft size={14} /> Back</Btn>}
                right={<Btn onClick={goNext}>{syncToken ? 'Continue' : 'Skip for now'} <ArrowRight size={14} /></Btn>}
              />
            </StepCard>
          )}

          {step.key === 'done' && (
            <StepCard title="You're set up." subtitle={`${centreName} is ready. Your Today dashboard is live.`}>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <div className="font-semibold">What's working now</div>
                <ul className="mt-2 space-y-1">
                  <SummaryCheck on={(settings?.icalUrls || []).length > 0}>Appointment feed connected</SummaryCheck>
                  <SummaryCheck on={!!(settings?.studentsPerInstructor)}>Staffing ratio set to 1:{ratioDraft}</SummaryCheck>
                  <SummaryCheck on={!!syncToken}>Google Sheets sync enabled (finish setup in Student Scheduler → Setup)</SummaryCheck>
                </ul>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
                <div className="font-semibold text-gray-900 mb-1">What to do next</div>
                <ul className="space-y-1">
                  <Bullet>Open Student Scheduler → Today to see your live dashboard</Bullet>
                  <Bullet>Add staff under Manage Staff so you can assign them to time slots</Bullet>
                  <Bullet>Customize colours, hours, and holidays in Centre Settings</Bullet>
                </ul>
              </div>
              <Actions
                left={<Btn ghost onClick={goBack}><ArrowLeft size={14} /> Back</Btn>}
                right={<Btn onClick={finish} loading={finishing}>View today's schedule <ArrowRight size={14} /></Btn>}
              />
            </StepCard>
          )}
        </div>
      </main>

      {/* Footer escape hatch — for super_admin testing the flow, or any
          edge case where the wizard gates someone who shouldn't be gated. */}
      <footer className="border-t border-gray-200 bg-white px-5 py-2 text-center text-[11px] text-gray-400">
        Stuck? Use the in-app chat (bottom right) or skip ahead with the buttons above.
      </footer>
    </div>
  );
}

// ── Small reusable bits ─────────────────────────────────────────────────

function StepCard({ title, subtitle, children }) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-600 max-w-xl">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Actions({ left, right }) {
  return (
    <div className="flex items-center gap-3">
      <div>{left}</div>
      <div className="ml-auto">{right}</div>
    </div>
  );
}

function Btn({ onClick, children, loading, ghost }) {
  return (
    <button onClick={onClick} disabled={loading}
      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
        ghost ? 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              : 'bg-red-600 text-white hover:bg-red-700'
      }`}>
      {loading ? 'Working…' : children}
    </button>
  );
}

function Bullet({ children }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400" />
      <span>{children}</span>
    </div>
  );
}

function SummaryCheck({ on, children }) {
  return (
    <li className="flex items-center gap-1.5">
      {on
        ? <CheckCircle2 size={14} className="text-emerald-600" />
        : <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-300" />}
      <span className={on ? '' : 'text-gray-500'}>{children}</span>
    </li>
  );
}

function CopyRow({ label, value, mono }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast.success(`${label} copied`); }
    catch { toast.error('Copy failed'); }
  };
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-gray-500">{label}</span>
      <code className={`flex-1 truncate rounded border border-gray-300 bg-white px-2 py-1 text-gray-800 ${mono ? 'font-mono text-[11px]' : 'text-xs'}`}>
        {value}
      </code>
      <button onClick={copy}
        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
        <Copy size={12} /> Copy
      </button>
    </div>
  );
}
