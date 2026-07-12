# Leaderboard form and analysis remain stale

## Symptoms

- A newly finalised result changes the aggregate leaderboard, but the recent-form dots and detailed points analysis still end at an earlier match.
- Example reported: Furkan's correct-outcome count remains 56 instead of 57.

## Root cause

Optimised leaderboard form and analysis render from the cached complete archive. The cache refreshes by querying finalised matches with `finalizedAt` newer than its cursor.

The browser `saveResult` path sets `finalizedAt`, but the Cloud Functions `finalizeMatchWithScore` path did not. Automatically collected results therefore could update `settings/leaderboard.totals` while being invisible to the cache delta query. Existing clients continued to render the older archived match list.

In addition, both finalisation paths only changed the aggregate document when at least one player earned points. A 0-point result had no cross-client refresh signal, so its form dots and analysis could remain stale for other users.

## Fix

1. Stamp every automatic finalisation with `finalizedAt`.
2. Write an `archiveVersion` update to the aggregate document for every finalisation, including 0-point results, so all clients request the archive delta.
3. Move the browser archive cache to a new key once, forcing a full archive load after deployment and repairing devices that cached the already-finalised match which lacked a timestamp.

## Verification

- `node --check app.js` passed.
- `node --check functions/index.js` passed.
- `git diff --check` passed.
- `npm.cmd run build` passed.
- Logic review: both manual and automatic finalisation write a cache-visible finalisation timestamp and emit an aggregate-document change. Existing v1 browser caches are bypassed once, so the previously timestamp-less result is included by the next full archive load.
