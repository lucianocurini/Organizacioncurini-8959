import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { X, RefreshCw } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { addCalendarMonths, addCalendarDays, isValidCalendarDate } from "../../../lib/installments/plan";
import {
  validateRebillingForm, buildRebillingEditPayload, buildRebillingCreatePayload,
  computePlanAmountMismatchWarning, type RebillingModalFormState,
} from "../../lib/rebilling-modal";

interface Props {
  policy: any;
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}

// Sugiere el fin de período como (inicio + N meses) - 1 día, en fechas
// calendario puras — sin pasar por Date+zona horaria local (evita
// desplazamientos por UTC en fechas como 31 de enero o fin de febrero).
function addMonths(dateStr: string, months: number): string {
  if (!dateStr || !months || !isValidCalendarDate(dateStr)) return "";
  return addCalendarDays(addCalendarMonths(dateStr, months), -1);
}

const CYCLE_MONTHS: Record<string, number> = {
  mensual: 1, trimestral: 3, cuatrimestral: 4, semestral: 6, anual: 12,
};
const CYCLE_LABEL: Record<string, string> = {
  mensual: "Mensual", trimestral: "Trimestral", cuatrimestral: "Cuatrimestral", semestral: "Semestral", anual: "Anual",
};

// Modo determinado únicamente por la presencia de `initial` — nunca por
// installmentCount ni por ningún otro campo del plan. Editar datos de una
// refacturación existente NUNCA exige ni envía cantidad de cuotas o primer
// vencimiento: eso pertenece exclusivamente a la acción separada "Corregir
// plan de cuotas" (ver botón en la lista de refacturaciones de
// poliza-detail.tsx, que usa POST /rebillings/:id/installments/rebuild).
export function RebillingModal({ policy, initial, onClose, onSaved }: Props) {
  const isEditMode = !!initial;
  const months = CYCLE_MONTHS[policy.billingCycle] ?? 0;

  const defaultStart = initial?.billingStart ?? policy._nextStart ?? policy.startDate ?? "";
  const defaultEnd = initial?.billingEnd ?? (months ? addMonths(defaultStart, months) : "");

  const [form, setForm] = useState<RebillingModalFormState>({
    billingStart: defaultStart,
    billingEnd: defaultEnd,
    premium: initial?.premium != null ? String(initial.premium) : (policy.premium != null ? String(policy.premium) : ""),
    monthlyFee: initial?.monthlyFee != null ? String(initial.monthlyFee) : (policy.monthlyFee != null ? String(policy.monthlyFee) : ""),
    // Solo relevantes en modo alta — en modo edición nunca se muestran, nunca
    // se validan y nunca se envían al backend.
    installmentCount: !isEditMode && months ? String(months) : "",
    firstDueDate: defaultStart,
    sumInsured: initial?.sumInsured != null ? String(initial.sumInsured) : (policy.sumInsured != null ? String(policy.sumInsured) : ""),
    deductible: initial?.deductible != null ? String(initial.deductible) : (policy.deductible != null ? String(policy.deductible) : ""),
    notes: initial?.notes ?? "",
  });
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string) => setForm(f => {
    const next = { ...f, [k]: v };
    if (k === "billingStart") {
      if (months) next.billingEnd = addMonths(v, months);
      if (!isEditMode && f.firstDueDate === f.billingStart) next.firstDueDate = v;
    }
    return next;
  });

  // Advertencia informativa (no bloqueante) — ver computePlanAmountMismatchWarning.
  const planAmountMismatchWarning = isEditMode
    ? computePlanAmountMismatchWarning(form.monthlyFee, form.premium, initial?.installmentCount)
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validateRebillingForm(form, isEditMode);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setLoading(true);
    try {
      if (isEditMode) {
        await api.put(`/api/rebillings/${initial.id}`, buildRebillingEditPayload(form));
        toast.success("Refacturación actualizada");
      } else {
        await api.post(`/api/policies/${policy.id}/rebillings`, buildRebillingCreatePayload(form));
        toast.success("Refacturación registrada");
      }
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  const inp = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";
  const lbl = "block text-xs text-gray-400 mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md my-4 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-violet-400" />
            <h2 className="text-base font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
              {isEditMode ? "Editar datos de la refacturación" : "Nueva Refacturación"}
            </h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Contexto */}
        <div className="px-6 pt-4 pb-2">
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl px-4 py-3 text-xs space-y-1">
            <p className="text-gray-400">Póliza <span className="text-blue-400 font-mono font-medium">{policy.policyNumber}</span></p>
            <p className="text-gray-500">Vigencia original: {formatDate(policy.startDate)} → {formatDate(policy.endDate)}</p>
            {months > 0 && (
              <p className="text-gray-500">
                Ciclo: <span className="text-gray-300">{CYCLE_LABEL[policy.billingCycle]}</span>
                {" — "}fecha fin se calcula automáticamente
              </p>
            )}
          </div>
          {isEditMode && (
            <div className="mt-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-xs text-blue-300">
              Esta pantalla solo edita datos administrativos (fechas, importes, franquicia, notas). No crea, borra ni
              recalcula cuotas. Para corregir el plan de cuotas, usá la acción separada "Corregir plan de cuotas".
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 pt-3 space-y-4">

          {/* Fechas */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Inicio vigencia *</label>
              <input type="date" className={inp} value={form.billingStart}
                onChange={e => set("billingStart", e.target.value)} required />
            </div>
            <div>
              <label className={lbl}>Fin vigencia *</label>
              <input type="date" className={inp} value={form.billingEnd}
                onChange={e => set("billingEnd", e.target.value)} required />
            </div>
          </div>

          {/* Plan de cuotas — SOLO en alta. En edición no se muestra: cantidad
              de cuotas y primer vencimiento pertenecen a "Corregir plan de
              cuotas", nunca a esta pantalla. */}
          {!isEditMode && (
            <div className="border border-[#1f2937] rounded-xl p-4 bg-[#0d1424] space-y-3">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Plan de cuotas</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Cantidad de cuotas *</label>
                  <input type="number" min="1" step="1" className={inp} value={form.installmentCount}
                    onChange={e => set("installmentCount", e.target.value)} placeholder="Ej: 3" required />
                </div>
                <div>
                  <label className={lbl}>Primer vencimiento *</label>
                  <input type="date" className={inp} value={form.firstDueDate}
                    onChange={e => set("firstDueDate", e.target.value)} required />
                </div>
              </div>
              <div>
                <label className={lbl}>Cuota mensual (ARS) *</label>
                <input type="number" className={inp} value={form.monthlyFee}
                  onChange={e => set("monthlyFee", e.target.value)} placeholder="0" required />
                <p className="text-[11px] text-gray-600 mt-1">Importe total del grupo de cuotas = cuota mensual × cantidad de cuotas.</p>
              </div>
            </div>
          )}

          {/* Montos */}
          <div className="border border-[#1f2937] rounded-xl p-4 bg-[#0d1424] space-y-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Valores actualizados</p>
            <div>
              <label className={lbl}>Prima / Monto total (ARS)</label>
              <input type="number" className={inp} value={form.premium}
                onChange={e => set("premium", e.target.value)} placeholder="0" />
              <p className="text-[11px] text-gray-600 mt-1">Informativo — no se usa para calcular las cuotas.</p>
            </div>
            {isEditMode && (
              <div>
                <label className={lbl}>Cuota mensual (ARS)</label>
                <input type="number" className={inp} value={form.monthlyFee}
                  onChange={e => set("monthlyFee", e.target.value)} placeholder="0" />
                <p className="text-[11px] text-gray-600 mt-1">Dato administrativo — cambiarlo acá no recalcula las cuotas ya generadas.</p>
              </div>
            )}
            <div>
              <label className={lbl}>Suma asegurada (ARS)</label>
              <input type="number" className={inp} value={form.sumInsured}
                onChange={e => set("sumInsured", e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className={lbl}>Franquicia (ARS)</label>
              <input type="number" min="0" className={inp} value={form.deductible}
                onChange={e => set("deductible", e.target.value)} placeholder="0" />
              <p className="text-[11px] text-gray-600 mt-1">Si se informa, también actualiza la franquicia vigente de la póliza.</p>
            </div>
          </div>

          {planAmountMismatchWarning && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
              {planAmountMismatchWarning}
            </div>
          )}

          {/* Notas */}
          <div>
            <label className={lbl}>Notas</label>
            <textarea className={inp + " resize-none"} rows={2} value={form.notes}
              onChange={e => set("notes", e.target.value)}
              placeholder="Ajuste por inflación, cambio de cobertura..." />
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
              Cancelar
            </button>
            <button type="submit" disabled={loading}
              className="px-5 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
              {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {isEditMode ? "Guardar cambios" : "Registrar refacturación"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
