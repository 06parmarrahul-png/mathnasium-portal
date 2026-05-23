/**
 * Mathnasium A+ — the tutoring brand mark, used in the sidebar header,
 * login page, and signup page. Kept here as the primary "Logo" because
 * those surfaces represent the centre's identity (Mathnasium Langley,
 * Mathnasium Chilliwack, etc.). The Ratio software brand mark lives in
 * RatioLogo.jsx and shows up only in Ratio-specific spots (Enterprise
 * profile avatar, Ratio welcome surfaces).
 */
export default function Logo({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="48" fill="#CE1126" />
      <text x="50" y="62" textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="42" fill="white">A</text>
      <text x="75" y="42" textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="22" fill="white">+</text>
    </svg>
  );
}
