#!/usr/bin/env node

import { Command } from "commander";
import { getDB } from "./DB.js";
import { JobManager } from "./JobManager.js";
import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";
import Table from "cli-table3";
import fs from "fs";
import { fork } from "child_process";
import path from "path";

const PID_FILE = path.join(process.cwd(), "data", "workers.pid");
const TIME_FORMAT = "YYYY-MM-DD HH:mm:ss"; // Defined here and used consistently

// Call getDB() to ensure connection is established and tables are created
const db = getDB();
const jobManager = new JobManager(db);

const program = new Command();

program
  .name("queuectl")
  .description("A CLI-based background job queue system")
  .version("1.0.0");

program
  .command("enqueue <filePath>")
  .description(
    "Add a new job to the queue by reading a JSON file. Example: queuectl enqueue ./path/to/job.json"
  )
  .action((filePath) => {
    // Commander passes the file path
    let jobJson;

    try {
      // 1. Check if file exists and read its content synchronously
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found at path: ${filePath}`);
      }

      jobJson = fs.readFileSync(filePath, "utf8");

      // 2. Parse the JSON content
      const data = JSON.parse(jobJson);

      // Basic validation
      if (!data.command || typeof data.command !== "string") {
        throw new Error("Job JSON must contain a 'command' string field.");
      }

      // 3. Define the job object and enqueue
      const job = {
        id: data.id || uuidv4(), // Use user ID or generate UUID
        command: data.command,
        state: "pending",
        attempts: 0,
        max_retries: data.max_retries || 3, // Default to 3 retries
        // Use TIME_FORMAT for consistent DB entries
        created_at: dayjs().format(TIME_FORMAT),
        updated_at: dayjs().format(TIME_FORMAT),
        next_attempt_at: dayjs().format(TIME_FORMAT),
      };

      jobManager.enqueue(job);
      console.log(`✅ Job Enqueued successfully! ID: ${job.id}`);
    } catch (error) {
      console.error(`❌ Failed to enqueue job: ${error.message}`);
      // If parsing fails, output the problematic JSON snippet
      if (error.message.includes("JSON") && jobJson) {
        console.error(
          `\n-- JSON Content Received --\n${jobJson}\n---------------------------\n`
        );
      }
      process.exit(1);
    }
  });

// 2.2. WORKER Command Group (Worker management implementation)
program
  .command("worker <action>")
  .description("Manage worker processes (start/stop)")
  .option("-c, --count <number>", "Number of workers to start", "1")
  .action((action, options) => {
    const count = parseInt(options.count);
    if (action === "start") {
      startWorkers(count);
    } else if (action === "stop") {
      stopWorkers();
    } else {
      console.error(
        `❌ Unknown worker action: ${action}. Use 'start' or 'stop'.`
      );
      process.exit(1);
    }
  });

// 2.3. LIST Command
program
  .command("list")
  .description("List jobs by state")
  .option(
    "-s, --state <state>",
    "Filter by job state (e.g., pending, completed)",
    "all"
  )
  .action((options) => {
    try {
      const jobs = jobManager.listJobs(options.state);

      if (jobs.length === 0) {
        console.log(`\n🔍 No jobs found in state: **${options.state}**`);
        return;
      }

      // --- Use cli-table3 here ---
      const table = new Table({
        head: [
          "ID (Short)",
          "State",
          "Attempts",
          "Max Retries",
          "Last Update",
          "Command Snippet",
        ],
        colWidths: [12, 12, 10, 10, 20, 30], // Define column widths for a clean display
        style: {
          head: ["cyan"],
          border: ["gray"],
        },
      });

      // Add job rows
      jobs.forEach((job) => {
        const idSnippet = job.id.substring(0, 8) + "...";
        const updatedTime = dayjs(job.updated_at).format("HH:mm:ss");
        const commandSnippet =
          job.command.substring(0, 28) + (job.command.length > 28 ? "..." : "");

        table.push([
          idSnippet,
          job.state,
          job.attempts,
          job.max_retries,
          updatedTime,
          commandSnippet,
        ]);
      });

      console.log(
        `\n--- Job Queue Status (${options.state.toUpperCase()}) ---`
      );
      console.log(table.toString()); // Print the formatted table
      console.log(`Total Jobs Found: **${jobs.length}**`);
    } catch (error) {
      console.error(`❌ Failed to list jobs: ${error.message}`);
      process.exit(1);
    }
  });

// 2.4. STATUS Command
program
  .command("status")
  .description("Show summary of all job states & active workers")
  .action(() => {
    try {
      const summary = jobManager.getJobStatusSummary();
      const workerPIDs = readPIDs();

      // --- Job Summary Table ---
      console.log("\n--- Job Queue Summary ---");
      const jobTable = new Table({
        head: ["State", "Count"],
        colWidths: [15, 10],
        style: { head: ["yellow"], border: ["gray"] },
      });

      // Sort states logically
      const states = ["pending", "processing", "failed", "completed", "dead"];
      states.forEach((state) => {
        const count = summary[state] || 0;
        let color = "";
        if (count > 0) {
          if (state === "pending") color = "cyan";
          else if (state === "processing") color = "blue";
          else if (state === "dead" || state === "failed") color = "red";
          else if (state === "completed") color = "green";
        }
        jobTable.push([
          { content: state, hAlign: "left" },
          { content: count, hAlign: "center", color: color },
        ]);
      });

      console.log(jobTable.toString());
      console.log(
        `Total Jobs: ${Object.values(summary).reduce((a, b) => a + b, 0)}`
      );

      // --- Worker Status ---
      console.log("\n--- Worker Status ---");
      console.log(`Active Workers: ${workerPIDs.length}`);
      if (workerPIDs.length > 0) {
        console.log(`PIDs: ${workerPIDs.join(", ")}`);
      }
    } catch (error) {
      console.error(`❌ Failed to show status: ${error.message}`);
      process.exit(1);
    }
  });

// 2.5. DLQ Command Group
const dlq = program
  .command("dlq")
  .description("Manage the Dead Letter Queue (DLQ).");

dlq
  .command("list")
  .description("List all jobs in the Dead Letter Queue (state=dead).")
  .action(() => {
    try {
      // Re-use the existing list logic, forcing state to 'dead'
      const jobs = jobManager.listJobs("dead");

      if (jobs.length === 0) {
        console.log(`\n🔍 The Dead Letter Queue is empty.`);
        return;
      }

      // --- Use cli-table3 here (identical to list command) ---
      const table = new Table({
        head: ["ID (Short)", "Attempts", "Last Update", "Command Snippet"],
        colWidths: [12, 10, 20, 30],
        style: { head: ["red"], border: ["gray"] },
      });

      jobs.forEach((job) => {
        const idSnippet = job.id.substring(0, 8) + "...";
        const updatedTime = dayjs(job.updated_at).format("YYYY-MM-DD HH:mm:ss");
        const commandSnippet =
          job.command.substring(0, 28) + (job.command.length > 28 ? "..." : "");

        table.push([idSnippet, job.attempts, updatedTime, commandSnippet]);
      });

      console.log(`\n--- Dead Letter Queue (${jobs.length} Jobs) ---`);
      console.log(table.toString());
      console.log('\nUse "queuectl dlq retry <ID>" to re-enqueue a job.');
    } catch (error) {
      console.error(`❌ Failed to list DLQ jobs: ${error.message}`);
      process.exit(1);
    }
  });

// DLQ RETRY subcommand
dlq
  .command("retry <jobId>")
  .description("Move a job from the DLQ back to the pending queue.")
  .action((jobId) => {
    try {
      jobManager.retryDeadJob(jobId);
      console.log(
        `✅ Job ${jobId} successfully moved back to 'pending' queue. Attempts reset to 0.`
      );
    } catch (error) {
      console.error(`❌ Failed to retry job ${jobId}: ${error.message}`);
      process.exit(1);
    }
  });

// 2.6. CONFIG Command Group
program
  .command("config <action>")
  .description("Manage configuration (max-retries, backoff, etc.)")
  .action((action) => {
    // Placeholder
    console.log(`Config action called: ${action}. Implementation pending.`);
  });

// 3. Parse and Run
program.parse(process.argv);

// --- Worker Management Helper Functions ---

function readPIDs() {
  if (!fs.existsSync(PID_FILE)) return [];
  const content = fs.readFileSync(PID_FILE, "utf8").trim();
  if (!content) return [];

  const filePIDs = content
    .split("\n")
    .map((p) => parseInt(p))
    .filter((p) => !isNaN(p));

  const livePIDs = [];
  let pidFileChanged = false;

  for (const pid of filePIDs) {
    try {
      // Send signal 0: This is a non-destructive way to check if the process is alive.
      // It throws an exception if the process does not exist.
      process.kill(pid, 0);
      livePIDs.push(pid);
    } catch (e) {
      // ESRCH (No Such Process) is thrown if the process is dead.
      if (e.code === "ESRCH") {
        pidFileChanged = true;
      } else {
        // Keep PIDs that are alive or have other unexpected errors
        livePIDs.push(pid);
      }
    }
  }

  // Rewrite the file ONLY if a stale PID was found and removed.
  if (pidFileChanged) {
    writePIDs(livePIDs);
  }

  return livePIDs;
}

function writePIDs(pids) {
  fs.writeFileSync(PID_FILE, pids.join("\n"));
}

function removePID(pidToRemove) {
  const pids = readPIDs().filter((pid) => pid !== pidToRemove);
  writePIDs(pids);
}

function startWorkers(count) {
  const workerPIDs = readPIDs();
  if (workerPIDs.length > 0) {
    console.log(
      `⚠️ ${workerPIDs.length} workers are already running. Stop them first using 'queuectl worker stop'.`
    );
    return;
  }

  const newPIDs = [];
  const workerPath = path.join(process.cwd(), "src", "Worker.js");

  for (let i = 0; i < count; i++) {
    const worker = fork(workerPath, [], {
      silent: false, // Keeps worker output visible
    });

    // CRITICAL FIX: Detach the child process from the parent's event loop.
    // This allows the parent CLI process to exit immediately, returning control to the terminal.
    worker.unref();

    worker.on("exit", (code) => {
      // This exit handler will still fire because it's a separate event.
      console.log(`[Manager] Worker ${worker.pid} exited with code ${code}.`);
      removePID(worker.pid); // Ensure PID is removed on exit
    });

    console.log(`✅ Started Worker ${i + 1} with PID: ${worker.pid}`);
    newPIDs.push(worker.pid);
  }
  writePIDs(newPIDs);
  console.log(`Total workers started: ${newPIDs.length}`);
  db.close();
}

function stopWorkers() {
  const workerPIDs = readPIDs();
  if (workerPIDs.length === 0) {
    console.log("🔍 No active workers found.");
    return;
  }

  console.log(
    `Attempting graceful shutdown of ${workerPIDs.length} workers...`
  );
  workerPIDs.forEach((pid) => {
    try {
      process.kill(pid, "SIGTERM"); // Send termination signal (caught by Worker.js)
      console.log(`Sent SIGTERM to PID ${pid}.`);
    } catch (error) {
      console.error(
        `❌ Failed to kill process ${pid} (it might have already exited): ${error.message}`
      );
    }
  });

  // Clear the PID file immediately
  fs.writeFileSync(PID_FILE, "");
}
