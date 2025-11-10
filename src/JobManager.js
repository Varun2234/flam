// Flam/src/JobManager.js

import dayjs from "dayjs";

// CRITICAL FIX: Use a consistent format for SQLite date/time comparison
const TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

export class JobManager {
  /**
   * @param {import('better-sqlite3').Database} db The database instance.
   */
  constructor(db) {
    this.db = db;
    // Prepare the statement once for efficiency
    this.insertStmt = this.db.prepare(`
            INSERT INTO jobs (
                id, command, state, attempts, max_retries, created_at, updated_at, next_attempt_at
            ) VALUES (
                @id, @command, @state, @attempts, @max_retries, @created_at, @updated_at, @next_attempt_at
            )
        `);
  }

  /**
   * Adds a new job to the queue.
   * @param {Object} job - The job object to insert.
   */
  enqueue(job) {
    try {
      // Using run() for INSERT/UPDATE/DELETE (Synchronous)
      const info = this.insertStmt.run(job);

      if (info.changes === 0) {
        throw new Error(`Job ID ${job.id} not inserted or already exists.`);
      }
      return info;
    } catch (error) {
      throw new Error(`Database error during enqueue: ${error.message}`);
    }
  }

  /**
   * Atomically finds and claims a job for processing.
   * Checks for 'pending' jobs or 'failed' jobs that are due for retry.
   * @returns {Object | null} The claimed job object, or null if no job is available.
   */
  claimJob() {
    // Uses the consistent format for comparison time
    const now = dayjs().format(TIME_FORMAT);
    let claimedJob = null;

    // Use a transaction to ensure the SELECT and UPDATE are atomic
    const transaction = this.db.transaction(() => {
      // 1. SELECT: Find the oldest eligible job
      const selectSql = `
                SELECT * FROM jobs 
                WHERE 
                    (state = 'pending') OR 
                    (state = 'failed' AND next_attempt_at <= ?)
                ORDER BY updated_at ASC
                LIMIT 1
            `;
      // Check if any job's next_attempt_at is less than or equal to 'now'
      const jobToClaim = this.db.prepare(selectSql).get(now);

      if (!jobToClaim) {
        return null; // No eligible job found
      }

      // 2. UPDATE: Change state to 'processing'
      const updateSql = `
                UPDATE jobs 
                SET state = 'processing', updated_at = ? 
                WHERE id = ?
            `;

      this.db.prepare(updateSql).run(now, jobToClaim.id);

      // Set the updated properties locally before returning
      jobToClaim.state = "processing";
      jobToClaim.updated_at = now;

      return jobToClaim;
    });

    // Execute and return the result of the transaction
    return transaction();
  }

  /**
   * Lists jobs, optionally filtering by state.
   */
  listJobs(state = "all") {
    let sql =
      "SELECT id, command, state, attempts, max_retries, updated_at FROM jobs";
    const params = [];

    if (state !== "all") {
      sql += " WHERE state = ?";
      params.push(state);
    }

    sql += " ORDER BY created_at DESC";

    try {
      return this.db.prepare(sql).all(params);
    } catch (error) {
      throw new Error(`Database error during list: ${error.message}`);
    }
  }

  /**
   * Calculates the exponential backoff delay.
   */
  calculateBackoff(attempts) {
    const BACKOFF_BASE_SECONDS = 5;

    // attempts starts at 1 for the first failure, so use attempts - 1 for power
    const delay = BACKOFF_BASE_SECONDS * Math.pow(2, attempts - 1);

    // Apply the consistent format
    const nextAttemptAt = dayjs().add(delay, "second").format(TIME_FORMAT);
    return nextAttemptAt;
  }

  /**
   * Updates the job state after execution (success/failure/DLQ).
   */
  updateJobState(job, success) {
    // Apply the consistent format
    const now = dayjs().format(TIME_FORMAT);

    if (success) {
      // Case 1: Success
      const sql = `
        UPDATE jobs 
        SET state = 'completed', updated_at = ? 
        WHERE id = ?
      `;
      this.db.prepare(sql).run(now, job.id);
      return;
    }

    // Case 2: Failure - Increment attempts
    const newAttempts = job.attempts + 1;

    if (newAttempts > job.max_retries) {
      // Case 2a: Failure - Move to DLQ (Dead)
      const sql = `
        UPDATE jobs 
        SET state = 'dead', attempts = ?, updated_at = ? 
        WHERE id = ?
      `;
      this.db.prepare(sql).run(newAttempts, now, job.id);
      return;
    }

    // Case 2b: Failure - Retry with Exponential Backoff
    const nextAttemptAt = this.calculateBackoff(newAttempts);
    const sql = `
      UPDATE jobs 
      SET state = 'failed', attempts = ?, next_attempt_at = ?, updated_at = ? 
      WHERE id = ?
    `;
    this.db.prepare(sql).run(newAttempts, nextAttemptAt, now, job.id);
  }

  /**
   * Returns a summary count of all jobs grouped by state.
   */
  getJobStatusSummary() {
    const sql = `
      SELECT state, COUNT(*) as count 
      FROM jobs 
      GROUP BY state
    `;
    const rows = this.db.prepare(sql).all();

    const summary = rows.reduce((acc, row) => {
      acc[row.state] = row.count;
      return acc;
    }, {});

    const allStates = ["pending", "processing", "completed", "failed", "dead"];
    for (const state of allStates) {
      if (!(state in summary)) {
        summary[state] = 0;
      }
    }
    return summary;
  }

  /**
   * Moves a permanently failed job (dead) back to the pending queue.
   */
  retryDeadJob(jobId) {
    // Apply the consistent format
    const now = dayjs().format(TIME_FORMAT);

    const sql = `
      UPDATE jobs 
      SET state = 'pending', attempts = 0, updated_at = ?, next_attempt_at = ?
      WHERE id = ? AND state = 'dead'
    `;
    const info = this.db.prepare(sql).run(now, now, jobId);

    if (info.changes === 0) {
      throw new Error(`Job ID ${jobId} not found in the 'dead' queue.`);
    }
    return info;
  }
}
