-- Migration 0014: sourceId nullable en remittance_items
-- Permite items de tipo manual_debt sin referencia a una fila real,
-- ya que no provienen de payments ni de cash_entries.

-- SQLite no soporta DROP CONSTRAINT ni ALTER COLUMN directamente.
-- La columna source_id ya no tiene NOT NULL; recreamos la tabla.

PRAGMA foreign_keys = OFF;

CREATE TABLE remittance_items_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  remittance_id INTEGER NOT NULL REFERENCES remittances(id),
  source      TEXT NOT NULL,
  source_id   INTEGER,
  amount      REAL NOT NULL,
  debtor_status TEXT NOT NULL DEFAULT 'pagado',
  paid_at     INTEGER,
  client_name TEXT,
  policy_number TEXT,
  company_name TEXT,
  payment_method TEXT,
  created_at  INTEGER
);

INSERT INTO remittance_items_new
  SELECT id, remittance_id, source, source_id, amount, debtor_status,
         paid_at, client_name, policy_number, company_name, payment_method, created_at
  FROM remittance_items;

DROP TABLE remittance_items;

ALTER TABLE remittance_items_new RENAME TO remittance_items;

PRAGMA foreign_keys = ON;
