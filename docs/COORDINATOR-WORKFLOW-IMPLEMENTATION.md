# Coordinator Workflow Enhancement — Phase A Implementation Report

## Overview
This document details the complete implementation and hardening of **Feature A: Excuse Review After Attendance Confirmation** in the Arabic RTL Friday-sermon application for Awqaf 15 May and Al-Tebeen.

All modifications are strictly confined to Phase A requirements. Features B and C remain deferred for subsequent phases.

---

## 1. Summary of Changes

### 1.1 Backend & Database Architecture
- **Additive Table (`excuse_requests`)**:
  - Implemented in `worker/migrations/0005_excuse_requests.sql` and `worker/schema.sql`.
  - Columns: `id` (PK), `date`, `mosque_id`, `khatib_id`, `assignment_version`, `status` (`pending`, `accepted`, `rejected`), `notes`, `created_at`, `reviewed_by`, `reviewed_at`.
  - Indexes:
    - Normal indexes on `(date, mosque_id)`, `(khatib_id)`, and `(status)`.
    - Partial unique index: `CREATE UNIQUE INDEX idx_excuse_requests_pending ON excuse_requests(date, mosque_id, khatib_id) WHERE status = 'pending';` to enforce that no khatib can have multiple simultaneous pending excuse requests for the same date and mosque.
- **Backend Endpoints (`worker/src/index.js`)**:
  - Registered `listExcuseRequests` (coordinator/admin access).
  - Registered `reviewExcuseRequest` (coordinator/admin access).
- **Excuse Review & Atomic CAS Execution (`worker/src/schedule.js`)**:
  - Implemented `reviewExcuseRequest_(db, user, b)`:
    - **Rejection**: Guarded by atomic CAS requiring that the assignment still matches the exact `mosque_id`, `khatib_id`, `status = 'confirmed'`, and `updated_at = assignment_version`. If reassigned or modified, returns explicit `STALE_REQUEST` conflict error (`code: 'STALE_REQUEST'`).
    - **Acceptance**: Employs an atomic D1 batch CAS operation where both the request status update and assignment status update (`confirmed` -> `excused`) require that the assignment still matches the exact `mosque_id`, `khatib_id`, `status = 'confirmed'`, and `updated_at = assignment_version`.
    - **Stale Request / Reassignment Conflict**: If the assignment was modified, reassigned to another khatib, or reset prior to coordinator review, the CAS changes zero rows and immediately returns a structured `STALE_REQUEST` error (`code: 'STALE_REQUEST'`), strictly preserving the replacement assignment, khatib readiness, and request records.
    - Concurrency & Double-Review Defense: If a request has already been reviewed by another coordinator, returns `ALREADY_REVIEWED`.
  - Extended `getSchedule_`:
    - Queries `excuse_requests` for the selected Friday.
    - Accurately correlates pending requests by exact assignment key: `${mosqueId}_${khatibId}_${assignmentVersion}`. Stale, replaced, or historical rows never show or enable actions on obsolete requests.
    - Injects `hasPendingExcuse` (boolean) and `pendingExcuseRequestId` into row payloads.
- **Khatib Portal Logic (`worker/src/khatib-portal.js`)**:
  - **Idempotent Confirmation**:
    - Confirming an already-confirmed assignment does NOT advance `updated_at` (preserving assignment version and avoiding silent invalidation of existing pending or rejected requests).
  - **Atomic CAS Guard on Every Assignment Reply**:
    - Initial excuse and confirmation transitions guard every `UPDATE assignments` by exact `id`, `khatib_id`, `status`, and `updated_at`.
    - Returns explicit `CONFLICT` error on zero matches, preventing delayed initial-excuse requests from bypassing review if confirmed concurrently, and preventing delayed confirmations from undoing an accepted excuse.
    - `khatib_readiness` synchronizes strictly within the same atomic batch ONLY when the guarded assignment update actually succeeds.
  - **Atomic Pending Creation (`INSERT SELECT ... WHERE EXISTS`)**:
    - Pending excuse creation requires that a matching confirmed assignment with the exact version currently exists. Returns explicit `CONFLICT` on zero matches.
    - Idempotent upsert via `ON CONFLICT(date, mosque_id, khatib_id) WHERE status = 'pending' DO UPDATE SET assignment_version = excluded.assignment_version, notes = ..., created_at = ...` guarantees version alignment across repeated submissions.
  - **Atomic Readiness-Only Route Guards**:
    - `responseType: 'readiness'` uses SQL `WHERE NOT EXISTS` conditions to atomically block excusing readiness when an active confirmed assignment exists, and blocks self-readying when an accepted excuse cycle is active.
  - **Self-Reconfirmation Prevention & Coordinator Reset Lifecycle**:
    - An accepted excuse blocks self-reconfirmation in the portal for that specific reviewed cycle (`FORBIDDEN`).
    - Once the coordinator explicitly resets the assignment to unassigned or replaces/reassigns the khatib, `updated_at` advances, permitting fresh confirmation.

### 1.2 Frontend Enhancements
- **Schedule Management (`schedule.html`)**:
  - Displays a red badge `طلب اعتذار قيد المراجعة` on any confirmed assignment row with an active pending excuse request.
  - Adds direct inline `قبول الاعتذار` (green) and `رفض الاعتذار` (red) buttons for authorized coordinators.
  - Pending review banner counts **only** current matching `hasPendingExcuse` rows (never historical stale requests).
  - Safe Review Flow: Flushes pending autosaves (`flushAutosave()`), locks UI against double-submit during review execution, and reloads current date without losing state or causing race conditions.
- **Khatib Portal Interface (`khatib-portal.html`)**:
  - Warning modal informing khatibs with confirmed attendance that submitting an excuse requires coordinator review.
  - Displays pending review badge (`طلب اعتذارك قيد مراجعة المنسق`) while review is pending.
  - Displays rejection notice (`تم رفض طلب الاعتذار من قِبل إدارة الأوقاف؛ التكليف ما زال مؤكداً`).
  - Displays accepted excuse notice (`تم قبول اعتذارك عن الخطبة من قِبل إدارة الأوقاف؛ لم تعد مكلفاً بهذا المسجد`).
  - Disables attendance confirmation buttons when an accepted excuse cycle is active.

---

## 2. Modified & Created Files

| File | Type | Purpose |
|---|---|---|
| `worker/migrations/0005_excuse_requests.sql` | Created | Additive migration for `excuse_requests` table and partial index |
| `worker/schema.sql` | Modified | Added table 11 definition and indexes for fresh environments |
| `worker/src/index.js` | Modified | Registered `listExcuseRequests` and `reviewExcuseRequest` actions |
| `worker/src/schedule.js` | Modified | Atomic CAS review logic (accept & reject), `STALE_REQUEST` conflict, row badge version matching |
| `worker/src/khatib-portal.js` | Modified | CAS assignment transitions, idempotent confirmation, atomic readiness guards, reset scoping |
| `schedule.html` | Modified | Coordinator UI: active pending banner count, pending badges, review buttons, autosave flush |
| `khatib-portal.html` | Modified | Khatib UI: pending/reviewed notices, confirmation modals, action locks |
| `worker/test/run.mjs` | Modified | Integration tests for full review workflow, race conditions, stale conflicts, legacy migration preservation, and deterministic barrier interleavings (Scenarios 15, 16, 17) |

---

## 3. Verification Gates Run & Results

1. **Frontend Assets Build**:
   ```bash
   node scripts/build-frontend.js
   ```
   *Result*: **PASS** (13 files copied to `dist/` and `dist/assets/`).

2. **Regional Frontend Navigation Tests**:
   ```bash
   node worker/test/frontend-regions.cjs
   ```
   *Result*: **PASS** (regional navigation, independent caches, public date URL).

3. **Khatib Portal Sessions Tests**:
   ```bash
   node worker/test/frontend-portal.cjs
   ```
   *Result*: **PASS** (independent portal sessions, regional API routing, logout/expiry isolation).

4. **Frontend Schedule Filter & State Tests**:
   ```bash
   node worker/test/frontend-schedule.cjs
   ```
   *Result*: **PASS** (status/search filters, pending assignment defaults, live filter updates).

5. **Portal Date Calculation Tests**:
   ```bash
   node worker/test/portal-date.mjs
   ```
   *Result*: **PASS** (Cairo time zone sermon dates, Friday rollover, and year boundary).

6. **Whitespace & Style Checks**:
   ```bash
   git diff --check
   ```
   *Result*: **PASS** (0 trailing whitespace warnings or errors).

7. **Backend Worker Integration Tests**:
   ```bash
   cmd.exe /c "cd worker && npm test"
   ```
   *Result*: **PASS** (**34 passed, 0 failed** across all integration test scenarios, including Scenarios 15, 16, and 17).

---

## 4. Unresolved Limitations & Boundary Constraints
- **Phase A Boundary**: No coordinator manual editing of weekly readiness, monthly availability, or report exports were added in this run (deferred to Phase B).
- **Hijri / Calendar UI**: Hijri calendar adjustments and special occasions deferred to Phase C.
- **Git State**: No commits, staging, or deployment operations were performed, preserving all work in the isolated worktree for independent orchestrator review.
