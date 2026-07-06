-- Migration 0022: cheques físicos recibidos dentro de un split cheque de un
-- cobro múltiple (Etapa 4B).
--
-- Un received_checks SIEMPRE cuelga de un payment_batch_splits con
-- method='cheque' (nunca de un payment individual, nunca de una cuota
-- directamente): uno o varios cheques pueden componer un mismo split cheque,
-- y SUM(received_checks.amount_cents) de un batch_split_id debe ser
-- exactamente ese payment_batch_splits.amount_cents (ver 0021 y
-- src/lib/payments/received-checks.ts). No existe relación cheque ↔
-- installment — la cuota que el cheque termina pagando es siempre indirecta,
-- a través del batch.
--
-- Estados: en_cartera (recién recibido) -> entregado_compania (parte de una
-- rendición futura) -> cobrado | rechazado (terminales). anulado es terminal
-- y solo alcanzable desde en_cartera. Deliberadamente SIN estado
-- "depositado" en esta etapa. Las transiciones válidas las valida
-- src/lib/payments/received-checks.ts (validateCheckStatusTransition), no
-- este CHECK — acá solo se restringe el vocabulario de valores posibles.
--
-- ON DELETE RESTRICT en batch_split_id: igual que 0021, este proyecto no
-- habilita PRAGMA foreign_keys, así que esta cláusula es hoy documentación de
-- la intención (bloquear que se borre un split con cheques ya recibidos), no
-- una restricción activa de SQLite. La aplicación debe bloquear
-- explícitamente cualquier eliminación insegura de un payment_batch_splits
-- que tenga received_checks asociados, y de un received_checks que no esté
-- en_cartera (ver src/lib/payments/received-checks.ts e index.ts).
--
-- Sin UNIQUE global ni banco+número: dos cheques del mismo banco y número
-- pueden coexistir en la tabla (ej. carga duplicada por error, o un cheque
-- rechazado y vuelto a cargar tras corrección) — la detección de posibles
-- duplicados es informativa, no un constraint (ver
-- findPossibleCheckDuplicates), y nunca bloquea automáticamente el alta.
--
-- Sin backfill: no existe ningún payment_batch_splits histórico con
-- method='cheque' para el que reconstruir cheques (Etapa 4A recién introdujo
-- payment_batch_splits, sin datos reales todavía).

CREATE TABLE IF NOT EXISTS received_checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_split_id   INTEGER NOT NULL REFERENCES payment_batch_splits(id) ON DELETE RESTRICT,
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
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_received_checks_batch_split_id ON received_checks(batch_split_id);
CREATE INDEX IF NOT EXISTS idx_received_checks_status ON received_checks(status);
CREATE INDEX IF NOT EXISTS idx_received_checks_due_date ON received_checks(due_date);
CREATE INDEX IF NOT EXISTS idx_received_checks_bank_number ON received_checks(bank_name, check_number);
