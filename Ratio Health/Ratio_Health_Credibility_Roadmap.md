# Ratio Health — Credibility & Licensing Roadmap

**For:** Rahul / Ratio
**Goal:** Take Ratio from a tutoring-centre scheduler (ratiosolved.com today) to a software Fraser Health can legally and politically procure.
**Date:** May 2026

---

## 1. Reality check — read this first

A few hard facts before you build anything:

**Fraser Health is already mid-rollout of a new scheduling system.** Their MySchedule Pro training is *paused* while the new system goes in, and they have a separate AI scheduling partnership with Deloitte (funded by a $1.5M Scale AI grant) being piloted at Eagle Ridge and Burnaby Hospitals. Translation: the front door for "replace the whole scheduling system" is closed for the next ~2–4 years. Anyone walking in cold with that pitch in 2026 gets ignored.

**That doesn't kill the plan — it changes the entry point.** Three viable wedges:

1. **Wedge A — Optimization layer.** Sit *on top of* the new system. Solve the things their core scheduler won't: vacancy fill, last-minute swaps, float pool optimization, fatigue/overtime prediction. Integrate via API.
2. **Wedge B — Department / site pilot.** Target a single hospital department where the new system is failing or hasn't rolled out (e.g. Mission Memorial — current public complaints about relief/float nurses). Prove ROI in one unit, expand.
3. **Wedge C — Adjacent authority first.** Vancouver Coastal, Island Health, or Interior Health. Less heat, less Deloitte. Use them as the case study, then come back to Fraser Health when their current rollout fails (it usually does).

My recommendation: **plan for Wedge A + C in parallel.** Wedge B is the long shot.

---

## 2. The compliance / licensing stack

There is no single "license" that makes you Fraser Health-ready. There's a stack. Get them in this order:

### Tier 1 — Non-negotiable (without these, no health authority will even take a meeting)

| Requirement | What it is | Why FH needs it | Rough cost / time |
|---|---|---|---|
| **Canadian data residency** | All PHI stored + accessed in Canada (AWS ca-central-1 or Azure Canada Central) | BC FOIPPA s.30.1 + post-2021 risk-based framework. PHI is sensitive → effectively must be in-Canada. | Architectural decision. ~$0 extra if you build right from day one. |
| **PIPEDA + BC PIPA compliance** | Federal + BC private-sector privacy laws | You're a third-party processor for a public body. You inherit the obligations. | Internal work + policies. ~$5–15K with a privacy lawyer. |
| **Privacy Impact Assessment (PIA)** | Mandatory under FOIPPA s.69(5) before any BC public body adopts your software | FH literally cannot procure you without one. | $15–40K, 2–4 months. Vendor usually supports the buyer's PIA. |
| **Security Threat & Risk Assessment (STRA)** | Independent security audit producing a "Statement of Acceptable Risk" | Same — required for procurement. | $25–60K, 2–3 months. |

### Tier 2 — Strong differentiator (gets you shortlisted)

| Requirement | What it is | Cost / time |
|---|---|---|
| **SOC 2 Type II** | North American security audit. Table stakes for any serious B2B SaaS. | $30–80K + ~6 mo readiness + 6 mo observation window. ~12 mo total. |
| **ISO 27001** | International infosec management standard. Adds credibility outside NA. | $40–100K, 9–12 mo. Often bundled with SOC 2. |
| **ISO 27799** | Health-specific extension of 27001 — controls for PHI. | Incremental on top of 27001. ~$15–30K. |

### Tier 3 — Only if you go cross-border later

- **HIPAA** — only matters if you ever touch US PHI. Skip for now.

### What this actually costs you in Year 1 if you're serious

Bare minimum to be "procurable" by a BC health authority: **PIPA/PIPEDA + Canadian hosting + a Privacy Impact Assessment you can hand over + SOC 2 Type II in progress.** Budget roughly **$60–120K** and **9–14 months** to get to that posture. ISO 27001/27799 stack on top adds another ~$60K and 6 months.

---

## 3. Union + credential constraints (these shape the product)

Fraser Health staff are mostly unionized under HEABC collective agreements (Nurses' Bargaining Association, Facilities, Community). Any scheduling product that ignores these will be rejected at the staff level — and unions can kill rollouts.

What your product must respect from day one:

- **Seniority-based assignment.** NBA Article 25. Shifts, OT, and vacancy fill go down a seniority list. Your auto-scheduler must rank by seniority, not just optimization score.
- **Master seniority lists.** Postable, exportable. Casual seniority capped at 1,950 hrs/yr.
- **Flexible Hours / Self-Scheduling.** Article 25 explicitly allows self-scheduling but inside collective agreement guardrails. Build this in.
- **Internal Schedule Change process.** Defined notice periods + grievance trail. Audit log everything.
- **Credential verification.** Nurses (BCCNM), physicians (CPSBC), care aides (BC Care Aide Registry). Your system needs to refuse to schedule someone whose credential is expired. Pull from / sync with the registries.

If you build these four things into Ratio Health from the start, you're already differentiated from generic UKG/Kronos deployments that bolt this on poorly.

---

## 4. Product gap — where Ratio is today vs. where Ratio Health needs to be

Your live site (ratiosolved.com) positions Ratio explicitly as "Smart Scheduling for Tutoring Centres." That's correct for Stage 1 — but it's also the first thing a Fraser Health procurement officer would Google, and it kills you instantly.

You need a **second, parallel brand surface** the day you start pitching healthcare: `ratiohealth.ca` (or a subdomain `health.ratiosolved.com`) with healthcare-specific copy, case studies (even pilot ones), the compliance posture page, and zero mentions of math tutoring.

Don't take down the tutoring site. It's revenue and proof you can ship. Just don't let it be the only public face.

Product gaps to close before a health pilot:

- Single-tenant or dedicated-tenant deployment option (some authorities require it)
- Full audit logging (every schedule change, every login, every export)
- Role-based access control with fine-grained permissions
- SSO via SAML / Azure AD (every authority uses this)
- API + HL7/FHIR awareness (you don't need to be a clinical system, but you'll need to exchange staff/credential data)
- Encryption at rest + in transit (table stakes, but document it)
- Backup, DR, RTO/RPO commitments documented for the STRA

---

## 5. Procurement path — how you actually get bought

Fraser Health buys through two channels:

1. **BC Bid** (`bcbid.gov.bc.ca`) — the central BC government marketplace. Register here first.
2. **Fraser Health's own Bids and Tenders portal** (`fraserhealth.bidsandtenders.ca`). Register here second.

Both are passive — you wait for RFPs. To get *invited* into RFPs (or to get a sole-source pilot under the procurement threshold, usually <$75K), you need relationships. The actual sales motion:

1. Get into BC Bid + FH portal (free, 1 week).
2. Find the **Workforce / HR / IT** decision makers at FH and adjacent authorities. Titles: VP HR (you saw Ken Casorso quoted publicly), CIO, Director of Workforce Planning, Manager of Staffing.
3. Pilot under procurement threshold first. A sub-$75K pilot in one department avoids the full RFP gauntlet and gives you the case study.
4. *Then* respond to RFPs with the case study + compliance posture in hand.

---

## 6. 12–18 month sequenced playbook

### Months 0–3 — Foundation (do these now, in parallel with Stage 1 revenue work)
- Spin up `ratiohealth.ca` landing page. Bare-bones is fine. Just claim the surface.
- Move (or confirm) hosting in AWS `ca-central-1` or Azure Canada Central. Document it.
- Hire / contract a Canadian privacy lawyer. Draft PIPEDA + BC PIPA policies, DPAs, sub-processor list.
- Register on BC Bid + FH Bids and Tenders portal.
- Build the four union-aware features (seniority ranking, master list, self-schedule with guardrails, audit log).

### Months 3–9 — Credibility build
- Start SOC 2 Type II readiness with a firm like Vanta, Drata, or Secureframe (~$15K/yr tooling). Pick one auditor.
- Build credential-verification integration (BCCNM + Care Aide Registry to start).
- Add SSO (SAML), RBAC, full audit logging.
- Write your own **template PIA** that you can hand to any BC public body to accelerate their PIA process. This is a massive deal-accelerator.
- Identify 1–2 friendly contacts inside an adjacent BC authority (Island Health is generally more approachable than FH for newcomers).

### Months 9–14 — First healthcare pilot
- Target a sub-threshold pilot ($25–75K) at a single site or department. Use Island Health or a Fraser Health long-term care site (less locked into the new core rollout).
- Complete first real PIA + STRA for the pilot.
- Close SOC 2 Type II observation window.
- Publish anonymized pilot results — vacancy fill time down X%, OT spend down Y%, manager hours saved Z.

### Months 14–18 — Fraser Health entry
- With SOC 2 Type II + a real PIA + a case study, you now have a credible RFP response.
- Approach Fraser Health on Wedge A (optimization layer on top of the new system) — much easier sell than replacement.
- Position the pitch around what their new system + Deloitte AI demonstrably won't handle: real-time vacancy fill, float pool optimization, fatigue/burnout prediction tied to OT data.

---

## 7. The honest risk list

- **The new FH rollout might succeed.** If it does, your wedge is "optimization layer," not replacement. Build accordingly.
- **Procurement cycles are 12–24 months.** Even with everything right, expect the first FH revenue ~18–24 months out. Stage 1 (tutoring) revenue has to fund this.
- **Compliance burn rate is real.** $60–120K Year 1, $30–60K/yr ongoing. Don't start the certification clock until you have a credible path to a paying pilot — otherwise you spend it and lose runway.
- **Unions can veto.** Even if FH leadership likes you, BCNU / HSA reps in a pilot unit can torpedo it. Build the union-aware features first; show them to the unions *before* the leadership pitch.

---

## 8. What I'd do this month

1. Buy `ratiohealth.ca`. Put up a one-page holding site with the compliance commitments listed.
2. Register on BC Bid + FH Bids and Tenders. Free, takes a week.
3. Move/confirm Canadian hosting. Write a one-page "Data Handling & Residency" public commitment.
4. Get a 1-hour consult with a BC privacy lawyer (~$500–800). Ask: what's the *minimum* documentation set to be PIA-ready.
5. Start scoping the union-aware features. Even if you don't ship them yet, having the spec ready means you can credibly say "we built this for HEABC environments" in any first meeting.

That's it for this month. Don't start a SOC 2 audit yet — wait until you've validated there's a real pilot conversation to close.

---

## Sources

- [Fraser Health — Business Opportunities](https://www.fraserhealth.ca/about-us/business-opportunities)
- [Fraser Health Bids and Tenders Portal](https://fraserhealth.bidsandtenders.ca/)
- [BC Bid](https://www.bcbid.gov.bc.ca/)
- [Fraser Health — Leveraging AI for Scheduling (Deloitte partnership)](https://www.fraserhealth.ca/news/2024/Sep/Leveraging-artificial-intelligence-to-assist-with-scheduling)
- [BC Gov — Privacy Impact Assessments](https://www2.gov.bc.ca/gov/content/governments/services-for-government/information-management-technology/privacy/privacy-impact-assessments)
- [BC Gov — Guidance on Disclosures Outside of Canada](https://www2.gov.bc.ca/gov/content/governments/services-for-government/information-management-technology/privacy/privacy-impact-assessments/guidance-on-disclosures-outside-of-canada)
- [HEABC — Nurses' Bargaining Association Collective Agreement 2022–2025](https://www.heabc.bc.ca/public/CAs/NBA/2022-2025_SummaryofChanges_NoInterps.pdf)
- [HEABC — 2019–2022 NBA Full CA](https://www.heabc.bc.ca/public/CAs/NBA/NBA2019-2022CA.pdf)
- [Office of the Privacy Commissioner — PIPEDA vs. BC PIPA](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_26/)
- [Dentons — BC Data Residency Requirements](https://www.dentonsdata.com/british-columbia-modifies-data-residency-requirements-in-response-to-covid-19/)
- [Vanta — SOC 2 for Healthcare](https://www.vanta.com/resources/soc-2-compliance-for-healthcare)
- [Instant 27001 — ISO 27001 in Healthcare](https://instant27001.com/iso-27001-use-cases/iso-27001-in-healthcare/)
