import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  DollarSign, Plus, Search, TrendingUp, CreditCard,
  Banknote, ArrowRightLeft, Trash2, Edit2, X, ChevronDown, Link, CheckSquare
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
  transferencia: "Transferencia",
  cheque: "Cheque",
  link_pago: "Link de pago",
};

const METHOD_COLORS: Record<string, string> = {
  efectivo: "bg-green-500/20 text-green-400 border-green-500/30",
  transferencia: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  cheque: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  link_pago: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

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
      <div className="relative w-full max-w-lg bg-[#0d1424] border border-[#1f2937] rounded-2xl shadow-2xl z-10 overflow-hidden">
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
                        Cuota #{inst.number} — vence {inst.dueDate} — ${inst.amount.toLocaleString("es-AR")}
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
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(METHOD_LABELS).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setForm(f => ({ ...f, paymentMethod: key }))}
                  className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                    form.paymentMethod === key ? METHOD_COLORS[key] : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                  {label}
                </button>
              ))}
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

export default function Cobranzas() {
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
    <AppLayout>
      <div className="p-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Cobranzas</h1>
            <p className="text-gray-400 text-sm mt-1">Registro e imputación de pagos de pólizas</p>
          </div>
          <button onClick={() => { setEditing(null); setModalOpen(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
            <Plus className="w-4 h-4" /> Imputar pago
          </button>
        </div>

        {/* Stats — 5 cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
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
              label: "Transferencias",
              value: stats ? formatCurrency(stats.byMethod.transferencia || 0) : "—",
            },
            {
              icon: Link,
              color: "bg-purple-600/20 text-purple-400",
              label: "Link de pago",
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
            <div className="overflow-x-auto">
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
          )}
        </div>
      </div>

      <PaymentModal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }}
        onSaved={load} editing={editing} />
    </AppLayout>
  );
}
