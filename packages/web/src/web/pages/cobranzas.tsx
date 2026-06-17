import React, { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  DollarSign, Plus, Search, TrendingUp, CreditCard,
  Banknote, ArrowRightLeft, Trash2, Edit2, X, ChevronDown, Link, CheckSquare,
  ClipboardList, AlertCircle, ChevronRight, ReceiptText, Building2, Check, ShoppingCart, Save
} from "lucide-react";
import { cn, formatCurrency as _fc } from "@/lib/utils";

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

interface PaymentRow {
  payment: {
    id: number;
    policyId: number | null;
    manualPayer: string | null;
    manualPolicyNumber: string | null;
    manualCompany: string | null;
    amount: number;
    paymentMethod: string;
    paymentDate: string;
    periodMonth: string | null;
    notes: string | null;
    status: string;
  };
  policy: { id: number; policyNumber: string } | null;
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
}

interface PolicyOption {
  policy: { id: number; policyNumber: string };
  insured: { name: string } | null;
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
  const [form, setForm] = useState({
    policyId: "",
    installmentId: "",
    manualPayer: "",
    manualPolicyNumber: "",
    manualCompany: "",
    amount: "",
    paymentMethod: "efectivo",
    paymentDate: new Date().toISOString().split("T")[0],
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
        installmentId: (editing.payment as any).installmentId ? String((editing.payment as any).installmentId) : "",
        manualPayer: editing.payment.manualPayer || "",
        manualPolicyNumber: editing.payment.manualPolicyNumber || "",
        manualCompany: editing.payment.manualCompany || "",
        amount: String(editing.payment.amount),
        paymentMethod: editing.payment.paymentMethod,
        paymentDate: editing.payment.paymentDate,
        periodMonth: editing.payment.periodMonth || "",
        notes: editing.payment.notes || "",
        status: editing.payment.status,
      });
      if (pId) api.get(`/api/policies/${pId}/installments`).then(setInstallments).catch(() => setInstallments([]));
    } else {
      setManualMode(false);
      setInstallments([]);
      setForm({
        policyId: "", installmentId: "", manualPayer: "", manualPolicyNumber: "", manualCompany: "",
        amount: "", paymentMethod: "efectivo",
        paymentDate: new Date().toISOString().split("T")[0],
        periodMonth: "", notes: "", status: "confirmado",
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
  const pendingInstallments = installments.filter((i: any) => i.status !== "pagada");
  const selectedInstallment = installments.find((i: any) => String(i.id) === form.installmentId);

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
    setSaving(true);
    const body: any = {
      amount: Number(form.amount),
      paymentMethod: form.paymentMethod,
      paymentDate: form.paymentDate,
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
    try {
      if (editing) await api.put(`/api/payments/${editing.payment.id}`, body);
      else await api.post("/api/payments", body);
      toast.success(editing ? "Pago actualizado" : "Pago imputado");
      onSaved(); onClose();
    } catch { toast.error("Error al guardar"); }
    setSaving(false);
  }

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
                      setForm(f => ({ ...f, installmentId: id, amount: inst ? String(inst.amount) : f.amount }));
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
              <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Método */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Método de pago *</label>
            <div className="mb-2">
              <p className="text-xs text-white/30 mb-1.5">Cuentas propias</p>
              <div className="grid grid-cols-3 gap-2">
                {["efectivo", "transferencia", "cheque"].map((key) => (
                  <button key={key} type="button" onClick={() => setForm(f => ({ ...f, paymentMethod: key }))}
                    className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                      form.paymentMethod === key ? METHOD_COLORS[key] : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                    {METHOD_LABELS[key]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-orange-400/60 mb-1.5">Directo a Compañía <span className="text-white/25">(no suma a caja propia)</span></p>
              <div className="grid grid-cols-2 gap-2">
                {["transferencia_compania", "link_pago"].map((key) => (
                  <button key={key} type="button" onClick={() => setForm(f => ({ ...f, paymentMethod: key }))}
                    className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                      form.paymentMethod === key ? METHOD_COLORS[key] : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                    {METHOD_LABELS[key]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Fechas */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Fecha de pago *</label>
              <input type="date" value={form.paymentDate} onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Período (mes)</label>
              <input type="month" value={form.periodMonth} onChange={e => setForm(f => ({ ...f, periodMonth: e.target.value }))}
                className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500" />
            </div>
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
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-all disabled:opacity-50">
            {saving ? "Guardando..." : editing ? "Guardar cambios" : "Imputar pago"}
          </button>
        </div>
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
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");

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
    await api.delete(`/api/payments/${id}`);
    toast.success("Pago eliminado");
    load();
  }

  const filtered = payments.filter(r => {
    if (filterMethod && r.payment.paymentMethod !== filterMethod) return false;
    if (filterStatus && r.payment.status !== filterStatus) return false;
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
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los métodos</option>
            {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los estados</option>
            <option value="confirmado">Confirmado</option>
            <option value="pendiente">Pendiente</option>
            <option value="anulado">Anulado</option>
          </select>
          {(filterMethod || filterStatus || search) && (
            <button onClick={() => { setFilterMethod(""); setFilterStatus(""); setSearch(""); }}
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
                      <span className={cn("px-2 py-0.5 rounded border", METHOD_COLORS[r.payment.paymentMethod] || "text-gray-400 border-gray-500/30")}>
                        {METHOD_LABELS[r.payment.paymentMethod] || r.payment.paymentMethod}
                      </span>
                      <span className={cn("px-2 py-0.5 rounded border", STATUS_COLORS[r.payment.status] || "text-gray-400 border-gray-500/30")}>
                        {r.payment.status.charAt(0).toUpperCase() + r.payment.status.slice(1)}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span>Fecha: {new Date(r.payment.paymentDate + "T12:00:00").toLocaleDateString("es-AR")}</span>
                      {r.payment.periodMonth && (
                        <span>Período: {new Date(r.payment.periodMonth + "-02").toLocaleDateString("es-AR", { month: "short", year: "numeric" })}</span>
                      )}
                    </div>
                    {r.payment.notes && <p className="text-xs text-gray-400">{r.payment.notes}</p>}
                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={() => { setEditing(r); setModalOpen(true); }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2d3748] text-gray-300 hover:text-blue-400 transition-colors">
                        <Edit2 className="w-3 h-3" /> Editar
                      </button>
                      <button onClick={() => handleDelete(r.payment.id)}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2d3748] text-gray-300 hover:text-red-400 transition-colors">
                        <Trash2 className="w-3 h-3" /> Eliminar
                      </button>
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
                    <th className="text-left px-3 py-3 font-medium">Fecha</th>
                    <th className="text-left px-3 py-3 font-medium">Estado</th>
                    <th className="text-left px-3 py-3 font-medium">Notas</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const isManual = r.payment.policyId == null;
                    const displayPolicyNum = r.policy?.policyNumber || r.payment.manualPolicyNumber || "—";
                    const displayInsured = r.insured?.name || r.payment.manualPayer || "—";
                    return (
                      <tr key={r.payment.id} className="border-b border-[#1f2937] hover:bg-[#1a2540]/30 transition-colors">
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
                          <span className={cn("px-2 py-0.5 rounded text-xs border", METHOD_COLORS[r.payment.paymentMethod] || "text-gray-400 border-gray-500/30")}>
                            {METHOD_LABELS[r.payment.paymentMethod] || r.payment.paymentMethod}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-white font-semibold">{formatCurrency(r.payment.amount)}</td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {new Date(r.payment.paymentDate + "T12:00:00").toLocaleDateString("es-AR")}
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("px-2 py-0.5 rounded text-xs border", STATUS_COLORS[r.payment.status] || "text-gray-400 border-gray-500/30")}>
                            {r.payment.status.charAt(0).toUpperCase() + r.payment.status.slice(1)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-gray-400 text-xs max-w-[140px] truncate">{r.payment.notes || "—"}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 justify-end">
                            <button onClick={() => { setEditing(r); setModalOpen(true); }}
                              className="text-gray-400 hover:text-blue-400 transition-colors" title="Editar">
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDelete(r.payment.id)}
                              className="text-gray-400 hover:text-red-400 transition-colors" title="Eliminar">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
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
  const [prontoPagoSurcharge, setProntoPagoSurcharge] = useState("800");
  const [breakdown, setBreakdown] = useState({ efectivo: "", transferencia: "", cheque: "", pronto_pago: "" });
  const [debtorItems, setDebtorItems] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/api/remittances/pending").then(d => { setPending(d); setLoadingPending(false); });
  }, []);

  const key = (item: any) => `${item.source}:${item.sourceId}`;

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

  const selectedItems = pending.filter(i => selected.has(key(i)));
  const totalSeleccionado = selectedItems.reduce((s, i) => s + i.amount, 0);
  const totalBreakdown = (Number(breakdown.efectivo) || 0) + (Number(breakdown.transferencia) || 0) +
    (Number(breakdown.cheque) || 0) + (Number(breakdown.pronto_pago) || 0);

  const filteredPending = pending.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    return i.clientName?.toLowerCase().includes(q) || i.policyNumber?.toLowerCase().includes(q) ||
      i.companyName?.toLowerCase().includes(q);
  });

  // Agrupar por método para mostrar separador
  const DIRECTO = ["transferencia_compania", "link_pago"];
  const propios = filteredPending.filter(i => !DIRECTO.includes(i.paymentMethod));
  const directos = filteredPending.filter(i => DIRECTO.includes(i.paymentMethod));

  async function save() {
    if (selectedItems.length === 0) { toast.error("Seleccioná al menos una cuota"); return; }
    setSaving(true);
    try {
      const bd: Record<string, number> = {};
      if (Number(breakdown.efectivo) > 0) bd.efectivo = Number(breakdown.efectivo);
      if (Number(breakdown.transferencia) > 0) bd.transferencia = Number(breakdown.transferencia);
      if (Number(breakdown.cheque) > 0) bd.cheque = Number(breakdown.cheque);
      if (Number(breakdown.pronto_pago) > 0) bd.pronto_pago = Number(breakdown.pronto_pago);

      await api.post("/api/remittances", {
        date,
        canal,
        notes: notes || null,
        paymentBreakdown: bd,
        prontoPagoSurcharge: canal === "pronto_pago" ? Number(prontoPagoSurcharge) || 0 : 0,
        items: selectedItems.map(i => ({
          source: i.source,
          sourceId: i.sourceId,
          amount: i.amount,
          debtorStatus: debtorItems.has(key(i)) ? "adeudado" : "pagado",
          clientName: i.clientName,
          policyNumber: i.policyNumber,
          companyName: i.companyName,
          paymentMethod: i.paymentMethod,
        })),
      });
      toast.success("Rendición registrada");
      onSaved();
      onClose();
    } catch { toast.error("Error al guardar rendición"); }
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
              <p className="text-sm text-white/50">Seleccioná las cuotas a incluir en esta rendición. Marcá las que el asegurado aún no pagó como "adeudado".</p>

              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <input className="w-full pl-8 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-blue-500"
                  placeholder="Buscar por cliente, póliza o compañía..."
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>

              {loadingPending ? (
                <div className="text-center py-8 text-white/30 text-sm">Cargando cobros pendientes...</div>
              ) : pending.length === 0 ? (
                <div className="text-center py-8 text-white/30 text-sm">No hay cobros pendientes de rendir.</div>
              ) : (
                <div className="space-y-3">
                  {propios.length > 0 && (
                    <div>
                      <p className="text-xs text-white/30 uppercase tracking-wider mb-2">Cuentas propias</p>
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
                                <p className="text-xs text-white/40">{item.companyName} · {item.policyNumber} · {item.paymentDate}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-semibold text-white">{fmt(item.amount)}</p>
                                <span className={cn("text-xs px-1.5 py-0.5 rounded border", METHOD_COLORS[item.paymentMethod] || "text-gray-400 border-gray-500/30")}>
                                  {METHOD_LABELS[item.paymentMethod] || item.paymentMethod}
                                </span>
                              </div>
                              {sel && (
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
                      <p className="text-xs text-orange-400/60 uppercase tracking-wider mb-2">Directo a Compañía</p>
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
                                <p className="text-xs text-white/40">{item.companyName} · {item.policyNumber} · {item.paymentDate}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-semibold text-white">{fmt(item.amount)}</p>
                                <span className={cn("text-xs px-1.5 py-0.5 rounded border", METHOD_COLORS[item.paymentMethod] || "text-gray-400 border-gray-500/30")}>
                                  {METHOD_LABELS[item.paymentMethod] || item.paymentMethod}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
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

              {canal === "pronto_pago" && (
                <div className="bg-purple-900/20 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3">
                  <AlertCircle size={16} className="text-purple-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs text-purple-300">Cargo extra por cuota en Pronto Pago</p>
                    <p className="text-xs text-white/40">Se suma al total rendido</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/50">$</span>
                    <input type="number" value={prontoPagoSurcharge} onChange={e => setProntoPagoSurcharge(e.target.value)}
                      className="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-sm text-white text-right focus:outline-none focus:border-purple-500" />
                    <span className="text-xs text-white/40">por cuota</span>
                  </div>
                </div>
              )}

              {/* Métodos de pago */}
              <div>
                <label className="text-xs text-white/50 mb-2 block">Cómo se paga a la compañía (puede mezclar métodos)</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { k: "efectivo", label: "Efectivo", color: "text-green-400" },
                    { k: "transferencia", label: "Transferencia", color: "text-blue-400" },
                    { k: "cheque", label: "Cheque", color: "text-yellow-400" },
                    { k: "pronto_pago", label: "Pronto Pago", color: "text-purple-400" },
                  ].map(({ k, label, color }) => (
                    <div key={k}>
                      <label className={cn("text-xs mb-1 block", color)}>{label}</label>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-white/40">$</span>
                        <input type="number" placeholder="0"
                          value={(breakdown as any)[k]} onChange={e => setBreakdown(b => ({ ...b, [k]: e.target.value }))}
                          className="flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex justify-between items-center text-sm">
                  <span className="text-white/40">Total a rendir:</span>
                  <span className={cn("font-bold", Math.abs(totalBreakdown - totalSeleccionado) > 1 ? "text-red-400" : "text-green-400")}>
                    {fmt(totalBreakdown)}
                    {Math.abs(totalBreakdown - totalSeleccionado) > 1 && (
                      <span className="text-xs font-normal text-red-400/70 ml-2">(cuotas: {fmt(totalSeleccionado)})</span>
                    )}
                  </span>
                </div>
                {canal === "pronto_pago" && (
                  <div className="mt-1 flex justify-between items-center text-xs text-white/40">
                    <span>Cargo extra Pronto Pago ({selectedItems.length} cuotas × {"$"}{prontoPagoSurcharge}):</span>
                    <span className="text-purple-400">+{fmt(selectedItems.length * (Number(prontoPagoSurcharge) || 0))}</span>
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
                <p className="text-xs text-white/40 mb-2">{selectedItems.length} cuotas — {debtorItems.size > 0 ? `${debtorItems.size} marcadas como adeudadas` : "todas pagadas"}</p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {selectedItems.map(i => (
                    <div key={key(i)} className="flex justify-between text-xs">
                      <span className="text-white/60 truncate mr-2">{i.clientName} · {i.companyName}</span>
                      <span className={cn("shrink-0", debtorItems.has(key(i)) ? "text-red-400" : "text-white/60")}>
                        {debtorItems.has(key(i)) ? "⚠ " : ""}{fmt(i.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#1f2937] flex justify-between items-center shrink-0">
          {step === "select" ? (
            <>
              <span className="text-sm text-white/40">{selected.size} seleccionadas — {fmt(totalSeleccionado)}</span>
              <button onClick={() => { if (selected.size === 0) { toast.error("Seleccioná al menos una cuota"); return; } setStep("pago"); }}
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
    } catch { toast.error("Error al cargar rendiciones"); }
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
          { label: "Cuotas rendidas", value: String(totalCuotas), color: "text-white", bg: "bg-white/5 border-white/10" },
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
                      <p className="text-xs text-white/40">{r.itemCount} cuotas{r.adeudadoCount > 0 ? ` · ${r.adeudadoCount} adeudadas` : ""}</p>
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
                        {METHOD_LABELS[m] || m}: {fmt(Number(v))}
                      </span>
                    ))}
                    <button onClick={e => { e.stopPropagation(); handleDelete(r.id); }}
                      className="p-1.5 text-white/20 hover:text-red-400 transition-colors">
                      <Trash2 size={14} />
                    </button>
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
    if (!confirm("¿Eliminar este gasto?")) return;
    try {
      await api.delete(`/api/cash/expenses/${id}`);
      toast.success("Gasto eliminado");
      load();
    } catch { toast.error("Error eliminando"); }
  }

  const total = gastos.reduce((s, g) => s + g.amount, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-base">Gastos registrados</h2>
          <p className="text-gray-400 text-xs mt-0.5">Se descuentan del saldo en caja</p>
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
  const [tab, setTab] = useState<"cobranzas" | "rendiciones" | "adeudados" | "transferencias" | "gastos">("cobranzas");

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
            { key: "transferencias", label: "Transf. Compañía", icon: Building2 },
            { key: "rendiciones", label: "Rendiciones", icon: ReceiptText },
            { key: "adeudados", label: "Adeudados", icon: AlertCircle },
            { key: "gastos", label: "Gastos", icon: ShoppingCart },
          ].map(({ key, label, icon: Icon }) => (
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
        {tab === "transferencias" && <TransferenciasTab />}
        {tab === "rendiciones" && <RendicionesTab />}
        {tab === "adeudados" && <AdeudadosTab />}
        {tab === "gastos" && <GastosTab />}
      </div>
    </AppLayout>
  );
}
