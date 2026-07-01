const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id      TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    name         TEXT
  );

  CREATE TABLE IF NOT EXISTS matches (
    match_id       INTEGER PRIMARY KEY,
    api_fixture_id INTEGER UNIQUE,
    team_home      TEXT NOT NULL,
    team_away      TEXT NOT NULL,
    kickoff        TEXT NOT NULL,
    stage          TEXT,
    status         TEXT NOT NULL DEFAULT 'NS',
    raw_status     TEXT,
    score_home     INTEGER,
    score_away     INTEGER
  );

  CREATE TABLE IF NOT EXISTS predictions (
    match_id  INTEGER NOT NULL,
    user_id   TEXT NOT NULL,
    pred_home INTEGER,
    pred_away INTEGER,
    points    INTEGER,
    PRIMARY KEY (match_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    note       TEXT
  );
`);

module.exports = db;
