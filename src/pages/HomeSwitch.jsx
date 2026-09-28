import { Component, Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { homeFor } from '../lib/homeFor';

const InstructorHome = lazy(() => import('./homes/InstructorHome'));
const LeadershipHome = lazy(() => import('./homes/LeadershipHome'));

/**
 * HomeSwitch — one of the two homes, with a floor under it.
 *
 * Which one is homeFor(): leadership run the centre, everyone else works
 * shifts, and they open the portal to ask different questions.
 *
 * WHY THE LOCAL BOUNDARY IS STILL HERE, NOW THERE IS NOTHING TO FALL BACK TO
 *   The app-wide ErrorBoundary in App.jsx replaces the ENTIRE UI with an
 *   error card — sidebar included. So without this, a render error on the
 *   home page would leave somebody with no navigation at all: no way to
 *   their shifts, the desk or the schedule, and nothing to do but wait for
 *   a deploy. It has already earned its keep once, catching a crash in the
 *   since-removed director board.
 *
 *   It used to catch that by dropping the person back onto the classic
 *   Home. The classic Home was deleted on 2026-09-28, so the fallback is
 *   now a plain card that says what happened and hands over the three
 *   links that answer most of why anybody opens Ratio. The rest of the
 *   portal is untouched and the sidebar survives, which is the whole
 *   point of catching it here rather than letting App.jsx have it.
 */
class HomeBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.which} home] failed to render:`, error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="mx-auto max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-5">
          <p className="text-sm font-semibold text-amber-900">
            Your home page didn&apos;t load.
          </p>
          <p className="mt-1 text-sm text-amber-900/80">
            Nothing is lost and the rest of Ratio is fine — it&apos;s just this page.
            Reloading usually sorts it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-amber-700 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-amber-800"
            >
              Reload
            </button>
            {/* The three questions that account for most visits. Without
                these somebody whose home is broken has a sidebar and no
                idea which of twenty links they wanted. */}
            {[
              { to: '/schedule', label: 'My schedule' },
              { to: '/desk', label: 'Management Desk' },
              { to: '/shift-board', label: 'Open shifts' },
            ].map(l => (
              <Link
                key={l.to}
                to={l.to}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-900 hover:bg-amber-100"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function HomeSwitch() {
  const auth = useAuth();
  const which = homeFor(auth);
  const Home = which === 'leadership' ? LeadershipHome : InstructorHome;

  return (
    <HomeBoundary which={which}>
      <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading…</div>}>
        <Home />
      </Suspense>
    </HomeBoundary>
  );
}
