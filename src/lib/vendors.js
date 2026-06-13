// Single source of truth for the Mathnasium-approved vendor catalog.
// Used by both:
//   - The public landing page (marketing — "Ratio integrates with the
//     tools you already use") and
//   - The in-app Connectors tab (operations — owners see which integrations
//     are live for their centre, what's coming, etc.).
//
// Status legend:
//   live    → integration is shipping and working end-to-end
//   beta    → working but limited (manual setup, opt-in)
//   soon    → actively being built, expected in the next release
//   planned → on the roadmap, no firm date
//
// Add / promote vendors here in ONE place; both surfaces auto-update.

export const VENDOR_STATUS = {
  live:    { label: 'Live',         color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  beta:    { label: 'Beta',         color: 'bg-blue-100 text-blue-800 border-blue-200' },
  soon:    { label: 'Coming Soon',  color: 'bg-amber-100 text-amber-800 border-amber-200' },
  planned: { label: 'Planned',      color: 'bg-gray-100 text-gray-700 border-gray-200' },
};

export const VENDOR_CATEGORIES = [
  {
    id: 'scheduling',
    title: 'Scheduling & Bookings',
    blurb: 'The student appointment pipeline — pulled into Ratio\'s daily ops dashboard.',
    vendors: [
      { name: 'Acuity Scheduling', status: 'live',    note: 'iCal feed; appointment auto-categorization' },
      { name: 'Radius / Guardian Portal', status: 'soon', note: 'Direct integration with Mathnasium\'s new platform' },
      { name: 'Appointy',    status: 'planned' },
      { name: 'Apptoto',     status: 'live',    note: 'Pulls intake & assessment meetings into the Centre Analytics dashboard.' },
    ],
  },
  {
    id: 'tracker',
    title: 'Student Tracker',
    blurb: 'Your Mathnasium Student Assessment Tracker spreadsheet — Ratio reads it natively.',
    vendors: [
      { name: 'Student Assessment Tracker CSV', status: 'live', note: 'Section-header categorization, binder assessment detection' },
      { name: 'Google Sheets sync', status: 'soon', note: 'Live sync, no manual re-import' },
    ],
  },
  {
    id: 'hiring',
    title: 'Hiring & Recruiting',
    blurb: 'Job posts, applicants, and offer letters — wired into Ratio so new instructors auto-appear in your staff pool.',
    vendors: [
      { name: 'CareerPlug',   status: 'soon',    note: 'New-hire auto-creates Ratio user' },
      { name: 'Indeed',       status: 'planned' },
      { name: 'ZipRecruiter', status: 'planned' },
      { name: 'Workstream',   status: 'planned' },
    ],
  },
  {
    id: 'background',
    title: 'Background Checks',
    blurb: 'Approve a new instructor only after their background check clears — Ratio gates staff status on the check result.',
    vendors: [
      { name: 'Checkr',                         status: 'planned' },
      { name: 'First Advantage',                status: 'planned' },
      { name: 'Shield Screening',               status: 'planned' },
      { name: 'Universal Background Screening', status: 'planned' },
      { name: 'IntelliCorp',                    status: 'planned' },
    ],
  },
  {
    id: 'payroll',
    title: 'Payroll & Accounting',
    blurb: 'Hours from Ratio shift check-ins flow straight into payroll and your accounting system.',
    vendors: [
      { name: 'Intuit QuickBooks', status: 'soon',    note: 'Hours → invoices, expenses sync' },
      { name: 'Paylocity',         status: 'planned', note: 'Direct payroll feed' },
      { name: 'ZeeWise',           status: 'planned', note: 'Accounting & reporting' },
    ],
  },
  {
    id: 'reviews',
    title: 'Reviews & Marketing',
    blurb: 'Parent reviews collected automatically after each session, plus the marketing tools you already use.',
    vendors: [
      { name: 'Listen360',        status: 'soon',    note: 'Auto-trigger NPS after check-in' },
      { name: 'Peachjar',         status: 'planned' },
      { name: 'LOCALACT',         status: 'planned' },
      { name: 'Members Today',    status: 'planned' },
      { name: 'The Pixel Factory',status: 'planned' },
      { name: 'Wild Impact',      status: 'planned' },
      { name: 'Kessler Creative', status: 'planned' },
      { name: 'Fishman PR',       status: 'planned' },
    ],
  },
  {
    id: 'communication',
    title: 'Communication & Call Handling',
    blurb: 'Missed calls, parent messages, and phone trees — surfaced in Ratio so nothing slips.',
    vendors: [
      { name: 'AnswerForce',                              status: 'planned' },
      { name: 'MC3 — Mathnasium Customer Connection',    status: 'planned' },
      { name: 'Telus Business Connect',                   status: 'planned' },
      { name: 'Verizon Business',                         status: 'planned' },
    ],
  },
  {
    id: 'insurance',
    title: 'Insurance & Legal',
    blurb: 'Direct links to your approved insurance and legal partners.',
    vendors: [
      { name: 'Academy Benefits Insurance', status: 'planned' },
      { name: 'Accolade',                   status: 'planned' },
      { name: 'Intermarket Insurance',      status: 'planned' },
      { name: 'LegalZoom',                  status: 'planned' },
      { name: 'Slater & Associates',        status: 'planned' },
      { name: 'The Insurance Market',       status: 'planned' },
    ],
  },
  {
    id: 'supplies',
    title: 'Supplies & Tech',
    blurb: 'Reorder office supplies, hardware, and centre essentials with one click.',
    vendors: [
      { name: 'Amazon Business — US',     status: 'planned' },
      { name: 'Amazon Business — Canada', status: 'planned' },
      { name: 'Bulk Office Supplies',     status: 'planned' },
      { name: 'Dell',                     status: 'planned' },
      { name: 'IKEA — US',                status: 'planned' },
      { name: 'IKEA — Canada',            status: 'planned' },
      { name: 'Lakeshore',                status: 'planned' },
      { name: 'Oriental Trading Co.',     status: 'planned' },
      { name: 'Staples Business Advantage', status: 'planned' },
      { name: 'Staples Professional',     status: 'planned' },
      { name: 'U.S. Toy Company',         status: 'planned' },
      { name: 'TaskRabbit',               status: 'planned' },
    ],
  },
  {
    id: 'apparel',
    title: 'Apparel & Branded Merch',
    blurb: 'Branded apparel, nametags, signage, and printing.',
    vendors: [
      { name: 'Entripy',                          status: 'planned' },
      { name: 'JF Branding',                      status: 'planned' },
      { name: 'Land\'s End Business Outfitters',  status: 'planned' },
      { name: 'Look Smart',                       status: 'planned' },
      { name: 'MathApparel.com',                  status: 'planned' },
      { name: 'Printing For Less',                status: 'planned' },
      { name: 'Quo',                              status: 'planned' },
      { name: 'Safeguard Marketing',              status: 'planned' },
      { name: 'Tag UR It! Nametags',              status: 'planned' },
      { name: 'VistaPrint',                       status: 'planned' },
    ],
  },
];

// Flat counts so we can advertise "X live, Y coming soon" up top.
export function vendorCounts() {
  const out = { live: 0, beta: 0, soon: 0, planned: 0, total: 0 };
  for (const cat of VENDOR_CATEGORIES) {
    for (const v of cat.vendors) {
      out[v.status] = (out[v.status] || 0) + 1;
      out.total++;
    }
  }
  return out;
}
