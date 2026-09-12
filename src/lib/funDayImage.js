/**
 * funDayImage.js — the month's fun-day sheet, uploaded rather than typed.
 *
 * The centre already makes this calendar every month. Retyping thirty
 * activities into Ratio afterwards is the same work twice, which is how a
 * calendar stops being kept up to date — so the picture they already have
 * is the thing to upload.
 *
 * WHERE IT LIVES, AND WHY IN TWO PLACES
 *   The file goes to Storage under the uploader's OWN folder, which is the
 *   pattern profile pictures already use and the only one the Storage
 *   emulator can test.
 *
 *   Which file the centre SEES is a separate Firestore document —
 *   centers/{id}/funDayCalendars/{YYYY-MM} — gated on whoever runs the
 *   floor. So an instructor can put a file in their own folder and cannot
 *   make anybody look at it.
 *
 * A TYPED MONTH STILL WINS FOR TODAY. An image cannot answer "what is it
 * today" — it is a picture. Where somebody has also typed the days in, the
 * home page leads with today's activity and shows the sheet underneath.
 */

import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db, storage } from '../firebase';

export const MAX_BYTES = 8 * 1024 * 1024;

/** What the picker will take. A phone photo of the printed sheet counts. */
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,image/heif';

/** Why this file won't do, or null. */
export function rejectReason(file) {
  if (!file) return 'Pick an image first.';
  if (!/^image\//.test(file.type || '')) {
    return 'That needs to be an image — a screenshot or a photo of the sheet is fine.';
  }
  if (file.size > MAX_BYTES) {
    return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 8 MB.`;
  }
  return null;
}

const extOf = (file) => {
  const m = /\.([a-z0-9]+)$/i.exec(file?.name || '');
  if (m) return m[1].toLowerCase();
  return (file?.type || '').split('/')[1] || 'png';
};

/**
 * Put a month up.
 *
 * The stored filename carries the month AND a timestamp, so replacing a
 * month never overwrites the file that is currently on screen — the old
 * one keeps working right up until the new document is written.
 */
export async function uploadFunDayImage({ centerId, uid, month, file, uploadedBy }) {
  const problem = rejectReason(file);
  if (problem) throw new Error(problem);
  if (!centerId || !uid || !/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new Error('Missing the centre, the month, or who you are.');
  }

  const path = `centers/${centerId}/fun-days/${uid}/${month}-${Date.now()}.${extOf(file)}`;
  const dest = storageRef(storage, path);
  await uploadBytes(dest, file, { contentType: file.type, cacheControl: 'public,max-age=86400' });
  const imageUrl = await getDownloadURL(dest);

  await setDoc(doc(db, 'centers', centerId, 'funDayCalendars', month), {
    month,
    imageUrl,
    storagePath: path,
    uploadedBy: uploadedBy || null,
    uploadedAt: new Date().toISOString(),
  });

  return { imageUrl, storagePath: path };
}

/**
 * Take a month down.
 *
 * The document goes first. If the file delete then fails — someone else
 * uploaded it, storage hiccuped — the month is still down, which is what
 * was asked for. An orphaned file is tidier to leave than a calendar that
 * refused to come off the wall.
 */
export async function removeFunDayImage({ centerId, month, storagePath }) {
  await deleteDoc(doc(db, 'centers', centerId, 'funDayCalendars', month));
  if (storagePath) {
    try { await deleteObject(storageRef(storage, storagePath)); }
    catch { /* the month is down; the file is somebody's to sweep up */ }
  }
}
