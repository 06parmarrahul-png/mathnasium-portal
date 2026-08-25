import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, serverTimestamp,
  collection, doc, query, where, getDocs, deleteDoc, writeBatch,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyDRbIRAdA_3ndsbgBiCQia6uL1gHQx8Uv4",
  authDomain: "mathnasium-langley.firebaseapp.com",
  projectId: "mathnasium-langley",
  storageBucket: "mathnasium-langley.firebasestorage.app",
  messagingSenderId: "1007864315644",
  appId: "1:1007864315644:web:e67c4ed3fe4d083e30a179"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
// Storage is used for user-uploaded profile pictures. See storage.rules
// for the security policy (each user can only write their own
// profile-pictures/{uid}/* path).
export const storage = getStorage(app);
export { serverTimestamp };

// Owner-only escape hatch: expose Firestore + a few helpers on the
// window so admin one-off scripts (bulk cleanup, migrations, purges)
// can run from Chrome DevTools without needing the bundler. Nothing
// here bypasses Firestore rules — auth still applies — so it's safe.
if (typeof window !== 'undefined') {
  window.__ratio = {
    db, auth,
    fs: { collection, doc, query, where, getDocs, deleteDoc, writeBatch },
  };
}
