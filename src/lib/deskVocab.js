/**
 * deskVocab.js — the centre's own words.
 *
 * Every entry here was read off the 1,750 notes already written, not
 * imagined, and the counts are how many of those notes contain it. Four of
 * the definitions came from Vin directly, and two of them changed what a
 * note gets FILED as rather than merely what it is tagged with:
 *
 *   DWP is a Digital Workout Plan, NOT an assessment. 54 notes were in the
 *   wrong drawer, so "show me the assessment notes" returned the wrong half.
 *
 *   ECT is the Employee Competency Test — an applicant gate. It had no
 *   category at all and fell straight through.
 *
 * WOP and DWP are the same artefact in two media: the sheet a student signs
 * in and out on, with session notes beside their pages. They file together
 * and the label says which.
 */

/** One topic per note — the drawer it goes in. First match wins, so order matters. */
export const TOPICS = [
  // ORDER IS SPECIFICITY, AND IT IS LOAD-BEARING. First match wins, so the
  // terms only this centre uses come first: "new AFU family enrolled" is
  // both funding and enrolment, and AFU is the rarer, more informative
  // word — filing it as a plain enrolment loses the thing that made it
  // worth saying.
  { key: 'Funding',      re: /\bafus?\b|autism|funding|\biep\b|subsid/i },
  { key: 'Workout plan', re: /\bdwps?\b|\bwops?\b|workout plan/i },
  { key: 'Applicant',    re: /applicant|interview|teaching trial|resume|\bects?\b|competency/i },
  { key: 'Gift card',    re: /gift\s*cards?|giftcard|\bgcs?\b/i },
  { key: 'Care call',    re: /care call|check[- ]?in call/i },
  { key: 'Referral',     re: /referr/i },
  { key: 'Assessment',   re: /assessment|post[- ]?assess|learning plan/i },
  { key: 'Supplies',     re: /supplies|staples|one source|printer|toner/i },
  // The general three come last.
  { key: 'Billing',      re: /declin|payment|invoice|charge|billing|card on file|refund|e-?transfer/i },
  { key: 'Scheduling',   re: /reschedul|make[- ]?up|missed session|cancel|absent|\bholds?\b|pause/i },
  { key: 'Enrolment',    re: /enrol|enroll|new student|start date|withdraw|leaving/i },
];

/** Many labels per note — the terms you can filter the archive by. */
export const VOCAB = [
  { key: 'Workout plan · digital', re: /\bdwps?\b|digital workout/i },
  { key: 'Workout plan · paper',   re: /\bwops?\b|paper workout/i },
  { key: 'Autism funding',  re: /\bafus?\b|autism/i },
  { key: 'Competency test', re: /\bects?\b|competency test/i },
  { key: 'Radius',      re: /\bradius\b/i },
  { key: 'Ratio',       re: /\bratio\b/i },
  { key: 'Online',      re: /\bonline\b/i },
  { key: 'In-centre',   re: /\bin[- ]?cent(re|er)\b/i },
  { key: 'Hybrid',      re: /\bhybrid\b/i },
  { key: 'Hold',        re: /\bholds?\b/i },
  { key: 'Assessment',  re: /assessment|post[- ]?assess/i },
  { key: 'Trial',       re: /\btrial\b/i },
  { key: 'Prize',       re: /\bprize/i },
  { key: 'Sibling',     re: /siblings?\b/i },
  { key: 'E-transfer',  re: /e-?transfer/i },
  { key: 'Voicemail',   re: /\bvm\b|voicemail/i },
  { key: 'Instagram',   re: /\big\b|instagram/i },
  { key: 'IB prep',     re: /\bib\b/i },
  { key: 'Summer camp', re: /summer camp/i },
];

/**
 * A grown-up is being talked about, not only a child.
 *
 * 225 notes say "mom", 139 "parent", 80 "dad". Most of these notes are about
 * a conversation with a parent, so the student gets tagged AND the note gets
 * marked as being about the family.
 */
export const FAMILY_RE = /\bmom\b|\bmum\b|\bmother\b|\bdad\b|\bfather\b|\bparents?\b|guardian|grandma|grandpa|grandmother|grandfather/i;

export function topicOf(text) {
  return TOPICS.find(t => t.re.test(String(text || '')))?.key || null;
}

export function labelsOf(text) {
  const s = String(text || '');
  return VOCAB.filter(v => v.re.test(s)).map(v => v.key);
}

export function mentionsFamily(text) {
  return FAMILY_RE.test(String(text || ''));
}
