-- Migration 0012: Módulo Caja
-- Nuevas tablas: cash_entries, cash_debts, cash_expenses,
--                remittances, remittance_items,
--                commission_entries, iva_entries
-- Campo nuevo en payments: rendered, rendered_at

ALTER TABLE payments ADD COLUMN rendered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN rendered_at INTEGER;

CREATE TABLE IF NOT EXISTS cash_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  policy_number TEXT,
  company_name TEXT,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  due_date TEXT,
  notes TEXT,
  rendered INTEGER NOT NULL DEFAULT 0,
  rendered_at INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS cash_debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  policy_number TEXT,
  company_name TEXT,
  amount REAL NOT NULL,
  due_date TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente',
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS cash_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS remittances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  canal TEXT NOT NULL,
  notes TEXT,
  payment_breakdown TEXT NOT NULL DEFAULT '{}',
  pronto_pago_surcharge REAL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  total_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmada',
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS remittance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remittance_id INTEGER NOT NULL REFERENCES remittances(id),
  source TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  debtor_status TEXT NOT NULL DEFAULT 'pagado',
  paid_at INTEGER,
  client_name TEXT,
  policy_number TEXT,
  company_name TEXT,
  payment_method TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS commission_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS iva_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER
);
