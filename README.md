# flam
demo video Link:(https://drive.google.com/file/d/1_J4ycM1t7qwaD1CWuIq2H3KdS1DsaCPF/view?usp=drivesdk)
A simple, persistent, CLI-based background job queue system built with Node.js and SQLite.

## Overview

**flam** provides a command-line tool, `queuectl`, to manage a persistent job queue. It is designed for running shell commands as background tasks in a reliable way.

Jobs are submitted to a SQLite database, and separate worker processes claim and execute these jobs. The system supports automatic retries with exponential backoff, a dead-letter queue (DLQ) for terminally failed jobs, and basic monitoring.

## Core Components

- **queuectl (The CLI)**: The main user interface for enqueuing jobs, managing workers, and checking queue status.

- **The Database (`DB.js`)**: A better-sqlite3 database file (`data/queue.db`). It uses Write-Ahead Logging (WAL) mode for better concurrency.

- **The Job Manager (`JobManager.js`)**: The core logic for handling job state. It provides methods for atomically claiming jobs, updating states (e.g., completed, failed), and calculating backoff.

- **The Worker (`Worker.js`)**: A separate, detached process that runs the workerLoop. It continuously polls the JobManager for new jobs, executes them using `child_process.spawn`, and reports the success or failure. Workers are ephemeral and will self-terminate after 10 seconds of inactivity.

## Installation

1. Clone the repository:
```bash
git clone https://github.com/varun2234/flam.git
cd flam
```

2. Install dependencies:
```bash
npm install
```

3. Link the CLI tool to make it accessible in your path:
```bash
npm link
```

You can now run `queuectl` from anywhere.

## How it Works: The Job Lifecycle
1. **Enqueueing**: A user adds a job by pointing to a JSON file:
   ```bash
   queuectl enqueue ./jobs/test.json
   ```
   The job is saved to the SQLite database with the state `pending`.

2. **Starting Workers**: The user starts one or more worker processes:
   ```bash
   queuectl worker start -c 2
   ```
   This forks `src/Worker.js` twice. The parent CLI process exits immediately, leaving the workers running in the background.

3. **Job Claiming**: Each worker enters a loop, asking the JobManager for a job. The `JobManager.js` atomically finds the oldest, eligible job (either `pending` or a `failed` job whose retry time has come) and updates its state to `processing`.

4. **Execution**: The worker executes the job's command string in a shell.

5. **Updating State (on Finish)**:
   - **Success**: If the command exits with code 0, the worker reports success. The JobManager updates the job's state to `completed`.
   - **Failure**: If the command exits with a non-zero code, the worker reports failure. The JobManager increments the attempts count.
   - **Retry**: If `attempts` is less than or equal to `max_retries`, the state is set to `failed`, and `next_attempt_at` is calculated using exponential backoff.
   - **Dead Letter Queue (DLQ)**: If `attempts` exceeds `max_retries`, the state is set to `dead`.

6. **Worker Shutdown**: If a worker finds no jobs for 10 consecutive seconds (`MAX_IDLE_COUNT`), it logs an exit message and terminates itself gracefully. A graceful stop can also be triggered via `queuectl worker stop`, which sends a `SIGTERM` signal to all running worker PIDs.

## Job File Format

Jobs are defined in simple JSON files. Here's an example `jobs/test.json`:

```json
{
  "id": "job",
  "command": "echo \"Job started from reliable file input\"",
  "max_retries": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | optional | A unique ID for the job. If not provided, a UUID will be generated. |
| `command` | string | required | The shell command to be executed. |
| `max_retries` | number | optional | The number of times to retry after the first failure. Defaults to 3. A value of 1 means 1 initial attempt and 1 retry (2 total runs). |

## CLI Commands (`queuectl`)

All commands are managed via `src/cli.js`. Here's the complete command reference:

### Job Management

#### `queuectl enqueue <filePath>`
Adds a new job to the queue from a JSON file.

```bash
queuectl enqueue ./jobs/my_job.json
```

Reads and parses the specified JSON file, validates it, and inserts it into the database with a `pending` state.

### Worker Management

#### `queuectl worker start`
Starts worker processes.

```bash
queuectl worker start -c 2  # Start 2 workers
```

**Options:**
- `-c, --count <number>`: Number of workers to start (default: "1")

The workers are detached, allowing the CLI to exit immediately. Worker PIDs are stored in `data/workers.pid`.

#### `queuectl worker stop`
Gracefully stops all worker processes.

```bash
queuectl worker stop
```

Reads the PIDs from `data/workers.pid` and sends a SIGTERM signal to each one.

### Monitoring

#### `queuectl list`
Lists jobs from the database in a formatted table.

```bash
queuectl list -s pending  # List only pending jobs
```

**Options:**
- `-s, --state <state>`: Filter by job state (pending/completed/failed/dead). Default: "all"

#### `queuectl status`
Shows a high-level summary of the job queue and active workers.

```bash
queuectl status
```

Displays:
1. **Job Queue Summary**: Count of all jobs grouped by state
2. **Worker Status**: Number of active worker PIDs

### Dead Letter Queue (DLQ)

#### `queuectl dlq list`
Lists all jobs in the dead state.

```bash
queuectl dlq list
```

#### `queuectl dlq retry <jobId>`
Moves a dead job back to the pending queue.

```bash
queuectl dlq retry job-123
```

Resets the job's attempts to 0 and allows it to run again.

### Configuration

#### `queuectl config <action>`
Manages system configuration (placeholder for future use).

```bash
queuectl config get-all
```

Currently prints "Implementation pending".

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | Node.js command-line framework |
| `better-sqlite3` | Fast and simple SQLite3 binding for Node.js |
| `cli-table3` | Renders the pretty tables for list and status commands |
| `dayjs` | Used for all date/time formatting and calculations |
| `uuid` | Generates unique IDs for jobs |