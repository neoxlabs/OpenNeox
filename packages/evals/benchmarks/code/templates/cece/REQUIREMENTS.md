# Cece Pet Management System Requirements

## 1. Mission

Build Cece into a fuller pet-care management system benchmarked against mainstream pet-care platforms while preserving the current Express + EJS + SQLite architecture.

The product should move from a basic record-keeping app toward a practical pet-care hub for families: pet profiles, routines, reminders, health records, medical history, shared care, insights, and exportable records.

## 2. Research Sources

### 2.1 11pets

Observed public positioning and capabilities:

- Multi-pet care platform.
- 50+ pet-care features.
- Medical records, veterinary visits, vaccinations, weight and measurements.
- Reminders for medication, grooming, nail trimming, flea/tick medication, and other services.
- Family member sharing.
- Sharing selected pet data with professionals, including vets.
- Fine-grained data sharing by pet, recipient, data type, and time window.
- Cloud data access.

Product implication for Cece:

- Cece needs stronger routine scheduling, sharing, medical depth, grooming/medication reminders, and export/share flows.

### 2.2 PetDesk

Observed public positioning and capabilities:

- Veterinary engagement platform connecting clinics, veterinary teams, and pet parents.
- Reminders and texting.
- Online booking.
- Mobile app.
- Payments and deposits.
- Prescription refill requests.
- Forms.
- Client loyalty.
- PIMS integration.
- AI-powered SOAP notes for clinics.

Product implication for Cece:

- Cece should not copy clinic workflow wholesale, but should support owner-side appointment preparation, visit follow-up, prescription tracking, care-provider contacts, and shareable records.

### 2.3 Tractive / Whistle style trackers

Observed public positioning and capabilities:

- GPS tracking.
- Virtual fences and escape alerts.
- Health monitoring.
- Activity, sleep, vitals, scratch/bark monitoring depending on device.
- Early health alerts based on trends.
- Danger/risk reports in an area.
- Power-saving zones and device management.

Product implication for Cece:

- Cece can initially implement manual activity/health analytics and a device-ready data model without needing live hardware integration.

### 2.4 Current Repo Survey

Current stack:

- Express.
- EJS views.
- SQLite through better-sqlite3.
- Session auth.
- Multer uploads.
- Node cron reminders.

Current modules:

- Auth: register, login, logout.
- Pets: CRUD, profile photo upload, details.
- Walks: add/list/delete walk records.
- Feedings: add/list/delete feeding records.
- Health: vaccines, deworming, weight records, weight chart.
- Medical: vet visit records and medication records.
- Reminders: manual reminders, complete/delete, automatic reminders from vaccines/deworming/next visits.
- Dashboard: pet count, monthly walk/feed counts, pending reminders, recent activity, weight chart.

Current data tables:

- users.
- pets.
- walks.
- walk_schedules.
- feedings.
- feeding_schedules.
- vaccines.
- dewormings.
- weight_records.
- medical_records.
- medications.
- reminders.

Current strengths:

- Core pet-care record structure exists.
- Per-user ownership exists on most tables.
- Automatic health/medical reminders already exist.
- Dashboard already aggregates multiple modules.
- Upload pipeline exists for pet photos.

Current gaps:

- Schedule tables exist but have no UI/routes.
- No calendar view.
- No routine completion flow.
- No family sharing/collaboration.
- No provider/vet contacts.
- No attachments for medical/vaccine documents.
- No export/shareable pet record.
- No grooming module.
- No medication dose schedule beyond simple medication records.
- No searchable/filterable list experience.
- No pagination for growing records.
- No analytics beyond weight chart and simple counts.
- No device-ready activity/sleep/location model.
- No notification delivery beyond in-app reminders.
- No tests.

## 3. Product Principles

- Keep the app simple and useful for real pet owners.
- Ship complete vertical slices instead of broad unfinished scaffolding.
- Preserve existing architecture unless a feature truly requires deeper refactor.
- Protect user data by validating ownership for every pet-scoped action.
- Make records shareable and exportable, but avoid exposing private data by default.
- Treat reminders as first-class tasks, not just passive rows.
- Use manual entry first; leave integration hooks for GPS, vet systems, OCR, and notifications.

## 4. Capability Matrix

| Domain | Current Status | Target Status |
| --- | --- | --- |
| Pet profiles | Partial | Rich profile, photo, identity, microchip, insurance, vet, tags |
| Family sharing | Missing | Invite caregivers with per-pet permissions |
| Routine schedules | Schema only | Walk/feeding/grooming/medication schedules with due tasks |
| Calendar | Missing | Monthly/weekly/day view of care tasks and appointments |
| Reminders | Partial | Unified task center with overdue/today/upcoming, snooze, source links |
| Feeding | Partial | Records, schedules, food inventory, feeding analytics |
| Walk/activity | Partial | Records, schedules, goals, activity trends |
| Health | Partial | Weight, vaccines, deworming, measurements, trend alerts |
| Medical | Partial | Visits, medications, attachments, provider contacts, costs |
| Grooming | Missing | Bath, nail, brushing, grooming appointments and reminders |
| Documents | Missing | Upload vaccine certs, bills, prescriptions, lab reports |
| Search/filter | Missing | Date range, pet, type, status filters across modules |
| Export/share | Missing | Printable/shareable pet health summary and CSV export |
| Analytics | Partial | Care streaks, overdue risk, cost trend, weight trend, activity summary |
| Device readiness | Missing | Manual/device activity entries and future integration table |
| Notifications | Partial | In-app now; extensible email/webhook later |
| Operations | Partial | Better startup, seed data, tests, validation, pagination |

## 5. Detailed Requirements

### 5.1 Pet Profiles

Must support:

- Name, species, breed, gender, birth date, weight, notes, photo.
- Microchip number.
- color/markings.
- neutered/spayed status.
- allergies.
- insurance provider and policy number.
- primary vet/clinic linkage.
- active/inactive status.

Acceptance:

- A user can create, edit, view, and delete their own pets.
- A user cannot reference another user's pet from any route.
- Pet detail page shows care summary and recent activity.

### 5.2 Contacts and Providers

Must support:

- Vets and clinics.
- Groomers.
- Sitters/walkers.
- Emergency contacts.
- Phone, email, address, notes.
- Optional association with one or more pets.

Acceptance:

- A user can add a vet and select it from medical records.
- Pet profile can show primary vet contact.

### 5.3 Routine Schedules

Must support:

- Walk schedules.
- Feeding schedules.
- Medication schedules.
- Grooming schedules.
- Recurrence by days of week.
- Time of day.
- Active/inactive toggle.
- Automatic reminder/task generation.

Acceptance:

- A user can create a daily feeding schedule.
- The system can show today's due routine tasks.
- Completing a scheduled routine can optionally create a record.

### 5.4 Unified Calendar

Must support:

- Month/week/day calendar view.
- Events from reminders, schedules, vaccines, deworming, medical next visits, medications, grooming.
- Filters by pet and event type.
- Overdue/today/upcoming visual states.

Acceptance:

- A user can see all pet care events for the current month.
- Clicking an event navigates to the source record or task.

### 5.5 Reminder and Task Center

Must support:

- Manual reminders.
- Auto reminders from health, medical, medication, grooming, feeding, and walk schedules.
- Today, overdue, upcoming, completed sections.
- Complete, snooze, delete.
- Source module metadata.
- Reminder severity/priority.

Acceptance:

- A generated vaccine reminder links back to the vaccine record.
- A user can snooze a reminder to a new date.
- Dashboard count reflects pending overdue and today tasks.

### 5.6 Feeding Management

Must support:

- Feeding records.
- Feeding schedules.
- Food brand/type/portion.
- Optional calories.
- Food inventory and reorder reminder as future enhancement.
- Trends by pet and week.

Acceptance:

- A feeding schedule appears in the calendar and reminder center.
- Feeding records can be filtered by pet/date.

### 5.7 Walk and Activity Management

Must support:

- Walk records.
- Walk schedules.
- Duration, distance, route, mood.
- Daily/weekly activity goals.
- Activity trend chart.
- Device-ready activity entries for future tracker imports.

Acceptance:

- A weekly walk summary shows count, duration, and distance by pet.
- A missed scheduled walk can appear as overdue.

### 5.8 Health Management

Must support:

- Vaccines.
- Deworming.
- Weight records.
- Additional measurements: body condition score, temperature, heart rate, sleep hours, activity minutes.
- Trend analysis and simple alert flags.

Acceptance:

- Weight trend remains visible.
- Health metrics can be recorded per pet and date.
- Abnormal weight change can be highlighted.

### 5.9 Medical Management

Must support:

- Vet visits.
- Diagnosis and treatment.
- Cost.
- Next visit.
- Provider link.
- Medications.
- Medication dosage schedule.
- Attachments for prescriptions, bills, lab reports.

Acceptance:

- A medical visit can include an attachment.
- A medication can generate recurring dose reminders.
- Medical costs can be summarized by month.

### 5.10 Grooming Management

Must support:

- Baths.
- Nail trimming.
- Brushing.
- Haircuts.
- Ear cleaning.
- Grooming appointment records.
- Grooming reminders.

Acceptance:

- A user can add a grooming record.
- Grooming due dates appear in reminders and calendar.

### 5.11 Documents and Attachments

Must support:

- Upload files for pets, vaccines, deworming, medical visits, medications, grooming, and insurance.
- Store original filename, mime type, size, module, record id, upload date.
- Download/view/delete own attachments.
- File type and size validation.

Acceptance:

- A user can upload a vaccine certificate and see it on the pet detail page.
- A user cannot access another user's attachment.

### 5.12 Search, Filters, and Pagination

Must support:

- Pet filter.
- Date range filter.
- Type/status filter.
- Keyword search where useful.
- Pagination for growing lists.

Acceptance:

- Walks, feedings, health records, medical records, reminders can be filtered by pet/date.
- Large lists do not render unbounded results.

### 5.13 Dashboard and Insights

Must support:

- Current pet count.
- Due/overdue tasks.
- Recent activity.
- Weight chart.
- Walk/feeding summary.
- Medical cost summary.
- Health risk cards.
- Care streak/consistency indicators.

Acceptance:

- Dashboard gives next actionable tasks first.
- Dashboard shows at least one insight beyond raw counts.

### 5.14 Sharing and Collaboration

Must support:

- Invite family/caregiver by email or username.
- Per-pet access.
- Permission levels: view, add records, manage pet.
- Expiring share links for vets as future enhancement.

Acceptance:

- A caregiver can view a shared pet but cannot access unshared pets.
- Owner can revoke sharing.

### 5.15 Export and Shareable Records

Must support:

- Printable pet health summary.
- CSV export for records.
- Medical packet export for vet visits.
- Date range and pet filters.

Acceptance:

- A user can export a pet's vaccination and medical history.
- Export only includes the user's accessible data.

### 5.16 Device and Integration Readiness

Must support initially:

- Tables/routes ready for imported activity metrics.
- Manual activity metrics input.
- Integration source field.

Future integrations:

- GPS tracker imports.
- Email notifications.
- Calendar .ics export.
- Vet platform integration.
- OCR for medical bills/prescriptions.

Acceptance:

- Manual device-style activity data can power trends without external hardware.

### 5.17 Security and Data Protection

Must support:

- Ownership checks on every pet-scoped create/update/delete/read.
- Session hardening for production.
- Upload validation.
- Private-by-default records.
- No accidental public file listing.

Acceptance:

- Cross-user pet IDs cannot be used in any write route.
- Uploaded attachments cannot bypass ownership checks.

### 5.18 Quality and Operations

Must support:

- Seed data for demo use.
- Smoke tests for key routes.
- Basic model tests where feasible.
- Startup without port conflicts in docs.
- Clear README.
- Database schema evolution notes.

Acceptance:

- `node --check` passes.
- Main app starts on a configurable `PORT`.
- A demo user can exercise pet -> schedule -> reminder -> dashboard flow.

## 6. Prioritized Delivery Plan

### P0: Stabilize Existing System

- Ensure upload directories exist.
- Enforce ownership checks for pet-scoped routes.
- Fix startup and route issues.
- Add README basics.

### P1: Routine Schedules and Task Center

- Implement walk schedule CRUD.
- Implement feeding schedule CRUD.
- Generate due reminders/tasks.
- Add today/overdue/upcoming reminder grouping.

### P2: Calendar and Pet Timeline

- Add calendar view.
- Add per-pet timeline combining walks, feedings, health, medical, reminders.
- Add filters.

### P3: Medical Depth and Attachments

- Add providers.
- Link providers to medical records.
- Add attachment metadata and upload/download/delete.
- Add medication dose schedules.

### P4: Grooming and Expanded Care

- Add grooming records.
- Add grooming schedules/reminders.
- Add common care templates.

### P5: Analytics and Insights

- Add feeding/walk summaries.
- Add medical cost summaries.
- Add health metric trend warnings.
- Improve dashboard to action-first layout.

### P6: Sharing and Export

- Add caregiver sharing.
- Add printable pet profile/medical summary.
- Add CSV exports.

### P7: Device Readiness and Integrations

- Add activity metric table.
- Add manual activity entry.
- Add integration source fields.
- Add future hooks for trackers and notifications.

## 7. First Execution Recommendation

Start with P1 because schedule tables already exist but are unused. This gives the biggest product lift with the smallest architecture risk:

1. Add schedule model methods for walks/feedings.
2. Add schedule routes and pages.
3. Surface scheduled items on reminders/dashboard.
4. Verify with browser flow.

This directly benchmarks mainstream apps that emphasize routines, reminders, and owner peace of mind.

## 8. 2026 Production Upgrade Research Addendum

### 8.1 Evidence and Benchmarks

Research completed against 11pets, PetDesk, Express production security guidance, and OWASP ASVS 5.0. The product benchmark emphasizes multi-pet records, recurring care, medication and exercise reminders, appointments and refill requests, family sharing, exportable health data, and owner peace of mind. The engineering benchmark requires TLS, secure cookies, non-default session naming, production session storage, Helmet security headers, brute-force protection, strict input handling, dependency hygiene, and explicit verification of authorization, uploads, sessions, and sensitive data.

Current-repo evidence:

- Express 4 + EJS + better-sqlite3 is a viable modular-monolith base, but routes currently mix HTTP handling, validation, authorization, and orchestration.
- The default session secret, MemoryStore, permissive cookie defaults, GET logout, missing CSRF/rate limits/security headers, and inconsistent validation block production use.
- Pet ownership is common but not centralized; sharing can create relationships without a model-level ownership guarantee.
- Uploads live under the public tree and rely primarily on extension/MIME checks.
- Database changes are ad-hoc; there is no migration ledger, automated test suite, health endpoint, structured logging, container definition, or backup procedure.
- The existing interface is dominated by glass panels, cards, emoji, decorative particles, and a management-dashboard shell. It does not meet the requested editorial, photographic, non-card visual direction.

### 8.2 Target Architecture

Use a production-oriented modular monolith, not premature microservices:

- `app` factory separated from process startup so tests can instantiate the application without opening a port.
- Domain modules own routes/controllers, services, repositories, validators, and authorization policies.
- Shared platform modules provide config validation, database transactions, errors, logging, uploads, sessions, CSRF, pagination, and response helpers.
- Controllers remain thin; services define use cases and transaction boundaries; repositories contain parameterized persistence only.
- Versioned forward migrations replace runtime schema patching. SQLite remains supported for single-instance/simple deployment; PostgreSQL is the documented scale path.
- Scheduler runs as an independently switchable worker with idempotency and a single-runner lease.
- Graceful shutdown closes HTTP, scheduler, session, and database resources.

Architecture acceptance:

- No domain route performs direct cross-domain SQL.
- Authorization policy tests cover owner, permitted caregiver, read-only caregiver, unrelated user, and anonymous user.
- App startup, HTTP serving, and worker execution can run independently.
- Migrations are repeatable on empty and populated databases.

### 8.3 Security Baseline

- Validate required environment variables at startup; production must never use fallback secrets.
- Use Helmet with a tested CSP, disable fingerprinting, configure proxy trust explicitly, and require HTTPS in production.
- Use secure, HTTP-only, SameSite cookies, a non-default cookie name, session rotation after login, POST logout, inactivity expiry, and a production-capable persistent store.
- Protect every state-changing browser request with CSRF tokens; rate-limit login, registration, invite, upload, and export endpoints.
- Normalize and validate all request parameters with allowlists, bounded lengths, date/range checks, and generic authentication errors.
- Hash passwords with an explicit cost policy; support password change and session invalidation.
- Centralize object authorization and deny by default for every pet-scoped resource.
- Store private documents outside the public directory; verify magic bytes, size, extension, and decoded image validity; randomize storage keys and force safe download headers.
- Add structured, redacted audit events for authentication, sharing, export, document access, and destructive actions.
- Run dependency audit and secret scanning in CI; document disclosure and incident response basics.

Security acceptance:

- Cross-user ID substitution fails for every read/write/delete/export/download flow.
- CSRF, brute-force, session fixation, unsafe upload, open redirect, reflected content, and missing-secret checks have automated coverage.
- Logs contain no password, session ID, CSRF token, document content, or full sensitive request body.

### 8.4 Deployment and Operations

- Provide a multi-stage Dockerfile, `.dockerignore`, Compose development/production examples, `.env.example`, health/readiness endpoints, and persistent volume declarations.
- Run as a non-root user with a read-only application filesystem except explicit data/upload volumes.
- Add deterministic install, migrations-before-start, health checks, graceful termination, resource limits, and restart policy.
- Document reverse proxy TLS, trusted proxy count, domain/cookie settings, backups, restore drills, upgrades, rollback, and first-admin creation without a default production password.
- Provide CI gates for syntax, lint, tests, security checks, migration verification, and container build.
- Define RPO 24 hours and RTO 4 hours for the initial single-instance profile; verify restore from an automated backup.

### 8.5 Performance and Reliability

- Add indexes proven by list/filter/calendar/dashboard query patterns and inspect slow queries.
- Paginate unbounded lists; avoid per-row queries; cache only safe computed summaries.
- Compress text responses, fingerprint static assets, use immutable cache headers where appropriate, and keep HTML/private data uncached.
- Process uploaded photography into responsive AVIF/WebP/JPEG variants with width/height metadata, lazy loading, and explicit aspect ratios.
- Target p75 LCP <= 2.5s, CLS <= 0.1, INP <= 200ms on representative mobile hardware; honor reduced-motion and data-saving preferences.
- Scheduler and reminder generation must be idempotent; failures must not crash the web process.


## 9. Brand, Website, and Experience Requirements

### 9.1 Visual Direction

The brand is warm, energetic, trustworthy, and editorial: cute through behavior and photography, professional through typography, spacing, hierarchy, and restraint.

Required:

- No dashboard-wide card grids. Prefer open editorial sections, split layouts, full-bleed bands, ruled lists, tables, timelines, sticky context rails, and layered photography.
- No SVG illustration packs, pseudo-3D mascots, glossy 3D icons, generic AI gradients, glassmorphism, or decorative particle noise.
- Use licensed raster photography (AVIF/WebP/JPEG) featuring real pets, owners, walking, feeding, grooming, and veterinary care. Every asset needs source/license metadata, alt text, focal point, and responsive derivatives.
- Create a distinctive palette based on warm cream, ink, tomato/coral, grass, and sky accents with WCAG-compliant text contrast.
- Use expressive display typography paired with a highly readable body family, with local/system fallbacks and controlled font loading.
- Icons must be a consistent minimal line set delivered through CSS/font/raster where needed; emoji are content only, never the primary UI system.

### 9.2 Motion Direction

- Motion communicates continuity of care: photographic reveals, horizontal routine tracks, timeline progress, gentle marquee bands, route traces, counters, and purposeful page transitions.
- Use CSS and small progressive JavaScript enhancements; no 3D/WebGL dependency.
- Animations stop or simplify under `prefers-reduced-motion`; no interaction depends on animation.
- Avoid perpetual background motion, scroll hijacking, cursor replacement, and animation that delays task completion.
- Interaction feedback begins within 100ms; page transitions must not hide server/network latency.

### 9.3 Public Website

Create a public marketing experience separate from the authenticated application shell:

- Editorial home page with photographic hero, concise promise, product proof, core-care story, family collaboration, health-record portability, trust/security section, testimonials/demo proof, and strong registration CTA.
- Product/features page organized around care journeys rather than a module grid.
- Security/privacy page explaining data ownership, access, storage, export, deletion, and responsible disclosure.
- About/contact/help content with professional metadata, social preview images, structured data, sitemap, robots rules, canonical URLs, and accessible legal links.
- Logged-in users can move between public website and app without confusing navigation or duplicate login prompts.

### 9.4 Authenticated Application Experience

- Replace the generic dashboard shell with a responsive care workspace: compact global navigation, pet switcher, today stream, chronological care timeline, and contextual actions.
- Desktop uses editorial whitespace and optional sticky rails; mobile uses bottom-level primary navigation and touch-safe actions without shrinking desktop tables.
- Forms use progressive sections, clear units, inline validation, safe defaults, autosave only where conflict-safe, and explicit destructive confirmation.
- Empty, loading, success, error, offline, and permission-denied states are designed, not browser defaults.
- Every feature remains usable with keyboard, zoom at 200%, screen-reader landmarks, visible focus, and adequate target sizes.

### 9.5 Design and UX Acceptance

- Zero application pages rely on a repeated card grid as their primary information architecture.
- No SVG or 3D visual assets are introduced; photography licenses and attribution requirements are documented.
- Public home, authentication, dashboard, pet detail, calendar, records, forms, and mobile navigation pass visual review at 390px, 768px, 1280px, and 1536px.
- Automated accessibility scan has no critical/serious violations; manual keyboard and reduced-motion checks pass.
- Key flows require no more steps than the current system unless a security control justifies the change.

## 10. Product Gap Matrix

| Area | Mainstream expectation | Current state | Target outcome |
|---|---|---|---|
| Care continuity | Routines, reminders, visits, refills | Modules exist but are fragmented | One today stream and timeline |
| Collaboration | Family/professional sharing | Partial sharing with weak central policy | Permissioned, audited collaboration |
| Records | Portable health and vaccine history | CSV/report fragments | Print/PDF/CSV export with access controls |
| Trust | Privacy, secure sessions, safe uploads | Development defaults | ASVS-informed production baseline |
| Deployment | Repeatable hosted operation | Manual local start | Container, health checks, migrations, backup/restore |
| Reliability | Tested upgrades and observable failures | No automated tests/structured logs | CI gates, audit logs, graceful operation |
| Website | Clear product story and conversion | App-like landing page | Separate editorial marketing site |
| Visual system | Distinctive, accessible brand | Glass cards, emoji, particles | Photographic, non-card, warm professional system |
| Performance | Fast mobile experience | Unmeasured global assets/animation | Measured budgets and responsive media |
| Accessibility | Keyboard, semantics, reduced motion | Partial support | WCAG 2.2 AA-oriented acceptance |

## 11. Verification and Definition of Done

The target is complete only when all of the following have evidence:

- Requirements are traceable to implementation and automated/manual checks.
- Unit tests cover services/policies; integration tests cover auth, CSRF, ownership, sharing, uploads, exports, migrations, and scheduler idempotency.
- Browser E2E covers public registration, login/logout, pet creation, daily care, health/medical record, document access, caregiver collaboration, export, and account cleanup.
- Security headers, cookies, rate limits, authorization, upload handling, dependency audit, and secret behavior are verified in production mode.
- Container starts from a clean checkout, migrates an empty database, serves health/readiness, persists data, survives restart, and restores a backup.
- Responsive visual checks and accessibility checks pass for public and authenticated critical pages.
- Performance budgets are measured on a production build with representative photography and seed data.
- README and operations documentation allow a new operator to deploy, upgrade, back up, restore, and troubleshoot without undocumented steps.
- No known critical/high security defect, broken critical flow, or unexplained test failure remains.

## 12. Delivery Order

Execution proceeds foundation-first: baseline tests and config, security controls, modular boundaries and migrations, deployment/operations, brand system and media pipeline, public website, authenticated shell, domain journeys, performance/accessibility hardening, and final release verification. Existing usable features remain operational throughout incremental migration.

