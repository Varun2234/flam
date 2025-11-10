import { getDB } from "./DB.js";
import { JobManager } from "./JobManager.js";
import { spawn } from "child_process";

// The worker needs its own instance of the DB and JobManager
const db = getDB();
// Instantiate the manager (assumes JobManager.js now has the final logic)
const jobManager = new JobManager(db);

let isRunning = true;

// Handle graceful termination signals (sent by 'queuectl worker stop')
process.on("SIGINT", () => {
  isRunning = false;
});
process.on("SIGTERM", () => {
  isRunning = false;
});

/**
 * Executes a shell command using child_process.spawn.
 * Uses 'pipe' for standard streams to prevent blocking the main terminal input.
 * @param {string} command - The shell command to run.
 * @returns {Promise<{code: number}>}
 */
function executeCommand(command) {
  return new Promise((resolve) => {
    // Use 'pipe' for stdout/stderr and 'ignore' for stdin to prevent blocking the parent terminal
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    // Pipe stdout/stderr from the child process directly to the worker's console
    if (child.stdout) {
      child.stdout.on("data", (data) => {
        process.stdout.write(data);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });
    }

    child.on("error", (err) => {
      console.error(`Execution failed: ${err.message}`);
      resolve({ code: 1 });
    });

    // The 'close' event gives the final exit code
    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        // Log detailed error output for failed jobs
        console.error(`\n--- Command Error Output (Code ${code}) ---`);
        console.error(stderr.trim());
        console.error("-------------------------------------------");
      }
      // Resolve with the actual exit code (0 for success, >0 for failure)
      resolve({ code: code });
    });
  });
}

async function workerLoop() {
  console.log(`[Worker ${process.pid}] Starting job loop...`);

  let idleCount = 0; // Counts consecutive idle cycles
  const MAX_IDLE_COUNT = 10; // ~10 seconds before auto-exit (10 × 1s)

  while (isRunning) {
    const job = jobManager.claimJob();

    if (job) {
      idleCount = 0; // Reset idle count when work is found

      console.log(
        `[Worker ${process.pid}] Claimed job: ${job.id}. Attempt ${
          job.attempts + 1
        }/${job.max_retries + 1}`
      );

      let success = false;
      try {
        const result = await executeCommand(job.command);
        success = result.code === 0;
      } catch (error) {
        console.error(
          `[Worker ${process.pid}] Internal error during execution: ${error.message}`
        );
      }

      jobManager.updateJobState(job, success);

      const status = success ? "COMPLETED" : "RETRYING/DEAD";
      console.log(
        `[Worker ${process.pid}] Job ${job.id} finished. New state: ${status}.`
      );
    } else {
      // No job found
      idleCount++;
      if (idleCount >= MAX_IDLE_COUNT) {
        console.log(
          `[Worker ${process.pid}] No jobs for ${MAX_IDLE_COUNT} seconds. Exiting.`
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Graceful shutdown
  try {
    db.close();
  } catch (err) {
    console.error(`[Worker ${process.pid}] DB close error: ${err.message}`);
  }

  console.log(`[Worker ${process.pid}] Shutting down gracefully.`);
  process.exit(0);
}

// Start the worker loop when the file is run
workerLoop();
