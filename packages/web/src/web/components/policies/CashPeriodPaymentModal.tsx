import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { X, Banknote, CheckCircle2, AlertTriangle } from "lucide-react";
import { formatCurrency, formatCurrencyCents, formatDate } from "@/lib/utils";
import { toArgentinaCalendarDay } from "../../../lib/dates/argentina-date";
import {
  createBatchSplitRow, addBatchSplitRow, removeBatchSplitRow, updateBatchSplitRow,
  syncSingleBatchSplitAmount, addCheckToSplit, removeCheckFromSplit, updateCheckInSplit,
  syncChequeSplitAmounts, updateSplitMethodPreservingChecks, computeSplitTotals,
  type BatchSplitFormRow,
} from "@/lib/payment-batch-form";
import {
  validateCashPeriodSplitsForm, validateCashPeriodDifferenceResolution,
  buildCashPeriodPaymentPayload, calculateBatchReceivedAppliedDifference,
  isRoundingAdjustmentEligible, buildRoundingAdjustmentPayload,
  type CashPeriodGroup,
} from "@/lib/cash-period-payment-form";
import { CheckSubForm } from "@/components/payments/CheckSubForm";

interface Props {
  policyNumber: string;
  group: CashPeriodGroup;
  onClose: () => void;
  onSaved: () => void;
}

const METHODS = [
  { value: "efectivo", label: "Efectivo" },
  { value: "transferencia", label: "Transferencia" },
  { value: "cheque", label: "Cheque" },
  { value: "transferencia_compania", label: "Transferencia directa a compañía" },
  { value: "link_pago", label: "Link de pago" },
];

export function CashPeriodPaymentModal({ policyNumber, group, onClose, onSaved }: Props) {
  const [paymentDate, setPaymentDate] = useState(toArgentinaCalendarDay());
  const [splits, setSplits] = useState<BatchSplitFormRow[]>([
    syncSingleBatchSplitAmount([createBatchSplitRow("efectivo", "")], String(group.cashAmountCents / 100))[0]!,
  ]);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<any[] | null>(null);
  const [receipt, setReceipt] = useState<any | null>(null);
  const [roundingAccepted, setRoundingAccepted] = useState(false);

  const discountCents = group.nominalAmountCents - group.cashAmountCents;
  const validation = validateCashPeriodSplitsForm(group.cashAmountCents, splits);

  // Ronda 2 — tolerancia de redondeo: los medios pueden diferir del importe
  // contado hasta $5 inclusive, con aceptación explícita del checkbox más
  // abajo — nunca saldo a favor/deudor (ver cash-period-payment-form.ts).
  const totals = computeSplitTotals(String(group.cashAmountCents / 100), splits);
  const difference = calculateBatchReceivedAppliedDifference(totals.distributedCents, group.cashAmountCents);
  const differenceValidation = validateCashPeriodDifferenceResolution(difference, roundingAccepted);

  // Cambiar cualquier importe puede cambiar la diferencia — la aceptación
  // previa nunca se arrastra a una diferencia distinta (mismo criterio que
  // "Cobrar en lote").
  useEffect(() => {
    setRoundingAccepted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [difference.differenceCents]);

  function setSplitsAndSync(next: BatchSplitFormRow[]) {
    setSplits(syncChequeSplitAmounts(next.length === 1 ? syncSingleBatchSplitAmount(next, String(group.cashAmountCents / 100)) : next));
  }

  async function doSubmit(confirmPossibleDuplicates = false) {
    setLoading(true);
    try {
      const payload = buildCashPeriodPaymentPayload({
        policyId: group.policyId, rebillingId: group.rebillingId, paymentDate, splits, notes, confirmPossibleDuplicates,
        accountDifferenceResolution: difference.kind === "exacto" ? null : buildRoundingAdjustmentPayload(),
      });
      const result = await api.post("/api/payment-batches/cash-period-payment", payload);
      setReceipt(result);
      toast.success("Período pagado de contado");
    } catch (e: any) {
      if (e.body?.code === "CHECK_POSSIBLE_DUPLICATE" && Array.isArray(e.body?.duplicates)) {
        setDuplicateWarning(e.body.duplicates);
      } else {
        toast.error(e.message || "No se pudo registrar el pago de contado");
      }
    } finally {
      setLoading(false);
    }
  }

  const inp = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";
  const lbl = "block text-xs text-gray-400 mb-1.5";

  // ── Vista de éxito / comprobante ──────────────────────────────────────────
  if (receipt) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto">
        <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md my-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h2 className="text-base font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Pago contado registrado</h2>
            </div>
            <button onClick={() => { onSaved(); onClose(); }} className="text-gray-400 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="px-6 py-5 space-y-3 text-sm">
            <p className="text-gray-400">Modalidad: <span className="text-white font-medium">Pago contado</span></p>
            <p className="text-gray-400">Póliza <span className="text-blue-400 font-mono">{policyNumber}</span> — {group.label}</p>
            <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl px-4 py-3 space-y-1.5">
              <div className="flex justify-between"><span className="text-gray-500">Total nominal en cuotas</span><span className="text-white">{formatCurrencyCents(receipt.nominalAmountCents)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Descuento comercial</span><span className="text-emerald-400">-{formatCurrencyCents(receipt.discountAmountCents)}</span></div>
              <div className="flex justify-between border-t border-[#1f2937] pt-1.5 mt-1.5"><span className="text-gray-300 font-medium">Importe contado cobrado</span><span className="text-white font-semibold">{formatCurrencyCents(receipt.cashAmountCents)}</span></div>
              {!!receipt.roundingAdjustmentCents && (
                <>
                  <div className="flex justify-between text-xs pt-1">
                    <span className="text-gray-500">Dinero real recibido</span>
                    <span className="text-gray-300">{formatCurrencyCents(receipt.actualReceivedCents)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Ajuste por redondeo</span>
                    <span className={receipt.roundingAdjustmentCents > 0 ? "text-emerald-400" : "text-red-400"}>
                      {receipt.roundingAdjustmentCents > 0 ? "+" : ""}{formatCurrencyCents(receipt.roundingAdjustmentCents)}
                    </span>
                  </div>
                </>
              )}
            </div>
            <p className="text-xs text-gray-500">{group.installmentCount} cuota{group.installmentCount === 1 ? "" : "s"} cancelada{group.installmentCount === 1 ? "" : "s"} — cobro #{receipt.id}.</p>
          </div>
          <div className="flex justify-end px-6 pb-6">
            <button onClick={() => { onSaved(); onClose(); }} className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-all">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Confirmación explícita antes de guardar (Regla 12) ─────────────────────
  if (confirming) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto">
        <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md my-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
            <h2 className="text-base font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Confirmar pago de contado</h2>
            <button onClick={() => setConfirming(false)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
          </div>
          <div className="px-6 py-5 space-y-3 text-sm">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
              Esta acción cancelará TODAS las {group.installmentCount} cuota{group.installmentCount === 1 ? "" : "s"} de {group.label.toLowerCase()} por el importe contado, no por el total nominal. No se puede deshacer sin anular el cobro completo.
            </div>
            {/* Vencimiento informativo (Regla del usuario, ronda 2): un
                contado vencido sigue siendo cobrable sin restricción — esta
                advertencia es solo para que el usuario esté al tanto, nunca
                bloquea "Confirmar cobro" más abajo. */}
            {group.deadlineStatus === "vencido" && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>
                  El plazo informativo de este contado venció el {formatDate(group.deadline)}. Podés continuar igual —
                  el vencimiento es solo informativo y no bloquea el cobro.
                </span>
              </div>
            )}
            <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl px-4 py-3 space-y-1.5">
              <div className="flex justify-between"><span className="text-gray-500">Total nominal en cuotas</span><span className="text-white">{formatCurrency(group.nominalAmountCents / 100)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Descuento comercial</span><span className="text-emerald-400">-{formatCurrency(discountCents / 100)}</span></div>
              <div className="flex justify-between border-t border-[#1f2937] pt-1.5 mt-1.5"><span className="text-gray-300 font-medium">A cobrar (contado)</span><span className="text-white font-semibold">{formatCurrency(group.cashAmountCents / 100)}</span></div>
              {difference.kind !== "exacto" && (
                <div className="flex justify-between text-xs pt-1">
                  <span className="text-gray-500">Ajuste por redondeo aceptado</span>
                  <span className={difference.kind === "saldo_a_favor" ? "text-emerald-400" : "text-red-400"}>
                    {difference.kind === "saldo_a_favor" ? "+" : "-"}{formatCurrencyCents(Math.abs(difference.differenceCents))}
                  </span>
                </div>
              )}
            </div>
            {duplicateWarning && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-300">
                Se detectaron posibles cheques duplicados. Verificá antes de confirmar de nuevo.
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3 px-6 pb-6">
            <button onClick={() => setConfirming(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Volver</button>
            <button
              disabled={loading}
              onClick={() => doSubmit(duplicateWarning != null)}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
            >
              {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Confirmar cobro
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Formulario principal ────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md my-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <div className="flex items-center gap-2">
            <Banknote className="w-4 h-4 text-emerald-400" />
            <h2 className="text-base font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Pagar período de contado</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 pt-4 pb-2">
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl px-4 py-3 text-xs space-y-1">
            <p className="text-gray-400">Póliza <span className="text-blue-400 font-mono font-medium">{policyNumber}</span> — {group.label}</p>
            <p className="text-gray-500">Cancela las {group.installmentCount} cuota{group.installmentCount === 1 ? "" : "s"} del período de una sola vez.</p>
            <p className="flex items-center gap-1.5">
              <span className="text-gray-500">Vencimiento informativo:</span>
              <span className="text-gray-300">{formatDate(group.deadline)}</span>
              <span className={
                "px-1.5 py-0.5 rounded border text-[10px] font-medium " +
                (group.deadlineStatus === "vigente"
                  ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                  : "text-amber-300 border-amber-500/30 bg-amber-500/10")
              }>
                {group.deadlineStatus === "vigente" ? "Vigente" : "Vencido"}
              </span>
            </p>
          </div>
          <div className="mt-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-xs space-y-1">
            <div className="flex justify-between text-gray-300"><span>Total nominal en cuotas</span><span>{formatCurrency(group.nominalAmountCents / 100)}</span></div>
            <div className="flex justify-between text-emerald-300"><span>Descuento comercial</span><span>-{formatCurrency(discountCents / 100)}</span></div>
            <div className="flex justify-between text-white font-semibold border-t border-emerald-500/20 pt-1 mt-1"><span>Importe a cobrar</span><span>{formatCurrency(group.cashAmountCents / 100)}</span></div>
          </div>
        </div>

        <div className="px-6 pb-6 pt-3 space-y-4">
          <div>
            <label className={lbl}>Fecha de cobro *</label>
            <input type="date" className={inp} value={paymentDate} onChange={e => setPaymentDate(e.target.value)} required />
          </div>

          <div className="border border-[#1f2937] rounded-xl p-4 bg-[#0d1424] space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Medios de pago</p>
              <button type="button" onClick={() => setSplitsAndSync(addBatchSplitRow(splits))} className="text-xs text-blue-400 hover:text-blue-300">+ Agregar medio</button>
            </div>
            {splits.map((split) => (
              <div key={split.uid} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <select
                    className={inp}
                    value={split.method}
                    onChange={e => setSplitsAndSync(updateSplitMethodPreservingChecks(splits, split.uid, e.target.value))}
                  >
                    {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <input
                    type="number" className={inp} placeholder="Importe" value={split.amount}
                    disabled={split.method === "cheque"}
                    onChange={e => setSplitsAndSync(updateBatchSplitRow(splits, split.uid, { amount: e.target.value }))}
                  />
                  {splits.length > 1 && (
                    <button type="button" onClick={() => setSplitsAndSync(removeBatchSplitRow(splits, split.uid))} className="text-gray-500 hover:text-red-400 shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {split.method === "cheque" && (
                  <CheckSubForm
                    split={split}
                    onAdd={() => setSplitsAndSync(addCheckToSplit(splits, split.uid))}
                    onRemove={(checkUid) => setSplitsAndSync(removeCheckFromSplit(splits, split.uid, checkUid))}
                    onUpdate={(checkUid, patch) => setSplitsAndSync(updateCheckInSplit(splits, split.uid, checkUid, patch))}
                  />
                )}
              </div>
            ))}
            {!validation.valid && validation.errorMessage && (
              <p className="text-xs text-red-400">{validation.errorMessage}</p>
            )}

            {/* Ronda 2 — tolerancia de redondeo: diferencia REAL de
                instrumentos contra el importe contado (nunca el descuento
                comercial, que ya está descontado del total a cobrar). Solo
                se muestra si los medios cargados forman un importe válido. */}
            {validation.valid && difference.kind !== "exacto" && (
              <div className={
                "rounded-xl border p-3 space-y-2 " +
                (difference.kind === "saldo_a_favor" ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20")
              }>
                <div className="flex items-center gap-2">
                  <AlertTriangle className={"w-3.5 h-3.5 flex-shrink-0 " + (difference.kind === "saldo_a_favor" ? "text-emerald-400" : "text-red-400")} />
                  <p className={"text-xs font-semibold " + (difference.kind === "saldo_a_favor" ? "text-emerald-300" : "text-red-300")}>
                    {difference.kind === "saldo_a_favor" ? "Sobrante" : "Faltante"} de instrumentos: {formatCurrencyCents(Math.abs(difference.differenceCents))}
                  </p>
                </div>
                <p className="text-xs text-gray-400">
                  Los medios cargados no suman exactamente el importe contado (${(group.cashAmountCents / 100).toLocaleString("es-AR")}) — nunca el descuento comercial, ya descontado del total a cobrar.
                </p>
                {isRoundingAdjustmentEligible(difference.differenceCents) ? (
                  <label className="flex items-start gap-2 text-xs text-gray-300">
                    <input
                      type="checkbox"
                      checked={roundingAccepted}
                      onChange={(e) => setRoundingAccepted(e.target.checked)}
                      className="mt-0.5 accent-blue-600"
                    />
                    Aceptar ajuste por redondeo de {formatCurrencyCents(Math.abs(difference.differenceCents))}
                  </label>
                ) : (
                  <p className="text-xs text-amber-300">
                    La diferencia supera el máximo tolerado de $5,00 — revisá los importes cargados.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className={lbl}>Notas</label>
            <textarea className={inp + " resize-none"} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Opcional..." />
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
            <button
              type="button"
              disabled={!validation.valid || !differenceValidation.valid}
              onClick={() => setConfirming(true)}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all"
            >
              Continuar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
