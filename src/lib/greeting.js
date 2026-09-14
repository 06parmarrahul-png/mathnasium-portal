/**
 * "Morning" / "Afternoon" / "Evening" — the one greeting both Homes use.
 * The classic Home said "Welcome back, Rahul!" and the new one "Morning,
 * Rahul"; a person switching between them met two voices.
 */
export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}
