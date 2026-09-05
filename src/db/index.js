import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { hashPassword } from '../lib/password.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(config.root, 'src', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

/**
 * Seed the two owner accounts described in Phase 1 ("likely just you and your
 * father, since it contains receivables"). The other three roles exist in the
 * schema for Phase 2 but have no users until the departments come on.
 */
export function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return [];
  const insert = db.prepare(
    'INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)'
  );
  const seeded = [
    ['shubh', 'Shubh Khandelwal', 'owner', 'balaji123'],
    ['rajesh', 'Balaji Enterprises (Owner)', 'owner', 'balaji123'],
  ];
  const tx = db.transaction(() => {
    for (const [u, n, r, p] of seeded) insert.run(u, n, r, hashPassword(p));
  });
  tx();
  return seeded.map(([u, , , p]) => ({ username: u, password: p }));
}
