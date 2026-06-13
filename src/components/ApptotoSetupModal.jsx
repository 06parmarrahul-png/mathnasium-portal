// Apptoto credentials setup modal — opens from the Connectors page when
// the user hits "Configure" on the Apptoto card. Walks them through
// finding the API key in their Apptoto account, tests the connection,
// and on success saves the creds + marks the vendor connected.

import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  getApptotoStatus, saveApptotoCredentials, clearApptotoCredentials,
  testApptotoConnection,
} from '../lib/integrations/apptoto';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { X, CheckCircle2, AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';

export default function ApptotoSetupModal({ open, onClose, onSaved }) {
  const { activeCenterId } = useAuth();
  const [email,  setEmail]  = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState({ configured: false });
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');
  const [ok,     setOk]     = useState(null); // null | success-message string

  // Load current saved state when the modal opens so we can show
  // "Connected as foo@bar.com" instead of an empty form.
  useEffect(() => {
    if (!open || !activeCenterId) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getApptotoStatus(activeCenterId);
        if (cancelled) return;
        setStatus(s);
        if (s.configured) setEmail(s.email);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, activeCenterId]);

  if (!open) return null;

  const handleTestAndSave = async () => {
    setError(''); setOk(null); setBusy(true);
    try {
      if (!email.trim() || !apiKey.trim()) {
        setError('Email and API key are both required.');
        return;
      }
      const r = await testApptotoConnection({
        centerId: activeCenterId, email: email.trim(), apiKey: apiKey.trim(),
      });
      if (!r.ok) {
        setError(r.error || 'Connection test failed.');
        return;
      }
      await saveApptotoCredentials(activeCenterId, { email, apiKey });
      // Flip the connector entry too so the Connectors grid shows the
      // green "Connected" pill and counters update.
      await setDoc(
        doc(db, 'centers', activeCenterId, 'connectors', 'apptoto'),
        { connected: true, updatedAt: new Date().toISOString() },
        { merge: true },
      );
      setOk(`Connected — pulled ${r.sampleEventCount} event${r.sampleEventCount === 1 ? '' : 's'} from the last 24h as a sanity check.`);
      setStatus({ configured: true, email });
      setApiKey('');
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setError(''); setBusy(true);
    try {
      await clearApptotoCredentials(activeCenterId);
      await setDoc(
        doc(db, 'centers', activeCenterId, 'connectors', 'apptoto'),
        { connected: false, updatedAt: new Date().toISOString() },
        { merge: true },
      );
      setStatus({ configured: false });
      setEmail(''); setApiKey(''); setOk(null);
      onSaved?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onClose()}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">Connect Apptoto</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pull intake meetings & assessment appointments into Ratio.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {status.configured && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 size={16} /> Connected as <span className="font-mono">{status.email}</span>
              </div>
              <p className="mt-1 text-xs text-emerald-800/80">Enter a new API key below to rotate, or disconnect.</p>
            </div>
          )}

          <ol className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600 space-y-1.5 list-decimal list-inside">
            <li>Sign in to <a href="https://www.apptoto.com/" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">Apptoto <ExternalLink size={10}/></a>.</li>
            <li>Open <strong>Settings → Integrations → API</strong>.</li>
            <li>Copy the API key shown there and paste it below.</li>
          </ol>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Apptoto account email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@yourcentre.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              disabled={busy}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="paste here — we'll Basic-auth with this"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-purple-500 focus:outline-none"
              disabled={busy}
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Stored encrypted at rest in Firestore. Never sent to the browser after save — the server proxies calls.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
          {ok && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 flex items-start gap-1.5">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> <span>{ok}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-3 bg-gray-50 rounded-b-2xl">
          {status.configured ? (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="text-xs font-medium text-rose-700 hover:underline disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : <span />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleTestAndSave}
              disabled={busy || !email.trim() || !apiKey.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Test &amp; save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
