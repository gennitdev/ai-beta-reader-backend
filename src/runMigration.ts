import { pool } from './db.js';
import fs from 'fs';
import path from 'path';

async function runMigration() {
  const migrationPath = path.join(process.cwd(), 'migrations', '002_add_parts_and_ordering.sql');

  try {
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    console.log('Running migration: 002_add_parts_and_ordering.sql');
    await pool.query(sql);
    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();