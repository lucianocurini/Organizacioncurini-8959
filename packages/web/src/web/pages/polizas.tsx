import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatCurrency, formatDate, daysUntil, POLICY_TYPES, STATUS_TYPES, COVERAGE_LABELS, cn } from "@/lib/utils";
import { Link, useLocation } from "wouter";
import {
  Plus, Search, Download, Trash2, Edit, Eye, ChevronUp, ChevronDown, Car, Home, ShieldCheck, Briefcase, FileText, Upload, Bike, HeartPulse, Zap, Scale, HardHat, Flame, CheckSquare, Square, X, ChevronLeft, ChevronRight
} from "lucide-react";
import { PolicyModal } from "@/components/policies/PolicyModal";
import { ImportModal } from "@/components/policies/ImportModal";
import { toast } from "sonner";

interface PolicyRow {
  policy: any;
  company: any;
  insured: any;
}

const typeIcons: Record<string, any> = {
  automotor: Car, motovehiculo: Bike, ecomovilidad: Zap, hogar: Home, accidentes: ShieldCheck, art: HeartPulse, comercial: Briefcase, responsabilidad_civil: Scale, cascos: HardHat, incendio: Flame,
};

type SortKey = "policyNumber" | "insured" | "company" | "type" | "status" | "endDate" | "premium";

const PAGE_SIZE = 50;

export default function Polizas() {
  const [location] = useLocation();
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const initialType = searchParams.get("type") || "";
  const initialStatus = searchParams.get("status") || "";

  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState(initialType);
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [sortKey, setSortKey] = useState<SortKey>("endDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editPolicy, setEditPolicy] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const data = await api.get(`/api/policies?${params}`);
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [q, typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { setPage(1); }, [q, typeFilter, statusFilter, sortKey, sortDir]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setTypeFilter(sp.get("type") || "");
    setStatusFilter(sp.get("status") || "");
  }, [location]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sorted = [...rows].sort((a, b) => {
    let va: any, vb: any;
    switch (sortKey) {
      case "policyNumber": va = a.policy.policyNumber; vb = b.policy.policyNumber; break;
      case "insured": va = a.insured?.name || ""; vb = b.insured?.name || ""; break;
      case "company": va = a.company?.name || ""; vb = b.company?.name || ""; break;
      case "type": va = a.policy.type; vb = b.policy.type; break;
      case "status": va = a.policy.status; vb = b.policy.status; break;
      case "endDate": va = a.policy.endDate; vb = b.policy.endDate; break;
      case "premium": va = a.policy.premium || 0; vb = b.policy.premium || 0; break;
      default: va = ""; vb = "";
    }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/api/policies/${id}`);
      toast.success("Póliza eliminada");
      load();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo eliminar la póliza.");
    }
    setDeleteId(null);
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    let ok = 0;
    let blocked = 0;
    for (const id of selected) {
      try { await api.delete(`/api/policies/${id}`); ok++; } catch { blocked++; }
    }
    if (ok > 0) toast.success(`${ok} póliza${ok !== 1 ? "s" : ""} eliminada${ok !== 1 ? "s" : ""}`);
    if (blocked > 0) toast.error(`${blocked} póliza${blocked !== 1 ? "s" : ""} no pudo${blocked !== 1 ? "ron" : ""} eliminarse (tienen movimientos asociados).`);
    setSelected(new Set());
    setShowBulkConfirm(false);
    setDeleting(false);
    load();
  };

  const toggleSelect = (id: number) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const toggleAll = () =>
    setSelected(prev => prev.size === sorted.length ? new Set() : new Set(sorted.map(r => r.policy.id)));

  const exportToCSV = () => {
    const headers = ["N° Póliza", "Tipo", "Estado", "Cobertura", "Asegurado", "Compañía", "Cuota Mensual", "Prima", "Suma Asegurada", "Vigencia Desde", "Vigencia Hasta"];
    const csvRows = sorted.map(r => [
      r.policy.policyNumber, r.policy.type, r.policy.status,
      r.policy.coverageType ? (COVERAGE_LABELS[r.policy.coverageType] || r.policy.coverageType) : "",
      r.insured?.name || "", r.company?.name || "",
      r.policy.monthlyFee || "", r.policy.premium || "", r.policy.sumInsured || "",
      r.policy.startDate, r.policy.endDate
    ]);
    const csv = [headers, ...csvRows].map(row => row.map(String).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "polizas_curini.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronUp className="w-3 h-3 text-gray-600" />;
    return sortDir === "asc"
      ? <ChevronUp className="w-3 h-3 text-blue-400" />
      : <ChevronDown className="w-3 h-3 text-blue-400" />;
  };

  const ThSort = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
    <th
      onClick={() => handleSort(col)}
      className="text-left text-xs text-gray-400 font-medium py-3 px-4 cursor-pointer select-none hover:text-white transition-colors whitespace-nowrap"
    >
      <span className="flex items-center gap-1">{children}<SortIcon col={col} /></span>
    </th>
  );

  // Sync top scrollbar
  const syncScroll = (from: "top" | "main") => (e: React.UIEvent<HTMLDivElement>) => {
    const other = document.getElementById(from === "top" ? "tbl-main" : "tbl-top");
    if (other) other.scrollLeft = (e.currentTarget as HTMLDivElement).scrollLeft;
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Pólizas</h1>
            <p className="text-gray-400 text-sm mt-1">
              {sorted.length} registros
              {selected.size > 0 ? ` · ${selected.size} seleccionada${selected.size !== 1 ? "s" : ""}` : ""}
              {totalPages > 1 ? ` · Página ${page} de ${totalPages}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportToCSV} className="flex items-center gap-2 px-3 py-2 bg-[#1f2937] border border-[#374151] text-gray-300 text-sm rounded-lg hover:text-white hover:border-gray-500 transition-all">
              <Download className="w-4 h-4" /> <span className="hidden sm:inline">Exportar CSV</span>
            </button>
            <button onClick={() => setShowImport(true)} className="flex items-center gap-2 px-3 py-2 bg-[#1f2937] border border-[#374151] text-gray-300 text-sm rounded-lg hover:text-white hover:border-gray-500 transition-all">
              <Upload className="w-4 h-4" /> <span className="hidden sm:inline">Importar</span>
            </button>
            <button onClick={() => { setEditPolicy(null); setShowModal(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all whitespace-nowrap">
              <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Nueva Póliza</span><span className="sm:hidden">Nueva</span>
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-5">
          <div className="relative flex-1 min-w-[180px] sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Buscar asegurado, compañía, N° póliza..."
              className="w-full pl-9 pr-4 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all"
            />
          </div>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all">
            <option value="">Todos los tipos</option>
            <option value="automotor">Automotor</option>
            <option value="motovehiculo">Motovehículo</option>
            <option value="hogar">Hogar</option>
            <option value="accidentes">Acc. Personales</option>
            <option value="art">ART</option>
            <option value="ecomovilidad">Ecomovilidad</option>
            <option value="responsabilidad_civil">Resp. Civil</option>
            <option value="cascos">Cascos</option>
            <option value="incendio">Incendio</option>
            <option value="comercial">Integrales</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all">
            <option value="">Todos los estados</option>
            <option value="activa">Activa</option>
            <option value="por_vencer">Por vencer</option>
            <option value="vencida">Vencida</option>
            <option value="cancelada">Cancelada</option>
          </select>
          {(typeFilter || statusFilter || q) && (
            <button onClick={() => { setQ(""); setTypeFilter(""); setStatusFilter(""); }} className="px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors">
              Limpiar filtros
            </button>
          )}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-blue-600/10 border border-blue-500/30 rounded-xl">
            <span className="text-sm text-blue-300 font-medium flex-1">
              {selected.size} póliza{selected.size !== 1 ? "s" : ""} seleccionada{selected.size !== 1 ? "s" : ""}
            </span>
            <button onClick={() => setShowBulkConfirm(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-sm rounded-lg transition-all">
              <Trash2 className="w-3.5 h-3.5" /> Eliminar seleccionadas
            </button>
            <button onClick={() => setSelected(new Set())} className="p-1.5 text-gray-400 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Mobile: tarjetas */}
        <div className="lg:hidden space-y-3">
          {loading ? (
            <div className="py-16 text-center text-gray-500 text-sm">Cargando...</div>
          ) : sorted.length === 0 ? (
            <div className="py-16 text-center text-gray-500 text-sm">No se encontraron pólizas</div>
          ) : paged.map((row) => {
            const days = daysUntil(row.policy.endDate);
            const typeInfo = POLICY_TYPES[row.policy.type];
            const statusInfo = STATUS_TYPES[row.policy.status];
            const Icon = typeIcons[row.policy.type] || FileText;
            const isSelected = selected.has(row.policy.id);
            return (
              <div key={row.policy.id} className={cn("bg-[#111827] border rounded-xl p-4", isSelected ? "border-blue-500/50 bg-blue-600/5" : "border-[#1f2937]")}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <button onClick={() => toggleSelect(row.policy.id)} className="mt-0.5 text-gray-400 hover:text-white transition-colors shrink-0">
                      {isSelected ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4" />}
                    </button>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{row.insured?.name || "—"}</p>
                      <p className="text-xs font-mono text-blue-400 truncate">{row.policy.policyNumber}</p>
                    </div>
                  </div>
                  <span className={cn("inline-flex px-2 py-0.5 rounded-md text-xs font-medium border whitespace-nowrap shrink-0", statusInfo?.color)}>
                    {statusInfo?.label || row.policy.status}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium border", typeInfo?.color)}>
                    <Icon className="w-3 h-3 shrink-0" />
                    <span className="truncate">{typeInfo?.label || row.policy.type}</span>
                  </span>
                  <span className="text-xs text-gray-400 truncate">{row.company?.name || "—"}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <p className="text-gray-500">Vigencia</p>
                    <p className="text-gray-300">{formatDate(row.policy.endDate)}</p>
                    {days >= 0 && days <= 30 && <p className="text-amber-400">{days === 0 ? "Vence hoy" : `${days}d restantes`}</p>}
                    {days < 0 && <p className="text-red-400">Vencida {Math.abs(days)}d</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-gray-500">Cuota mensual</p>
                    <p className="font-mono text-white">{row.policy.monthlyFee ? formatCurrency(row.policy.monthlyFee) : (row.policy.premium ? formatCurrency(row.policy.premium) : "—")}</p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1 pt-2 border-t border-[#1f2937]">
                  <Link href={`/polizas/${row.policy.id}`}>
                    <a className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-[#1f2937] rounded-md transition-all">
                      <Eye className="w-3.5 h-3.5" /> Ver
                    </a>
                  </Link>
                  <button onClick={() => { setEditPolicy(row); setShowModal(true); }} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-300 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all">
                    <Edit className="w-3.5 h-3.5" /> Editar
                  </button>
                  <button onClick={() => setDeleteId(row.policy.id)} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-300 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop: tabla */}
        <div className="hidden lg:block bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">

          {/* Top scrollbar */}
          <div
            id="tbl-top"
            className="overflow-x-auto"
            style={{ height: 10, overflowY: "hidden" }}
            onScroll={syncScroll("top")}
          >
            <div style={{ width: 1100, height: 1 }} />
          </div>

          {/* Main scroll area */}
          <div
            id="tbl-main"
            className="overflow-x-auto"
            onScroll={syncScroll("main")}
          >
            <table className="w-full table-fixed" style={{ minWidth: 960 }}>
              <colgroup>
                <col style={{ width: 36 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 90 }} />
              </colgroup>
              <thead className="border-b border-[#1f2937] bg-[#111827]">
                <tr>
                  <th className="py-3 px-3 w-9">
                    <button onClick={toggleAll} className="text-gray-400 hover:text-white transition-colors">
                      {selected.size === sorted.length && sorted.length > 0
                        ? <CheckSquare className="w-4 h-4 text-blue-400" />
                        : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  <ThSort col="policyNumber">N° Póliza</ThSort>
                  <ThSort col="type">Tipo</ThSort>
                  <ThSort col="insured">Asegurado</ThSort>
                  <ThSort col="company">Compañía</ThSort>
                  <ThSort col="status">Estado</ThSort>
                  <th className="text-left text-xs text-gray-400 font-medium py-3 px-3 whitespace-nowrap">Cobertura</th>
                  <ThSort col="endDate">Vigencia</ThSort>
                  <ThSort col="premium">Cuota Mens.</ThSort>
                  <th className="text-xs text-gray-400 font-medium py-3 px-3 text-right whitespace-nowrap sticky right-0 bg-[#111827]">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="py-16 text-center text-gray-500 text-sm">Cargando...</td></tr>
                ) : sorted.length === 0 ? (
                  <tr><td colSpan={10} className="py-16 text-center text-gray-500 text-sm">No se encontraron pólizas</td></tr>
                ) : paged.map((row) => {
                  const days = daysUntil(row.policy.endDate);
                  const typeInfo = POLICY_TYPES[row.policy.type];
                  const statusInfo = STATUS_TYPES[row.policy.status];
                  const Icon = typeIcons[row.policy.type] || FileText;
                  const isSelected = selected.has(row.policy.id);
                  return (
                    <tr key={row.policy.id} className={cn("border-b border-[#1f2937] table-row-hover transition-colors", isSelected && "bg-blue-600/5")}>
                      <td className="py-2.5 px-3">
                        <button onClick={() => toggleSelect(row.policy.id)} className="text-gray-400 hover:text-white transition-colors">
                          {isSelected ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 overflow-hidden">
                        <span className="text-xs font-mono text-blue-400 block truncate">{row.policy.policyNumber}</span>
                      </td>
                      <td className="py-2.5 px-3 overflow-hidden">
                        <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium border max-w-full overflow-hidden", typeInfo?.color)}>
                          <Icon className="w-3 h-3 shrink-0" />
                          <span className="truncate">{typeInfo?.label || row.policy.type}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 overflow-hidden">
                        <p className="text-sm text-white truncate">{row.insured?.name || "—"}</p>
                        {row.insured?.dni && <p className="text-xs text-gray-500 truncate">DNI: {row.insured.dni}</p>}
                      </td>
                      <td className="py-2.5 px-3 overflow-hidden">
                        <p className="text-sm text-gray-300 truncate">{row.company?.name || "—"}</p>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn("inline-flex px-2 py-0.5 rounded-md text-xs font-medium border whitespace-nowrap", statusInfo?.color)}>
                          {statusInfo?.label || row.policy.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 overflow-hidden">
                        {row.policy.coverageType
                          ? <span className="text-xs text-gray-300 block truncate" title={COVERAGE_LABELS[row.policy.coverageType] || row.policy.coverageType}>{COVERAGE_LABELS[row.policy.coverageType] || row.policy.coverageType}</span>
                          : <span className="text-xs text-gray-600">—</span>}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <p className="text-xs text-gray-500">{row.policy.startDate ? formatDate(row.policy.startDate) : "—"}</p>
                        <p className="text-sm text-gray-300">{formatDate(row.policy.endDate)}</p>
                        {days >= 0 && days <= 30 && <p className="text-xs text-amber-400">{days === 0 ? "Vence hoy" : `${days}d restantes`}</p>}
                        {days < 0 && <p className="text-xs text-red-400">Vencida {Math.abs(days)}d</p>}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap overflow-hidden">
                        <p className="text-sm font-mono text-white truncate">{row.policy.monthlyFee ? formatCurrency(row.policy.monthlyFee) : <span className="text-gray-600">—</span>}</p>
                        {row.policy.premium && row.policy.monthlyFee && <p className="text-xs text-gray-500 truncate">P: {formatCurrency(row.policy.premium)}</p>}
                        {row.policy.premium && !row.policy.monthlyFee && <p className="text-sm font-mono text-gray-300 truncate">{formatCurrency(row.policy.premium)}</p>}
                      </td>
                      <td className="py-2.5 px-3 sticky right-0 bg-[#0d1520]" style={{ boxShadow: "-4px 0 12px rgba(0,0,0,0.4)" }}>
                        <div className="flex items-center justify-end gap-1">
                          <Link href={`/polizas/${row.policy.id}`}>
                            <a className="p-1.5 text-gray-400 hover:text-white hover:bg-[#1f2937] rounded-md transition-all" title="Ver detalles">
                              <Eye className="w-4 h-4" />
                            </a>
                          </Link>
                          <button onClick={() => { setEditPolicy(row); setShowModal(true); }} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all" title="Editar">
                            <Edit className="w-4 h-4" />
                          </button>
                          <button onClick={() => setDeleteId(row.policy.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all" title="Eliminar">
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-gray-500">
              Mostrando {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} de {sorted.length}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={page === 1} className="px-2 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1f2937] rounded-md transition-all">«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1f2937] rounded-md transition-all">
                <ChevronLeft className="w-3 h-3" /> Anterior
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                  if (idx > 0 && (p as number) - (arr[idx - 1] as number) > 1) acc.push("...");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === "..." ? (
                    <span key={`e${i}`} className="px-2 text-xs text-gray-600">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p as number)}
                      className={cn("w-8 h-7 text-xs rounded-md transition-all", page === p ? "bg-blue-600 text-white font-medium" : "text-gray-400 hover:text-white hover:bg-[#1f2937]")}
                    >{p}</button>
                  )
                )}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1f2937] rounded-md transition-all">
                Siguiente <ChevronRight className="w-3 h-3" />
              </button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-2 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1f2937] rounded-md transition-all">»</button>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirm */}
      {deleteId !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2" style={{ fontFamily: "Syne, sans-serif" }}>¿Eliminar póliza?</h3>
            <p className="text-gray-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
              <button onClick={() => handleDelete(deleteId)} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-all">Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirm */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-500/15 mx-auto mb-4">
              <Trash2 className="w-5 h-5 text-red-400" />
            </div>
            <h3 className="text-white font-semibold text-center mb-1" style={{ fontFamily: "Syne, sans-serif" }}>
              ¿Eliminar {selected.size} póliza{selected.size !== 1 ? "s" : ""}?
            </h3>
            <p className="text-gray-400 text-sm text-center mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowBulkConfirm(false)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
              <button onClick={handleBulkDelete} disabled={deleting} className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm rounded-lg transition-all flex items-center justify-center gap-2">
                {deleting && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"/>}
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <PolicyModal
          initial={editPolicy}
          onClose={() => { setShowModal(false); setEditPolicy(null); }}
          onSaved={() => { setShowModal(false); setEditPolicy(null); load(); }}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); load(); }}
        />
      )}
    </AppLayout>
  );
}
