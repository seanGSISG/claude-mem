# Plan: Fix Fresh Install Timeout Issue

**Issue**: Fresh plugin installation fails with "operation was aborted" errors
**Date**: 2026-01-01
**Status**: Draft - Awaiting Approval

---

## Problem Statement

When claude-mem is freshly installed, the SessionStart hooks fail with timeout errors:

```
Plugin hook "bun worker-service.cjs start" failed to start: The operation was aborted.
Plugin hook "node context-hook.js" failed to start: The operation was aborted.
Plugin hook "node user-message-hook.js" failed to start: The operation was aborted.
```

This prevents the plugin from functioning on first use, requiring manual intervention to start the worker.

---

## Root Cause Analysis

### The Timeout Chain

```
Claude Code Plugin System
    │
    ▼
hooks.json (timeout: 15s for worker-service.cjs start)
    │
    ▼
worker-service.cjs start command
    │
    ├─► Spawns daemon process (fast, ~100ms)
    │
    └─► waitForHealth() polls /api/readiness (up to 30s)
            │
            ▼
        /api/readiness returns 503 until initializationCompleteFlag=true
            │
            ▼
        initializationCompleteFlag set ONLY after:
            1. cleanupOrphanedProcesses()
            2. ModeManager.loadMode()
            3. dbManager.initialize() ◄─── Can be slow on first run
            4. PendingMessageStore recovery
            5. SearchManager initialization
            6. MCP client connection ◄─── 5-minute timeout, slow on first run
```

### Key Files Involved

| File | Line | Issue |
|------|------|-------|
| `plugin/hooks/hooks.json` | 16, 37, 54, 70 | `timeout: 15` is insufficient |
| `src/services/worker-service.ts` | 158 | Uses `/api/readiness` not `/api/health` |
| `src/services/worker-service.ts` | 1943 | Waits 30s for "health" (actually readiness) |
| `src/shared/worker-utils.ts` | ~50 | `waitForWorker()` also uses readiness |

### Timing Analysis

| Operation | Typical Time | First Run Time |
|-----------|-------------|----------------|
| Spawn daemon | ~100ms | ~100ms |
| HTTP server bind | ~50ms | ~50ms |
| Database init | ~200ms | ~500ms (creates DB) |
| MCP connection | ~2s | ~10-30s (downloads deps) |
| **Total to readiness** | **~3s** | **~15-45s** |
| **Hook timeout** | **15s** | **15s** |

---

## Solution Design

### Design Principles

1. **Fail fast, succeed fast**: The `start` command should return as soon as the worker is accepting connections, not wait for full initialization
2. **Graceful degradation**: Hooks should work even if background services aren't ready
3. **Clear separation**: Distinguish between "running" (health) and "fully ready" (readiness)
4. **Backward compatibility**: Don't break existing behavior for users with running workers

### Proposed Changes

#### Change 1: Separate Health from Readiness in Start Command

**File**: `src/services/worker-service.ts`

Create two distinct functions:
- `waitForHealth()` - checks `/api/health` (port is listening)
- `waitForReadiness()` - checks `/api/readiness` (full initialization complete)

The `start` command should use `waitForHealth()` since its job is just to ensure the worker is running.

```typescript
// Current (problematic):
async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  // ...
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`); // ← Wrong endpoint
  // ...
}

// Proposed:
async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  // ...
  const response = await fetch(`http://127.0.0.1:${port}/api/health`); // ← Correct endpoint
  // ...
}

async function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  // ...
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
  // ...
}
```

#### Change 2: Update Hook Timeouts as Safety Margin

**File**: `plugin/hooks/hooks.json`

Increase timeouts for the worker start command to provide margin for slow systems:

```json
// Current:
"timeout": 15

// Proposed:
"timeout": 45
```

This is a safety margin; with Change 1, the command should return in <5s normally.

#### Change 3: Update Shared Worker Utils

**File**: `src/shared/worker-utils.ts`

The `waitForWorker()` function used by hooks should also be updated to distinguish health from readiness, with appropriate retry behavior.

```typescript
// Current behavior: waits for /api/readiness
// Proposed: Try health first, then readiness with graceful fallback
export async function waitForWorker(): Promise<void> {
  // First, ensure worker is running (health check)
  await waitForHealth();

  // Then, optionally wait for readiness with shorter timeout
  // If readiness times out, log warning but don't fail
  try {
    await waitForReadiness(5000); // 5s timeout
  } catch {
    logger.warn('WORKER', 'Worker running but not fully ready, proceeding anyway');
  }
}
```

#### Change 4: Add Startup Mode to Health Endpoint

**File**: `src/services/worker-service.ts`

Enhance `/api/health` to indicate initialization status without blocking:

```typescript
this.app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    initializing: !this.initializationCompleteFlag,  // ← Add this
    mcpReady: this.mcpReady,
    // ... existing fields
  });
});
```

This allows clients to know the worker is starting up without being blocked.

---

## Implementation Plan

### Phase 1: Core Fix (Minimal Change)

**Goal**: Fix the immediate timeout issue with minimal risk

1. **Update `waitForHealth()` endpoint** (worker-service.ts:158)
   - Change from `/api/readiness` to `/api/health`
   - Keep function name for backward compatibility

2. **Update hook timeouts** (hooks.json)
   - Change worker-service timeout from 15s to 45s

3. **Test on fresh install**

### Phase 2: Robust Implementation

**Goal**: Proper separation of concerns

1. **Rename `waitForHealth()` to `waitForRunning()`** for clarity
2. **Create new `waitForReadiness()` function** that checks `/api/readiness`
3. **Update all callers** to use appropriate function
4. **Update `isPortInUse()` to use `/api/health`** (currently uses readiness)
5. **Update shared worker-utils.ts** with new semantics

### Phase 3: Polish

**Goal**: Better user experience

1. **Add `initializing` field to health response**
2. **Update context-hook.js** to handle initializing state gracefully
3. **Add startup progress logging** visible to user
4. **Update documentation**

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/worker-service.ts` | Lines 145-166, 382-393 |
| `plugin/hooks/hooks.json` | Lines 16, 37, 54, 70 |
| `src/shared/worker-utils.ts` | `waitForWorker()` function |
| `src/hooks/context-hook.ts` | Handle initializing state |

---

## Testing Plan

### Manual Testing

1. **Fresh install simulation**:
   ```bash
   # Remove all claude-mem data
   rm -rf ~/.claude-mem
   rm -rf ~/.claude/plugins/marketplaces/thedotmack/node_modules
   rm ~/.claude/plugins/marketplaces/thedotmack/.install-version

   # Kill any running worker
   curl -X POST http://127.0.0.1:37777/api/admin/shutdown

   # Start new Claude Code session
   claude
   ```

2. **Verify worker starts successfully**:
   - Check no "operation was aborted" errors
   - Check `curl http://127.0.0.1:37777/api/health` returns 200
   - Check context injection works

3. **Verify subsequent sessions work normally**

### Automated Testing

Add test cases to verify:
- `waitForHealth()` returns true when port is listening but not ready
- `waitForReadiness()` returns false when initializing, true when ready
- Hook timeout is sufficient for slow initialization

---

## Rollback Plan

If issues arise:
1. Revert the endpoint change in `waitForHealth()`
2. Increase hook timeout to 120s as temporary workaround
3. Document manual worker start as fallback

---

## Success Criteria

- [ ] Fresh install completes without "operation was aborted" errors
- [ ] Worker starts within 5 seconds on normal systems
- [ ] Context injection works on first session
- [ ] No regression on systems with running worker
- [ ] Hook timeout provides adequate safety margin

---

## Open Questions

1. Should we add a visual indicator that the worker is still initializing?
2. Should context-hook.js wait for full readiness or proceed with partial functionality?
3. Is 45s timeout sufficient for very slow systems (old hardware, heavy load)?

---

## Approval

- [ ] Plan reviewed
- [ ] Implementation approach approved
- [ ] Ready to proceed with Phase 1
