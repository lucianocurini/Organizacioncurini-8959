import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Send, Plus, Search, X, Check, Trash2, Edit2,
  MessageCircle, Mail, Copy, Building, ChevronDown, Package, Clock
} from "lucide-react";
import { cn } from "@/lib/utils";

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  copia_cliente: "Copia al cliente",
  retiro_oficina: "Retiro en oficina",
};
const CHANNEL_ICONS: Record<string, any> = {
  whatsapp: MessageCircle, email: Mail, copia_cliente: Copy, retiro_oficina: Building,
};
const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "bg-green-500/20 text-green-400 border-green-500/30",
  email: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  copia_cliente: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  retiro_oficina: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};
const DOC_LABELS: Record<string, string> = {
  poliza: "Póliza", refacturacion: "Refacturación",
};

interface DeliveryRow {
  delivery: {
    id: number;
    policyId: number | null;
    manualRecipient: string | null;
    manualPolicyNumber: string | null;
    manualCompany: string | null;
    documentType: string;
    channel: string;
    status: string;
    scheduledDate: string | null;
    completedDate: string | null;
    notes: string | null;
  };
  policy: { id: number; policyNumber: string } | null;
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
}

interface PolicyOption {
  policy: { id: number; policyNumber: string };
  insured: { name: string } | null;
}

function DeliveryModal({ open, onClose, onSaved, editing }: {
  open: boolean; onClose: () => void; onSaved: () => void; editing: DeliveryRow | null;
}) {
  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [policySearch, setPolicySearch] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [form, setForm] = useState({
    policyId: "",
    manualRecipient: "",
    manualPolicyNumber: "",
    manualCompany: "",
    documentType: "poliza",
    channel: "whatsapp",
    status: "pendiente",
    scheduledDate: "",
    notes: "",
  });

  useEffect(() => {
    if (!open) return;
    api.get("/api/policies").then(setPolicies).catch(() => {});
    if (editing) {
      const noPolicy = editing.delivery.policyId == null;
      setManualMode(noPolicy);
      setForm({
        policyId: editing.delivery.policyId ? String(editing.delivery.policyId) : "",
        manualRecipient: editing.delivery.manualRecipient || "",
        manualPolicyNumber: editing.delivery.manualPolicyNumber || "",
        manualCompany: editing.delivery.manualCompany || "",
        documentType: editing.delivery.documentType,
        channel: editing.delivery.channel,
        status: editing.delivery.status,
        scheduledDate: editing.delivery.scheduledDate || "",
        notes: editing.delivery.notes || "",
      });
    } else {
      setManualMode(false);
      setForm({
        policyId: "", manualRecipient: "", manualPolicyNumber: "", manualCompany: "",
        documentType: "poliza", channel: "whatsapp", status: "pendiente",
        scheduledDate: "", notes: "",
      });
    }
  }, [open, editing]);

  const filteredPolicies = policies.filter(p =>
    p.policy.policyNumber.toLowerCase().includes(policySearch.toLowerCase()) ||
    (p.insured?.name || "").toLowerCase().includes(policySearch.toLowerCase())
  );
  const selectedPolicy = policies.find(p => String(p.policy.id) === form.policyId);

  async function handleSave() {
    if (!manualMode && !form.policyId) {
      toast.error("Seleccioná una póliza o usá registro manual");
      return;
    }
    if (manualMode && !form.manualRecipient && !form.manualPolicyNumber) {
      toast.error("Completá al menos el destinatario o N° de póliza");
      return;
    }
    setSaving(true);
    const body: any = {
      documentType: form.documentType,
      channel: form.channel,
      status: form.status,
      scheduledDate: form.scheduledDate || null,
      notes: form.notes || null,
    };
    if (manualMode) {
      body.policyId = null;
      body.manualRecipient = form.manualRecipient || null;
      body.manualPolicyNumber = form.manualPolicyNumber || null;
      body.manualCompany = form.manualCompany || null;
    } else {
      body.policyId = Number(form.policyId);
      body.manualRecipient = null;
      body.manualPolicyNumber = null;
      body.manualCompany = null;
    }
    try {
      if (editing) await api.put(`/api/deliveries/${editing.delivery.id}`, body);
      else await api.post("/api/deliveries", body);
      toast.success(editing ? "Envío actualizado" : "Envío registrado");
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
          <h2 className="text-white font-semibold text-lg">{editing ? "Editar envío" : "Registrar envío"}</h2>
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
              Registro manual
            </button>
          </div>

          {!manualMode ? (
            /* Póliza selector */
            <div>
              <label className="block text-xs text-gray-400 mb-1">Póliza</label>
              <div className="relative">
                <button type="button" onClick={() => setPolicyOpen(!policyOpen)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-left">
                  <span className={selectedPolicy ? "text-white" : "text-gray-500"}>
                    {selectedPolicy
                      ? `${selectedPolicy.policy.policyNumber} — ${selectedPolicy.insured?.name}`
                      : "Seleccionar póliza..."}
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
                        onClick={() => { setForm(f => ({ ...f, policyId: String(p.policy.id) })); setPolicyOpen(false); setPolicySearch(""); }}
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
          ) : (
            /* Campos manuales */
            <div className="space-y-3 p-3 bg-[#0a0f1e] border border-[#2d3748] rounded-lg">
              <p className="text-xs text-gray-500">Completá los datos del envío sin vincular póliza del sistema</p>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Destinatario</label>
                <input type="text" value={form.manualRecipient}
                  onChange={e => setForm(f => ({ ...f, manualRecipient: e.target.value }))}
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

          {/* Tipo documento */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Tipo de documento</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(DOC_LABELS).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setForm(f => ({ ...f, documentType: key }))}
                  className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                    form.documentType === key
                      ? "border-blue-500/50 bg-blue-500/20 text-blue-300"
                      : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Canal */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Método de envío / entrega</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CHANNEL_LABELS).map(([key, label]) => {
                const Icon = CHANNEL_ICONS[key];
                return (
                  <button key={key} type="button" onClick={() => setForm(f => ({ ...f, channel: key }))}
                    className={cn("flex items-center gap-2 py-2 px-3 rounded-lg text-sm border transition-all",
                      form.channel === key ? CHANNEL_COLORS[key] : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                    <Icon className="w-4 h-4 flex-shrink-0" />{label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fecha */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Fecha programada</label>
            <input type="date" value={form.scheduledDate}
              onChange={e => setForm(f => ({ ...f, scheduledDate: e.target.value }))}
              className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500" />
          </div>

          {/* Estado */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Estado</label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setForm(f => ({ ...f, status: "pendiente" }))}
                className={cn("flex items-center gap-2 py-2 px-3 rounded-lg text-sm border transition-all",
                  form.status === "pendiente"
                    ? "border-yellow-500/50 bg-yellow-500/20 text-yellow-300"
                    : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                <Clock className="w-4 h-4" /> Pendiente
              </button>
              <button type="button" onClick={() => setForm(f => ({ ...f, status: "realizado" }))}
                className={cn("flex items-center gap-2 py-2 px-3 rounded-lg text-sm border transition-all",
                  form.status === "realizado"
                    ? "border-green-500/50 bg-green-500/20 text-green-300"
                    : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                <Check className="w-4 h-4" /> Realizado
              </button>
            </div>
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
            {saving ? "Guardando..." : editing ? "Guardar cambios" : "Registrar envío"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Envios() {
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DeliveryRow | null>(null);
  const [filterChannel, setFilterChannel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDoc, setFilterDoc] = useState("");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/deliveries");
      setDeliveries(data);
    } catch { toast.error("Error al cargar envíos"); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleComplete(id: number) {
    const res = await fetch(`/api/deliveries/${id}/complete`, {
      method: "PATCH",
      headers: { "x-session-id": localStorage.getItem("session_id") || "" },
    });
    if (res.ok) { toast.success("Marcado como realizado"); load(); }
  }

  async function handleDelete(id: number) {
    if (!confirm("¿Eliminar este envío?")) return;
    await api.delete(`/api/deliveries/${id}`);
    toast.success("Envío eliminado");
    load();
  }

  const filtered = deliveries.filter(r => {
    if (filterChannel && r.delivery.channel !== filterChannel) return false;
    if (filterStatus && r.delivery.status !== filterStatus) return false;
    if (filterDoc && r.delivery.documentType !== filterDoc) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = (r.insured?.name || r.delivery.manualRecipient || "").toLowerCase();
      const num = (r.policy?.policyNumber || r.delivery.manualPolicyNumber || "").toLowerCase();
      if (!name.includes(q) && !num.includes(q)) return false;
    }
    return true;
  });

  const pendientes = deliveries.filter(r => r.delivery.status === "pendiente").length;
  const realizados = deliveries.filter(r => r.delivery.status === "realizado").length;
  const byChannel = Object.fromEntries(
    Object.keys(CHANNEL_LABELS).map(k => [k, deliveries.filter(r => r.delivery.channel === k).length])
  );

  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Envíos y Entregas</h1>
            <p className="text-gray-400 text-sm mt-1">Registro de envíos de pólizas y refacturaciones</p>
          </div>
          <button onClick={() => { setEditing(null); setModalOpen(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
            <Plus className="w-4 h-4" /> Registrar envío
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
                <Clock className="w-5 h-5 text-yellow-400" />
              </div>
              <div><p className="text-xs text-gray-500">Pendientes</p><p className="text-xl font-bold text-white">{pendientes}</p></div>
            </div>
          </div>
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                <Check className="w-5 h-5 text-green-400" />
              </div>
              <div><p className="text-xs text-gray-500">Realizados</p><p className="text-xl font-bold text-white">{realizados}</p></div>
            </div>
          </div>
          {Object.entries(CHANNEL_LABELS).map(([key, label]) => {
            const Icon = CHANNEL_ICONS[key];
            return (
              <div key={key} className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
                <div className="flex items-center gap-3">
                  <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", CHANNEL_COLORS[key])}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div><p className="text-xs text-gray-500">{label}</p><p className="text-xl font-bold text-white">{byChannel[key] || 0}</p></div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input type="text" placeholder="Buscar destinatario o N° póliza..." value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
          </div>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los estados</option>
            <option value="pendiente">Pendiente</option>
            <option value="realizado">Realizado</option>
          </select>
          <select value={filterChannel} onChange={e => setFilterChannel(e.target.value)}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los canales</option>
            {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={filterDoc} onChange={e => setFilterDoc(e.target.value)}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los documentos</option>
            <option value="poliza">Póliza</option>
            <option value="refacturacion">Refacturación</option>
          </select>
          {(filterChannel || filterStatus || filterDoc || search) && (
            <button onClick={() => { setFilterChannel(""); setFilterStatus(""); setFilterDoc(""); setSearch(""); }}
              className="flex items-center gap-1 px-3 py-2 text-sm text-gray-400 hover:text-white border border-[#1f2937] rounded-lg transition-colors">
              <X className="w-3 h-3" /> Limpiar
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <span className="text-sm text-gray-400">{filtered.length} {filtered.length === 1 ? "envío" : "envíos"}</span>
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Sin envíos registrados</p>
              <button onClick={() => { setEditing(null); setModalOpen(true); }}
                className="mt-3 text-blue-400 text-sm hover:underline">Registrar primer envío</button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-[#1f2937]">
                    <th className="text-left px-5 py-3 font-medium">Póliza / Destinatario</th>
                    <th className="text-left px-3 py-3 font-medium">Documento</th>
                    <th className="text-left px-3 py-3 font-medium">Canal</th>
                    <th className="text-left px-3 py-3 font-medium">Estado</th>
                    <th className="text-left px-3 py-3 font-medium">Programado</th>
                    <th className="text-left px-3 py-3 font-medium">Realizado</th>
                    <th className="text-left px-3 py-3 font-medium">Notas</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const Icon = CHANNEL_ICONS[r.delivery.channel] || Send;
                    const isPending = r.delivery.status === "pendiente";
                    const isManual = r.delivery.policyId == null;
                    const displayNum = r.policy?.policyNumber || r.delivery.manualPolicyNumber || "—";
                    const displayName = r.insured?.name || r.delivery.manualRecipient || "—";
                    return (
                      <tr key={r.delivery.id}
                        className={cn("border-b border-[#1f2937] transition-colors",
                          isPending ? "hover:bg-yellow-500/5" : "hover:bg-[#1a2540]/30")}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div>
                              <p className="text-white font-medium">{displayNum}</p>
                              <p className="text-xs text-gray-400">{displayName}</p>
                            </div>
                            {isManual && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/30 bg-orange-500/10 text-orange-400">
                                manual
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className="px-2 py-0.5 rounded text-xs border border-[#2d3748] text-gray-300">
                            {DOC_LABELS[r.delivery.documentType] || r.delivery.documentType}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("flex items-center gap-1.5 w-fit px-2 py-0.5 rounded text-xs border",
                            CHANNEL_COLORS[r.delivery.channel] || "text-gray-400 border-gray-500/30")}>
                            <Icon className="w-3 h-3" />
                            {CHANNEL_LABELS[r.delivery.channel] || r.delivery.channel}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("px-2 py-0.5 rounded text-xs border",
                            isPending
                              ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                              : "bg-green-500/20 text-green-400 border-green-500/30")}>
                            {isPending ? "Pendiente" : "Realizado"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.delivery.scheduledDate
                            ? new Date(r.delivery.scheduledDate + "T12:00:00").toLocaleDateString("es-AR") : "—"}
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.delivery.completedDate
                            ? new Date(r.delivery.completedDate + "T12:00:00").toLocaleDateString("es-AR") : "—"}
                        </td>
                        <td className="px-3 py-3 text-gray-400 text-xs max-w-[120px] truncate">
                          {r.delivery.notes || "—"}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 justify-end">
                            {isPending && (
                              <button onClick={() => handleComplete(r.delivery.id)}
                                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/40 transition-colors">
                                <Check className="w-3 h-3" /> Realizado
                              </button>
                            )}
                            <button onClick={() => { setEditing(r); setModalOpen(true); }}
                              className="text-gray-400 hover:text-blue-400 transition-colors" title="Editar">
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDelete(r.delivery.id)}
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

      <DeliveryModal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }}
        onSaved={load} editing={editing} />
    </AppLayout>
  );
}
