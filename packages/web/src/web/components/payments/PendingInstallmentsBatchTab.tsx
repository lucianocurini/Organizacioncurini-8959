import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Search, Loader2, X, Plus, Trash2, ReceiptText, Layers, RefreshCw, Info, ChevronDown, ShoppingCart, FileEdit, Users,
  Pencil, Ban, AlertTriangle,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import {
  type PendingInstallmentForPayment, type BatchSplitFormRow, type PaymentBatchSummary,
  type PaymentBatchDetail, type CheckFormRow, type BatchCartItem, type ManualPaymentFormState,
  type PaymentBatchCancelCheckResponse, type BatchEditFormState,
  summarizeCartInsureds, calculateCartTotal, getInstallmentRowState, addInstallmentToCart, removeFromCart,
  cartItemKey, emptyManualPaymentForm, validateManualPaymentForm, addManualPaymentToCart,
  estimateProntoPagoSurchargeCents, calculateBatchTargetAmountCents,
  createBatchSplitRow, addBatchSplitRow, removeBatchSplitRow, updateBatchSplitRow,
  syncSingleBatchSplitAmount, addCheckToSplit, removeCheckFromSplit, updateCheckInSplit,
  validateBatchSplitsForm, computeSplitTotals, groupSplitsByMethod,
  isBatchSubmitDisabled, buildPaymentBatchPayload, normalizeBatchSubmitError,
  isManualBatchDetailItem, describeBatchDetailItem, batchDetailItemInsuredLabel,
  canShowCancelButton, canShowEditButton, describeBatchCancelImpact, isCancelConfirmationValid,
  buildBatchCancelPayload, emptyBatchEditForm, validateBatchEditForm, buildBatchPatchPayload, BATCH_CORRECTION_HINT,
} from "@/lib/payment-batch-form";

const METHOD_LABELS: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transf. cuenta propia",
  cheque: "Cheque",
  link_pago: "Link de Pago",
  transferencia_compania: "Transf. a Compañía",
};
const PAYMENT_METHODS = ["efectivo", "transferencia", "cheque", "link_pago", "transferencia_compania"];

interface PolicyOption {
  policy: { id: number; policyNumber: string; status: string; insuredId: number };
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Asegurado/pagador de un ítem de carrito, para mostrar en cada fila. */
function cartItemInsuredLabel(item: BatchCartItem): string {
  if (item.insuredId != null) return item.insuredName!;
  if (item.kind === "manual_payment" && item.manualPayer) return item.manualPayer;
  return "—";
}

function cartItemLabel(item: BatchCartItem): string {
  if (item.kind === "installment") return `Cuota #${item.installmentNumber} — ${item.policyNumber}`;
  if (item.kind === "policy_manual_payment") return `Cobro manual — ${item.policyNumber}`;
  const parts = [item.manualPayer, item.manualPolicyNumber].filter(Boolean);
  return `Cobro manual — ${parts.length > 0 ? parts.join(" / ") : "imputación libre"}`;
}

function cartItemSubtitle(item: BatchCartItem): string {
  if (item.kind === "installment") return `${item.companyName} · vence ${fmtDate(item.dueDate)}`;
  if (item.kind === "policy_manual_payment") return `${item.companyName}${item.description ? ` · ${item.description}` : ""}`;
  const company = item.manualCompany ? `Compañía: ${item.manualCompany}` : "Sin compañía";
  return `${company}${item.description ? ` · ${item.description}` : ""}`;
}

// ─── Tab principal: buscador + carrito + acciones ───────────────────────────
// Un lote es una operación de cobro, no un asegurado: el carrito acepta
// libremente cuotas, cobros con póliza real y cobros completamente
// manuales de distintos integrantes de una misma familia (o directamente
// sin ningún asegurado real) — no existe ningún "Cliente del lote" que
// fijar de antemano.

export function PendingInstallmentsBatchTab() {
  const [cart, setCart] = useState<BatchCartItem[]>([]);
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [pending, setPending] = useState<PendingInstallmentForPayment[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);

  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState<ManualPaymentFormState>(emptyManualPaymentForm());
  const [manualPolicySearch, setManualPolicySearch] = useState("");
  const [manualPolicyOpen, setManualPolicyOpen] = useState(false);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [receipt, setReceipt] = useState<PaymentBatchDetail | null>(null);
  const [recentBatches, setRecentBatches] = useState<PaymentBatchSummary[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [pendingBatchId, setPendingBatchId] = useState<number | null>(null); // creado pero sin poder refrescar/leer detalle

  // Edición administrativa (solo fecha/notas) y anulación de un lote ya
  // confirmado — ambos accesibles desde el comprobante y desde el listado de
  // lotes recientes.
  const [editingBatchId, setEditingBatchId] = useState<number | null>(null);
  const [cancellingBatchId, setCancellingBatchId] = useState<number | null>(null);

  const cartTotal = calculateCartTotal(cart);
  const surchargeEstimateCents = estimateProntoPagoSurchargeCents(cart);
  const cartInsuredSummary = summarizeCartInsureds(cart);
  const shouldSearch = search.trim() !== "" || companyId !== "";

  async function loadPending() {
    setLoadingPending(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (companyId) params.set("companyId", companyId);
      const qs = params.toString();
      const data = await api.get(`/api/installments/pending-for-payment${qs ? `?${qs}` : ""}`);
      setPending(data);
    } catch {
      toast.error("No se pudieron cargar las cuotas pendientes.");
    } finally {
      setLoadingPending(false);
    }
  }

  async function loadRecentBatches() {
    setLoadingRecent(true);
    try {
      const data = await api.get("/api/payment-batches?limit=10");
      setRecentBatches(data);
    } catch {
      // no bloqueante — el listado reciente es informativo
    } finally {
      setLoadingRecent(false);
    }
  }

  useEffect(() => {
    if (!shouldSearch) { setPending([]); return; }
    loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, companyId]);

  useEffect(() => { loadRecentBatches(); }, []);
  useEffect(() => { api.get("/api/policies").then(setPolicies).catch(() => {}); }, []);

  function addInstallment(item: PendingInstallmentForPayment) {
    const result = addInstallmentToCart(cart, item);
    if (result.error) { toast.error(result.error); return; }
    setCart(result.cart);
  }

  function removeItem(key: string) {
    setCart((prev) => removeFromCart(prev, key));
  }

  function clearCart() {
    setCart([]);
  }

  function selectManualPolicy(p: PolicyOption) {
    setManualForm((f) => ({
      ...f,
      policyId: String(p.policy.id),
      policyNumber: p.policy.policyNumber,
      policyStatus: p.policy.status,
      policyInsuredId: String(p.insured?.id ?? p.policy.insuredId),
      policyInsuredName: p.insured?.name ?? "",
      policyCompanyId: String(p.company?.id ?? ""),
      policyCompanyName: p.company?.name ?? "",
    }));
    setManualPolicyOpen(false);
    setManualPolicySearch("");
  }

  function addManualPayment() {
    const result = addManualPaymentToCart(cart, manualForm);
    if (result.error) { toast.error(result.error); return; }
    setCart(result.cart);
    setManualForm(emptyManualPaymentForm());
    setShowManualForm(false);
  }

  const manualValidation = validateManualPaymentForm(manualForm);
  const filteredManualPolicies = policies.filter((p) => {
    const q = manualPolicySearch.toLowerCase();
    if (!q) return true;
    return p.policy.policyNumber.toLowerCase().includes(q) || (p.insured?.name ?? "").toLowerCase().includes(q);
  });

  async function openReceipt(batchId: number) {
    try {
      const detail = await api.get(`/api/payment-batches/${batchId}`);
      setReceipt(detail);
      setPendingBatchId(null);
    } catch {
      toast.error("No se pudo abrir el comprobante. El cobro ya fue creado (id " + batchId + ").");
      setPendingBatchId(batchId);
    }
  }

  async function handleBatchCreated(batchId: number) {
    setShowBatchModal(false);
    clearCart();
    let refreshFailed = false;
    try {
      await loadPending();
    } catch { refreshFailed = true; }
    try {
      await loadRecentBatches();
    } catch { refreshFailed = true; }
    await openReceipt(batchId);
    if (refreshFailed) {
      toast.error("El cobro fue creado, pero no se pudo actualizar la pantalla. Podés recargar manualmente.");
    } else {
      toast.success("Cobro por lote registrado correctamente.");
    }
  }

  return (
    <div className="space-y-6">
      {/* Búsqueda de cuotas existentes */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-white/40" />
          <h3 className="text-sm font-semibold text-white">Buscar cuotas para agregar al lote</h3>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por asegurado o póliza..."
              className="w-full pl-10 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder-white/30 outline-none focus:border-blue-500"
            />
          </div>
          <input
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value.replace(/\D/g, ""))}
            placeholder="ID compañía (opcional)"
            className="sm:w-56 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm placeholder-white/30 outline-none focus:border-blue-500"
          />
          <button onClick={loadPending} disabled={!shouldSearch} className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white/60 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-white/30 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" /> Podés agregar cuotas de distintos asegurados, pólizas y compañías al mismo lote.
        </p>

        {!shouldSearch ? (
          <div className="p-8 text-center text-white/40 text-sm">
            Buscá por asegurado, póliza o compañía para ver cuotas cobrables.
          </div>
        ) : (
          <div className="border border-white/10 rounded-xl overflow-x-auto">
            {loadingPending ? (
              <div className="p-8 text-center text-white/40 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Buscando cuotas...
              </div>
            ) : pending.length === 0 ? (
              <div className="p-8 text-center text-white/40">No hay cuotas cobrables con estos filtros.</div>
            ) : (
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr className="text-xs text-white/40 border-b border-white/10">
                    <th className="text-left px-3 py-2.5 font-medium">Asegurado</th>
                    <th className="text-left px-3 py-2.5 font-medium">Póliza</th>
                    <th className="text-left px-3 py-2.5 font-medium">Compañía</th>
                    <th className="text-left px-3 py-2.5 font-medium">Cuota</th>
                    <th className="text-left px-3 py-2.5 font-medium">Vencimiento</th>
                    <th className="text-right px-3 py-2.5 font-medium">Importe</th>
                    <th className="w-32 px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((item) => {
                    const state = getInstallmentRowState(item, cart);
                    return (
                      <tr
                        key={item.installmentId}
                        title={state.reason ?? undefined}
                        className={cn("border-b border-white/5 last:border-0", !state.addable && "opacity-40")}
                      >
                        <td className="px-3 py-2.5 text-white">{item.insuredName}</td>
                        <td className="px-3 py-2.5 text-white/70 font-mono text-xs">{item.policyNumber}</td>
                        <td className="px-3 py-2.5 text-white/70">{item.companyName}</td>
                        <td className="px-3 py-2.5 text-white/50 font-mono text-xs">#{item.installmentNumber}</td>
                        <td className="px-3 py-2.5 text-white/70">{fmtDate(item.dueDate)}</td>
                        <td className="px-3 py-2.5 text-right text-white font-mono">{formatCurrency(item.amount)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            onClick={() => addInstallment(item)}
                            disabled={!state.addable}
                            className="flex items-center gap-1 px-2.5 py-1 bg-blue-600/80 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded-lg transition-all ml-auto"
                          >
                            <Plus className="w-3 h-3" /> Agregar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Agregar cobro manual */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileEdit className="w-4 h-4 text-white/40" />
            <h3 className="text-sm font-semibold text-white">Cobro manual</h3>
          </div>
          <button
            onClick={() => setShowManualForm((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
          >
            <Plus className="w-3.5 h-3.5" /> {showManualForm ? "Cancelar" : "Agregar cobro manual"}
          </button>
        </div>

        {showManualForm && (
          <div className="space-y-3 p-3 bg-white/5 border border-white/10 rounded-lg">
            <p className="text-xs text-white/40">
              Cobro real sin cuota puntual (ej. una cuota faltante que se cobra igual, o un pago cuya póliza no está
              cargada o está mal cargada). No crea ninguna cuota nueva ni queda registrado como deuda. Podés cargarlo
              aunque el carrito esté vacío y sin elegir ningún cliente de antemano.
            </p>

            <label className="flex items-center gap-2 text-xs text-white/60">
              <input type="checkbox" checked={manualForm.linkPolicy}
                onChange={(e) => setManualForm((f) => ({ ...f, linkPolicy: e.target.checked }))}
                className="accent-blue-600" />
              Vincular a una póliza existente (opcional)
            </label>

            {manualForm.linkPolicy ? (
              <div>
                <label className="block text-xs text-white/50 mb-1">Póliza *</label>
                <div className="relative">
                  <button type="button" onClick={() => setManualPolicyOpen(!manualPolicyOpen)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-left">
                    <span className={manualForm.policyId ? "text-white" : "text-white/40"}>
                      {manualForm.policyId ? `${manualForm.policyNumber} — ${manualForm.policyInsuredName}` : "Seleccionar póliza..."}
                    </span>
                    <ChevronDown className="w-4 h-4 text-white/40" />
                  </button>
                  {manualPolicyOpen && (
                    <div className="absolute z-20 w-full mt-1 bg-[#0d1117] border border-white/10 rounded-lg shadow-xl max-h-52 overflow-y-auto">
                      <div className="p-2 border-b border-white/10">
                        <input type="text" placeholder="Buscar..." value={manualPolicySearch}
                          onChange={(e) => setManualPolicySearch(e.target.value)} autoFocus
                          className="w-full bg-white/5 border border-white/10 rounded px-3 py-1.5 text-sm text-white placeholder-white/30 outline-none" />
                      </div>
                      {filteredManualPolicies.map((p) => (
                        <button key={p.policy.id} type="button" onClick={() => selectManualPolicy(p)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors">
                          <span className="text-white">{p.policy.policyNumber}</span>
                          <span className="text-white/40 ml-2">— {p.insured?.name}</span>
                          {p.policy.status === "cancelada" && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400">cancelada</span>
                          )}
                        </button>
                      ))}
                      {filteredManualPolicies.length === 0 && <p className="text-white/40 text-sm px-3 py-2">Sin resultados</p>}
                    </div>
                  )}
                </div>
                {manualForm.policyStatus === "cancelada" && (
                  <p className="text-xs text-red-400 mt-1">Esta póliza está cancelada — no se puede cargar un cobro manual.</p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Pagador / asegurado</label>
                  <input value={manualForm.manualPayer}
                    onChange={(e) => setManualForm((f) => ({ ...f, manualPayer: e.target.value }))}
                    placeholder="Nombre completo..."
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">N° de póliza (manual)</label>
                  <input value={manualForm.manualPolicyNumber}
                    onChange={(e) => setManualForm((f) => ({ ...f, manualPolicyNumber: e.target.value }))}
                    placeholder="Ej: 12345678"
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-white/50 mb-1">Compañía (manual)</label>
                  <input value={manualForm.manualCompany}
                    onChange={(e) => setManualForm((f) => ({ ...f, manualCompany: e.target.value }))}
                    placeholder="Ej: MAPFRE"
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
                </div>
                <p className="col-span-2 text-[11px] text-white/30">
                  Completá al menos el pagador o el N° de póliza. Una compañía tipeada acá nunca activa el recargo
                  Pronto Pago automáticamente — solo una póliza real vinculada calificaría.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/50 mb-1">Importe *</label>
                <input type="number" value={manualForm.amount}
                  onChange={(e) => setManualForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">Descripción / notas</label>
                <input value={manualForm.description}
                  onChange={(e) => setManualForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Ej: cuota faltante importada"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
              </div>
            </div>

            <button
              onClick={addManualPayment}
              disabled={!manualValidation.valid}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/80 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded-lg transition-all font-medium"
            >
              <Plus className="w-3.5 h-3.5" /> Agregar al carrito
            </button>
            {!manualValidation.valid && manualValidation.errorMessage && (manualForm.manualPayer || manualForm.manualPolicyNumber || manualForm.policyId) && (
              <p className="text-xs text-red-400">{manualValidation.errorMessage}</p>
            )}
          </div>
        )}
      </div>

      {/* Carrito */}
      <div className="bg-white/5 border border-blue-500/20 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Carrito {cart.length > 0 && `(${cart.length})`}</h3>
            {cartInsuredSummary.kind === "multiple" && (
              <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-300">
                <Users className="w-3 h-3" /> Varios asegurados
              </span>
            )}
          </div>
          {cart.length > 0 && (
            <button onClick={clearCart} className="text-xs text-white/50 hover:text-white transition-all">
              Vaciar carrito
            </button>
          )}
        </div>

        {cart.length === 0 ? (
          <p className="text-sm text-white/40 py-4 text-center">
            El carrito está vacío. Buscá una cuota o agregá un cobro manual para empezar — puede ser de cualquier
            asegurado, o incluso una imputación completamente manual sin ningún asegurado real.
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              {cart.map((item) => {
                const k = cartItemKey(item);
                return (
                  <div key={k} className="flex items-center justify-between gap-3 px-3 py-2 bg-white/5 rounded-lg text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="text-white truncate">
                        {item.kind !== "installment" && (
                          <span className="text-xs px-1.5 py-0.5 rounded border border-orange-500/30 bg-orange-500/10 text-orange-400 mr-1.5">Cobro manual</span>
                        )}
                        {item.kind === "installment" ? cartItemLabel(item) : (
                          item.kind === "policy_manual_payment" ? item.policyNumber
                            : [item.manualPayer, item.manualPolicyNumber].filter(Boolean).join(" / ") || "imputación libre"
                        )}
                      </p>
                      <p className="text-xs text-white/40">{cartItemInsuredLabel(item)} · {cartItemSubtitle(item)}</p>
                    </div>
                    <span className="text-white font-mono shrink-0">{formatCurrency(item.amount)}</span>
                    <button onClick={() => removeItem(k)} className="text-white/30 hover:text-red-400 shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-white/10 space-y-1 text-sm">
              <div className="flex justify-between text-white/60">
                <span>Subtotal ({cart.length} ítem{cart.length === 1 ? "" : "s"})</span>
                <span className="font-mono">{formatCurrency(cartTotal)}</span>
              </div>
              {surchargeEstimateCents > 0 && (
                <div className="flex justify-between text-purple-400">
                  <span>Posible recargo Pronto Pago (si todos los medios son propios)</span>
                  <span className="font-mono">+{formatCurrency(surchargeEstimateCents / 100)}</span>
                </div>
              )}
              <div className="flex justify-between text-white font-semibold pt-1">
                <span>Total estimado</span>
                <span className="font-mono">{formatCurrency(cartTotal + surchargeEstimateCents / 100)}</span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowBatchModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all"
              >
                <Layers className="w-4 h-4" /> Cobrar en lote
              </button>
            </div>
          </>
        )}
      </div>

      {/* Lotes recientes */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <ReceiptText className="w-4 h-4 text-white/40" />
          <h3 className="text-sm font-semibold text-white">Cobros por lote recientes</h3>
        </div>
        {loadingRecent ? (
          <p className="text-xs text-white/40">Cargando...</p>
        ) : recentBatches.length === 0 ? (
          <p className="text-xs text-white/40">Todavía no se registró ningún cobro por lote.</p>
        ) : (
          <div className="space-y-2">
            {recentBatches.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 px-3 py-2 bg-white/5 rounded-lg text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-white/40">#{b.id}</span>
                  <span className="text-white">{b.insuredDisplay}</span>
                  <span className="text-white/40">{fmtDate(b.paymentDate)}</span>
                  <span className="text-white/40">{b.itemCount} ítem{b.itemCount === 1 ? "" : "s"}</span>
                  {b.checkCount > 0 && <span className="text-yellow-400">{b.checkCount} cheque{b.checkCount === 1 ? "" : "s"}</span>}
                  {b.status === "anulado" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400">Anulado</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-white font-mono">{formatCurrency(b.totalReceivedCents / 100)}</span>
                  {canShowEditButton(b.status) && (
                    <button onClick={() => setEditingBatchId(b.id)} title="Editar datos" className="text-white/40 hover:text-white">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {canShowCancelButton(b.status) && (
                    <button onClick={() => setCancellingBatchId(b.id)} title="Anular cobro" className="text-white/40 hover:text-red-400">
                      <Ban className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => openReceipt(b.id)} className="text-blue-400 hover:text-blue-300">Ver</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingBatchId != null && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300 flex items-center justify-between gap-3">
          <span>El cobro (id {pendingBatchId}) fue creado, pero no se pudo abrir el comprobante.</span>
          <button onClick={() => openReceipt(pendingBatchId)} className="px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/25 rounded-lg border border-amber-500/30">
            Reintentar
          </button>
        </div>
      )}

      {showBatchModal && (
        <BatchPaymentModal
          cart={cart}
          onClose={() => setShowBatchModal(false)}
          onCreated={handleBatchCreated}
        />
      )}

      {receipt && (
        <BatchReceiptModal
          detail={receipt}
          onClose={() => setReceipt(null)}
          onEdit={() => setEditingBatchId(receipt.batch.id)}
          onCancelRequest={() => setCancellingBatchId(receipt.batch.id)}
        />
      )}

      {editingBatchId != null && (
        <EditBatchModal
          batchId={editingBatchId}
          onClose={() => setEditingBatchId(null)}
          onSaved={async () => {
            setEditingBatchId(null);
            await loadRecentBatches();
            if (receipt?.batch.id === editingBatchId) await openReceipt(editingBatchId);
          }}
        />
      )}

      {cancellingBatchId != null && (
        <CancelBatchModal
          batchId={cancellingBatchId}
          onClose={() => setCancellingBatchId(null)}
          onCancelled={async () => {
            setCancellingBatchId(null);
            await loadRecentBatches();
            await loadPending();
            if (receipt?.batch.id === cancellingBatchId) await openReceipt(cancellingBatchId);
            toast.success("Cobro anulado correctamente.");
          }}
        />
      )}
    </div>
  );
}

// ─── Modal "Cobrar en lote" ─────────────────────────────────────────────────────

function BatchPaymentModal({
  cart, onClose, onCreated,
}: {
  cart: BatchCartItem[];
  onClose: () => void;
  onCreated: (batchId: number) => void;
}) {
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [splits, setSplits] = useState<BatchSplitFormRow[]>(() => {
    const target = calculateBatchTargetAmountCents(cart, [{ ...createBatchSplitRow("efectivo"), method: "efectivo" }]);
    return [createBatchSplitRow("efectivo", String(target / 100))];
  });
  const [submitting, setSubmitting] = useState(false);
  let submissionLock = false; // guard sincrónico además del estado `submitting` — ver nota en handleSubmit

  const subtotal = calculateCartTotal(cart);
  const targetCents = calculateBatchTargetAmountCents(cart, splits);
  const surchargeCents = targetCents - Math.round(subtotal * 100);
  const validation = validateBatchSplitsForm(targetCents, splits);
  const totals = computeSplitTotals(String(targetCents / 100), splits);

  function setSplitsAndSync(next: BatchSplitFormRow[]) {
    const target = calculateBatchTargetAmountCents(cart, next);
    setSplits(next.length === 1 ? syncSingleBatchSplitAmount(next, String(target / 100)) : next);
  }

  function handleAddSplit() {
    setSplitsAndSync(addBatchSplitRow(splits));
  }
  function handleRemoveSplit(uid: string) {
    setSplitsAndSync(removeBatchSplitRow(splits, uid));
  }
  function handleUpdateSplit(uid: string, patch: Partial<Pick<BatchSplitFormRow, "method" | "amount">>) {
    setSplitsAndSync(updateBatchSplitRow(splits, uid, patch));
  }

  async function handleSubmit() {
    // Guard sincrónico: además de deshabilitar el botón vía `submitting`
    // (estado, asíncrono), esta variable local corta un segundo click que
    // llegue antes del primer re-render — es la "submission lock" pedida,
    // sin depender de una idempotency key persistida (ver nota en el
    // backend, index.ts, sección PAYMENT BATCHES).
    if (submissionLock || submitting) return;
    submissionLock = true;
    if (!validation.valid) {
      toast.error(validation.errorMessage ?? "Revisá los medios de pago.");
      submissionLock = false;
      return;
    }
    setSubmitting(true);
    try {
      const payload = buildPaymentBatchPayload({
        paymentDate, cart, splits, notes: notes || null,
      });
      const result = await api.post("/api/payment-batches", payload);
      onCreated(result.id);
    } catch (err: any) {
      const normalized = normalizeBatchSubmitError(err);
      toast.error(normalized.message);
    } finally {
      setSubmitting(false);
      submissionLock = false;
    }
  }

  const disabled = isBatchSubmitDisabled(submitting, validation.valid, cart.length > 0);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-2xl my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Cobrar en lote</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Resumen del carrito */}
          <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-white/40 border-b border-white/10">
                  <th className="text-left px-3 py-2">Ítem</th>
                  <th className="text-left px-3 py-2">Asegurado/Pagador</th>
                  <th className="text-left px-3 py-2">Compañía</th>
                  <th className="text-right px-3 py-2">Importe</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((item) => (
                  <tr key={cartItemKey(item)} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 text-white/80">
                      {item.kind === "installment"
                        ? `Cuota #${item.installmentNumber} — ${item.policyNumber} — vence ${fmtDate(item.dueDate)}`
                        : item.kind === "policy_manual_payment"
                          ? `Cobro manual — ${item.policyNumber}${item.description ? ` — ${item.description}` : ""}`
                          : `Cobro manual — ${[item.manualPayer, item.manualPolicyNumber].filter(Boolean).join(" / ") || "imputación libre"}${item.description ? ` — ${item.description}` : ""}`}
                    </td>
                    <td className="px-3 py-2 text-white/70">{cartItemInsuredLabel(item)}</td>
                    <td className="px-3 py-2 text-white/70">
                      {item.kind === "manual_payment" ? (item.manualCompany || "—") : item.companyName}
                    </td>
                    <td className="px-3 py-2 text-right text-white font-mono">{formatCurrency(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td colSpan={3} className="px-3 py-2 text-white/60 font-medium">Subtotal ({cart.length} ítem{cart.length === 1 ? "" : "s"})</td>
                  <td className="px-3 py-2 text-right text-white font-mono">{formatCurrency(subtotal)}</td>
                </tr>
                {surchargeCents > 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-purple-400">Recargo Pronto Pago Rivadavia</td>
                    <td className="px-3 py-2 text-right text-purple-400 font-mono">+{formatCurrency(surchargeCents / 100)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-white font-semibold">Total a cobrar</td>
                  <td className="px-3 py-2 text-right text-white font-mono font-semibold">{formatCurrency(targetCents / 100)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Fecha y notas */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/50 block mb-1">Fecha de pago *</label>
              <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-white/50 block mb-1">Notas</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Editor de medios */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-white/50 uppercase tracking-wider font-medium">Medios de pago</p>
              <button onClick={handleAddSplit} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
                <Plus className="w-3.5 h-3.5" /> Agregar medio
              </button>
            </div>
            <div className="space-y-3">
              {splits.map((split) => (
                <div key={split.uid} className="bg-white/5 border border-white/10 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <select value={split.method} onChange={(e) => handleUpdateSplit(split.uid, { method: e.target.value })}
                      className="payment-method-select flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded text-white text-xs outline-none focus:border-blue-500">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                    </select>
                    <input type="number" value={split.amount} onChange={(e) => handleUpdateSplit(split.uid, { amount: e.target.value })}
                      placeholder="0.00" disabled={splits.length === 1}
                      className="w-32 px-2 py-1.5 bg-white/5 border border-white/10 rounded text-white text-xs outline-none focus:border-blue-500 disabled:opacity-60" />
                    {splits.length > 1 && (
                      <button onClick={() => handleRemoveSplit(split.uid)} className="text-white/40 hover:text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {split.method === "cheque" && (
                    <CheckSubForm
                      split={split}
                      onAdd={() => setSplits(addCheckToSplit(splits, split.uid))}
                      onRemove={(checkUid) => setSplits(removeCheckFromSplit(splits, split.uid, checkUid))}
                      onUpdate={(checkUid, patch) => setSplits(updateCheckInSplit(splits, split.uid, checkUid, patch))}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Totales */}
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-white/40">Distribuido: {formatCurrency(totals.distributedCents / 100)}</span>
              {totals.diferenciaCents !== 0 && totals.diferenciaCents != null && (
                <span className="text-amber-400">Diferencia: {formatCurrency(totals.diferenciaCents / 100)}</span>
              )}
            </div>
            {validation.errorMessage && (
              <p className="mt-2 text-xs text-red-400">{validation.errorMessage}</p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button onClick={onClose} className="px-4 py-2 bg-white/5 text-white/60 text-sm rounded-lg hover:bg-white/10 transition-all">Cancelar</button>
            <button onClick={handleSubmit} disabled={disabled}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Confirmar cobro
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Subformulario de cheques (uno o varios por split método=cheque) ───────────

function CheckSubForm({
  split, onAdd, onRemove, onUpdate,
}: {
  split: BatchSplitFormRow;
  onAdd: () => void;
  onRemove: (checkUid: string) => void;
  onUpdate: (checkUid: string, patch: Partial<Omit<CheckFormRow, "uid">>) => void;
}) {
  return (
    <div className="pl-3 border-l-2 border-yellow-500/30 space-y-2">
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

// ─── Comprobante del lote ────────────────────────────────────────────────────

function BatchReceiptModal({
  detail, onClose, onEdit, onCancelRequest,
}: {
  detail: PaymentBatchDetail;
  onClose: () => void;
  onEdit: () => void;
  onCancelRequest: () => void;
}) {
  const groupedSplits = groupSplitsByMethod(detail.splits);
  const isAnulado = detail.batch.status === "anulado";
  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className={cn("bg-[#0d1117] border rounded-2xl w-full max-w-lg my-4", isAnulado ? "border-red-500/30" : "border-emerald-500/30")}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <ReceiptText className={cn("w-4 h-4", isAnulado ? "text-red-400" : "text-emerald-400")} />
            <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Comprobante del cobro #{detail.batch.id}</h2>
            {isAnulado && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400">Anulado</span>
            )}
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4 text-sm">
          {!isAnulado && (
            <div className="flex justify-end gap-2">
              <button onClick={onEdit} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/70">
                <Pencil className="w-3.5 h-3.5" /> Editar datos
              </button>
              <button onClick={onCancelRequest} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-xs text-red-400">
                <Ban className="w-3.5 h-3.5" /> Anular cobro
              </button>
            </div>
          )}

          {isAnulado && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                Este cobro fue anulado{detail.batch.cancelledAt ? ` el ${fmtDate(detail.batch.cancelledAt.slice(0, 10))}` : ""}
                {detail.batch.cancellationReason ? ` — motivo: ${detail.batch.cancellationReason}` : ""}.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><span className="text-white/40">Fecha:</span> <span className="text-white">{fmtDate(detail.batch.paymentDate)}</span></div>
            <div><span className="text-white/40">Estado:</span> <span className="text-white">{detail.batch.status}</span></div>
            <div><span className="text-white/40">Asegurado:</span> <span className="text-white">{detail.insuredSummary.insuredDisplay}</span></div>
            <div><span className="text-white/40">Ítems:</span> <span className="text-white">{detail.items.length}</span></div>
            <div className="col-span-2"><span className="text-white/40">Recargos:</span> <span className="text-white">{formatCurrency(detail.batch.surchargeAmountCents / 100)}</span></div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
            <p className="text-xs text-white/40 uppercase tracking-wider mb-2">Ítems del cobro</p>
            {detail.items.map((item) => (
              <div key={item.payment.id} className="flex justify-between items-start gap-3 text-xs py-1 border-b border-white/5 last:border-0">
                <span className={cn("flex-1", isManualBatchDetailItem(item) ? "text-orange-300" : "text-white/70")}>
                  <span className="text-white/50">{batchDetailItemInsuredLabel(item)}</span> — {describeBatchDetailItem(item)}
                </span>
                <span className="text-white font-mono shrink-0">{formatCurrency(item.payment.amount)}</span>
              </div>
            ))}
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
            <p className="text-xs text-white/40 uppercase tracking-wider mb-2">Medios de pago</p>
            {groupedSplits.map((s) => (
              <div key={s.method} className="flex justify-between text-xs py-0.5">
                <span className="text-white/70">{METHOD_LABELS[s.method] ?? s.method}</span>
                <span className="text-white font-mono">{formatCurrency(s.amountCents / 100)}</span>
              </div>
            ))}
          </div>

          {detail.splits.some((s) => s.checks.length > 0) && (
            <div className="bg-white/5 border border-white/10 rounded-xl p-3">
              <p className="text-xs text-white/40 uppercase tracking-wider mb-2">Cheques</p>
              {detail.splits.flatMap((s) => s.checks).map((c) => (
                <div key={c.id} className="flex justify-between text-xs py-0.5">
                  <span className="text-white/70">{c.bankName} #{c.checkNumber} — vence {fmtDate(c.dueDate)}</span>
                  <span className="text-white font-mono">{formatCurrency(c.amountCents / 100)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between items-center px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
            <span className="text-emerald-300 text-sm font-medium">Total recibido</span>
            <span className="text-white font-mono font-semibold">{formatCurrency(detail.batch.totalReceivedCents / 100)}</span>
          </div>

          {Object.values(detail.integrity).some((v) => v === false || (Array.isArray(v) && v.length > 0)) && (
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>Se detectaron inconsistencias de integridad en este cobro — revisar con un administrador.</span>
            </div>
          )}

          <p className="text-[11px] text-white/30">{BATCH_CORRECTION_HINT}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Modal "Editar datos" (solo fecha/notas) ────────────────────────────────

function EditBatchModal({ batchId, onClose, onSaved }: { batchId: number; onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<BatchEditFormState>(emptyBatchEditForm("", null));

  useEffect(() => {
    api.get(`/api/payment-batches/${batchId}`)
      .then((detail: PaymentBatchDetail) => setForm(emptyBatchEditForm(detail.batch.paymentDate, detail.batch.notes)))
      .catch(() => toast.error("No se pudieron cargar los datos del cobro."))
      .finally(() => setLoading(false));
  }, [batchId]);

  const validation = validateBatchEditForm(form);

  async function handleSave() {
    if (!validation.valid) { toast.error(validation.errorMessage ?? "Revisá los datos."); return; }
    setSaving(true);
    try {
      await api.patch(`/api/payment-batches/${batchId}`, buildBatchPatchPayload(form));
      toast.success("Datos del cobro actualizados.");
      onSaved();
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-md my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Pencil className="w-4 h-4 text-white/60" />
            <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Editar datos del cobro #{batchId}</h2>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-white/40 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Cargando...
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>{BATCH_CORRECTION_HINT}</span>
            </div>

            <div>
              <label className="text-xs text-white/50 block mb-1">Fecha de pago *</label>
              <input type="date" value={form.paymentDate} onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-white/50 block mb-1">Notas</label>
              <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={3}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-blue-500 resize-none" />
            </div>

            <div className="flex justify-end gap-3 pt-1">
              <button onClick={onClose} className="px-4 py-2 bg-white/5 text-white/60 text-sm rounded-lg hover:bg-white/10 transition-all">Cancelar</button>
              <button onClick={handleSave} disabled={saving || !validation.valid}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Guardar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Modal "Anular cobro" ────────────────────────────────────────────────────

function CancelBatchModal({ batchId, onClose, onCancelled }: { batchId: number; onClose: () => void; onCancelled: () => void }) {
  const [loading, setLoading] = useState(true);
  const [check, setCheck] = useState<PaymentBatchCancelCheckResponse | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get(`/api/payment-batches/${batchId}/cancel-check`)
      .then(setCheck)
      .catch(() => toast.error("No se pudo verificar si este cobro se puede anular."))
      .finally(() => setLoading(false));
  }, [batchId]);

  async function handleConfirmCancel() {
    if (!isCancelConfirmationValid(check, confirmed)) return;
    setSubmitting(true);
    try {
      await api.post(`/api/payment-batches/${batchId}/cancel`, buildBatchCancelPayload(reason));
      onCancelled();
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || "No se pudo anular el cobro.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-red-500/30 rounded-2xl w-full max-w-lg my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Ban className="w-4 h-4 text-red-400" />
            <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Anular cobro #{batchId}</h2>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-white/40 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Verificando...
          </div>
        ) : !check ? (
          <div className="p-8 text-center text-white/40">No se pudo verificar este cobro.</div>
        ) : !check.canCancel ? (
          <div className="p-6 space-y-3">
            <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-300">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium mb-1">Este cobro no se puede anular todavía.</p>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-red-300/90">
                  {check.blockingReasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="px-4 py-2 bg-white/5 text-white/60 text-sm rounded-lg hover:bg-white/10 transition-all">Cerrar</button>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-1.5">
              <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Esto es lo que va a pasar</p>
              {describeBatchCancelImpact(check).map((line, i) => (
                <p key={i} className="text-xs text-white/70 flex items-start gap-1.5">
                  <span className="text-white/30">•</span> {line}
                </p>
              ))}
            </div>

            <div>
              <label className="text-xs text-white/50 block mb-1">Motivo (opcional, queda registrado)</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                placeholder="Ej: error de carga, importe equivocado..."
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm outline-none focus:border-red-500 resize-none" />
            </div>

            <label className="flex items-start gap-2 text-xs text-white/70">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="accent-red-600 mt-0.5" />
              Confirmo que deseo anular este cobro por lote
            </label>

            <div className="flex justify-end gap-3 pt-1">
              <button onClick={onClose} className="px-4 py-2 bg-white/5 text-white/60 text-sm rounded-lg hover:bg-white/10 transition-all">Cancelar</button>
              <button onClick={handleConfirmCancel} disabled={submitting || !isCancelConfirmationValid(check, confirmed)}
                className="px-5 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Anular cobro
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
