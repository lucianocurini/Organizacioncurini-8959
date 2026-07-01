import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatCurrency, formatDate, POLICY_TYPES, cn } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Download, Printer, Search, X, RefreshCw,
  FileText, TrendingUp, Plus, Copy, BarChart3,
} from "lucide-react";
import * as XLSX from "xlsx";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RebillingRow {
  rebillingId: number;
  policyId: number;
  policyNumber: string;
  insuredName: string;
  companyName: string;
  type: string;
  billingStart: string;
  billingEnd: string;
  premium: number | null;
  monthlyFee: number | null;
  policyOriginalStart: string;
  billingCycle: string | null;
  rebillingType: string;
  duplicateCount: number;
  extraDuplicateRows: number;
}

interface RenovationConfirmedRow {
  policyId: number;
  policyNumber: string;
  insuredName: string;
  companyName: string;
  type: string;
  startDate: string;
  endDate: string;
  premium: number | null;
  renewedFromPolicyNumber: string | null;
  renewedFromEndDate: string | null;
}

interface RenovationImportedRow {
  policyId: number;
  policyNumber: string;
  insuredName: string;
  companyName: string;
  type: string;
  startDate: string;
  endDate: string;
  premium: number | null;
  sourceImporter: string;
}

interface NewPolicyRow {
  policyId: number;
  policyNumber: string;
  insuredName: string;
  companyName: string;
  type: string;
  startDate: string;
  endDate: string;
  premium: number | null;
  movementType: string;
  sourceImporter: string;
  classificationReason: string;
}

interface ReportTotals {
  rebillingsCount: number;
  rebillingsDuplicateGroups: number;
  rebillingsExtraRows: number;
  totalPremiumRebillings: number;
  renovationsConfirmedCount: number;
  renovationsImportedCount: number;
  totalPremiumRenovations: number;
  newPoliciesCount: number;
  totalMovements: number;
}

interface ReportData {
  month: string;
  rebillings: RebillingRow[];
  renovationsConfirmed: RenovationConfirmedRow[];
  renovationsImported: RenovationImportedRow[];
  newPolicies: NewPolicyRow[];
  totals: ReportTotals;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  if (!month) return "";
  const [y, m] = month.split("-");
  try {
    return new Date(Number(y), Number(m) - 1, 1)
      .toLocaleString("es-AR", { month: "long", year: "numeric" });
  } catch {
    return month;
  }
}

function importerLabel(imp: string): string {
  const map: Record<string, string> = {
    el_norte_v2: "El Norte",
    el_norte_v1: "El Norte (v1)",
    rivadavia: "Rivadavia",
    rivadavia_ssn_gde: "Rivadavia SSN",
    mercantil_andina: "Mercantil Andina",
    manual: "Manual",
    otro: "Otro",
  };
  return map[imp] ?? imp;
}

// ── Badges ────────────────────────────────────────────────────────────────────

const REBILLING_TYPE_LABELS: Record<string, string> = {
  prorroga: "Prórroga",
  endoso: "Endoso",
  extension_vigencia: "Ext. Vigencia",
  renovacion: "Renovación",
  rehabilitacion: "Rehabilitación",
  otro: "Otro",
};

const REBILLING_TYPE_COLORS: Record<string, string> = {
  prorroga: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  endoso: "bg-purple-500/15 text-purple-400 border-purple-500/20",
  extension_vigencia: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  renovacion: "bg-teal-500/15 text-teal-400 border-teal-500/20",
  rehabilitacion: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  otro: "bg-gray-500/15 text-gray-400 border-gray-500/20",
};

function RebillingTypeBadge({ type }: { type: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border",
      REBILLING_TYPE_COLORS[type] ?? REBILLING_TYPE_COLORS.otro)}>
      {REBILLING_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function DuplicateBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
      <Copy className="w-3 h-3" /> Duplicado ×{count}
    </span>
  );
}

function AltaBadge({ reason }: { reason: string }) {
  if (reason === "sin_antecedente_de_poliza" || reason === "refacturacion_sin_base") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-slate-500/15 text-slate-400 border border-slate-500/20">
        Alta sin antecedente
      </span>
    );
  }
  return null;
}

function TypeBadge({ type }: { type: string }) {
  const info = POLICY_TYPES[type];
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border",
      info?.color ?? "bg-gray-500/15 text-gray-400 border-gray-500/20")}>
      {info?.label ?? type}
    </span>
  );
}

// ── Table header ──────────────────────────────────────────────────────────────

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn("text-left text-xs text-gray-400 font-medium py-3 px-3 whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn("py-3 px-3 text-sm text-gray-300 align-top", className)}>
      {children}
    </td>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon, label, value, sub, color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-4 print-card">
      <div className="flex items-center gap-3 mb-2">
        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", color)}>
          <Icon className="w-4 h-4" />
        </div>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title, count, children, empty,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  empty?: string;
}) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden print-section">
      <div className="px-4 py-3 border-b border-[#1f2937] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-gray-500 bg-[#1f2937] px-2 py-0.5 rounded-full">{count}</span>
      </div>
      {count === 0
        ? <p className="text-sm text-gray-500 p-6 text-center">{empty ?? "Sin resultados para este período."}</p>
        : <div className="overflow-x-auto">{children}</div>}
    </div>
  );
}

// ── CSV export helper ─────────────────────────────────────────────────────────

function escapeCSV(val: unknown): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes(";") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(escapeCSV).join(","),
    ...rows.map((r) => headers.map((h) => escapeCSV(r[h])).join(",")),
  ];
  return "﻿" + lines.join("\r\n");
}

// ── Excel export ──────────────────────────────────────────────────────────────

function exportExcel(data: ReportData, activeFilters: string) {
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryRows = [
    { Sección: "Mes del reporte", Valor: monthLabel(data.month) },
    { Sección: "Filtros activos", Valor: activeFilters || "Ninguno" },
    { Sección: "Fecha de emisión", Valor: new Date().toLocaleString("es-AR") },
    { Sección: "", Valor: "" },
    { Sección: "Refacturaciones", Valor: data.totals.rebillingsCount },
    { Sección: "  · Grupos con duplicados", Valor: data.totals.rebillingsDuplicateGroups },
    { Sección: "  · Filas extra suprimidas", Valor: data.totals.rebillingsExtraRows },
    { Sección: "  · Premio total (deduplicado)", Valor: data.totals.totalPremiumRebillings },
    { Sección: "Renovaciones confirmadas", Valor: data.totals.renovationsConfirmedCount },
    { Sección: "Renovaciones importadas", Valor: data.totals.renovationsImportedCount },
    { Sección: "Premio total renovaciones", Valor: data.totals.totalPremiumRenovations },
    { Sección: "Altas del mes", Valor: data.totals.newPoliciesCount },
    { Sección: "Total movimientos", Valor: data.totals.totalMovements },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Resumen");

  // Refacturaciones sheet
  const rebRows = data.rebillings.map((r) => ({
    "N° Póliza": r.policyNumber,
    "Asegurado": r.insuredName,
    "Compañía": r.companyName,
    "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
    "Inicio refact.": r.billingStart,
    "Fin refact.": r.billingEnd,
    "Premio": r.premium,
    "Cuota mensual": r.monthlyFee,
    "Inicio póliza": r.policyOriginalStart,
    "Tipo": REBILLING_TYPE_LABELS[r.rebillingType] ?? r.rebillingType,
    "Duplicados detectados": r.duplicateCount > 1 ? r.duplicateCount : "",
  }));
  const rebSheet = XLSX.utils.json_to_sheet(rebRows);
  XLSX.utils.book_append_sheet(wb, rebSheet, "Refacturaciones");

  // Renovaciones sheet (confirmed + imported merged)
  const renRows = [
    ...data.renovationsConfirmed.map((r) => ({
      "Tipo renovación": "Confirmada",
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Inicio vigencia": r.startDate,
      "Fin vigencia": r.endDate,
      "Premio": r.premium,
      "Póliza anterior": r.renewedFromPolicyNumber ?? "",
      "Vto. anterior": r.renewedFromEndDate ?? "",
      "Importador": "",
    })),
    ...data.renovationsImported.map((r) => ({
      "Tipo renovación": "Importada",
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Inicio vigencia": r.startDate,
      "Fin vigencia": r.endDate,
      "Premio": r.premium,
      "Póliza anterior": "",
      "Vto. anterior": "",
      "Importador": importerLabel(r.sourceImporter),
    })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(renRows), "Renovaciones");

  // Altas sheet
  const altasRows = data.newPolicies.map((r) => ({
    "N° Póliza": r.policyNumber,
    "Asegurado": r.insuredName,
    "Compañía": r.companyName,
    "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
    "Inicio vigencia": r.startDate,
    "Fin vigencia": r.endDate,
    "Premio": r.premium,
    "Importador": importerLabel(r.sourceImporter),
    "Clasificación": r.classificationReason === "sin_antecedente_de_poliza"
      ? "Sin antecedente"
      : r.classificationReason === "refacturacion_sin_base"
        ? "Refact. sin base"
        : "Alta directa",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(altasRows), "Altas");

  XLSX.writeFile(wb, `renovaciones_refacturaciones_${data.month}.xlsx`);
}

// ── CSV full export ───────────────────────────────────────────────────────────

function exportCSV(data: ReportData) {
  const all: Record<string, unknown>[] = [
    ...data.rebillings.map((r) => ({
      "Tipo de movimiento": "Refacturación",
      "Subtipo": REBILLING_TYPE_LABELS[r.rebillingType] ?? r.rebillingType,
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Fecha inicio": r.billingStart,
      "Fecha fin": r.billingEnd,
      "Premio": r.premium ?? "",
      "Cuota mensual": r.monthlyFee ?? "",
      "Inicio póliza original": r.policyOriginalStart,
      "Duplicados detectados": r.duplicateCount > 1 ? r.duplicateCount : "",
      "Póliza anterior": "",
      "Importador": "",
      "Clasificación alta": "",
    })),
    ...data.renovationsConfirmed.map((r) => ({
      "Tipo de movimiento": "Renovación confirmada",
      "Subtipo": "",
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Fecha inicio": r.startDate,
      "Fecha fin": r.endDate,
      "Premio": r.premium ?? "",
      "Cuota mensual": "",
      "Inicio póliza original": "",
      "Duplicados detectados": "",
      "Póliza anterior": r.renewedFromPolicyNumber ?? "",
      "Importador": "",
      "Clasificación alta": "",
    })),
    ...data.renovationsImported.map((r) => ({
      "Tipo de movimiento": "Renovación importada",
      "Subtipo": "",
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Fecha inicio": r.startDate,
      "Fecha fin": r.endDate,
      "Premio": r.premium ?? "",
      "Cuota mensual": "",
      "Inicio póliza original": "",
      "Duplicados detectados": "",
      "Póliza anterior": "",
      "Importador": importerLabel(r.sourceImporter),
      "Clasificación alta": "",
    })),
    ...data.newPolicies.map((r) => ({
      "Tipo de movimiento": "Alta",
      "Subtipo": "",
      "N° Póliza": r.policyNumber,
      "Asegurado": r.insuredName,
      "Compañía": r.companyName,
      "Ramo": POLICY_TYPES[r.type]?.label ?? r.type,
      "Fecha inicio": r.startDate,
      "Fecha fin": r.endDate,
      "Premio": r.premium ?? "",
      "Cuota mensual": "",
      "Inicio póliza original": "",
      "Duplicados detectados": "",
      "Póliza anterior": "",
      "Importador": importerLabel(r.sourceImporter),
      "Clasificación alta": r.classificationReason === "sin_antecedente_de_poliza"
        ? "Sin antecedente"
        : r.classificationReason === "refacturacion_sin_base"
          ? "Refact. sin base"
          : "Alta directa",
    })),
  ];

  const csv = buildCSV(all);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `renovaciones_refacturaciones_${data.month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Print styles ──────────────────────────────────────────────────────────────

const PRINT_STYLES = `
@media print {
  @page { size: A4 landscape; margin: 1cm; }
  body { background: white !important; color: black !important; }
  .no-print { display: none !important; }
  .print-card { border: 1px solid #ccc !important; background: white !important; break-inside: avoid; }
  .print-section { border: 1px solid #ccc !important; background: white !important; break-inside: auto; margin-bottom: 1cm; }
  .print-section table { page-break-inside: auto; }
  .print-section tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  a { color: inherit !important; text-decoration: none !important; }
  * { color: black !important; background: white !important; border-color: #ccc !important; box-shadow: none !important; }
}
`;

// ── Main component ────────────────────────────────────────────────────────────

export default function ReporteMes() {
  const [month, setMonth] = useState(currentMonth);
  const [companyFilter, setCompanyFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("");
  const [rebillingTypeFilter, setRebillingTypeFilter] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    api.get("/api/companies").then((c: any[]) => setCompanies(c)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ month });
      if (companyFilter) params.set("companyId", companyFilter);
      if (typeFilter) params.set("type", typeFilter);
      if (movementTypeFilter) params.set("movementType", movementTypeFilter);
      if (rebillingTypeFilter) params.set("rebillingType", rebillingTypeFilter);
      if (q.trim()) params.set("q", q.trim());
      const result = await api.get(`/api/reports/renewals-rebillings?${params}`);
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [month, companyFilter, typeFilter, movementTypeFilter, rebillingTypeFilter, q]);

  useEffect(() => { load(); }, [load]);

  const clearFilters = () => {
    setCompanyFilter("");
    setTypeFilter("");
    setMovementTypeFilter("");
    setRebillingTypeFilter("");
    setQ("");
  };
  const hasFilters = companyFilter || typeFilter || movementTypeFilter || rebillingTypeFilter || q;

  const activeFiltersLabel = [
    companyFilter && companies.find(c => String(c.id) === companyFilter)?.name,
    typeFilter && (POLICY_TYPES[typeFilter]?.label ?? typeFilter),
    movementTypeFilter,
    rebillingTypeFilter,
    q && `"${q}"`,
  ].filter(Boolean).join(", ");

  const t = data?.totals;

  return (
    <AppLayout>
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <div className="p-4 lg:p-8">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6 no-print">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
              Renovaciones y Refacturaciones
            </h1>
            <p className="text-gray-400 text-sm mt-1 capitalize">{monthLabel(month)}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-3 py-2 bg-[#1f2937] border border-[#374151] text-gray-300 text-sm rounded-lg hover:text-white hover:border-gray-500 transition-all"
            >
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Imprimir / PDF</span>
            </button>
            {data && (
              <>
                <button
                  onClick={() => exportCSV(data)}
                  className="flex items-center gap-2 px-3 py-2 bg-[#1f2937] border border-[#374151] text-gray-300 text-sm rounded-lg hover:text-white hover:border-gray-500 transition-all"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">CSV</span>
                </button>
                <button
                  onClick={() => exportExcel(data, activeFiltersLabel)}
                  className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg font-medium transition-all"
                >
                  <FileText className="w-4 h-4" />
                  <span className="hidden sm:inline">Descargar Excel</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Print header (visible only in print) */}
        <div className="hidden print:block mb-6">
          <h1 className="text-2xl font-bold">Renovaciones y Refacturaciones del mes</h1>
          <p className="text-lg capitalize mt-1">{monthLabel(month)}</p>
          {activeFiltersLabel && <p className="text-sm mt-1">Filtros: {activeFiltersLabel}</p>}
          <p className="text-sm mt-1">Emitido: {new Date().toLocaleString("es-AR")}</p>
        </div>

        {/* Month navigation */}
        <div className="flex items-center gap-2 mb-5 no-print">
          <button
            onClick={() => setMonth(m => addMonths(m, -1))}
            className="p-2 rounded-lg bg-[#111827] border border-[#1f2937] text-gray-400 hover:text-white transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="month"
            value={month}
            onChange={e => e.target.value && setMonth(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-white focus:outline-none focus:border-blue-500 transition-all"
          />
          <button
            onClick={() => setMonth(m => addMonths(m, 1))}
            className="p-2 rounded-lg bg-[#111827] border border-[#1f2937] text-gray-400 hover:text-white transition-all"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setMonth(currentMonth())}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] text-gray-400 text-sm rounded-lg hover:text-white transition-all"
          >
            Hoy
          </button>
          {loading && <RefreshCw className="w-4 h-4 text-blue-400 animate-spin ml-1" />}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-5 no-print">
          <div className="relative flex-1 min-w-[160px] sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Póliza o asegurado..."
              className="w-full pl-9 pr-4 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all"
            />
          </div>
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all"
          >
            <option value="">Todas las compañías</option>
            {companies.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all"
          >
            <option value="">Todos los ramos</option>
            {Object.entries(POLICY_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select
            value={movementTypeFilter}
            onChange={e => setMovementTypeFilter(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all"
          >
            <option value="">Todos los movimientos</option>
            <option value="rebilling">Refacturaciones</option>
            <option value="renovation_confirmed">Renovaciones confirmadas</option>
            <option value="renovation_imported">Renovaciones importadas</option>
            <option value="new_policy">Altas</option>
          </select>
          <select
            value={rebillingTypeFilter}
            onChange={e => setRebillingTypeFilter(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-[#1f2937] rounded-lg text-sm text-gray-300 focus:outline-none focus:border-blue-500 transition-all"
          >
            <option value="">Todos los subtipos</option>
            <option value="prorroga">Prórrogas</option>
            <option value="endoso">Endosos</option>
            <option value="extension_vigencia">Extensiones de vigencia</option>
            <option value="renovacion">Renovaciones</option>
            <option value="rehabilitacion">Rehabilitaciones</option>
            <option value="otro">Otros</option>
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 py-2 text-gray-400 text-sm hover:text-white transition-all"
            >
              <X className="w-3 h-3" /> Limpiar
            </button>
          )}
        </div>

        {/* Summary cards */}
        {t && (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            <SummaryCard
              icon={BarChart3}
              label="Refacturaciones"
              value={t.rebillingsCount}
              sub={t.rebillingsDuplicateGroups > 0 ? `${t.rebillingsDuplicateGroups} con duplicados` : undefined}
              color="bg-blue-600/20 text-blue-400"
            />
            <SummaryCard
              icon={TrendingUp}
              label="Renovaciones"
              value={t.renovationsConfirmedCount + t.renovationsImportedCount}
              sub={`${t.renovationsConfirmedCount} confirmadas · ${t.renovationsImportedCount} importadas`}
              color="bg-emerald-600/20 text-emerald-400"
            />
            <SummaryCard
              icon={Plus}
              label="Altas del mes"
              value={t.newPoliciesCount}
              color="bg-purple-600/20 text-purple-400"
            />
            <SummaryCard
              icon={Copy}
              label="Duplicados detectados"
              value={t.rebillingsDuplicateGroups}
              sub={t.rebillingsExtraRows > 0 ? `${t.rebillingsExtraRows} filas suprimidas` : undefined}
              color="bg-amber-600/20 text-amber-400"
            />
            <SummaryCard
              icon={FileText}
              label="Premio total refact."
              value={t.totalPremiumRebillings > 0 ? formatCurrency(t.totalPremiumRebillings) : "—"}
              sub={t.totalPremiumRenovations > 0 ? `Renov.: ${formatCurrency(t.totalPremiumRenovations)}` : undefined}
              color="bg-teal-600/20 text-teal-400"
            />
          </div>
        )}

        {/* Loading state */}
        {loading && !data && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        )}

        {/* Sections */}
        {data && (
          <div className="space-y-5">

            {/* 1. Refacturaciones */}
            <Section
              title="Refacturaciones"
              count={data.rebillings.length}
              empty="Sin refacturaciones para este período."
            >
              <table className="w-full">
                <thead className="border-b border-[#1f2937] bg-[#0d1424]">
                  <tr>
                    <Th>N° Póliza</Th>
                    <Th>Asegurado</Th>
                    <Th>Compañía</Th>
                    <Th>Ramo</Th>
                    <Th>Inicio refact.</Th>
                    <Th>Fin refact.</Th>
                    <Th>Premio</Th>
                    <Th>Tipo</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]">
                  {data.rebillings.map((r) => (
                    <tr key={`${r.rebillingId}`} className="hover:bg-[#0d1424]/50 transition-colors">
                      <Td>
                        <span className="font-mono text-blue-400 text-xs">{r.policyNumber}</span>
                      </Td>
                      <Td>{r.insuredName}</Td>
                      <Td className="text-gray-400">{r.companyName}</Td>
                      <Td><TypeBadge type={r.type} /></Td>
                      <Td className="font-mono text-xs">{formatDate(r.billingStart)}</Td>
                      <Td className="font-mono text-xs">{formatDate(r.billingEnd)}</Td>
                      <Td className="font-medium text-white">{formatCurrency(r.premium)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <RebillingTypeBadge type={r.rebillingType} />
                          <DuplicateBadge count={r.duplicateCount} />
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            {/* 2. Renovaciones confirmadas */}
            <Section
              title="Renovaciones confirmadas"
              count={data.renovationsConfirmed.length}
              empty="Sin renovaciones confirmadas este mes."
            >
              <table className="w-full">
                <thead className="border-b border-[#1f2937] bg-[#0d1424]">
                  <tr>
                    <Th>N° Póliza</Th>
                    <Th>Asegurado</Th>
                    <Th>Compañía</Th>
                    <Th>Ramo</Th>
                    <Th>Inicio vigencia</Th>
                    <Th>Fin vigencia</Th>
                    <Th>Premio</Th>
                    <Th>Renueva a</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]">
                  {data.renovationsConfirmed.map((r) => (
                    <tr key={r.policyId} className="hover:bg-[#0d1424]/50 transition-colors">
                      <Td><span className="font-mono text-blue-400 text-xs">{r.policyNumber}</span></Td>
                      <Td>{r.insuredName}</Td>
                      <Td className="text-gray-400">{r.companyName}</Td>
                      <Td><TypeBadge type={r.type} /></Td>
                      <Td className="font-mono text-xs">{formatDate(r.startDate)}</Td>
                      <Td className="font-mono text-xs">{formatDate(r.endDate)}</Td>
                      <Td className="font-medium text-white">{formatCurrency(r.premium)}</Td>
                      <Td>
                        {r.renewedFromPolicyNumber
                          ? <span className="font-mono text-xs text-gray-400">{r.renewedFromPolicyNumber} (vto. {formatDate(r.renewedFromEndDate)})</span>
                          : <span className="text-gray-600 text-xs">—</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            {/* 3. Renovaciones importadas */}
            <Section
              title="Renovaciones importadas"
              count={data.renovationsImported.length}
              empty="Sin renovaciones importadas este mes."
            >
              <table className="w-full">
                <thead className="border-b border-[#1f2937] bg-[#0d1424]">
                  <tr>
                    <Th>N° Póliza</Th>
                    <Th>Asegurado</Th>
                    <Th>Compañía</Th>
                    <Th>Ramo</Th>
                    <Th>Inicio vigencia</Th>
                    <Th>Fin vigencia</Th>
                    <Th>Premio</Th>
                    <Th>Importador</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]">
                  {data.renovationsImported.map((r) => (
                    <tr key={r.policyId} className="hover:bg-[#0d1424]/50 transition-colors">
                      <Td><span className="font-mono text-blue-400 text-xs">{r.policyNumber}</span></Td>
                      <Td>{r.insuredName}</Td>
                      <Td className="text-gray-400">{r.companyName}</Td>
                      <Td><TypeBadge type={r.type} /></Td>
                      <Td className="font-mono text-xs">{formatDate(r.startDate)}</Td>
                      <Td className="font-mono text-xs">{formatDate(r.endDate)}</Td>
                      <Td className="font-medium text-white">{formatCurrency(r.premium)}</Td>
                      <Td className="text-gray-400 text-xs">{importerLabel(r.sourceImporter)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            {/* 4. Altas */}
            <Section
              title="Altas del mes"
              count={data.newPolicies.length}
              empty="Sin altas este mes."
            >
              <table className="w-full">
                <thead className="border-b border-[#1f2937] bg-[#0d1424]">
                  <tr>
                    <Th>N° Póliza</Th>
                    <Th>Asegurado</Th>
                    <Th>Compañía</Th>
                    <Th>Ramo</Th>
                    <Th>Inicio vigencia</Th>
                    <Th>Fin vigencia</Th>
                    <Th>Premio</Th>
                    <Th>Origen</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2937]">
                  {data.newPolicies.map((r) => (
                    <tr key={r.policyId} className="hover:bg-[#0d1424]/50 transition-colors">
                      <Td><span className="font-mono text-blue-400 text-xs">{r.policyNumber}</span></Td>
                      <Td>{r.insuredName}</Td>
                      <Td className="text-gray-400">{r.companyName}</Td>
                      <Td><TypeBadge type={r.type} /></Td>
                      <Td className="font-mono text-xs">{formatDate(r.startDate)}</Td>
                      <Td className="font-mono text-xs">{formatDate(r.endDate)}</Td>
                      <Td className="font-medium text-white">{formatCurrency(r.premium)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1 items-center">
                          <span className="text-xs text-gray-400">{importerLabel(r.sourceImporter)}</span>
                          <AltaBadge reason={r.classificationReason} />
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

          </div>
        )}
      </div>
    </AppLayout>
  );
}
