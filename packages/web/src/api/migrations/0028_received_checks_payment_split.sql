-- Migración 0028: generaliza received_checks para que también puedan colgar
-- de un payment_splits (pago individual/standalone), no solo de un
-- payment_batch_splits (cheque de un cobro múltiple).
--
-- Motivo: hasta esta migración, un pago individual con method="cheque" no
-- dejaba ninguna trazabilidad real del instrumento (número, banco,
-- vencimiento, librador) — solo quedaba el texto "cheque" en
-- payment_splits.method. received_checks.batch_split_id era NOT NULL, así
-- que era literalmente imposible insertar un cheque que no colgara de un
-- cobro múltiple.
--
-- A. received_checks (rebuild completo — SQLite no permite
--    "ALTER COLUMN ... DROP NOT NULL" ni agregar un CHECK a una tabla
--    existente vía ALTER TABLE; se sigue el mismo procedimiento de 12 pasos
--    ya usado en 0008/0009/0010/0014/0026):
--
--    - batch_split_id pasa a NULLABLE (antes NOT NULL).
--    - se agrega payment_split_id INTEGER REFERENCES payment_splits(id),
--      nullable.
--    - CHECK XOR real: exactamente uno de (batch_split_id, payment_split_id)
--      debe estar presente. SQLite SÍ enforcea CHECK aunque este proyecto no
--      habilite PRAGMA foreign_keys (son mecanismos independientes) — mismo
--      criterio que ya usa remittance_allocations desde la migración 0024.
--    - se preservan todos los cheques existentes de lote (INSERT...SELECT
--      sin backfill: ninguna fila cambia de valor, batch_split_id conserva
--      el mismo valor real que tenía).
--    - índice nuevo idx_received_checks_payment_split_id; se conserva
--      idx_received_checks_batch_split_id (y el resto de los índices
--      existentes) tal cual.
--
-- B. remittance_allocations (rebuild completo — el segundo CHECK de la
--    migración 0024 hoy PROHÍBE explícitamente que una allocation tenga
--    received_check_id junto con payment_split_id, porque hasta ahora un
--    cheque nunca podía colgar de un payment_split; SQLite no permite
--    modificar un CHECK existente vía ALTER TABLE, así que también se
--    recrea):
--
--    CHECK anterior:
--      received_check_id IS NULL OR payment_batch_split_id IS NOT NULL
--    CHECK nuevo:
--      received_check_id IS NULL
--      OR payment_batch_split_id IS NOT NULL
--      OR payment_split_id IS NOT NULL
--
--    El resto de columnas, FKs, el CHECK "exactamente un leaf"
--    ((payment_split_id IS NOT NULL) + (payment_batch_split_id IS NOT NULL) +
--    (cash_entry_id IS NOT NULL) = 1) y las 4 UNIQUE parciales
--    (ux_remittance_allocations_payment_split,
--    ux_remittance_allocations_batch_split_no_check,
--    ux_remittance_allocations_received_check,
--    ux_remittance_allocations_cash_entry) quedan exactamente iguales.
--    Sin backfill: ninguna fila cambia de valor.
--
-- payment_splits.id / payment_batch_splits.id referencian estas tablas por
-- NOMBRE de tabla — SQLite (legacy_alter_table=OFF) actualiza esas
-- referencias automáticamente al hacer RENAME TO, sin tocar las tablas
-- hijas (mismo comportamiento confirmado en libsql para la migración 0026).
--
-- La idempotencia y el procedimiento seguro (PRAGMA foreign_keys=OFF fuera
-- de la transacción, PRAGMA foreign_key_check antes de confirmar) los
-- garantiza el aplicador TS
-- (src/lib/migrations/apply-0028-received-checks-payment-split.ts), no este
-- archivo por sí solo — mismo criterio que toda migración de este proyecto
-- desde 0017 en adelante.

-- ─── A. received_checks ─────────────────────────────────────────────────────

CREATE TABLE received_checks_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_split_id   INTEGER REFERENCES payment_batch_splits(id),
  payment_split_id INTEGER REFERENCES payment_splits(id),
  check_number     TEXT NOT NULL,
  bank_name        TEXT NOT NULL,
  bank_code        TEXT,
  drawer_name      TEXT,
  drawer_document  TEXT,
  issue_date       TEXT,
  due_date         TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT NOT NULL DEFAULT 'ARS',
  status           TEXT NOT NULL DEFAULT 'en_cartera'
                     CHECK (status IN ('en_cartera', 'entregado_compania', 'cobrado', 'rechazado', 'anulado')),
  notes            TEXT,
  received_at      INTEGER NOT NULL,
  delivered_at     INTEGER,
  cleared_at       INTEGER,
  rejected_at      INTEGER,
  cancelled_at     INTEGER,
  created_by       INTEGER REFERENCES users(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (
    (batch_split_id IS NOT NULL) + (payment_split_id IS NOT NULL) = 1
  )
);

INSERT INTO received_checks_new (
  id, batch_split_id, payment_split_id, check_number, bank_name, bank_code,
  drawer_name, drawer_document, issue_date, due_date, amount_cents, currency,
  status, notes, received_at, delivered_at, cleared_at, rejected_at,
  cancelled_at, created_by, created_at, updated_at
)
SELECT
  id, batch_split_id, NULL, check_number, bank_name, bank_code,
  drawer_name, drawer_document, issue_date, due_date, amount_cents, currency,
  status, notes, received_at, delivered_at, cleared_at, rejected_at,
  cancelled_at, created_by, created_at, updated_at
FROM received_checks;

DROP TABLE received_checks;
ALTER TABLE received_checks_new RENAME TO received_checks;

CREATE INDEX IF NOT EXISTS idx_received_checks_batch_split_id ON received_checks(batch_split_id);
CREATE INDEX IF NOT EXISTS idx_received_checks_payment_split_id ON received_checks(payment_split_id);
CREATE INDEX IF NOT EXISTS idx_received_checks_status ON received_checks(status);
CREATE INDEX IF NOT EXISTS idx_received_checks_due_date ON received_checks(due_date);
CREATE INDEX IF NOT EXISTS idx_received_checks_bank_number ON received_checks(bank_name, check_number);

-- ─── B. remittance_allocations ──────────────────────────────────────────────

CREATE TABLE remittance_allocations_new (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  remittance_id           INTEGER NOT NULL REFERENCES remittances(id),
  remittance_item_id      INTEGER REFERENCES remittance_items(id),
  payment_id              INTEGER REFERENCES payments(id),
  payment_split_id        INTEGER REFERENCES payment_splits(id),
  payment_batch_id        INTEGER REFERENCES payment_batches(id),
  payment_batch_split_id  INTEGER REFERENCES payment_batch_splits(id),
  received_check_id       INTEGER REFERENCES received_checks(id),
  cash_entry_id           INTEGER REFERENCES cash_entries(id),
  method                  TEXT NOT NULL CHECK (
                            method IN ('efectivo', 'transferencia', 'cheque', 'link_pago', 'transferencia_compania')
                          ),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at              INTEGER NOT NULL,
  CHECK (
    (payment_split_id IS NOT NULL) +
    (payment_batch_split_id IS NOT NULL) +
    (cash_entry_id IS NOT NULL) = 1
  ),
  CHECK (
    received_check_id IS NULL
    OR payment_batch_split_id IS NOT NULL
    OR payment_split_id IS NOT NULL
  )
);

INSERT INTO remittance_allocations_new (
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
)
SELECT
  id, remittance_id, remittance_item_id, payment_id, payment_split_id,
  payment_batch_id, payment_batch_split_id, received_check_id, cash_entry_id,
  method, amount_cents, created_at
FROM remittance_allocations;

DROP TABLE remittance_allocations;
ALTER TABLE remittance_allocations_new RENAME TO remittance_allocations;

CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_id ON remittance_allocations(remittance_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_item_id ON remittance_allocations(remittance_item_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_method ON remittance_allocations(method);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_id ON remittance_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_batch_id ON remittance_allocations(payment_batch_id);

-- payment_split_id + received_check_id IS NULL: un split NO-cheque (o el
-- caso legacy pre-0028) tiene a lo sumo una allocation. Un split cheque con
-- N cheques ahora genera N allocations que comparten el MISMO
-- payment_split_id (una por cheque, ver resolveStandalonePaymentInstruments
-- en src/lib/payments/remittance-allocations.ts) — sin la condición
-- "received_check_id IS NULL" acá, este índice bloquearía en falso esa
-- carga múltiple legítima. Mismo criterio que
-- ux_remittance_allocations_batch_split_no_check ya usa para
-- payment_batch_split_id desde la migración 0024.
CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split
  ON remittance_allocations(payment_split_id)
  WHERE payment_split_id IS NOT NULL AND received_check_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check
  ON remittance_allocations(payment_batch_split_id)
  WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check
  ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry
  ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL;
