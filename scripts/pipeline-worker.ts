/**
 * scripts/pipeline-worker.ts — Persistent pipeline worker for Oracle Ubuntu VPS
 *
 * This script runs as a long-lived process that continuously polls the Supabase
 * pipeline_tasks queue and processes tasks one at a time.
 *
 * Behavior:
 *   - Stable worker ID based on hostname
 *   - Loop forever
 *   - Call processPipelineTaskBatch
 *   - Sleep 5 seconds if work processed
 *   - Sleep 30 seconds if no work
 *   - Handle SIGINT/SIGTERM gracefully
 *   - Log progress to stdout
 *   - Exit only on configuration errors
 *
 * Usage:
 *   npx tsx scripts/pipeline-worker.ts
 *   # or via package.json:
 *   npm run worker:pipeline
 *
 * PM2:
 *   pm2 start "npm run worker:pipeline" --name pipeline-worker
 */

// Load environment variables from .env.worker if available
import { config } from 'dotenv';
import { resolve } from 'path';

// Try loading .env.worker first, then .env.local, then .env
config({ path: resolve(process.cwd(), '.env.worker') });
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { processPipelineTaskBatch } from '../lib/pipeline-worker';
import { markStuckTasks } from '../lib/pipeline-queue';
import { markStuckPipelineRuns } from '../lib/pipeline-run-tracker';
import { optionalEnv, requiredEnv } from '../lib/env';

// ═══ Configuration ═══

const WORKER_ID = `oracle-worker-${require('os').hostname().slice(0, 20)}-${process.pid}`;
const MAX_TASKS_PER_BATCH = 5;
const MAX_RUNTIME_MS = 300000;  // 5 minutes per batch
const SLEEP_AFTER_WORK_MS = 5000;  // 5 seconds
const SLEEP_NO_WORK_MS = 30000;    // 30 seconds
const STUCK_CHECK_INTERVAL = 10;   // Check stuck every N iterations
const HOUSEKEEPING_INTERVAL = 20;  // Run housekeeping every N iterations

// ═══ State ═══

let running = true;
let iteration = 0;

// ═══ Signal Handling ═══

process.on('SIGINT', () => {
  console.log(`[pipeline-worker] SIGINT received, shutting down gracefully...`);
  running = false;
});

process.on('SIGTERM', () => {
  console.log(`[pipeline-worker] SIGTERM received, shutting down gracefully...`);
  running = false;
});

process.on('uncaughtException', (err) => {
  console.error(`[pipeline-worker] Uncaught exception:`, err.message);
  console.error(err.stack);
  // Exit on uncaught exception to allow PM2 to restart with clean state
  // A worker with broken state (e.g., lost DB connection) cannot recover
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[pipeline-worker] Unhandled rejection:`, reason);
});

// ═══ Main Loop ═══

async function main() {
  console.log(`[pipeline-worker] Starting...`);
  console.log(`[pipeline-worker] Worker ID: ${WORKER_ID}`);
  console.log(`[pipeline-worker] Max tasks per batch: ${MAX_TASKS_PER_BATCH}`);
  console.log(`[pipeline-worker] Max runtime per batch: ${MAX_RUNTIME_MS}ms`);

  // Validate required env vars
  try {
    requiredEnv('SUPABASE_URL');
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    console.log(`[pipeline-worker] Supabase config OK`);
  } catch (err: any) {
    console.error(`[pipeline-worker] Configuration error: ${err.message}`);
    console.error(`[pipeline-worker] Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY`);
    process.exit(1);
  }

  console.log(`[pipeline-worker] Entering main loop...`);

  while (running) {
    iteration++;

    try {
      // Process a batch of tasks
      const result = await processPipelineTaskBatch({
        workerId: WORKER_ID,
        maxTasks: MAX_TASKS_PER_BATCH,
        maxRuntimeMs: MAX_RUNTIME_MS
      });

      if (result.tasks_processed > 0) {
        console.log(
          `[pipeline-worker] Iteration ${iteration}: ` +
          `processed ${result.tasks_processed} tasks ` +
          `(${result.tasks_completed} completed, ${result.tasks_failed} failed, ${result.tasks_retried} retried) ` +
          `in ${result.runtime_ms}ms ` +
          `| stopped: ${result.stopped_reason}`
        );

        if (result.errors.length > 0) {
          for (const err of result.errors.slice(0, 3)) {
            console.error(`[pipeline-worker] Error: ${err}`);
          }
        }

        // Brief sleep after work
        await sleep(SLEEP_AFTER_WORK_MS);
      } else {
        // No work available — longer sleep
        if (iteration % 10 === 0) {
          console.log(`[pipeline-worker] Iteration ${iteration}: No tasks available, waiting...`);
        }
        await sleep(SLEEP_NO_WORK_MS);
      }

      // Periodic housekeeping
      if (iteration % HOUSEKEEPING_INTERVAL === 0) {
        try {
          const stuckTasks = await markStuckTasks(10);
          const stuckRuns = await markStuckPipelineRuns(10);
          if (stuckTasks > 0 || stuckRuns > 0) {
            console.log(`[pipeline-worker] Housekeeping: marked ${stuckTasks} stuck tasks, ${stuckRuns} stuck runs`);
          }
        } catch (err: any) {
          console.error(`[pipeline-worker] Housekeeping error: ${err.message}`);
        }
      }

    } catch (err: any) {
      console.error(`[pipeline-worker] Iteration ${iteration} error:`, err.message);
      // Sleep longer after errors to avoid tight error loops
      await sleep(SLEEP_NO_WORK_MS);
    }
  }

  console.log(`[pipeline-worker] Shutting down after ${iteration} iterations. Goodbye.`);
  process.exit(0);
}

// ═══ Helpers ═══

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Allow immediate wake on shutdown
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once('SIGINT', wake);
    process.once('SIGTERM', wake);
  });
}

// ═══ Start ═══

main().catch((err) => {
  console.error(`[pipeline-worker] Fatal error:`, err);
  process.exit(1);
});
