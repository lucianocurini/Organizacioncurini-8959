import React, { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "sonner";
import {
  DollarSign, Plus, Search, TrendingUp, CreditCard,
  Banknote, ArrowRightLeft, Trash2, Edit2, X, ChevronDown, Link, CheckSquare,
  ClipboardList, AlertCircle, ChevronRight, ReceiptText, Building2, Check, ShoppingCart, Save, Layers, Ban
} from "lucide-react";
import { PendingInstallmentsBatchTab } from "@/components/payments/PendingInstallmentsBatchTab";
import { cn, formatCurrency as _fc } from "@/lib/utils";
import {
  splitsFromPayment, computeSplitTotals, groupSplitsByMethod,
  SINGLE_SPLIT_MISMATCH_MESSAGE, isImputarButtonDisabled,
} from "@/lib/payment-splits-form";
import {
  type BatchSplitFormRow, type CheckFormRow,
  createBatchSplitRow, addBatchSplitRow, removeBatchSplitRow, updateBatchSplitRow,
  syncSingleBatchSplitAmount, addCheckToSplit, removeCheckFromSplit, updateCheckInSplit,
  validateBatchSplitsForm, updateSplitMethodPreservingChecks, splitsToPaymentSplitsPayload,
} from "@/lib/payment-batch-form";
import { CheckSubForm } from "@/components/payments/CheckSubForm";
import { getPendingItemPaymentGroup } from "@/lib/rendicion-pending";

function formatCurrency(v: number, short = false) {
  if (short) {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v}`;
  }
  return _fc(v);
}

const METHOD_LABELS: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transf. cuenta propia",
  cheque: "Cheque",
  link_pago: "Link de Pago",
  transferencia_compania: "Transf. a Compañía",
};

const BREAKDOWN_LABELS: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  cheque: "Cheque",
  pronto_pago: "Pronto Pago",
};

const METHOD_COLORS: Record<string, string> = {
  efectivo: "bg-green-500/20 text-green-400 border-green-500/30",
  transferencia: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  cheque: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  link_pago: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  transferencia_compania: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

// Métodos que van directo a la compañía
const DIRECTO_COMPANIA_METHODS = ["transferencia_compania", "link_pago"];

const STATUS_COLORS: Record<string, string> = {
  confirmado: "bg-green-500/20 text-green-400 border-green-500/30",
  pendiente: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  anulado: "bg-red-500/20 text-red-400 border-red-500/30",
};

const PP_SURCHARGE = 800;

interface PaymentRow {
  payment: {
    id: number;
    policyId: number | null;
    installmentId: number | null;
    manualPayer: string | null;
    manualPolicyNumber: string | null;
    manualCompany: string | null;
    amount: number;
    paymentMethod: string;
    paymentDate: string;
    periodMonth: string | null;
    notes: string | null;
    status: string;
    rendered: number;
    hasSurcharge: boolean;
    hasChecks: boolean;
    dueDate: string | null;
    splits: { method: string; amountCents: number; notes: string | null }[];
  };
  policy: { id: number; policyNumber: string } | null;
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
}

interface PolicyOption {
  policy: { id: number; policyNumber: string };
  insured: { name: string } | null;
  company: { id: number; name: string } | null;
}

interface Stats {
  total: number;
  count: number;
  byMethod: Record<string, number>;
  byMonth: Record<string, number>;
}

function PaymentModal({ open, onClose, onSaved, editing }: {
  open: boolean; onClose: () => void; onSaved: () => void; editing: PaymentRow | null;
}) {
  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [policySearch, setPolicySearch] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [installments, setInstallments] = useState<any[]>([]);
  const [applyProntoPagoSurcharge, setApplyProntoPagoSurcharge] = useState(true);
  const [form, setForm] = useState({
    policyId: "",
    installmentId: "",
    manualPayer: "",
    manualPolicyNumber: "",
    manualCompany: "",
    amount: "",
    splits: [createBatchSplitRow("efectivo")] as BatchSplitFormRow[],
    paymentDate: new Date().toISOString().split("T")[0],
    dueDate: "",
    periodMonth: "",
    notes: "",
    status: "confirmado",
  });

  useEffect(() => {
    if (!open) return;
    api.get("/api/policies").then(setPolicies).catch(() => {});
    if (editing) {
      const noPolicy = editing.payment.policyId == null;
      setManualMode(noPolicy);
      const pId = editing.payment.policyId ? String(editing.payment.policyId) : "";
      setForm({
        policyId: pId,
        installmentId: editing.payment.installmentId ? String(editing.payment.installmentId) : "",
        manualPayer: editing.payment.manualPayer || "",
        manualPolicyNumber: editing.payment.manualPolicyNumber || "",
        manualCompany: editing.payment.manualCompany || "",
        amount: String(editing.payment.amount),
        // Etapa 3B-2: un combinado SIEMPRE se precarga desde payment.splits
        // (nunca desde paymentMethod, que puede valer "combinado" y no es un
        // método real seleccionable en ninguna fila).
        // syncSingleBatchSplitAmount es no-op con 2+ splits — solo garantiza
        // que, si el pago tiene un único medio, su importe quede igual al
        // total (defensivo: cubre cualquier dato legacy con el split vacío).
        // Migración 0028: los cheques existentes de un split ya cargado NO se
        // reconstruyen acá (checks: []) — el backend bloquea con 409 editar
        // los splits de un pago que ya tiene cheques reales (ver PUT
        // /payments/:id), así que este formulario solo necesita `checks`
        // poblado para un split cheque NUEVO que el usuario está cargando.
        splits: syncSingleBatchSplitAmount(
          splitsFromPayment(editing.payment).map((s) => ({ ...s, checks: [] as CheckFormRow[] })),
          String(editing.payment.amount)
        ),
        paymentDate: editing.payment.paymentDate,
        dueDate: editing.payment.dueDate || "",
        periodMonth: editing.payment.periodMonth || "",
        notes: editing.payment.notes || "",
        status: editing.payment.status,
      });
      setApplyProntoPagoSurcharge(editing.payment.hasSurcharge);
      if (pId) api.get(`/api/policies/${pId}/installments`).then(setInstallments).catch(() => setInstallments([]));
    } else {
      setManualMode(false);
      setInstallments([]);
      setApplyProntoPagoSurcharge(true);
      setForm({
        policyId: "", installmentId: "", manualPayer: "", manualPolicyNumber: "", manualCompany: "",
        amount: "", splits: [createBatchSplitRow("efectivo")],
        paymentDate: new Date().toISOString().split("T")[0],
        dueDate: "", periodMonth: "", notes: "", status: "confirmado",
      });
    }
  }, [open, editing]);

  // Load installments when policy changes
  useEffect(() => {
    if (form.policyId) {
      api.get(`/api/policies/${form.policyId}/installments`).then(setInstallments).catch(() => setInstallments([]));
    } else {
      setInstallments([]);
    }
  }, [form.policyId]);

  const filteredPolicies = policies.filter(p =>
    p.policy.policyNumber.toLowerCase().includes(policySearch.toLowerCase()) ||
    (p.insured?.name || "").toLowerCase().includes(policySearch.toLowerCase())
  );
  const selectedPolicy = policies.find(p => String(p.policy.id) === form.policyId);
  const pendingInstallments = installments.filter((i: any) => i.status !== "pagada" && i.status !== "no_exigible" && !i.rendered);
  const selectedInstallment = installments.find((i: any) => String(i.id) === form.installmentId);

  // Etapa 3B-2: validación completa de la sección de splits — se usa tanto
  // para el disabled del botón Guardar como (repetida) adentro de handleSave,
  // para no depender exclusivamente del disabled ante un estado stale.
  // Migración 0028: validateBatchSplitsForm agrega la validación de los
  // cheques de cada split method="cheque" (número/banco/vencimiento
  // obligatorios, suma de cheques = importe del split) sobre la misma
  // validación de siempre (método/suma total/grupo propio-vs-directo) — es
  // la misma función que ya usa "Cobrar en lote", ninguna lógica nueva.
  const targetAmountCents = Math.round(Number(form.amount) * 100);
  const splitsValidation = validateBatchSplitsForm(targetAmountCents, form.splits);
  const splitTotals = computeSplitTotals(form.amount, form.splits);

  // Si el grupo deja de ser "own" (ej. el usuario cambia todas las filas a
  // directo a compañía), el recargo Pronto Pago no puede seguir marcado.
  useEffect(() => {
    if (splitsValidation.group !== "own" && applyProntoPagoSurcharge) {
      setApplyProntoPagoSurcharge(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitsValidation.group]);

  async function handleSave() {
    if (!manualMode && !form.policyId) {
      toast.error("Seleccioná una póliza o usá imputación manual");
      return;
    }
    if (manualMode && !form.manualPayer && !form.manualPolicyNumber) {
      toast.error("Completá al menos el pagador o N° de póliza manual");
      return;
    }
    if (!form.amount || !form.paymentDate) {
      toast.error("Completá importe y fecha");
      return;
    }
    // Re-validar acá, no confiar solo en el disabled del botón.
    const validation = validateBatchSplitsForm(Math.round(Number(form.amount) * 100), form.splits);
    if (!validation.valid) {
      toast.error(validation.errorMessage || "Revisá el desglose de medios de pago.");
      return;
    }
    setSaving(true);
    const body: any = {
      amount: Number(form.amount),
      // El backend decide resolvedPaymentMethod a partir de splits — nunca
      // se envía paymentMethod="combinado" ni un método suelto acá.
      splits: splitsToPaymentSplitsPayload(form.splits),
      paymentDate: form.paymentDate,
      dueDate: form.dueDate || null,
      periodMonth: form.periodMonth || null,
      notes: form.notes || null,
      status: form.status,
    };
    if (manualMode) {
      body.policyId = null;
      body.installmentId = null;
      body.manualPayer = form.manualPayer || null;
      body.manualPolicyNumber = form.manualPolicyNumber || null;
      body.manualCompany = form.manualCompany || null;
    } else {
      body.policyId = Number(form.policyId);
      body.installmentId = form.installmentId ? Number(form.installmentId) : null;
      body.manualPayer = null;
      body.manualPolicyNumber = null;
      body.manualCompany = null;
    }
    const isRivadaviaBody = manualMode
      ? form.manualCompany.toLowerCase().includes("rivadavia")
      : (selectedPolicy?.company?.name?.toLowerCase().includes("rivadavia") ?? false);
    if (isRivadaviaBody && validation.group === "own") {
      body.applyProntoPagoSurcharge = applyProntoPagoSurcharge;
    }
    try {
      if (editing) await api.put(`/api/payments/${editing.payment.id}`, body);
      else await api.post("/api/payments", body);
      toast.success(editing ? "Pago actualizado" : "Pago imputado");
      onSaved(); onClose();
    } catch (err: any) {
      const msg = err?.message || "";
      const status = err?.status;
      // Los errores 400/409 del backend ya traen un mensaje específico y
      // útil (mixed, suma inválida, combinado sin splits, rendido, cuota ya
      // pagada, recargo ya rendido) — se muestra tal cual. El genérico queda
      // solo para fallos inesperados (5xx, red, sin mensaje).
      if (msg && status && status < 500) toast.error(msg);
      else toast.error("Error al guardar pago");
    }
    setSaving(false);
  }

  const isRendered = !!(editing && editing.payment.rendered === 1);
  const isRivadaviaSrc = manualMode
    ? form.manualCompany.toLowerCase().includes("rivadavia")
    : (selectedPolicy?.company?.name?.toLowerCase().includes("rivadavia") ?? false);
  // Etapa 3B-2: el grupo se decide por los splits reales, no por un único
  // form.paymentMethod (que ya no existe en el estado). Con grupo "mixed" el
  // checkbox tampoco se muestra — nunca puede considerarse válido.
  const showSurchargeCheckbox = isRivadaviaSrc && splitsValidation.group === "own";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0d1424] border border-[#1f2937] rounded-2xl shadow-2xl z-10 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <h2 className="text-white font-semibold text-lg">{editing ? "Editar pago" : "Imputar pago"}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {isRendered && (
            <div className="p-3 bg-amber-900/20 border border-amber-500/20 rounded-lg">
              <p className="text-xs text-amber-400">Este pago ya fue rendido. Solo podés editar las notas.</p>
            </div>
          )}

          {/* Toggle manual/póliza */}
          <div className="flex rounded-lg border border-[#2d3748] overflow-hidden text-sm">
            <button type="button" onClick={() => setManualMode(false)}
              className={cn("flex-1 py-2 text-center transition-colors",
                !manualMode ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
              Vincular a póliza
            </button>
            <button type="button" onClick={() => setManualMode(true)}
              className={cn("flex-1 py-2 text-center transition-colors",
                manualMode ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
              Imputación manual
            </button>
          </div>

          {!manualMode ? (
            /* Póliza selector + cuota */
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Póliza</label>
                <div className="relative">
                  <button type="button" onClick={() => setPolicyOpen(!policyOpen)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-left">
                    <span className={selectedPolicy ? "text-white" : "text-gray-500"}>
                      {selectedPolicy ? `${selectedPolicy.policy.policyNumber} — ${selectedPolicy.insured?.name}` : "Seleccionar póliza..."}
                    </span>
                    <ChevronDown className="w-4 h-4 text-gray-500" />
                  </button>
                  {policyOpen && (
                    <div className="absolute z-20 w-full mt-1 bg-[#0d1424] border border-[#2d3748] rounded-lg shadow-xl max-h-52 overflow-y-auto">
                      <div className="p-2 border-b border-[#1f2937]">
                        <input type="text" placeholder="Buscar..." value={policySearch}
                          onChange={e => setPolicySearch(e.target.value)} autoFocus
                          className="w-full bg-[#0a0f1e] border border-[#2d3748] rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none" />
                      </div>
                      {filteredPolicies.map(p => (
                        <button key={p.policy.id} type="button"
                          onClick={() => { setForm(f => ({ ...f, policyId: String(p.policy.id), installmentId: "" })); setPolicyOpen(false); setPolicySearch(""); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[#1a2540] transition-colors">
                          <span className="text-white">{p.policy.policyNumber}</span>
                          <span className="text-gray-400 ml-2">— {p.insured?.name}</span>
                        </button>
                      ))}
                      {filteredPolicies.length === 0 && <p className="text-gray-500 text-sm px-3 py-2">Sin resultados</p>}
                    </div>
                  )}
                </div>
              </div>
              {/* Installment selector */}
              {pendingInstallments.length > 0 && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Cuota (opcional)</label>
                  <select
                    value={form.installmentId}
                    onChange={e => {
                      const id = e.target.value;
                      const inst = installments.find((i: any) => String(i.id) === id);
                      setForm(f => {
                        const amount = inst ? String(inst.amount) : f.amount;
                        return {
                          ...f,
                          installmentId: id,
                          amount,
                          dueDate: id ? (inst?.dueDate ?? "") : "",
                          // Con un único medio de pago, su importe sigue siempre
                          // al de la cuota elegida — con 2+ splits no hace nada.
                          splits: syncSingleBatchSplitAmount(f.splits, amount),
                        };
                      });
                    }}
                    className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500"
                  >
                    <option value="">Sin vincular cuota específica</option>
                    {pendingInstallments.map((inst: any) => (
                      <option key={inst.id} value={inst.id}>
                        Cuota #{inst.number} — vence {inst.dueDate} — {"$"}{inst.amount.toLocaleString("es-AR")}
                      </option>
                    ))}
                  </select>
                  {selectedInstallment && (
                    <p className="text-xs text-blue-400 mt-1">Importe auto-completado desde la cuota seleccionada.</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* Campos manuales */
            <div className="space-y-3 p-3 bg-[#0a0f1e] border border-[#2d3748] rounded-lg">
              <p className="text-xs text-gray-500">Completá los datos del pago sin vincular póliza del sistema</p>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Nombre del pagador</label>
                <input type="text" value={form.manualPayer}
                  onChange={e => setForm(f => ({ ...f, manualPayer: e.target.value }))}
                  placeholder="Nombre completo..."
                  className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">N° de póliza</label>
                  <input type="text" value={form.manualPolicyNumber}
                    onChange={e => setForm(f => ({ ...f, manualPolicyNumber: e.target.value }))}
                    placeholder="Ej: 12345678"
                    className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Compañía</label>
                  <input type="text" value={form.manualCompany}
                    onChange={e => setForm(f => ({ ...f, manualCompany: e.target.value }))}
                    placeholder="Ej: MAPFRE"
                    className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                </div>
              </div>
            </div>
          )}

          {/* Importe */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Importe *</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
              <input type="number" value={form.amount}
                onChange={e => setForm(f => ({
                  ...f,
                  amount: e.target.value,
                  // Con un único medio de pago, su importe sigue siempre al
                  // importe total — con 2+ splits no hace nada (reparto manual).
                  splits: syncSingleBatchSplitAmount(f.splits, e.target.value),
                }))}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Medios de pago (splits) — Etapa 3B-2 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs text-gray-400">Medios de pago *</label>
              <button type="button"
                onClick={() => setForm(f => ({ ...f, splits: addBatchSplitRow(f.splits) }))}
                disabled={isRendered}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                + Agregar medio
              </button>
            </div>

            <div className="space-y-2">
              {form.splits.map((split, idx) => (
                <div key={split.uid} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label htmlFor={`split-method-${split.uid}`} className="sr-only">
                      Método del medio de pago {idx + 1}
                    </label>
                    <select
                      id={`split-method-${split.uid}`}
                      value={split.method}
                      disabled={isRendered}
                      onChange={e => setForm(f => ({ ...f, splits: updateSplitMethodPreservingChecks(f.splits, split.uid, e.target.value) }))}
                      className="payment-method-select flex-1 min-w-0 px-2 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50"
                    >
                      <optgroup label="Cuentas propias">
                        {["efectivo", "transferencia", "cheque"].map((key) => (
                          <option key={key} value={key}>{METHOD_LABELS[key]}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Directo a Compañía">
                        {["transferencia_compania", "link_pago"].map((key) => (
                          <option key={key} value={key}>{METHOD_LABELS[key]}</option>
                        ))}
                      </optgroup>
                    </select>

                    <label htmlFor={`split-amount-${split.uid}`} className="sr-only">
                      Importe del medio de pago {idx + 1}
                    </label>
                    <div className="relative w-28 shrink-0">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                      <input
                        id={`split-amount-${split.uid}`}
                        type="number" step="0.01" min="0"
                        value={split.amount}
                        disabled={isRendered}
                        onChange={e => setForm(f => ({ ...f, splits: updateBatchSplitRow(f.splits, split.uid, { amount: e.target.value }) }))}
                        placeholder="0.00"
                        className="w-full pl-5 pr-2 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 disabled:opacity-50"
                      />
                    </div>

                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, splits: removeBatchSplitRow(f.splits, split.uid) }))}
                      disabled={isRendered || form.splits.length <= 1}
                      aria-label={`Eliminar medio de pago ${idx + 1} (${METHOD_LABELS[split.method] || split.method})`}
                      className="p-2 text-gray-400 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Migración 0028: subformulario de cheque(s) — mismo componente que "Cobrar en lote" */}
                  {split.method === "cheque" && !isRendered && (
                    <CheckSubForm
                      split={split}
                      onAdd={() => setForm(f => ({ ...f, splits: addCheckToSplit(f.splits, split.uid) }))}
                      onRemove={(checkUid) => setForm(f => ({ ...f, splits: removeCheckFromSplit(f.splits, split.uid, checkUid) }))}
                      onUpdate={(checkUid, patch) => setForm(f => ({ ...f, splits: updateCheckInSplit(f.splits, split.uid, checkUid, patch) }))}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Totales / diferencia — todo en centavos, nunca suma directa de floats */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
              <span>Total del cobro: <span className="text-white font-medium">
                {splitTotals.totalCents != null ? formatCurrency(splitTotals.totalCents / 100) : "—"}
              </span></span>
              <span>Distribuido: <span className="text-white font-medium">
                {formatCurrency(splitTotals.distributedCents / 100)}
              </span></span>
              {splitsValidation.group !== "mixed" && splitTotals.diferenciaCents != null && splitTotals.diferenciaCents !== 0 && (
                <span className={splitTotals.diferenciaCents > 0 ? "text-yellow-400" : "text-red-400"}>
                  {form.splits.length === 1
                    ? SINGLE_SPLIT_MISMATCH_MESSAGE
                    : splitTotals.diferenciaCents > 0
                      ? `Faltan distribuir ${formatCurrency(splitTotals.diferenciaCents / 100)}`
                      : `Se excede por ${formatCurrency(Math.abs(splitTotals.diferenciaCents) / 100)}`}
                </span>
              )}
            </div>

            {/* Migración 0028: además de "mixed", cubre los errores propios de
                cheque (número/banco/vencimiento faltante, suma de cheques
                distinta al importe del split) que validateBatchSplitsForm ya
                valida y que el bloque de diferencia de arriba no muestra. */}
            {splitsValidation.errorMessage && (
              <p className="mt-2 text-xs text-red-400" role="alert">{splitsValidation.errorMessage}</p>
            )}
          </div>

          {/* Recargo Pronto Pago (solo Rivadavia + método propio) */}
          {showSurchargeCheckbox && (
            isRendered ? (
              <div className="p-3 bg-purple-900/20 border border-purple-500/20 rounded-lg">
                <span className="text-xs text-purple-400">
                  Recargo Pronto Pago: {editing?.payment.hasSurcharge ? "aplicado ($800)" : "no aplicado"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 bg-purple-900/20 border border-purple-500/20 rounded-lg cursor-pointer"
                onClick={() => setApplyProntoPagoSurcharge(v => !v)}>
                <input type="checkbox" id="pp-surcharge" checked={applyProntoPagoSurcharge}
                  onChange={e => setApplyProntoPagoSurcharge(e.target.checked)}
                  className="w-4 h-4 accent-purple-500" />
                <label htmlFor="pp-surcharge" className="text-xs text-purple-300 cursor-pointer">
                  Registrar recargo Pronto Pago ($800) — Rivadavia
                </label>
              </div>
            )
          )}

          {/* Fechas */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Fecha de pago *</label>
              <input type="date" value={form.paymentDate} onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                disabled={isRendered}
                className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Período (mes)</label>
              <input type="month" value={form.periodMonth} onChange={e => setForm(f => ({ ...f, periodMonth: e.target.value }))}
                className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Vencimiento de cuota */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Vencimiento de cuota</label>
            <input
              type="date"
              value={form.dueDate}
              onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
              disabled={isRendered || !!form.installmentId}
              className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500 disabled:opacity-50"
            />
            {form.installmentId ? (
              <p className="text-xs text-blue-400/60 mt-1">Tomado de la cuota vinculada</p>
            ) : (
              <p className="text-xs text-gray-500 mt-1">Opcional — fecha límite para rendir esta cuota</p>
            )}
          </div>

          {/* Estado */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Estado</label>
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
              className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500">
              <option value="confirmado">Confirmado</option>
              <option value="pendiente">Pendiente</option>
              <option value="anulado">Anulado</option>
            </select>
          </div>

          {/* Notas */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notas</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2} placeholder="Observaciones opcionales..."
              className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 resize-none" />
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-[#1f2937]">
          <button onClick={onClose}
            className="flex-1 py-2 px-4 rounded-lg border border-[#2d3748] text-gray-400 text-sm hover:text-white hover:bg-[#1a2540] transition-all">
            Cancelar
          </button>
          <button onClick={handleSave} disabled={isImputarButtonDisabled(saving, splitsValidation.valid)}
            className="flex-1 py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-all disabled:opacity-50">
            {saving ? "Guardando..." : editing ? "Guardar cambios" : "Imputar pago"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Etapa 3B-2: badge de método para la tabla. Un solo split → badge normal,
// sin cambios visuales. N>1 splits → badge "Combinado" + resumen compacto
// agrupado por método (sin alterar los splits originales), visible sin abrir
// edición — sin agregar una columna nueva a la tabla.
function PaymentMethodBadge({ splits, paymentMethod, compact = false }: {
  splits: { method: string; amountCents: number }[]; paymentMethod: string; compact?: boolean;
}) {
  // Solo el badge — nunca el resumen de splits acá (eso ensanchaba la tabla,
  // ver SplitsDetailPanel + el chevron de expansión que lo reemplaza).
  if (!splits || splits.length <= 1) {
    const method = splits?.[0]?.method ?? paymentMethod;
    return (
      <span className={cn(compact ? "px-2 py-0.5 rounded border" : "px-2 py-0.5 rounded text-xs border",
        METHOD_COLORS[method] || "text-gray-400 border-gray-500/30")}>
        {METHOD_LABELS[method] || method}
      </span>
    );
  }
  return (
    <span className={cn(compact ? "px-2 py-0.5 rounded border" : "px-2 py-0.5 rounded text-xs border",
      "bg-indigo-500/20 text-indigo-300 border-indigo-500/30")}>
      Combinado
    </span>
  );
}

// Botón de expansión para un payment con 2+ splits — la fila/card arranca
// cerrada; al abrirla se muestra SplitsDetailPanel debajo, ocupando el ancho
// disponible en vez de ensanchar la columna de Método.
function SplitsExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      aria-label={expanded ? "Ocultar desglose de medios de pago" : "Ver desglose de medios de pago"}
      aria-expanded={expanded}
      className="text-gray-400 hover:text-white transition-colors shrink-0">
      <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")} />
    </button>
  );
}

// Detalle expandido de un pago combinado: método + importe agrupado (métodos
// repetidos se suman) + total distribuido. Es puramente de lectura sobre
// payment.splits ya cargado — no dispara ningún cálculo ni cambia el payload
// de edición.
function SplitsDetailPanel({ splits }: { splits: { method: string; amountCents: number }[] }) {
  const grouped = groupSplitsByMethod(splits);
  const totalCents = grouped.reduce((s, g) => s + g.amountCents, 0);
  return (
    <div className="rounded-lg border border-[#2d3748] bg-[#0a0f1e] p-3 space-y-1.5 max-w-sm">
      {grouped.map(g => (
        <div key={g.method} className="flex items-center justify-between gap-3 text-xs">
          <span className={cn("px-1.5 py-0.5 rounded border shrink-0", METHOD_COLORS[g.method] || "text-gray-400 border-gray-500/30")}>
            {METHOD_LABELS[g.method] || g.method}
          </span>
          <span className="text-gray-300">{formatCurrency(g.amountCents / 100)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs pt-1.5 border-t border-[#1f2937]">
        <span className="text-gray-500">Total distribuido</span>
        <span className="text-white font-medium">{formatCurrency(totalCents / 100)}</span>
      </div>
    </div>
  );
}

function CobranzasTab() {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [filterMethod, setFilterMethod] = useState("");
  const [filterVista, setFilterVista] = useState<"pendiente_rendir" | "rendidos" | "anulados" | "todos">("pendiente_rendir");
  const [search, setSearch] = useState("");
  // Desglose de splits: cerrado por defecto, uno por payment.id — solo UI,
  // no afecta payload ni cálculos.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  function toggleExpanded(id: number) {
    setExpandedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function load() {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([api.get("/api/payments"), api.get("/api/payments/stats")]);
      setPayments(p);
      setStats(s);
    } catch { toast.error("Error al cargar pagos"); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: number) {
    if (!confirm("¿Eliminar este pago?")) return;
    try {
      await api.delete(`/api/payments/${id}`);
      toast.success("Pago eliminado");
      load();
    } catch (err: any) {
      const msg = err?.message || "";
      const status = err?.status;
      // El backend ya trae un mensaje específico y accionable para 400/409
      // (rendido, cheques asociados, hijo de un cobro múltiple) — se muestra
      // tal cual, igual que en handleSave. El genérico queda solo para
      // fallos inesperados (5xx, red, sin mensaje).
      if (msg && status && status < 500) toast.error(msg);
      else toast.error("Error al eliminar el pago");
    }
  }

  // Migración 0028: un pago con cheques reales asociados nunca se borra
  // físicamente (DELETE ya lo rechaza con 409) — la única corrección
  // disponible es anularlo (soft, conserva payment_splits/received_checks
  // para trazabilidad) y volver a cargarlo si hace falta. Mismo criterio que
  // POST /payment-batches/:id/cancel para cobros múltiples.
  async function handleAnular(id: number) {
    if (!confirm(
      "Este pago tiene cheques asociados. No se eliminará físicamente. Se anulará el pago y el cheque quedará anulado."
    )) return;
    try {
      await api.put(`/api/payments/${id}`, { status: "anulado" });
      toast.success("Pago anulado");
      load();
    } catch (err: any) {
      const msg = err?.message || "";
      const status = err?.status;
      if (msg && status && status < 500) toast.error(msg);
      else toast.error("Error al anular el pago");
    }
  }

  const filtered = payments.filter(r => {
    if (filterVista === "pendiente_rendir") {
      if (r.payment.status !== "confirmado" || r.payment.rendered !== 0) return false;
    } else if (filterVista === "rendidos") {
      if (r.payment.status !== "confirmado" || r.payment.rendered !== 1) return false;
    } else if (filterVista === "anulados") {
      if (r.payment.status !== "anulado") return false;
    }
    if (filterMethod) {
      // Etapa 3B-2: matchea si CUALQUIER split usa ese método — el backend ya
      // filtra así (GET /payments?method=), esto evita que el filtro local
      // vuelva a comparar contra payment.paymentMethod (puede ser "combinado").
      // Fallback legacy a paymentMethod solo si no hay splits cargados.
      const hasSplits = r.payment.splits && r.payment.splits.length > 0;
      const matches = hasSplits
        ? r.payment.splits.some(s => s.method === filterMethod)
        : r.payment.paymentMethod === filterMethod;
      if (!matches) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const insuredName = (r.insured?.name || r.payment.manualPayer || "").toLowerCase();
      const policyNum = (r.policy?.policyNumber || r.payment.manualPolicyNumber || "").toLowerCase();
      if (!insuredName.includes(q) && !policyNum.includes(q)) return false;
    }
    return true;
  });

  const monthlyData = (() => {
    if (!stats) return [];
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      const key = d.toISOString().substring(0, 7);
      const label = d.toLocaleDateString("es-AR", { month: "short", year: "2-digit" });
      return { key, label, amount: stats.byMonth[key] || 0 };
    });
  })();
  const maxMonthly = Math.max(...monthlyData.map(m => m.amount), 1);

  return (
    <React.Fragment>
    <div className="space-y-6">
      <div className="flex justify-end">
          <button onClick={() => { setEditing(null); setModalOpen(true); }}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
            <Plus className="w-4 h-4" /> Imputar pago
          </button>
        </div>

        {/* Stats — 5 cards */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          {[
            {
              icon: DollarSign,
              color: "bg-blue-600/20 text-blue-400",
              label: "Total cobrado",
              value: stats ? formatCurrency(stats.total) : "—",
            },
            {
              icon: Banknote,
              color: "bg-green-600/20 text-green-400",
              label: "Efectivo",
              value: stats ? formatCurrency(stats.byMethod.efectivo || 0) : "—",
            },
            {
              icon: ArrowRightLeft,
              color: "bg-blue-600/20 text-blue-400",
              label: "Transf. cuenta propia",
              value: stats ? formatCurrency(stats.byMethod.transferencia || 0) : "—",
            },
            {
              icon: Building2,
              color: "bg-orange-600/20 text-orange-400",
              label: "Transf. Compañía",
              value: stats ? formatCurrency(stats.byMethod.transferencia_compania || 0) : "—",
            },
            {
              icon: Link,
              color: "bg-purple-600/20 text-purple-400",
              label: "Link de Pago",
              value: stats ? formatCurrency(stats.byMethod.link_pago || 0) : "—",
            },
            {
              icon: CheckSquare,
              color: "bg-yellow-600/20 text-yellow-400",
              label: "Cheques",
              value: stats ? formatCurrency(stats.byMethod.cheque || 0) : "—",
            },
          ].map(({ icon: Icon, color, label, value }) => (
            <div key={label} className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
              <div className="flex items-center gap-3">
                <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", color)}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 truncate">{label}</p>
                  <p className="text-lg font-bold text-white truncate">{value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Bar chart */}
        <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <TrendingUp className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Cobrado últimos 6 meses</h3>
          </div>
          <div className="flex items-end gap-3 h-32">
            {monthlyData.map(m => (
              <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs text-gray-500">{m.amount > 0 ? formatCurrency(m.amount, true) : ""}</span>
                <div className="w-full bg-blue-600/80 rounded-t-sm transition-all"
                  style={{ height: `${Math.max((m.amount / maxMonthly) * 96, m.amount > 0 ? 4 : 0)}px` }} />
                <span className="text-xs text-gray-500">{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input type="text" placeholder="Buscar asegurado o N° póliza..." value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
          </div>
          <select value={filterMethod} onChange={e => setFilterMethod(e.target.value)}
            className="payment-method-select px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los métodos</option>
            {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={filterVista} onChange={e => setFilterVista(e.target.value as any)}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="pendiente_rendir">Pendientes de rendir</option>
            <option value="rendidos">Rendidos</option>
            <option value="anulados">Anulados</option>
            <option value="todos">Todos</option>
          </select>
          {(filterMethod || filterVista !== "pendiente_rendir" || search) && (
            <button onClick={() => { setFilterMethod(""); setFilterVista("pendiente_rendir"); setSearch(""); }}
              className="flex items-center gap-1 px-3 py-2 text-sm text-gray-400 hover:text-white border border-[#1f2937] rounded-lg transition-colors">
              <X className="w-3 h-3" /> Limpiar
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <span className="text-sm text-gray-400">{filtered.length} {filtered.length === 1 ? "pago" : "pagos"}</span>
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Sin pagos registrados</p>
              <button onClick={() => { setEditing(null); setModalOpen(true); }}
                className="mt-3 text-blue-400 text-sm hover:underline">Imputar primer pago</button>
            </div>
          ) : (
            <div>
            {/* Mobile cards */}
            <div className="lg:hidden divide-y divide-[#1f2937]">
              {filtered.map(r => {
                const isManual = r.payment.policyId == null;
                const displayPolicyNum = r.policy?.policyNumber || r.payment.manualPolicyNumber || "—";
                const displayInsured = r.insured?.name || r.payment.manualPayer || "—";
                return (
                  <div key={r.payment.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-white font-medium">{displayPolicyNum}</p>
                          {isManual && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/30 bg-orange-500/10 text-orange-400">manual</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate">{displayInsured}</p>
                      </div>
                      <p className="text-white font-semibold flex-shrink-0">{formatCurrency(r.payment.amount)}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <PaymentMethodBadge splits={r.payment.splits} paymentMethod={r.payment.paymentMethod} compact />
                      {r.payment.splits.length > 1 && (
                        <SplitsExpandToggle
                          expanded={expandedIds.has(r.payment.id)}
                          onToggle={() => toggleExpanded(r.payment.id)}
                        />
                      )}
                      <span className={cn("px-2 py-0.5 rounded border", STATUS_COLORS[r.payment.status] || "text-gray-400 border-gray-500/30")}>
                        {r.payment.status.charAt(0).toUpperCase() + r.payment.status.slice(1)}
                      </span>
                    </div>
                    {r.payment.splits.length > 1 && expandedIds.has(r.payment.id) && (
                      <SplitsDetailPanel splits={r.payment.splits} />
                    )}
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span>Cobrado: {new Date(r.payment.paymentDate + "T12:00:00").toLocaleDateString("es-AR")}</span>
                      {r.payment.periodMonth && (
                        <span>Período: {new Date(r.payment.periodMonth + "-02").toLocaleDateString("es-AR", { month: "short", year: "numeric" })}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                      <span className="text-gray-400">Vence:</span>
                      <DueDateBadge dueDate={r.payment.dueDate} showNull />
                    </div>
                    {r.payment.notes && <p className="text-xs text-gray-400">{r.payment.notes}</p>}
                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={() => { setEditing(r); setModalOpen(true); }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2d3748] text-gray-300 hover:text-blue-400 transition-colors">
                        <Edit2 className="w-3 h-3" /> Editar
                      </button>
                      {r.payment.hasChecks ? (
                        <button onClick={() => handleAnular(r.payment.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">
                          <Ban className="w-3 h-3" /> Anular pago
                        </button>
                      ) : (
                        <button onClick={() => handleDelete(r.payment.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2d3748] text-gray-300 hover:text-red-400 transition-colors">
                          <Trash2 className="w-3 h-3" /> Eliminar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Desktop table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-[#1f2937]">
                    <th className="text-left px-5 py-3 font-medium">Póliza / Asegurado</th>
                    <th className="text-left px-3 py-3 font-medium">Período</th>
                    <th className="text-left px-3 py-3 font-medium">Método</th>
                    <th className="text-right px-3 py-3 font-medium">Importe</th>
                    <th className="text-left px-3 py-3 font-medium">Cobrado</th>
                    <th className="text-left px-3 py-3 font-medium">Vencimiento</th>
                    <th className="text-left px-2 py-3 font-medium">Estado</th>
                    <th className="text-left px-2 py-3 font-medium">Notas</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const isManual = r.payment.policyId == null;
                    const displayPolicyNum = r.policy?.policyNumber || r.payment.manualPolicyNumber || "—";
                    const displayInsured = r.insured?.name || r.payment.manualPayer || "—";
                    const isExpanded = r.payment.splits.length > 1 && expandedIds.has(r.payment.id);
                    return (
                      <React.Fragment key={r.payment.id}>
                      <tr className="border-b border-[#1f2937] hover:bg-[#1a2540]/30 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div>
                              <p className="text-white font-medium">{displayPolicyNum}</p>
                              <p className="text-xs text-gray-400">{displayInsured}</p>
                            </div>
                            {isManual && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/30 bg-orange-500/10 text-orange-400">
                                manual
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.payment.periodMonth
                            ? new Date(r.payment.periodMonth + "-02").toLocaleDateString("es-AR", { month: "short", year: "numeric" })
                            : "—"}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <PaymentMethodBadge splits={r.payment.splits} paymentMethod={r.payment.paymentMethod} />
                            {r.payment.splits.length > 1 && (
                              <SplitsExpandToggle
                                expanded={expandedIds.has(r.payment.id)}
                                onToggle={() => toggleExpanded(r.payment.id)}
                              />
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right text-white font-semibold">{formatCurrency(r.payment.amount)}</td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {new Date(r.payment.paymentDate + "T12:00:00").toLocaleDateString("es-AR")}
                        </td>
                        <td className="px-3 py-3">
                          <DueDateBadge dueDate={r.payment.dueDate} showNull />
                        </td>
                        <td className="px-2 py-3">
                          <span className={cn("px-2 py-0.5 rounded text-xs border", STATUS_COLORS[r.payment.status] || "text-gray-400 border-gray-500/30")}>
                            {r.payment.status.charAt(0).toUpperCase() + r.payment.status.slice(1)}
                          </span>
                        </td>
                        <td className="px-2 py-3 text-gray-400 text-xs max-w-[90px] truncate">{r.payment.notes || "—"}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 justify-end">
                            <button onClick={() => { setEditing(r); setModalOpen(true); }}
                              className="text-gray-400 hover:text-blue-400 transition-colors" title="Editar">
                              <Edit2 className="w-4 h-4" />
                            </button>
                            {r.payment.hasChecks ? (
                              <button onClick={() => handleAnular(r.payment.id)}
                                className="text-red-400 hover:text-red-300 transition-colors" title="Anular pago (tiene cheques asociados)">
                                <Ban className="w-4 h-4" />
                              </button>
                            ) : (
                              <button onClick={() => handleDelete(r.payment.id)}
                                className="text-gray-400 hover:text-red-400 transition-colors" title="Eliminar">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-b border-[#1f2937] bg-[#0a0f1e]/40">
                          <td colSpan={9} className="px-5 py-3">
                            <SplitsDetailPanel splits={r.payment.splits} />
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </div>
          )}
        </div>
      </div>

    <PaymentModal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }}
      onSaved={load} editing={editing} />
    </React.Fragment>
  );
}

// ─── Helpers de fecha de vencimiento ──────────────────────────────────────────
function localTodayYMD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDueDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function DueDateBadge({ dueDate, showNull = false }: { dueDate: string | null; showNull?: boolean }) {
  if (!dueDate) {
    if (showNull) return <span className="text-[10px] text-white/25">Sin vencimiento</span>;
    return null;
  }
  const today = localTodayYMD();
  if (dueDate < today) {
    return (
      <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border bg-red-900/30 border-red-500/40 text-red-400 shrink-0">
        Vencida
      </span>
    );
  }
  if (dueDate === today) {
    return (
      <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border bg-yellow-900/30 border-yellow-500/40 text-yellow-400 shrink-0">
        Vence hoy
      </span>
    );
  }
  return (
    <span className="text-[10px] text-white/30 shrink-0">Vence: {fmtDueDate(dueDate)}</span>
  );
}

// ─── Constantes de canales ─────────────────────────────────────────────────────
const CANAL_LABELS: Record<string, string> = {
  directo: "Directo a Compañía",
  pronto_pago: "Pronto Pago",
  informativo: "Informativo",
};
const CANAL_COLORS: Record<string, string> = {
  directo: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  pronto_pago: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  informativo: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

// ─── Modal Nueva Rendición ─────────────────────────────────────────────────────
function NuevaRendicionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<"select" | "pago">("select");
  const [pending, setPending] = useState<any[]>([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [canal, setCanal] = useState("directo");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [breakdown, setBreakdown] = useState({ efectivo: "", transferencia: "", cheque: "" });
  const [debtorItems, setDebtorItems] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // ── Estado para ítems manuales ───────────────────────────────────────────────
  const [manualForm, setManualForm] = useState({ insured: "", policy: "", company: "", period: "", amount: "", notes: "" });
  const [manualItems, setManualItems] = useState<any[]>([]);
  const [showManualForm, setShowManualForm] = useState(false);

  useEffect(() => {
    api.get("/api/remittances/pending").then(d => { setPending(d); setLoadingPending(false); });
  }, []);

  const key = (item: any) => item._uid != null ? `manual_debt:${item._uid}` : `${item.source}:${item.sourceId}`;

  const toggle = (item: any) => {
    const k = key(item);
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const toggleDebtor = (item: any) => {
    const k = key(item);
    setDebtorItems(prev => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  function addManualItem() {
    if (!manualForm.insured.trim() || !manualForm.amount) {
      toast.error("Completá al menos asegurado e importe");
      return;
    }
    setManualItems(prev => [...prev, {
      source: "manual_debt",
      sourceId: null,
      _uid: Date.now(),
      amount: Number(manualForm.amount),
      clientName: manualForm.insured.trim(),
      policyNumber: manualForm.policy.trim() || "—",
      companyName: manualForm.company.trim() || "—",
      paymentMethod: null,
      period: manualForm.period.trim(),
      notes: manualForm.notes.trim(),
    }]);
    setManualForm({ insured: "", policy: "", company: "", period: "", amount: "", notes: "" });
  }

  function removeManualItem(uid: number) {
    setManualItems(prev => prev.filter(i => i._uid !== uid));
  }

  const pendingVisible = pending.filter((i: any) => i.entryType !== "pronto_pago_surcharge");
  const selectedCobradas = pendingVisible.filter((i: any) => selected.has(key(i)));
  const selectedItems = [...selectedCobradas, ...manualItems];
  const totalSeleccionado = selectedItems.reduce((s, i) => s + i.amount, 0);
  const totalBreakdown = (Number(breakdown.efectivo) || 0) + (Number(breakdown.transferencia) || 0) +
    (Number(breakdown.cheque) || 0);
  const autoSurchargeItems = canal === "pronto_pago"
    ? selectedCobradas.filter((i: any) => i.source === "payment" && i.hasSurcharge)
    : [];
  const manualSurchargeItems = canal === "pronto_pago"
    ? manualItems.filter((i: any) =>
        String(i.companyName ?? "").trim().toLowerCase().includes("rivadavia"))
    : [];
  const rivadaviaNoSurchargeItems = canal === "pronto_pago"
    ? selectedCobradas.filter((i: any) => i.source === "payment" && !i.hasSurcharge && (i.companyName as string | undefined)?.toLowerCase().includes("rivadavia"))
    : [];
  const totalSurchargeCount = autoSurchargeItems.length + manualSurchargeItems.length;
  const autoSurchargeTotal = totalSurchargeCount * PP_SURCHARGE;
  const expectedTotal = totalSeleccionado + autoSurchargeTotal;

  const filteredPending = pendingVisible.filter((i: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return i.clientName?.toLowerCase().includes(q) || i.policyNumber?.toLowerCase().includes(q) ||
      i.companyName?.toLowerCase().includes(q);
  });

  // Agrupar por paymentGroup (own/direct_company) para mostrar separador —
  // Etapa 3B-2: nunca comparar paymentMethod contra una lista de strings
  // ("combinado" no matchea nada). getPendingItemPaymentGroup ya prioriza
  // paymentGroup si el backend lo mandó, y solo cae a paymentMethod si no
  // hay ni paymentGroup ni splits (ver rendicion-pending.ts).
  const propios = filteredPending.filter((i: any) => getPendingItemPaymentGroup(i) === "own");
  const directos = filteredPending.filter((i: any) => getPendingItemPaymentGroup(i) === "direct_company");
  // Defensivo: las reglas de Etapa 3B-1 ya rechazan mixed en POST/PUT
  // /payments, así que esto no debería ocurrir nunca en datos reales — pero
  // si un dato inconsistente llegara igual, no se clasifica silenciosamente
  // como propio ni como directo, se aísla y se advierte.
  const mixedPendingItems = filteredPending.filter((i: any) => getPendingItemPaymentGroup(i) === "mixed");

  async function save() {
    if (selectedItems.length === 0) { toast.error("Seleccioná al menos una cuota"); return; }
    setSaving(true);
    try {
      const bd: Record<string, number> = {};
      if (Number(breakdown.efectivo) > 0) bd.efectivo = Number(breakdown.efectivo);
      if (Number(breakdown.transferencia) > 0) bd.transferencia = Number(breakdown.transferencia);
      if (Number(breakdown.cheque) > 0) bd.cheque = Number(breakdown.cheque);

      await api.post("/api/remittances", {
        date,
        canal,
        notes: notes || null,
        paymentBreakdown: bd,
        prontoPagoSurcharge: canal === "pronto_pago" ? 800 : 0,
        items: selectedItems.map(i => ({
          source: i.source,
          sourceId: i.sourceId,
          amount: i.amount,
          // Un payment confirmado (source='payment') NUNCA puede mandarse como
          // adeudado, sin importar el estado de debtorItems — la UI ya no
          // ofrece el toggle para ese source, pero esto es defensivo (no
          // depender solo de que el checkbox esté oculto).
          debtorStatus: i.source === "payment"
            ? "pagado"
            : (i.source === "manual_debt" || debtorItems.has(key(i))) ? "adeudado" : "pagado",
          clientName: i.clientName,
          policyNumber: i.policyNumber,
          companyName: i.companyName,
          paymentMethod: i.paymentMethod || null,
        })),
      });
      toast.success("Rendición registrada");
      onSaved();
      onClose();
    } catch (err: any) { toast.error(err?.message || "Error al guardar rendición"); }
    setSaving(false);
  }

  const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937] shrink-0">
          <div className="flex items-center gap-3">
            <ReceiptText size={18} className="text-blue-400" />
            <h3 className="text-white font-semibold">Nueva Rendición</h3>
            {step === "pago" && (
              <span className="text-xs text-white/40">{selectedItems.length} cuotas — {fmt(totalSeleccionado)}</span>
            )}
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-6">
          {step === "select" ? (
            <div className="space-y-4">
              {/* ── Sección 1: Cobradas pendientes de rendir ─────────────────── */}
              <div>
                <p className="text-xs text-white/30 uppercase tracking-wider mb-3 font-medium">Cobradas — pendientes de rendir</p>
                <p className="text-xs text-white/40 mb-3">Seleccioná los cobros ya registrados. Marcá como "adeudado" los que el asegurado aún no pagó.</p>

                <div className="relative mb-3">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                  <input className="w-full pl-8 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-blue-500"
                    placeholder="Buscar por cliente, póliza o compañía..."
                    value={search} onChange={e => setSearch(e.target.value)} />
                </div>

                {loadingPending ? (
                  <div className="text-center py-6 text-white/30 text-sm">Cargando cobros pendientes...</div>
                ) : pendingVisible.length === 0 ? (
                  <div className="text-center py-6 text-white/30 text-sm">No hay cobros pendientes de rendir.</div>
                ) : (
                  <div className="space-y-3">
                    {propios.length > 0 && (
                      <div>
                        <p className="text-xs text-white/20 uppercase tracking-wider mb-1.5">Cuentas propias</p>
                        <div className="space-y-1">
                          {propios.map(item => {
                            const k = key(item);
                            const sel = selected.has(k);
                            const isDebtor = debtorItems.has(k);
                            return (
                              <div key={k} className={cn("flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer",
                                sel ? "bg-blue-900/20 border-blue-500/30" : "bg-white/3 border-white/8 hover:bg-white/5")}
                                onClick={() => toggle(item)}>
                                <div className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0",
                                  sel ? "bg-blue-600 border-blue-600" : "border-white/20")}>
                                  {sel && <Check size={10} className="text-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white truncate">{item.clientName}</p>
                                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                    <span className="text-xs text-white/40">{item.companyName} · {item.policyNumber} · {item.paymentDate}</span>
                                    <DueDateBadge dueDate={item.dueDate ?? null} />
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-sm font-semibold text-white">{fmt(item.amount)}</p>
                                  <PaymentMethodBadge splits={item.splits ?? []} paymentMethod={item.paymentMethod} compact />
                                  {item.hasSurcharge && canal === "pronto_pago" && (
                                    <span className="block text-xs text-purple-400 mt-0.5">+$800 PP</span>
                                  )}
                                </div>
                                {/* Un cobro confirmado (source='payment') nunca puede rendirse como
                                    adeudado — representa dinero ya recibido. El toggle solo tiene
                                    sentido para cash_entry (cobro manual de Caja, mismo criterio que
                                    ya tenía antes de esta regla). */}
                                {sel && item.source !== "payment" && (
                                  <button type="button" onClick={e => { e.stopPropagation(); toggleDebtor(item); }}
                                    className={cn("text-xs px-2 py-1 rounded border shrink-0 transition-all",
                                      isDebtor ? "bg-red-900/30 border-red-500/40 text-red-400" : "border-white/15 text-white/40 hover:border-yellow-500/40 hover:text-yellow-400")}>
                                    {isDebtor ? "Adeudado" : "Pagado"}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {directos.length > 0 && (
                      <div>
                        <p className="text-xs text-orange-400/60 uppercase tracking-wider mb-1.5">Directo a Compañía</p>
                        <div className="space-y-1">
                          {directos.map(item => {
                            const k = key(item);
                            const sel = selected.has(k);
                            return (
                              <div key={k} className={cn("flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer",
                                sel ? "bg-orange-900/20 border-orange-500/30" : "bg-white/3 border-white/8 hover:bg-white/5")}
                                onClick={() => toggle(item)}>
                                <div className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0",
                                  sel ? "bg-orange-600 border-orange-600" : "border-white/20")}>
                                  {sel && <Check size={10} className="text-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white truncate">{item.clientName}</p>
                                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                    <span className="text-xs text-white/40">{item.companyName} · {item.policyNumber} · {item.paymentDate}</span>
                                    <DueDateBadge dueDate={item.dueDate ?? null} />
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-sm font-semibold text-white">{fmt(item.amount)}</p>
                                  <PaymentMethodBadge splits={item.splits ?? []} paymentMethod={item.paymentMethod} compact />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {mixedPendingItems.length > 0 && (
                      <div>
                        <p className="text-xs text-red-400 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5" /> Desglose inconsistente — no seleccionable
                        </p>
                        <div className="space-y-1">
                          {mixedPendingItems.map(item => {
                            const k = key(item);
                            return (
                              <div key={k}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-900/10">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white truncate">{item.clientName}</p>
                                  <p className="text-xs text-red-400/80">
                                    Combina medios propios y directos a la compañía en un mismo cobro — no se puede
                                    clasificar. Revisá este pago antes de rendir.
                                  </p>
                                </div>
                                <p className="text-sm font-semibold text-white shrink-0">{fmt(item.amount)}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-white/10">
                {/* ── Carga manual ─────────────────────────────────────────────── */}
                <div className="mt-0 pt-0">
                  <button
                    type="button"
                    onClick={() => setShowManualForm(v => !v)}
                    className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
                  >
                    <Plus size={12} />
                    {showManualForm ? "Cancelar carga manual" : "Agregar adeudada manualmente"}
                  </button>

                  {showManualForm && (
                    <div className="mt-3 p-3 bg-orange-950/20 border border-orange-500/20 rounded-lg space-y-2">
                      <p className="text-xs text-orange-400/70 font-medium">Deuda manual — se agregará como adeudada</p>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          placeholder="Asegurado *"
                          value={manualForm.insured}
                          onChange={e => setManualForm(f => ({ ...f, insured: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                        <input
                          placeholder="Póliza"
                          value={manualForm.policy}
                          onChange={e => setManualForm(f => ({ ...f, policy: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                        <input
                          placeholder="Compañía"
                          value={manualForm.company}
                          onChange={e => setManualForm(f => ({ ...f, company: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                        <input
                          placeholder="Período / cuota (ej: Cuota 1 - Jun 2026)"
                          value={manualForm.period}
                          onChange={e => setManualForm(f => ({ ...f, period: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                        <input
                          type="number"
                          placeholder="Importe *"
                          value={manualForm.amount}
                          onChange={e => setManualForm(f => ({ ...f, amount: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                        <input
                          placeholder="Observación (opcional)"
                          value={manualForm.notes}
                          onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))}
                          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/50"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={addManualItem}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600/80 hover:bg-orange-500 text-white text-xs rounded-lg transition-all font-medium"
                      >
                        <Plus size={12} /> Agregar a la rendición
                      </button>
                    </div>
                  )}

                  {manualItems.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {manualItems.map(item => (
                        <div key={item._uid} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-orange-900/20 border-orange-500/30">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{item.clientName}</p>
                            <p className="text-xs text-white/40">
                              {item.companyName} · {item.policyNumber}
                              {item.period && ` · ${item.period}`}
                              {item.notes && ` · ${item.notes}`}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-semibold text-white">{fmt(item.amount)}</p>
                            <span className="text-xs text-orange-400 border border-orange-500/30 bg-orange-900/20 px-1.5 py-0.5 rounded">Adeudado</span>
                            {canal === "pronto_pago" && String(item.companyName ?? "").trim().toLowerCase().includes("rivadavia") && (
                              <span className="block text-xs text-purple-400 mt-0.5">+${PP_SURCHARGE} PP</span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => removeManualItem(item._uid)}
                            className="p-1 text-white/30 hover:text-red-400 shrink-0 transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Datos generales */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-white/50 mb-1 block">Fecha de rendición *</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-white/50 mb-1 block">Canal *</label>
                  <select value={canal} onChange={e => setCanal(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0a0f1e] border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500">
                    <option value="directo">Directo a Compañía</option>
                    <option value="pronto_pago">Pronto Pago</option>
                    <option value="informativo">Informativo (link/transf.)</option>
                  </select>
                </div>
              </div>

              {canal === "pronto_pago" && totalSurchargeCount > 0 && (
                <div className="bg-purple-900/20 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3">
                  <AlertCircle size={16} className="text-purple-400 shrink-0" />
                  <div>
                    <p className="text-xs text-purple-300">
                      Recargo Pronto Pago: {totalSurchargeCount} cuota{totalSurchargeCount !== 1 ? "s" : ""} × ${PP_SURCHARGE} = {fmt(autoSurchargeTotal)}
                    </p>
                    <p className="text-xs text-white/40">Se incluye automáticamente al confirmar</p>
                  </div>
                </div>
              )}

              {rivadaviaNoSurchargeItems.length > 0 && (
                <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-3 flex items-center gap-3">
                  <AlertCircle size={16} className="text-yellow-400 shrink-0" />
                  <p className="text-xs text-yellow-300">
                    Hay {rivadaviaNoSurchargeItems.length} pago{rivadaviaNoSurchargeItems.length > 1 ? "s" : ""} de Rivadavia sin recargo Pronto Pago registrado. No se sumarán $800 automáticamente.
                  </p>
                </div>
              )}

              {/* Métodos de pago */}
              <div>
                <label className="text-xs text-white/50 mb-2 block">Cómo se paga a la compañía (puede mezclar métodos)</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { k: "efectivo", label: "Efectivo", color: "text-green-400" },
                    { k: "transferencia", label: "Transferencia", color: "text-blue-400" },
                    { k: "cheque", label: "Cheque", color: "text-yellow-400" },
                  ] as { k: keyof typeof breakdown; label: string; color: string }[]).map(({ k, label, color }) => (
                    <div key={k}>
                      <label className={cn("text-xs mb-1 block", color)}>{label}</label>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-white/40">$</span>
                        <input type="number" placeholder="0"
                          value={breakdown[k]} onChange={e => setBreakdown(b => ({ ...b, [k]: e.target.value }))}
                          className="flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex justify-between items-center text-sm">
                  <span className="text-white/40">Total a rendir:</span>
                  <span className={cn("font-bold", Math.abs(totalBreakdown - expectedTotal) > 1 ? "text-red-400" : "text-green-400")}>
                    {fmt(totalBreakdown)}
                    {Math.abs(totalBreakdown - expectedTotal) > 1 && (
                      <span className="text-xs font-normal text-red-400/70 ml-2">(esperado: {fmt(expectedTotal)})</span>
                    )}
                  </span>
                </div>
                {canal === "pronto_pago" && totalSurchargeCount > 0 && (
                  <div className="mt-1 flex justify-between items-center text-xs text-white/40">
                    <span>Recargo PP ({totalSurchargeCount} cuota{totalSurchargeCount !== 1 ? "s" : ""} × ${PP_SURCHARGE} — auto-incluido):</span>
                    <span className="text-purple-400">+{fmt(autoSurchargeTotal)}</span>
                  </div>
                )}
              </div>

              {/* Notas */}
              <div>
                <label className="text-xs text-white/50 mb-1 block">Notas</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
                  placeholder="Compañía, número de rendición, observaciones..." />
              </div>

              {/* Resumen cuotas */}
              <div className="bg-white/3 border border-white/8 rounded-lg p-3">
                <p className="text-xs text-white/40 mb-2">
                  {selectedCobradas.length > 0 && `${selectedCobradas.length} cobradas`}
                  {selectedCobradas.length > 0 && manualItems.length > 0 && " · "}
                  {manualItems.length > 0 && <span className="text-orange-400/70">{manualItems.length} manuales (adeudadas)</span>}
                  {" — "}{fmt(totalSeleccionado)}
                </p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {selectedItems.map(i => {
                    const isDebtor = i.source === "manual_debt" || debtorItems.has(key(i));
                    return (
                      <div key={key(i)} className="flex justify-between text-xs">
                        <span className="text-white/60 truncate mr-2">{i.clientName} · {i.companyName}</span>
                        <span className={cn("shrink-0", isDebtor ? (i.source === "manual_debt" ? "text-orange-400" : "text-red-400") : "text-white/60")}>
                          {isDebtor ? "⚠ " : ""}{fmt(i.amount)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#1f2937] flex justify-between items-center shrink-0">
          {step === "select" ? (
            <>
              <span className="text-sm text-white/40">{selectedItems.length} seleccionadas — {fmt(totalSeleccionado)}</span>
              <button onClick={() => { if (selectedItems.length === 0) { toast.error("Seleccioná al menos una cuota"); return; } setStep("pago"); }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
                Siguiente <ChevronRight size={16} />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep("select")}
                className="px-4 py-2 border border-white/10 text-white/60 hover:text-white text-sm rounded-lg transition-all">
                ← Volver
              </button>
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50">
                {saving ? "Guardando..." : "Confirmar Rendición"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tab Rendiciones ──────────────────────────────────────────────────────────
function RendicionesTab() {
  const { user } = useAuth();
  const [rendiciones, setRendiciones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [itemsCache, setItemsCache] = useState<Record<number, any[]>>({});
  const [modalOpen, setModalOpen] = useState(false);

  const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 });

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/remittances");
      setRendiciones(data);
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("permisos") || msg.includes("autorizado") || msg.includes("Forbidden")) {
        toast.error("Sin permisos para acceder a rendiciones");
      } else {
        toast.error("Error al cargar rendiciones");
      }
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function loadItems(id: number) {
    if (itemsCache[id]) return;
    const items = await api.get(`/api/remittances/${id}/items`);
    setItemsCache(c => ({ ...c, [id]: items }));
  }

  async function toggleExpand(id: number) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) { n.delete(id); return n; }
      n.add(id);
      loadItems(id);
      return n;
    });
  }

  async function handleDelete(id: number) {
    if (!confirm("¿Eliminar esta rendición? Las cuotas volverán a estar pendientes de rendir.")) return;
    await api.delete(`/api/remittances/${id}`);
    toast.success("Rendición eliminada");
    load();
  }

  // Totales
  const totalRendido = rendiciones.reduce((s, r) => s + r.totalPaid, 0);
  const totalCuotas = rendiciones.reduce((s, r) => s + r.itemCount, 0);
  const totalAdeudado = rendiciones.reduce((s, r) => s + r.adeudadoTotal, 0);

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total rendido", value: fmt(totalRendido), color: "text-blue-400", bg: "bg-blue-900/20 border-blue-500/20" },
          { label: "Ítems rendidos", value: String(totalCuotas), color: "text-white", bg: "bg-white/5 border-white/10" },
          { label: "Adeudado en rendiciones", value: fmt(totalAdeudado), color: "text-red-400", bg: "bg-red-900/20 border-red-500/20" },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={cn("rounded-lg border px-4 py-3", bg)}>
            <p className="text-xs text-white/40 mb-1">{label}</p>
            <p className={cn("text-lg font-bold", color)}>{value}</p>
          </div>
        ))}
      </div>

      {/* Botón nueva rendición */}
      <div className="flex justify-end">
        <button onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
          <Plus size={16} /> Nueva Rendición
        </button>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="text-center py-12 text-white/30 text-sm">Cargando rendiciones...</div>
      ) : rendiciones.length === 0 ? (
        <div className="text-center py-12 text-white/30 text-sm">
          <ReceiptText size={32} className="mx-auto mb-3 opacity-30" />
          No hay rendiciones registradas aún.
        </div>
      ) : (
        <div className="space-y-2">
          {rendiciones.map((r: any) => {
            const isExp = expanded.has(r.id);
            const items = itemsCache[r.id] || [];
            const bd = r.paymentBreakdown || {};
            return (
              <div key={r.id} className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/2 transition-colors"
                  onClick={() => toggleExpand(r.id)}>
                  <ChevronDown size={16} className={cn("text-white/30 transition-transform shrink-0", isExp && "rotate-180")} />
                  <div className="flex-1 min-w-0 grid grid-cols-2 lg:grid-cols-4 gap-2">
                    <div>
                      <p className="text-xs text-white/40">Fecha</p>
                      <p className="text-sm text-white">{r.date}</p>
                    </div>
                    <div>
                      <p className="text-xs text-white/40">Canal</p>
                      <span className={cn("text-xs px-2 py-0.5 rounded border", CANAL_COLORS[r.canal] || "text-gray-400 border-gray-500/30")}>
                        {CANAL_LABELS[r.canal] || r.canal}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs text-white/40">{r.itemCount} ítem{r.itemCount !== 1 ? "s" : ""}{r.adeudadoCount > 0 ? ` · ${r.adeudadoCount} adeudados` : ""}</p>
                      <p className="text-sm font-semibold text-white">{fmt(r.totalAmount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-white/40">Pagado a compañía</p>
                      <p className="text-sm font-bold text-green-400">{fmt(r.totalPaid)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Métodos */}
                    {Object.entries(bd).filter(([, v]) => Number(v) > 0).map(([m, v]) => (
                      <span key={m} className={cn("hidden lg:inline text-xs px-1.5 py-0.5 rounded border", METHOD_COLORS[m] || "text-gray-400 border-gray-500/30")}>
                        {BREAKDOWN_LABELS[m] || m}: {fmt(Number(v))}
                      </span>
                    ))}
                    {user?.role === "admin" && (
                      <button onClick={e => { e.stopPropagation(); handleDelete(r.id); }}
                        className="p-1.5 text-white/20 hover:text-red-400 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Detalle expandido */}
                {isExp && (
                  <div className="border-t border-[#1f2937] px-4 py-3">
                    {r.notes && <p className="text-xs text-white/40 mb-3 italic">{r.notes}</p>}
                    {items.length === 0 ? (
                      <p className="text-xs text-white/30 text-center py-2">Cargando...</p>
                    ) : (
                      <div className="space-y-1">
                        {items.map((item: any) => (
                          <div key={item.id} className="flex items-center gap-3 py-1.5 border-b border-white/5 last:border-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white truncate">{item.clientName}</p>
                              <p className="text-xs text-white/40">{item.companyName} · {item.policyNumber}</p>
                            </div>
                            <span className={cn("text-xs px-1.5 py-0.5 rounded border shrink-0", METHOD_COLORS[item.paymentMethod] || "text-gray-400 border-gray-500/30")}>
                              {METHOD_LABELS[item.paymentMethod] || item.paymentMethod}
                            </span>
                            <span className={cn("text-sm font-medium shrink-0 w-24 text-right",
                              item.debtorStatus === "adeudado" && !item.paidAt ? "text-red-400" : "text-white")}>
                              {fmt(item.amount)}
                            </span>
                            {item.debtorStatus === "adeudado" && (
                              <span className={cn("text-xs px-1.5 py-0.5 rounded border shrink-0",
                                item.paidAt ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30")}>
                                {item.paidAt ? "Cobrado" : "Adeudado"}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && <NuevaRendicionModal onClose={() => setModalOpen(false)} onSaved={load} />}
    </div>
  );
}

// ─── Tab Adeudados de Rendiciones ─────────────────────────────────────────────
function AdeudadosTab() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 });

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/remittances/adeudados");
      setItems(data);
    } catch { toast.error("Error al cargar adeudados"); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function markPaid(id: number) {
    await api.patch(`/api/remittances/items/${id}/paid`, {});
    toast.success("Marcado como cobrado");
    load();
  }

  const total = items.reduce((s, i) => s + i.amount, 0);

  return (
    <div className="space-y-5">
      <div className="bg-red-900/20 border border-red-500/20 rounded-lg px-4 py-3 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-red-400" />
          <p className="text-sm text-white">Cuotas rendidas que el asegurado aún no pagó a la oficina</p>
        </div>
        <p className="text-lg font-bold text-red-400">{fmt(total)}</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-white/30 text-sm">Cargando...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-white/30 text-sm">
          <CheckSquare size={32} className="mx-auto mb-3 opacity-30" />
          No hay adeudados pendientes.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item: any) => (
            <div key={item.id} className="bg-[#0d1424] border border-red-500/20 rounded-xl px-4 py-3 flex items-center gap-4">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium">{item.clientName}</p>
                <p className="text-xs text-white/40">{item.companyName} · Póliza {item.policyNumber}</p>
                <p className="text-xs text-white/30 mt-0.5">
                  Rendición del {item.remittanceDate} ·{" "}
                  <span className={cn("", CANAL_COLORS[item.remittanceCanal]?.replace("bg-", "text-").split(" ")[0])}>
                    {CANAL_LABELS[item.remittanceCanal] || item.remittanceCanal}
                  </span>
                </p>
              </div>
              <p className="text-base font-bold text-red-400 shrink-0">{fmt(item.amount)}</p>
              <button onClick={() => markPaid(item.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-all shrink-0">
                <Check size={12} /> Cobrado
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tab Transferencias a Compañía ────────────────────────────────────────────
function TransferenciasTab() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"todos" | "pendientes" | "rendidos">("pendientes");

  const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 });

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/cash/payments/transferencias");
      setItems(data);
    } catch { toast.error("Error al cargar transferencias"); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function toggleRendido(item: any) {
    const newRendered = !item.rendered;
    const msg = newRendered
      ? "¿Marcar esta transferencia como rendida a la compañía?"
      : "¿Desmarcar como rendida? Volverá a estar pendiente.";
    if (!confirm(msg)) return;
    await api.patch(`/api/cash/payments/${item.id}/render`, { rendered: newRendered });
    toast.success(newRendered ? "Marcada como rendida" : "Desmarcada como rendida");
    load();
  }

  const filtered = items.filter(i => {
    if (filter === "pendientes") return !i.rendered;
    if (filter === "rendidos") return !!i.rendered;
    return true;
  });

  const totalPendiente = items.filter(i => !i.rendered).reduce((s, i) => s + i.amount, 0);
  const totalRendido = items.filter(i => i.rendered).reduce((s, i) => s + i.amount, 0);

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-orange-900/20 border border-orange-500/20 rounded-xl px-4 py-3">
          <p className="text-xs text-white/40 mb-1">Pendientes de informar a compañía</p>
          <p className="text-xl font-bold text-orange-400">{fmt(totalPendiente)}</p>
          <p className="text-xs text-white/30 mt-0.5">{items.filter(i => !i.rendered).length} cuota{items.filter(i => !i.rendered).length !== 1 ? "s" : ""}</p>
        </div>
        <div className="bg-green-900/20 border border-green-500/20 rounded-xl px-4 py-3">
          <p className="text-xs text-white/40 mb-1">Ya rendidas a compañía</p>
          <p className="text-xl font-bold text-green-400">{fmt(totalRendido)}</p>
          <p className="text-xs text-white/30 mt-0.5">{items.filter(i => i.rendered).length} cuota{items.filter(i => i.rendered).length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-orange-900/10 border border-orange-500/15 rounded-lg px-4 py-3 flex items-start gap-3">
        <AlertCircle size={16} className="text-orange-400 shrink-0 mt-0.5" />
        <p className="text-xs text-white/50">
          Estas cuotas fueron pagadas por el asegurado directamente a la compañía por transferencia bancaria.
          Marcalas como rendidas una vez que hayas informado el pago a la compañía para que lo imputen correctamente.
        </p>
      </div>

      {/* Filtro */}
      <div className="flex gap-1 bg-white/5 border border-white/10 rounded-lg p-1 w-fit">
        {(["pendientes", "rendidos", "todos"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn("px-3 py-1.5 rounded text-xs font-medium transition-all capitalize",
              filter === f ? "bg-white/10 text-white" : "text-white/40 hover:text-white")}>
            {f === "pendientes" ? "Pendientes" : f === "rendidos" ? "Rendidas" : "Todas"}
          </button>
        ))}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="text-center py-12 text-white/30 text-sm">Cargando...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-white/30 text-sm">
          {filter === "pendientes" ? "No hay transferencias pendientes de informar." :
           filter === "rendidos" ? "No hay transferencias rendidas aún." :
           "No hay transferencias registradas."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item: any) => {
            const clientName = item.insuredName || item.manualPayer || "—";
            const policyNum = item.policyNumber || item.manualPolicyNumber || "—";
            const company = item.companyName || item.manualCompany || "—";
            const rendDate = item.renderedAt
              ? new Date(typeof item.renderedAt === "number" ? item.renderedAt * 1000 : item.renderedAt)
                  .toLocaleDateString("es-AR")
              : null;
            return (
              <div key={item.id}
                className={cn("bg-[#0d1424] border rounded-xl px-4 py-3 flex items-center gap-4",
                  item.rendered ? "border-green-500/20" : "border-orange-500/20")}>
                {/* Estado */}
                <div className={cn("w-2 h-2 rounded-full shrink-0", item.rendered ? "bg-green-400" : "bg-orange-400")} />
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-white">{clientName}</p>
                    <span className="text-xs text-white/30">·</span>
                    <p className="text-xs text-white/50">{company}</p>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                    <p className="text-xs text-white/30">Póliza {policyNum}</p>
                    {item.periodMonth && (
                      <p className="text-xs text-white/30">
                        Período {new Date(item.periodMonth + "-02").toLocaleDateString("es-AR", { month: "short", year: "numeric" })}
                      </p>
                    )}
                    <p className="text-xs text-white/30">
                      Cobrado {new Date(item.paymentDate + "T12:00:00").toLocaleDateString("es-AR")}
                    </p>
                    {item.rendered && rendDate && (
                      <span className="text-xs text-green-400/70">Rendida el {rendDate}</span>
                    )}
                  </div>
                  {item.notes && <p className="text-xs text-white/30 mt-0.5 italic">{item.notes}</p>}
                </div>
                {/* Monto */}
                <p className="text-base font-bold text-white shrink-0">{fmt(item.amount)}</p>
                {/* Acción */}
                <button onClick={() => toggleRendido(item)}
                  className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all shrink-0",
                    item.rendered
                      ? "border-white/15 text-white/40 hover:border-red-500/30 hover:text-red-400"
                      : "bg-orange-600 hover:bg-orange-500 border-transparent text-white")}>
                  {item.rendered ? (
                    <><X size={12} /> Desmarcar</>
                  ) : (
                    <><Check size={12} /> Rendida a compañía</>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Gastos Tab ───────────────────────────────────────────────────────────────
interface Gasto {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  notes: string | null;
}

function GastosTab() {
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), description: "", amount: "", category: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const fmt = (v: number) => formatCurrency(v);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/cash/expenses") as Gasto[];
      setGastos(data);
    } catch { toast.error("Error cargando gastos"); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function openNew() {
    setEditingId(null);
    setForm({ date: new Date().toISOString().slice(0, 10), description: "", amount: "", category: "", notes: "" });
    setShowForm(true);
  }

  function openEdit(g: Gasto) {
    setEditingId(g.id);
    setForm({ date: g.date, description: g.description, amount: String(g.amount), category: g.category || "", notes: g.notes || "" });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.description.trim()) return toast.error("Ingresá una descripción");
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) return toast.error("Monto inválido");
    setSaving(true);
    try {
      const payload = { date: form.date, description: form.description.trim(), amount: Number(form.amount), category: form.category.trim() || null, notes: form.notes.trim() || null };
      if (editingId) {
        await api.put(`/api/cash/expenses/${editingId}`, payload);
      } else {
        await api.post("/api/cash/expenses", payload);
      }
      toast.success(editingId ? "Gasto actualizado" : "Gasto registrado");
      setShowForm(false);
      load();
    } catch { toast.error("Error guardando gasto"); }
    finally { setSaving(false); }
  }

  async function handleDelete(id: number) {
    if (!confirm("¿Anular este gasto?")) return;
    try {
      await api.delete(`/api/cash/expenses/${id}`);
      toast.success("Gasto anulado");
      await load();
    } catch (e: any) { toast.error(e?.message || "Error al anular el gasto"); }
  }

  const total = gastos.reduce((s, g) => s + g.amount, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-base">Gastos registrados</h2>
          <p className="text-gray-400 text-xs mt-0.5">Gastos operativos registrados</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-sm font-medium transition-colors">
          <Plus size={15} /> Nuevo gasto
        </button>
      </div>

      {/* Resumen total */}
      {gastos.length > 0 && (
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-500/20 flex items-center justify-center">
              <ShoppingCart size={18} className="text-orange-400" />
            </div>
            <div>
              <p className="text-xs text-gray-400">Total gastos</p>
              <p className="text-lg font-bold text-orange-400">{fmt(total)}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500">{gastos.length} {gastos.length === 1 ? "registro" : "registros"}</p>
        </div>
      )}

      {/* Form inline */}
      {showForm && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
          <h3 className="text-white font-semibold text-sm">{editingId ? "Editar gasto" : "Nuevo gasto"}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Fecha *</label>
              <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Monto *</label>
              <input type="number" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                placeholder="0.00" min="0" step="0.01"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50" />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-gray-400 mb-1 block">Descripción *</label>
              <input type="text" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Ej: Papelería, servicios, comisión banco..."
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Categoría (opcional)</label>
              <input type="text" value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                placeholder="Ej: Administrativo, Impuestos..."
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Notas (opcional)</label>
              <input type="text" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="Detalle adicional..."
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50" />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              <Save size={14} /> {saving ? "Guardando..." : "Guardar"}
            </button>
            <button onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/60 rounded-lg text-sm transition-colors">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 text-sm">Cargando...</div>
      ) : gastos.length === 0 ? (
        <div className="text-center py-16">
          <ShoppingCart size={32} className="mx-auto text-gray-600 mb-3" />
          <p className="text-gray-400 text-sm font-medium">Sin gastos registrados</p>
          <p className="text-gray-600 text-xs mt-1">Los gastos se descuentan del saldo en caja</p>
        </div>
      ) : (
        <div className="space-y-2">
          {gastos.map(g => (
            <div key={g.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center shrink-0">
                <ShoppingCart size={14} className="text-orange-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-white truncate">{g.description}</p>
                  {g.category && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-white/5 text-gray-400 border border-white/10">{g.category}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-gray-500">{g.date}</p>
                  {g.notes && <p className="text-xs text-gray-600 truncate">— {g.notes}</p>}
                </div>
              </div>
              <p className="text-base font-bold text-orange-400 shrink-0">{fmt(g.amount)}</p>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => openEdit(g)} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-blue-400 transition-colors">
                  <Edit2 size={13} />
                </button>
                <button onClick={() => handleDelete(g.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-gray-400 hover:text-red-400 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Contenedor principal con tabs ───────────────────────────────────────────
export default function Cobranzas() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"cobranzas" | "lote" | "rendiciones" | "adeudados" | "transferencias" | "gastos">("cobranzas");

  return (
    <AppLayout>
      <div className="p-4 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Cobranzas y Rendiciones</h1>
            <p className="text-gray-400 text-sm mt-1">Imputación de cobros y gestión de rendiciones a compañías</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 bg-white/5 border border-white/10 rounded-lg p-1 w-fit">
          {[
            { key: "cobranzas", label: "Cobranzas", icon: DollarSign },
            { key: "lote", label: "Cuotas pendientes", icon: Layers },
            { key: "transferencias", label: "Transf. Compañía", icon: Building2 },
            { key: "rendiciones", label: "Rendiciones", icon: ReceiptText },
            { key: "adeudados", label: "Adeudados", icon: AlertCircle },
            { key: "gastos", label: "Gastos", icon: ShoppingCart },
          ].filter(t => t.key !== "transferencias" || user?.role === "admin")
          .map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setTab(key as any)}
              className={cn("flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
                tab === key ? "bg-blue-600 text-white" : "text-white/40 hover:text-white")}>
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        {/* Contenido del tab */}
        {tab === "cobranzas" && <CobranzasTab />}
        {tab === "lote" && <PendingInstallmentsBatchTab />}
        {tab === "transferencias" && <TransferenciasTab />}
        {tab === "rendiciones" && <RendicionesTab />}
        {tab === "adeudados" && <AdeudadosTab />}
        {tab === "gastos" && <GastosTab />}
      </div>
    </AppLayout>
  );
}
