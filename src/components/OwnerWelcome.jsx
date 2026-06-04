import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Sparkles, Building2, Users, BarChart3, Settings, Shield, X, ArrowRight,
  TrendingUp, Globe, MessageCircle,
} from 'lucide-react';

/**
 * OwnerWelcome — the first-14-days hero shown to brand-new owners
 * (role === 'owner' only — Enterprise / admins / instructors never see
 * this). Stamped once on first render with `ownerWelcomeStartAt` on
 * the user doc; auto-retires 14 days later. A user-driven dismiss
 * (`ownerWelcomeDismissed`) hides it permanently if they prefer the
 * regular dashboard.
 *
 * This is a relationship surface, not a marketing surface — leans into
 * a personal thank-you note + week-1 onboarding actions + a small
 * sense of being part of something growing (platform stats). Visual
 * tone: subtle gradient + glassmorphism, not arcade flash.
 */

const WELCOME_WINDOW_DAYS = 14;

function firstName(displayName) {
  if (!displayName) return 'there';
  return displayName.trim().split(/\s+/)[0];
}

function tsToDate(ts) {
  if (!ts) return null;
  if (ts.seconds) return new Date(ts.seconds * 1000);
  if (ts instanceof Date) return ts;
  return null;
}

function daysSince(date) {
  if (!date) return 0;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

/**
 * Decide whether to show the welcome. Returns one of:
 *   'show'   — render the hero
 *   'stamp'  — render the hero AND stamp ownerWelcomeStartAt now
 *   'hide'   — skip; render the regular dashboard
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOwnerWelcomeState() {
  // Show the welcome banner to AA too — they have the same setup tasks
  // as the owner (centre settings, fixed staff, holidays, etc.).
  const { profile, isOwnerLike } = useAuth();
  if (!profile || !isOwnerLike) return 'hide';
  if (profile.ownerWelcomeDismissed) return 'hide';
  const startedAt = tsToDate(profile.ownerWelcomeStartAt);
  if (!startedAt) return 'stamp';  // first owner-Home visit
  return daysSince(startedAt) < WELCOME_WINDOW_DAYS ? 'show' : 'hide';
}

export default function OwnerWelcome({ onContinue }) {
  const { profile, activeCenterId } = useAuth();
  const [centers, setCenters] = useState([]);
  const [userCount, setUserCount] = useState(null);

  // Stamp ownerWelcomeStartAt on first render if it isn't set yet — this
  // is what kicks off the 14-day timer. Idempotent: if the field already
  // exists we skip the write. We don't surface a loading state for this —
  // it's a single Firestore write and the page is already populated from
  // the rest of the data; nothing meaningful would render differently.
  useEffect(() => {
    if (!profile || profile.ownerWelcomeStartAt) return;
    updateDoc(doc(db, 'users', profile.uid), {
      ownerWelcomeStartAt: serverTimestamp(),
    }).catch(() => { /* swallow — not worth blocking the page on */ });
  }, [profile]);

  // Platform stats. Both collections are signed-in-readable.
  useEffect(() => onSnapshot(
    collection(db, 'centers'),
    snap => setCenters(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    () => setCenters([]),
  ), []);

  useEffect(() => onSnapshot(
    collection(db, 'users'),
    snap => setUserCount(snap.docs.filter(d => d.data()?.approved !== false).length),
    () => setUserCount(null),
  ), []);

  const myCentre = useMemo(
    () => centers.find(c => c.id === activeCenterId),
    [centers, activeCenterId],
  );

  const handleDismiss = async () => {
    if (!profile?.uid) return;
    try {
      await updateDoc(doc(db, 'users', profile.uid), {
        ownerWelcomeDismissed: true,
      });
    } catch { /* ignore — user can always click Continue */ }
  };

  const name = firstName(profile?.displayName);
  const centreName = myCentre?.name || 'your centre';

  return (
    <div className="relative -mx-4 -mt-4 md:-mx-6 md:-mt-6 lg:-mx-8 lg:-mt-8 mb-8 overflow-hidden">
      {/* Animated gradient backdrop. Three layered gradients on a slow
          drift give depth without crossing into casino territory. */}
      <style>{`
        @keyframes ownerWelcomeDrift {
          0%   { transform: translate(0, 0) scale(1); }
          50%  { transform: translate(2%, -1%) scale(1.05); }
          100% { transform: translate(0, 0) scale(1); }
        }
        @keyframes ownerWelcomeFadeUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ow-fade-up { animation: ownerWelcomeFadeUp 700ms ease-out both; }
        .ow-fade-up-1 { animation-delay: 100ms; }
        .ow-fade-up-2 { animation-delay: 220ms; }
        .ow-fade-up-3 { animation-delay: 340ms; }
        .ow-fade-up-4 { animation-delay: 460ms; }
        .ow-drift {
          animation: ownerWelcomeDrift 18s ease-in-out infinite;
        }
      `}</style>

      <div className="relative bg-gradient-to-br from-gray-900 via-purple-900 to-red-900 text-white">
        {/* Soft moving blobs for depth */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="ow-drift absolute -top-20 -left-20 h-96 w-96 rounded-full bg-purple-500/30 blur-3xl" />
          <div className="ow-drift absolute -bottom-20 -right-20 h-96 w-96 rounded-full bg-red-500/30 blur-3xl"
               style={{ animationDelay: '6s' }} />
          <div className="ow-drift absolute top-1/2 left-1/3 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl"
               style={{ animationDelay: '12s' }} />
        </div>

        {/* Dismiss button — small, top-right, never aggressive */}
        <button
          onClick={handleDismiss}
          className="absolute top-4 right-4 z-10 rounded-full bg-white/10 p-1.5 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
          title="Hide this welcome (you'll still see the regular dashboard below)"
        >
          <X size={16} />
        </button>

        <div className="relative px-6 md:px-12 lg:px-16 py-12 md:py-16">
          {/* Greeting */}
          <div className="ow-fade-up max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 backdrop-blur px-3 py-1 text-xs font-medium text-white/90 mb-5">
              <Sparkles size={12} /> Welcome to Ratio
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05]">
              Welcome, {name}.
            </h1>
            <p className="mt-3 text-lg md:text-xl text-white/80 leading-snug">
              {centreName} is now live on Ratio.
            </p>
          </div>

          {/* Thank-you note. Glassmorphism card with the Ratio promise as
              a pull-quote in the middle so the brand mantra gets a real
              moment instead of being buried in prose. */}
          <div className="ow-fade-up ow-fade-up-1 mt-8 max-w-2xl rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-6 md:p-7">
            <p className="text-[15px] md:text-base text-white/90 leading-relaxed">
              {name === 'there' ? 'Hi,' : `${name},`} thanks for trusting us with how
              {' '}{centreName} runs. Here&apos;s what we&apos;re promising you:
            </p>
            <p className="my-4 text-lg md:text-xl font-medium text-white leading-snug border-l-2 border-white/40 pl-4">
              More time with students. More time with family. Less time on everything else.
            </p>
            <p className="text-[15px] md:text-base text-white/90 leading-relaxed">
              I built this at my own centre because the things I had to coordinate
              every week — who&apos;s covering Saturday, who can swap with whom, how
              much we paid last month — were eating my evenings. None of it should
              be hard.
            </p>
            <p className="mt-3 text-[15px] md:text-base text-white/90 leading-relaxed">
              Anything that doesn&apos;t work the way you&apos;d expect, message me directly
              from <Link to="/platform-chat" className="underline decoration-white/40 hover:decoration-white">Platform Chat</Link> and I&apos;ll fix it.
            </p>
            <p className="mt-4 text-sm text-white/70">— Rahul, Ratio</p>
          </div>

          {/* Platform stats */}
          <div className="ow-fade-up ow-fade-up-2 mt-10 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
            <StatCard
              Icon={Globe}
              label="Centres on the platform"
              value={centers.length}
              hint={centers.length === 1 ? 'and counting' : 'and counting'}
            />
            <StatCard
              Icon={Users}
              label="Team members across centres"
              value={userCount}
              hint="approved staff"
            />
            <StatCard
              Icon={TrendingUp}
              label={`${centreName} status`}
              valueText="Live"
              hint="ready when you are"
            />
          </div>

          {/* Onboarding quick actions */}
          <div className="ow-fade-up ow-fade-up-3 mt-10 max-w-4xl">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60 mb-3">
              Your first week
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <ActionCard
                to="/admin"
                Icon={Users}
                title="Set up your team"
                desc="Approve staff and assign sub-roles"
              />
              <ActionCard
                to="/center-settings"
                Icon={Settings}
                title="Centre settings"
                desc="Pay rates, scheduler tunables, hours"
              />
              <ActionCard
                to="/center-analytics"
                Icon={BarChart3}
                title="Centre analytics"
                desc="Coverage, payroll, and trends"
              />
              <ActionCard
                to="/admin"
                Icon={Shield}
                title="Admin panel"
                desc="Announcements, holidays, salaried staff"
              />
            </div>
          </div>

          {/* Continue CTA */}
          <div className="ow-fade-up ow-fade-up-4 mt-10 flex flex-wrap items-center gap-3">
            <button
              onClick={onContinue}
              className="inline-flex items-center gap-2 rounded-xl bg-white text-gray-900 px-5 py-3 text-sm font-semibold shadow-lg hover:shadow-xl hover:bg-gray-100 transition-all"
            >
              Continue to dashboard <ArrowRight size={15} />
            </button>
            <Link
              to="/platform-chat"
              className="inline-flex items-center gap-2 rounded-xl border border-white/30 px-5 py-3 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
            >
              <MessageCircle size={15} /> Say hi to Rahul
            </Link>
            <span className="text-xs text-white/50">
              You can dismiss this any time with the × in the corner.
            </span>
          </div>
        </div>

        {/* Building icon watermark — subtle */}
        <Building2 size={220} className="pointer-events-none absolute -bottom-6 -right-6 text-white/[0.04]" />
      </div>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
function StatCard({ Icon, label, value, valueText, hint }) {
  const shown = valueText ?? (value === null || value === undefined ? '—' : value);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md px-4 py-4">
      <div className="flex items-center gap-2 text-white/70">
        <Icon size={14} />
        <p className="text-xs uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 text-3xl font-bold text-white leading-none">{shown}</p>
      {hint && <p className="mt-1 text-xs text-white/50">{hint}</p>}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars
function ActionCard({ to, Icon, title, desc }) {
  return (
    <Link
      to={to}
      className="group rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4 hover:bg-white/10 hover:border-white/25 transition-all"
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="rounded-lg bg-white/10 p-2 text-white group-hover:bg-white/20 transition-colors">
          <Icon size={15} />
        </div>
        <ArrowRight size={14} className="ml-auto text-white/40 group-hover:text-white/80 group-hover:translate-x-0.5 transition-all" />
      </div>
      <p className="font-semibold text-white text-sm leading-tight">{title}</p>
      <p className="mt-1 text-xs text-white/60 leading-snug">{desc}</p>
    </Link>
  );
}
