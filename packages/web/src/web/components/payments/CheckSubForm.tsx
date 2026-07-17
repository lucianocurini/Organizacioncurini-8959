import { Trash2, Plus } from "lucide-react";
import { type BatchSplitFormRow, type CheckFormRow, amountStringToCentsStrict } from "@/lib/payment-batch-form";
import { formatCurrencyCents } from "@/lib/utils";

// Subformulario de cheques (uno o varios) para un split method="cheque" —
// extraído de PendingInstallmentsBatchTab.tsx (Cobrar en lote) para
// reutilizarlo también en el modal de Imputar pago individual
// (cobranzas.tsx). Puramente de presentación: no conoce si el split
// pertenece a un lote o a un pago individual, solo opera sobre
// BatchSplitFormRow/CheckFormRow (ver web/lib/payment-batch-form.ts).
export function CheckSubForm({
  split, onAdd, onRemove, onUpdate,
}: {
  split: BatchSplitFormRow;
  onAdd: () => void;
  onRemove: (checkUid: string) => void;
  onUpdate: (checkUid: string, patch: Partial<Omit<CheckFormRow, "uid">>) => void;
}) {
  // split.amount es el importe objetivo de ESTE split (con un único medio en
  // el lote/pago, ya viene sincronizado al total real, centavos incluidos —
  // ver syncSingleBatchSplitAmount). El campo de importe de arriba puede
  // mostrarlo redondeado a peso en otros lugares de la pantalla; acá se
  // repite con los centavos reales para que el usuario no tenga que
  // adivinar/copiar un valor redondeado al cargar cada cheque.
  const targetCents = amountStringToCentsStrict(split.amount);
  return (
    <div className="pl-3 border-l-2 border-yellow-500/30 space-y-2">
      {targetCents != null && (
        <p className="text-[11px] text-yellow-300/80">
          El importe total de cheques debe ser exactamente {formatCurrencyCents(targetCents)}.
        </p>
      )}
      {split.checks.map((chk, idx) => (
        <div key={chk.uid} className="bg-black/20 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/40 uppercase">Cheque {idx + 1}</span>
            {split.checks.length > 1 && (
              <button onClick={() => onRemove(chk.uid)} className="text-white/30 hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <input placeholder="Número *" value={chk.checkNumber} onChange={(e) => onUpdate(chk.uid, { checkNumber: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <input placeholder="Banco *" value={chk.bankName} onChange={(e) => onUpdate(chk.uid, { bankName: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <input placeholder="Cód. banco" value={chk.bankCode} onChange={(e) => onUpdate(chk.uid, { bankCode: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <input placeholder="Librador" value={chk.drawerName} onChange={(e) => onUpdate(chk.uid, { drawerName: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <input placeholder="Doc. librador" value={chk.drawerDocument} onChange={(e) => onUpdate(chk.uid, { drawerDocument: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <input placeholder="Importe *" type="number" value={chk.amount} onChange={(e) => onUpdate(chk.uid, { amount: e.target.value })}
              className="px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            <div>
              <label className="text-[9px] text-white/30 block">Emisión</label>
              <input type="date" value={chk.issueDate} onChange={(e) => onUpdate(chk.uid, { issueDate: e.target.value })}
                className="w-full px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            </div>
            <div className="col-span-2">
              <label className="text-[9px] text-white/30 block">Vencimiento *</label>
              <input type="date" value={chk.dueDate} onChange={(e) => onUpdate(chk.uid, { dueDate: e.target.value })}
                className="w-full px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
            </div>
            <input placeholder="Observaciones" value={chk.notes} onChange={(e) => onUpdate(chk.uid, { notes: e.target.value })}
              className="col-span-3 px-2 py-1 bg-white/5 border border-white/10 rounded text-white text-[11px] outline-none focus:border-yellow-500" />
          </div>
        </div>
      ))}
      <button onClick={onAdd} className="flex items-center gap-1 text-[11px] text-yellow-400 hover:text-yellow-300">
        <Plus className="w-3 h-3" /> Agregar otro cheque
      </button>
    </div>
  );
}
