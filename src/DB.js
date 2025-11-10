// src/DB.js

import SQLite from "better-sqlite3";
import path from "path";
import fs from "fs";

// Define the path for the database file
const DB_PATH = path.join(process.cwd(), "data", "queue.db");

let db = null;

/**
 * Initializes the database connection and creates necessary tables.
 */
function initializeDatabase() {
  // Ensure the data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  try {
    // Open the database connection
    db = new SQLite(DB_PATH);
    db.pragma("journal_mode = WAL"); // Recommended for better concurrency

    // --- Create Tables ---

    // 1. Jobs Table
    db.exec(`
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                state TEXT NOT NULL,         -- pending, processing, completed, failed, dead
                attempts INTEGER NOT NULL,
                max_retries INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                next_attempt_at TEXT         -- Used for scheduling retries (ISO 8601 string)
            );
        `);

    // 2. Configuration Table
    db.exec(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

  } catch (error) {
    console.error("❌ Error initializing database:", error.message);
    // You might want to exit the process here if DB connection is critical
    process.exit(1);
  }
}

/**
 * Returns the active database instance, initializing it if necessary.
 * @returns {SQLite.Database} The database instance.
 */
export function getDB() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

// Ensure database initialization runs when this module is first imported
initializeDatabase();
