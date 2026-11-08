-- D1 database "realiostats-live" (binding DB)
CREATE TABLE IF NOT EXISTS cursors (chain TEXT PRIMARY KEY, cursor TEXT, updated INTEGER, status TEXT, error TEXT, source TEXT, behind INTEGER);
CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, chain TEXT NOT NULL, ts INTEGER NOT NULL, row TEXT NOT NULL, seen INTEGER);
CREATE INDEX IF NOT EXISTS transfers_ts ON transfers (ts);
