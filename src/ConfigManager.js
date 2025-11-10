// src/ConfigManager.js

export class ConfigManager {
  /**
   * @param {import('better-sqlite3').Database} db The database instance.
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Sets a configuration value.
   * @param {string} key - The configuration key
   * @param {string} value - The configuration value
   */
  set(key, value) {
    const sql = `
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `;
    this.db.prepare(sql).run(key, value);
  }

  /**
   * Gets a configuration value.
   * @param {string} key - The configuration key
   * @returns {string|null} The configuration value or null if not found
   */
  get(key) {
    const sql = `SELECT value FROM config WHERE key = ?`;
    const row = this.db.prepare(sql).get(key);
    return row ? row.value : null;
  }

  /**
   * Gets all configuration values.
   * @returns {Object} An object containing all config key-value pairs
   */
  getAll() {
    const sql = `SELECT key, value FROM config`;
    const rows = this.db.prepare(sql).all();
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
  }

  /**
   * Delete a configuration value.
   * @param {string} key - The configuration key to delete
   */
  delete(key) {
    const sql = `DELETE FROM config WHERE key = ?`;
    this.db.prepare(sql).run(key);
  }
}