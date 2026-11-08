# AutoML Streaming Prediction + Graph Grabber Implementation Plan

**Goal:** Stream CSV predictions with progress and add a browser graph digitizer tab.

**Architecture:** CSV parsing and prediction stay browser-local, processing one row at a time to avoid a full prediction request payload. Graph Grabber is a dependency-free canvas workflow: image load, axis calibration, click points, CSV export.

**Tech Stack:** Flask/Python, vanilla JS, Canvas API.

## Tasks

### Task 1: Streaming CSV prediction
- Modify `automl/automl.js`.
- Read CSV incrementally, submit one row per API call, update visible percentage, collect outputs for CSV download.
- Fail on first invalid row and name its row number.

### Task 2: Graph Grabber tab
- Create `grabber/grabber.js`, `grabber/grabber.css`.
- Modify `migas.html`, `shared/app.js`.
- Add image upload, two-point X/Y calibration, manual point collection, CSV export, clear/reset controls.

### Task 3: Verification and delivery
- Syntax-check JavaScript, test Flask import, package source as `.tar.gz`.

## Acceptance
- CSV prediction never sends all rows in one API request.
- Progress visibly reaches 100% or reports exact failed row.
- Grabber exports calibrated X/Y CSV from clicked chart points.
- Existing tabs remain functional.

## Self-review
- No backend config changes. No new Python or JS dependencies. Scope contains only approved features.
