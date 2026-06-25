-- Migration 0015: Caja Propia
-- A. commission_entries: payment_method, period_month, status
-- B. cash_expenses: type, payment_method, payee_name, salary_period, status, reconciled_at
-- C. cash_entries: entry_type, payment_id
-- D. Nueva tabla own_money_movements

-- A. commission_entries
ALTER TABLE commission_entries ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'transferencia';
ALTER TABLE commission_entries ADD COLUMN period_month TEXT;
ALTER TABLE commission_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'registrado';

-- B. cash_expenses
ALTER TABLE cash_expenses ADD COLUMN type TEXT NOT NULL DEFAULT 'gasto_operativo';
ALTER TABLE cash_expenses ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'efectivo';
ALTER TABLE cash_expenses ADD COLUMN payee_name TEXT;
ALTER TABLE cash_expenses ADD COLUMN salary_period TEXT;
ALTER TABLE cash_expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'registrado';
ALTER TABLE cash_expenses ADD COLUMN reconciled_at INTEGER;

-- C. cash_entries
ALTER TABLE cash_entries ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE cash_entries ADD COLUMN payment_id INTEGER REFERENCES payments(id);

-- D. own_money_movements
CREATE TABLE IF NOT EXISTS own_money_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK (type IN ('aporte', 'reintegro')),
  date           TEXT NOT NULL,
  amount         REAL NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'efectivo' CHECK (payment_method IN ('efectivo', 'transferencia')),
  status         TEXT NOT NULL DEFAULT 'registrado' CHECK (status IN ('registrado', 'anulado')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     INTEGER
);

-- E. Índice único parcial: un payment sólo puede tener un recargo pronto_pago_surcharge
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_entries_pronto_pago_payment
  ON cash_entries(payment_id)
  WHERE entry_type = 'pronto_pago_surcharge'
    AND payment_id IS NOT NULL;
