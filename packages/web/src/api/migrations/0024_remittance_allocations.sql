-- Migration 0024: remittance_allocations — vínculo real entre una rendición
-- y los instrumentos de pago concretos que la componen (Etapa 4C).
--
-- Hasta esta migración, remittance_items solo guarda (source, sourceId)
-- genérico y remittances.payment_breakdown es un JSON de texto libre sin
-- ninguna relación real con payment_splits/payment_batch_splits/
-- received_checks/cash_entries. remittance_allocations es la única tabla que
-- conecta una rendición con el instrumento real que la cubrió, uno por fila:
--
--   - Pago standalone (simple o combinado): una allocation por cada
--     payment_splits real del payment, con remittance_item_id apuntando al
--     ítem de esa cuota/pago.
--   - Cobro múltiple (payment_batches): una allocation por cada
--     payment_batch_splits del batch (remittance_item_id NULL — el batch se
--     rinde completo, no hay un ítem individual al que atarla, ver
--     src/lib/payments/remittance-allocations.ts). Si el split es
--     method='cheque', una allocation por cada received_checks del split en
--     vez de una por el split entero (permite in cast rastrear cada cheque).
--   - cash_entry (recargo Pronto Pago u otro cobro manual de Caja): una
--     allocation con cash_entry_id, remittance_item_id apuntando al ítem.
--   - Cuota no cobrada (source='installment') y deuda manual
--     (source='manual_debt'): CERO allocations — no representan dinero
--     recibido, la ausencia de filas es la señal correcta.
--
-- payment_id y payment_batch_id son denormalizados a propósito (auditoría
-- directa sin tener que resolver payment_split_id->payment_id o
-- payment_batch_split_id->payment_batch_id con un join extra).
--
-- CHECK "exactamente un leaf": cada allocation debe identificar EXACTAMENTE
-- un instrumento real de nivel hoja — un payment_splits (pago standalone), un
-- payment_batch_splits (split de batch no-cheque), o un cash_entries. Un
-- cheque de un split de batch NO cuenta como leaf aparte: sigue siendo
-- payment_batch_split_id el leaf, con received_check_id como disambiguador
-- adicional de cuál cheque específico del split. Por eso la segunda CHECK
-- exige que received_check_id nunca aparezca sin payment_batch_split_id.
--
-- Sin triggers (este proyecto no usa triggers en ningún lado — ver grep en
-- src/api/migrations/*.sql). La validación de que
-- SUM(allocations.amount_cents) = remittance.total_paid (en centavos) es
-- responsabilidad de la aplicación (ver validateAllocationTotal en
-- src/lib/payments/remittance-allocations.ts), igual que
-- validateBatchTotals/validateChecksMatchSplit.
--
-- Los UNIQUE parciales son la única garantía real (a nivel de todo el
-- historial, no solo dentro de una rendición) de que un mismo instrumento
-- real nunca se asigna a dos rendiciones: ni un mismo payment_split_id, ni un
-- mismo payment_batch_split_id sin cheque, ni un mismo received_check_id, ni
-- un mismo cash_entry_id.
--
-- Sin backfill: las 6 rendiciones históricas existentes hoy quedan con cero
-- allocations (ver clasificador legacy/completa/inconsistente en
-- src/lib/payments/remittance-allocations.ts) — mismo criterio "schema-only"
-- que todas las migraciones anteriores de este proyecto.
--
-- ON DELETE sin cláusula explícita en ninguna FK: igual que el resto del
-- proyecto, este esquema no habilita PRAGMA foreign_keys a nivel de
-- declaración SQL — el borrado en cascada (DELETE /remittances/:id) lo hace
-- la aplicación explícitamente dentro de una transacción, nunca SQLite solo.

CREATE TABLE IF NOT EXISTS remittance_allocations (
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
  )
);

CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_id ON remittance_allocations(remittance_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_remittance_item_id ON remittance_allocations(remittance_item_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_method ON remittance_allocations(method);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_id ON remittance_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_remittance_allocations_payment_batch_id ON remittance_allocations(payment_batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_payment_split
  ON remittance_allocations(payment_split_id) WHERE payment_split_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_batch_split_no_check
  ON remittance_allocations(payment_batch_split_id)
  WHERE payment_batch_split_id IS NOT NULL AND received_check_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_received_check
  ON remittance_allocations(received_check_id) WHERE received_check_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_remittance_allocations_cash_entry
  ON remittance_allocations(cash_entry_id) WHERE cash_entry_id IS NOT NULL;
