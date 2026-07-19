import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  Wallet,
  Plus,
  CheckCircle2,
  Trash2,
  Pencil,
  X,
  ChevronDown,
  ChevronRight,
  ArrowDownCircle,
  Banknote,
  CreditCard,
  FileText,
  BarChart2,
  TrendingUp,
  Receipt,
  AlertTriangle,
  AlertCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { type CashSummary, hasUnverifiedCashSummaryData } from "@/lib/caja-types";
import { filterPendingCashItems, formatAdeudadoOrigin } from "@/lib/caja-cobrados";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const METHODS = [
  { value: "efectivo", label: "Efectivo", group: "propio" },
  { value: "transferencia", label: "Transferencia (cuenta propia)", group: "propio" },
  { value: "cheque", label: "Cheque", group: "propio" },
  { value: "transferencia_compania", label: "Transf. directa a Compañía", group: "compania" },
  { value: "link_pago", label: "Link de Pago", group: "compania" },
];

// Métodos que van directo a la compañía (no a cuentas propias)
const DIRECTO_COMPANIA = ["transferencia_compania", "link_pago"];

function methodLabel(m: string) {
  return METHODS.find((x) => x.value === m)?.label || m;
}

function methodIcon(m: string) {
  if (m === "efectivo") return <Banknote size={14} className="text-green-400" />;
  if (m === "transferencia") return <ArrowDownCircle size={14} className="text-blue-400" />;
  if (m === "cheque") return <FileText size={14} className="text-yellow-400" />;
  if (m === "transferencia_compania") return <ArrowDownCircle size={14} className="text-orange-400" />;
  if (m === "link_pago") return <CreditCard size={14} className="text-purple-400" />;
  return <CreditCard size={14} className="text-purple-400" />;
}

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });
}

// ─── Modal genérico ────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#1a2035] rounded-xl shadow-2xl w-full max-w-lg mx-4 border border-white/10">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h3 className="text-white font-semibold">{title}</h3>
          <button onClick={onClose} className="text-white/50 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ─── Form Cobro Manual ─────────────────────────────────────────────────────────
const EMPTY_ENTRY = {
  clientName: "",
  policyNumber: "",
  companyName: "",
  amount: "",
  paymentMethod: "efectivo",
  paymentDate: new Date().toISOString().slice(0, 10),
  dueDate: "",
  notes: "",
};

function EntryForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: any;
  onSave: (data: any) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(
    initial
      ? {
          clientName: initial.clientName || "",
          policyNumber: initial.policyNumber || "",
          companyName: initial.companyName || "",
          amount: String(initial.amount || ""),
          paymentMethod: initial.paymentMethod || "efectivo",
          paymentDate: initial.paymentDate || new Date().toISOString().slice(0, 10),
          dueDate: initial.dueDate || "",
          notes: initial.notes || "",
        }
      : { ...EMPTY_ENTRY }
  );

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.clientName.trim() && form.amount && Number(form.amount) > 0 && form.paymentDate;

  return (
    <>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-white/50 mb-1 block">Cliente *</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.clientName}
              onChange={(e) => set("clientName", e.target.value)}
              placeholder="Nombre del cliente"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">N° Póliza</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.policyNumber}
              onChange={(e) => set("policyNumber", e.target.value)}
              placeholder="Opcional"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Compañía</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.companyName}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder="Opcional"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Importe *</label>
            <input
              type="number"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="0.00"
              min="0"
              step="0.01"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Método *</label>
            <select
              className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.paymentMethod}
              onChange={(e) => set("paymentMethod", e.target.value)}
            >
              <optgroup label="── Cuentas propias ──">
                {METHODS.filter(m => m.group === "propio").map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </optgroup>
              <optgroup label="── Directo a Compañía ──">
                {METHODS.filter(m => m.group === "compania").map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Fecha cobro *</label>
            <input
              type="date"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.paymentDate}
              onChange={(e) => set("paymentDate", e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Venc. cuota</label>
            <input
              type="date"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-white/50 mb-1 block">Notas</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Opcional"
            />
          </div>
        </div>
      </div>
      <div className="flex gap-3 mt-5 justify-end">
        <button onClick={onClose} className="px-4 py-2 text-sm text-white/60 hover:text-white">
          Cancelar
        </button>
        <button
          disabled={!valid}
          onClick={() => onSave(form)}
          className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium"
        >
          Guardar
        </button>
      </div>
    </>
  );
}

// ─── Form Adeudado ─────────────────────────────────────────────────────────────
const EMPTY_DEBT = {
  clientName: "",
  policyNumber: "",
  companyName: "",
  amount: "",
  dueDate: "",
  notes: "",
};

function DebtForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: any;
  onSave: (data: any) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(
    initial
      ? {
          clientName: initial.clientName || "",
          policyNumber: initial.policyNumber || "",
          companyName: initial.companyName || "",
          amount: String(initial.amount || ""),
          dueDate: initial.dueDate || "",
          notes: initial.notes || "",
        }
      : { ...EMPTY_DEBT }
  );
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.clientName.trim() && form.amount && Number(form.amount) > 0;

  return (
    <>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-white/50 mb-1 block">Cliente *</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.clientName}
              onChange={(e) => set("clientName", e.target.value)}
              placeholder="Nombre del cliente"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">N° Póliza</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.policyNumber}
              onChange={(e) => set("policyNumber", e.target.value)}
              placeholder="Opcional"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Compañía</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.companyName}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder="Opcional"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Importe *</label>
            <input
              type="number"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="0.00"
              min="0"
              step="0.01"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 mb-1 block">Fecha vencimiento</label>
            <input
              type="date"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-white/50 mb-1 block">Notas</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Opcional"
            />
          </div>
        </div>
      </div>
      <div className="flex gap-3 mt-5 justify-end">
        <button onClick={onClose} className="px-4 py-2 text-sm text-white/60 hover:text-white">
          Cancelar
        </button>
        <button
          disabled={!valid}
          onClick={() => onSave(form)}
          className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium"
        >
          Guardar
        </button>
      </div>
    </>
  );
}

// ─── Tooltip personalizado ────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1a2035] border border-white/10 rounded-lg px-4 py-3 shadow-xl text-xs">
      <p className="text-white/60 mb-2 font-medium">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }} className="mb-1">
          {p.name}: <span className="font-bold">{Number(p.value).toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</span>
        </p>
      ))}
    </div>
  );
}

// ─── StatsSection ─────────────────────────────────────────────────────────────
function StatsSection({ stats, view }: { stats: any[]; view: "mensual" | "historico" }) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const displayData = view === "mensual"
    ? stats.filter((s) => s.mes === currentMonth)
    : stats;

  // Para vista mensual sin datos todavía
  if (displayData.length === 0) {
    return (
      <div className="p-8 text-center text-white/30 text-sm">
        <BarChart2 size={32} className="mx-auto mb-2 opacity-30" />
        {view === "mensual" ? "Sin movimientos este mes" : "Sin datos históricos aún"}
      </div>
    );
  }

  // Formato de etiqueta mes
  const fmtMes = (m: string) => {
    const [y, mo] = m.split("-");
    const meses = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
    return `${meses[parseInt(mo) - 1]} ${y}`;
  };

  const chartData = displayData.map((r: any) => ({
    mes: fmtMes(r.mes),
    Cobrado: r.cobrado,
    Rendido: r.rendido,
    "Acum. Cobrado": r.acumuladoCobrado,
    "Acum. Rendido": r.acumuladoRendido,
  }));

  // Totales del período mostrado
  const totalCobrado = displayData.reduce((s: number, r: any) => s + r.cobrado, 0);
  const totalRendido = displayData.reduce((s: number, r: any) => s + r.rendido, 0);
  const enCartera = totalCobrado - totalRendido;

  return (
    <div className="p-5">
      {/* KPIs del período */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-xs text-white/40 mb-1">{view === "mensual" ? "Cobrado este mes" : "Total cobrado"}</p>
          <p className="text-lg font-bold text-white">{totalCobrado.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-xs text-white/40 mb-1">{view === "mensual" ? "Rendido este mes" : "Total rendido"}</p>
          <p className="text-lg font-bold text-orange-400">{totalRendido.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white/5 rounded-xl p-4">
          <p className="text-xs text-white/40 mb-1">
            {view === "mensual" ? "En cartera del mes" : "En cartera total"}
          </p>
          <p className="text-lg font-bold text-blue-400">{enCartera.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</p>
          <p className="text-xs text-white/25 mt-0.5">
            {view === "mensual" ? "Cobrado menos rendido dentro del mes seleccionado" : "Cobrado menos rendido en el período"}
          </p>
        </div>
      </div>

      {/* Gráfico */}
      {view === "historico" && chartData.length > 1 ? (
        <div className="mb-5">
          {/* Barras: cobrado vs rendido por mes */}
          <p className="text-xs text-white/40 mb-3 uppercase tracking-wider">Por mes</p>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="mes" tick={{ fill: "#ffffff50", fontSize: 11 }} />
              <YAxis tick={{ fill: "#ffffff50", fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#ffffff80" }} />
              <Bar dataKey="Cobrado" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
              <Bar dataKey="Rendido" fill="#f97316" radius={[4, 4, 0, 0]} maxBarSize={40} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* Líneas: evolución acumulada */}
          <p className="text-xs text-white/40 mt-5 mb-3 uppercase tracking-wider">Evolución acumulada</p>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="mes" tick={{ fill: "#ffffff50", fontSize: 11 }} />
              <YAxis tick={{ fill: "#ffffff50", fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#ffffff80" }} />
              <Line type="monotone" dataKey="Acum. Cobrado" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Acum. Rendido" stroke="#f97316" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : view === "mensual" ? (
        /* Vista mensual: barra única comparativa */
        <div className="mb-5">
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs text-white/50 mb-1">
                <span>Cobrado</span>
                <span>{totalCobrado.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</span>
              </div>
              <div className="h-3 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: "100%" }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-white/50 mb-1">
                <span>Rendido</span>
                <span>{totalRendido.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</span>
              </div>
              <div className="h-3 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-orange-500 rounded-full" style={{ width: totalCobrado > 0 ? `${Math.min(100, (totalRendido / totalCobrado) * 100)}%` : "0%" }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-white/50 mb-1">
                <span>En cartera</span>
                <span>{enCartera.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</span>
              </div>
              <div className="h-3 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400/60 rounded-full" style={{ width: totalCobrado > 0 ? `${Math.min(100, (enCartera / totalCobrado) * 100)}%` : "0%" }} />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tabla histórica */}
      {view === "historico" && (
        <div className="overflow-x-auto">
          <p className="text-xs text-white/40 mb-3 uppercase tracking-wider">Detalle por mes</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/40 border-b border-white/10">
                <th className="text-left py-2 pr-4">Mes</th>
                <th className="text-right py-2 pr-4">Cobrado</th>
                <th className="text-right py-2 pr-4">Rendido</th>
                <th className="text-right py-2 pr-4">En cartera</th>
                <th className="text-right py-2 pr-4">Acum. cobrado</th>
                <th className="text-right py-2">Acum. rendido</th>
              </tr>
            </thead>
            <tbody>
              {[...displayData].reverse().map((row: any) => (
                <tr key={row.mes} className="border-b border-white/5 hover:bg-white/3">
                  <td className="py-2 pr-4 text-white font-medium">{fmtMes(row.mes)}</td>
                  <td className="py-2 pr-4 text-right text-white">{row.cobrado.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</td>
                  <td className="py-2 pr-4 text-right text-orange-400">{row.rendido.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</td>
                  <td className="py-2 pr-4 text-right text-blue-400">{(row.cobrado - row.rendido).toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</td>
                  <td className="py-2 pr-4 text-right text-white/60">{row.acumuladoCobrado.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</td>
                  <td className="py-2 text-right text-white/60">{row.acumuladoRendido.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Sección colapsable ────────────────────────────────────────────────────────
function Section({
  title,
  badge,
  badgeColor = "bg-blue-600",
  open,
  onToggle,
  children,
  action,
}: {
  title: string;
  badge?: string | number;
  badgeColor?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-[#141c2e] rounded-xl border border-white/10 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-white/5 transition-colors"
        onClick={onToggle}
      >
        {open ? <ChevronDown size={16} className="text-white/40" /> : <ChevronRight size={16} className="text-white/40" />}
        <span className="text-white font-semibold text-sm flex-1 text-left">{title}</span>
        {badge !== undefined && (
          <span className={`${badgeColor} text-white text-xs px-2 py-0.5 rounded-full font-medium`}>
            {badge}
          </span>
        )}
        {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
      </button>
      {open && <div className="border-t border-white/10">{children}</div>}
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function CajaPage() {
  const { user } = useAuth();

  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);

  const [sections, setSections] = useState({
    resumen: true,
    cajaPropia: true,
    estadisticas: true,
    cobrados: true,
    cartera: false,
    adeudados: true,
    comisiones: true,
    gastos: true,
    movimientosPropios: true,
    iva: true,
  });
  const [statView, setStatView] = useState<"mensual" | "historico">("mensual");

  // Período seleccionado para el resumen (mes actual por defecto)
  const [periodoMes, setPeriodoMes] = useState<string>(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  });

  const [modals, setModals] = useState({
    addEntry: false,
    editEntry: null as any,
    addDebt: false,
    editDebt: null as any,
  });

  const [tab, setTab] = useState<"manual" | "cobranzas">("cobranzas");

  // ── Comisiones
  const [commissions, setCommissions] = useState<any[]>([]);
  const [commForm, setCommForm] = useState({
    companyId: "",
    date: new Date().toISOString().slice(0, 10),
    amount: "",
    notes: "",
    paymentMethod: "transferencia",
    periodMonth: "",
    status: "registrado",
  });
  const [editingComm, setEditingComm] = useState<any>(null);

  // ── IVA
  const [ivaList, setIvaList] = useState<any[]>([]);
  const [ivaForm, setIvaForm] = useState({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
  const [editingIva, setEditingIva] = useState<any>(null);

  // ── Companies
  const [companiesList, setCompaniesList] = useState<any[]>([]);

  // ── Gastos y Sueldos
  const [expenses, setExpenses] = useState<any[]>([]);
  const [expForm, setExpForm] = useState({
    type: "gasto_operativo",
    date: new Date().toISOString().slice(0, 10),
    description: "",
    category: "",
    amount: "",
    paymentMethod: "efectivo",
    payeeName: "",
    salaryPeriod: "",
    notes: "",
    status: "registrado",
  });
  const [editingExp, setEditingExp] = useState<any>(null);
  const [expError, setExpError] = useState<string | null>(null);

  // ── Movimientos propios
  const [ownMovements, setOwnMovements] = useState<any[]>([]);
  const [ownForm, setOwnForm] = useState({
    type: "aporte",
    date: new Date().toISOString().slice(0, 10),
    amount: "",
    paymentMethod: "efectivo",
    notes: "",
  });
  const [editingOwn, setEditingOwn] = useState<any>(null);
  const [ownError, setOwnError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [s, e, p, st, comm, iva, comp, exp, own] = await Promise.all([
      api.get(`/api/cash/summary?month=${periodoMes}`),
      api.get("/api/cash/entries"),
      api.get("/api/cash/payments"),
      api.get("/api/cash/stats"),
      api.get("/api/cash/commissions"),
      api.get("/api/cash/iva"),
      api.get("/api/companies"),
      api.get("/api/cash/expenses"),
      api.get("/api/cash/own-movements"),
    ]);
    setSummary(s);
    setEntries(Array.isArray(e) ? e : []);
    setPayments(Array.isArray(p) ? p : []);
    setStats(Array.isArray(st) ? st : []);
    setCommissions(Array.isArray(comm) ? comm : []);
    setIvaList(Array.isArray(iva) ? iva : []);
    setCompaniesList(Array.isArray(comp) ? comp : []);
    setExpenses(Array.isArray(exp) ? exp : []);
    setOwnMovements(Array.isArray(own) ? own : []);
  }, [periodoMes]);

  useEffect(() => {
    if (user) loadAll();
  }, [user, loadAll]);

  function toggleSection(k: keyof typeof sections) {
    setSections((s) => ({ ...s, [k]: !s[k] }));
  }

  // ── Entry CRUD
  async function saveEntry(data: any) {
    if (modals.editEntry) {
      await api.put(`/api/cash/entries/${modals.editEntry.id}`, data);
    } else {
      await api.post("/api/cash/entries", data);
    }
    setModals((m) => ({ ...m, addEntry: false, editEntry: null }));
    loadAll();
  }

  async function deleteEntry(id: number) {
    if (!confirm("¿Eliminar este cobro?")) return;
    await api.delete(`/api/cash/entries/${id}`);
    loadAll();
  }

  // ── Debt CRUD
  async function saveDebt(data: any) {
    if (modals.editDebt) {
      await api.put(`/api/cash/debts/${modals.editDebt.id}`, data);
    } else {
      await api.post("/api/cash/debts", data);
    }
    setModals((m) => ({ ...m, addDebt: false, editDebt: null }));
    loadAll();
  }

  async function deleteDebt(id: number) {
    if (!confirm("¿Eliminar este adeudado?")) return;
    await api.delete(`/api/cash/debts/${id}`);
    loadAll();
  }

  async function markDebtCobrado(debt: any) {
    const newStatus = debt.status === "cobrado" ? "pendiente" : "cobrado";
    await api.patch(`/api/cash/debts/${debt.id}/status`, { status: newStatus });
    loadAll();
  }

  // ── Commissions CRUD
  async function saveComm() {
    const src = editingComm ?? commForm;
    const data = {
      companyId: src.companyId ? parseInt(String(src.companyId)) : null,
      date: src.date,
      amount: parseFloat(String(src.amount)),
      notes: src.notes || null,
      paymentMethod: src.paymentMethod || "transferencia",
      periodMonth: src.periodMonth || null,
      status: src.status || "registrado",
    };
    if (!data.amount || isNaN(data.amount)) return;
    if (editingComm) {
      await api.put(`/api/cash/commissions/${editingComm.id}`, data);
      setEditingComm(null);
    } else {
      await api.post("/api/cash/commissions", data);
    }
    setCommForm({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "", paymentMethod: "transferencia", periodMonth: "", status: "registrado" });
    loadAll();
  }
  async function deleteComm(id: number) {
    if (!confirm("¿Anular esta comisión? Quedará visible en el historial como anulada.")) return;
    await api.delete(`/api/cash/commissions/${id}`);
    loadAll();
  }

  // ── IVA CRUD
  async function saveIva() {
    const data = { ...ivaForm, amount: parseFloat(ivaForm.amount), companyId: ivaForm.companyId ? parseInt(ivaForm.companyId) : null };
    if (!data.amount || isNaN(data.amount)) return;
    if (editingIva) {
      await api.put(`/api/cash/iva/${editingIva.id}`, data);
      setEditingIva(null);
    } else {
      await api.post("/api/cash/iva", data);
    }
    setIvaForm({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
    loadAll();
  }
  async function deleteIvaEntry(id: number) {
    if (!confirm("¿Eliminar este registro de IVA?")) return;
    await api.delete(`/api/cash/iva/${id}`);
    loadAll();
  }

  // ── Expenses CRUD
  async function saveExp() {
    setExpError(null);
    const src = editingExp ?? expForm;
    const data = {
      type: src.type,
      date: src.date,
      description: src.description,
      category: src.category || null,
      amount: parseFloat(String(src.amount)),
      paymentMethod: src.paymentMethod,
      payeeName: src.type === "sueldo" ? (src.payeeName || null) : null,
      salaryPeriod: src.type === "sueldo" ? (src.salaryPeriod || null) : null,
      notes: src.notes || null,
      status: src.status || "registrado",
    };
    if (!data.amount || isNaN(data.amount) || !data.date || !data.description?.trim()) return;
    try {
      if (editingExp) {
        await api.put(`/api/cash/expenses/${editingExp.id}`, data);
        setEditingExp(null);
      } else {
        await api.post("/api/cash/expenses", data);
      }
      setExpForm({ type: "gasto_operativo", date: new Date().toISOString().slice(0, 10), description: "", category: "", amount: "", paymentMethod: "efectivo", payeeName: "", salaryPeriod: "", notes: "", status: "registrado" });
      loadAll();
    } catch (e: any) {
      setExpError(e.message || "Error al guardar");
    }
  }

  async function anularExp(id: number) {
    if (!confirm("¿Anular este gasto/sueldo? Quedará visible como anulado.")) return;
    try {
      await api.delete(`/api/cash/expenses/${id}`);
      loadAll();
    } catch (e: any) {
      setExpError(e.message || "Error al anular");
    }
  }

  // ── OwnMovements CRUD
  async function saveOwn() {
    setOwnError(null);
    const src = editingOwn ?? ownForm;
    const data = {
      type: src.type,
      date: src.date,
      amount: parseFloat(String(src.amount)),
      paymentMethod: src.paymentMethod,
      notes: src.notes || null,
    };
    if (!data.amount || isNaN(data.amount) || !data.date) return;
    try {
      if (editingOwn) {
        await api.put(`/api/cash/own-movements/${editingOwn.id}`, data);
        setEditingOwn(null);
      } else {
        await api.post("/api/cash/own-movements", data);
      }
      setOwnForm({ type: "aporte", date: new Date().toISOString().slice(0, 10), amount: "", paymentMethod: "efectivo", notes: "" });
      loadAll();
    } catch (e: any) {
      setOwnError(e.message || "Error al guardar movimiento");
    }
  }

  async function anularOwn(id: number) {
    if (!confirm("¿Anular este movimiento?")) return;
    try {
      await api.delete(`/api/cash/own-movements/${id}`);
      loadAll();
    } catch (e: any) {
      setOwnError(e.message || "Error al anular");
    }
  }

  if (!user || user.role !== "admin") return <AppLayout><div /></AppLayout>;

  // ─── Cobros pendientes de rendición — lista fija en rendered=0. El estado
  // rendered se gestiona únicamente vía el flujo real de Rendiciones, nunca
  // desde acá (ver filterPendingCashItems en src/web/lib/caja-cobrados.ts).
  const pendingEntries = filterPendingCashItems(entries);
  const pendingPayments = filterPendingCashItems(payments);
  const cobradosSource = tab === "manual" ? pendingEntries : pendingPayments;

  return (
    <AppLayout>
    <div className="min-h-screen bg-[#0d1424] text-white">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-blue-600/20 rounded-lg">
            <Wallet size={22} className="text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Caja</h1>
            <p className="text-white/40 text-xs">Gestión de cobros, rendiciones y adeudados</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* ─── Estadísticas ──────────────────────────────────────────────── */}
          <Section
            title="Estadísticas"
            open={sections.estadisticas}
            onToggle={() => toggleSection("estadisticas")}
            action={
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                {(["mensual", "historico"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setStatView(v)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      statView === v ? "bg-blue-600 text-white" : "text-white/50 hover:text-white"
                    }`}
                  >
                    {v === "mensual" ? "Este mes" : "Histórico"}
                  </button>
                ))}
              </div>
            }
          >
            <StatsSection stats={stats} view={statView} />
          </Section>

          {/* ─── Resumen ───────────────────────────────────────────────────── */}
          <Section
            title="Resumen de caja"
            open={sections.resumen}
            onToggle={() => toggleSection("resumen")}
            action={
              <input
                type="month"
                value={periodoMes}
                onChange={(e) => setPeriodoMes(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
            }
          >
            {summary ? (
              <div className="p-5">
                {hasUnverifiedCashSummaryData(summary) && (
                  <div className="rounded-xl p-4 mb-5 flex items-start gap-3 bg-yellow-900/20 border border-yellow-500/30">
                    <AlertTriangle size={20} className="text-yellow-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-yellow-300">
                        Hay movimientos que no pudieron verificarse y fueron excluidos de los totales para evitar duplicaciones.
                      </p>
                      <details className="mt-2 text-xs text-yellow-200/70">
                        <summary className="cursor-pointer select-none">Ver detalle técnico</summary>
                        <ul className="mt-2 space-y-1">
                          {summary.allocationsModel.inconsistencias.map((i) => (
                            <li key={`ra-${i.remittanceId}`}>
                              Rendición #{i.remittanceId} ({i.date}): {i.reason}
                            </li>
                          ))}
                          {summary.carteraInconsistencias.map((i, idx) => (
                            <li key={`ci-${i.sourceType}-${i.sourceId}-${idx}`}>
                              {i.sourceType} #{i.sourceId}: {i.reason}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  </div>
                )}
                {/* Tarjetas detalle */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* Diferencia de caja — saldo neto (cartera − adeudados, sin restar
                      gastos: son un movimiento de Caja propia, no de la cartera del
                      asegurado). Baja cuando se rinde una cuota real como adeudada
                      (Curini adelantó esa plata) y vuelve a subir exacto cuando se
                      registra el cobro posterior (ver POST /remittances/items/:id/collect)
                      — es el mismo campo `diferencia` que ya calculaba el backend. */}
                  <div className={`rounded-xl p-4 border ${summary.diferencia >= 0 ? "bg-green-900/20 border-green-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                    <p className={`text-xs mb-1 ${summary.diferencia >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>Diferencia de caja</p>
                    <p className={`text-lg font-bold ${summary.diferencia >= 0 ? "text-green-400" : "text-red-400"}`}>{fmt(summary.diferencia)}</p>
                    <p className="text-xs text-white/30 mt-0.5">En cartera − Adeudados</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Total cobrado</p>
                    <p className="text-lg font-bold text-white">{fmt(summary.totalCobrado)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Rendido</p>
                    <p className="text-lg font-bold text-orange-400">{fmt(summary.totalRendido)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Pendiente total de rendir</p>
                    <p className="text-lg font-bold text-blue-400">{fmt(summary.cajaNeta.total)}</p>
                    <p className="text-xs text-white/25 mt-0.5">Saldo acumulado de cuentas propias aún no rendido</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Adeudados</p>
                    <p className="text-lg font-bold text-red-400">{fmt(summary.totalAdeudado)}</p>
                  </div>
                  <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4">
                    <p className="text-xs text-orange-400/70 mb-1">Gastos registrados</p>
                    <p className="text-lg font-bold text-orange-400">-{fmt(summary.totalGastos)}</p>
                  </div>
                  <div className={`rounded-xl p-4 border ${summary.gananciaNeta >= 0 ? "bg-emerald-900/20 border-emerald-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                    <p className={`text-xs mb-1 ${summary.gananciaNeta >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>Ganancia neta del mes</p>
                    <p className={`text-lg font-bold ${summary.gananciaNeta >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(summary.gananciaNeta)}</p>
                    <p className="text-xs text-white/30 mt-0.5">comisiones − gastos</p>
                  </div>
                </div>

                {/* Desglose cartera propia */}
                <div className="mt-4">
                  <p className="text-xs text-white/30 uppercase tracking-wider mb-2 font-medium">Cuentas propias</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-green-900/20 border border-green-500/20 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Banknote size={14} className="text-green-400" />
                        <p className="text-xs text-white/40">Efectivo</p>
                      </div>
                      <p className="text-base font-bold text-green-400">{fmt(summary.cartera.efectivo)}</p>
                    </div>
                    <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <ArrowDownCircle size={14} className="text-blue-400" />
                        <p className="text-xs text-white/40">Transferencias</p>
                      </div>
                      <p className="text-base font-bold text-blue-400">{fmt(summary.cartera.transferencia)}</p>
                    </div>
                    <div className="bg-yellow-900/20 border border-yellow-500/20 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <FileText size={14} className="text-yellow-400" />
                        <p className="text-xs text-white/40">Cheques</p>
                      </div>
                      <p className="text-base font-bold text-yellow-400">{fmt(summary.cartera.cheque)}</p>
                    </div>
                  </div>
                </div>

                {/* Directo a Compañía — separado, no suma al total de caja */}
                {summary.directoCompania && summary.directoCompania.total > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 mb-2">
                      <p className="text-xs text-white/30 uppercase tracking-wider font-medium">Directo a Compañía</p>
                      <span className="text-xs text-orange-400/70 bg-orange-900/20 border border-orange-500/20 rounded px-2 py-0.5">no suma a caja propia</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-orange-900/20 border border-orange-500/20 rounded-lg px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <ArrowDownCircle size={14} className="text-orange-400" />
                          <p className="text-xs text-white/40">Transf. a Compañía</p>
                        </div>
                        <p className="text-base font-bold text-orange-400">{fmt(summary.directoCompania.transferencia_compania)}</p>
                      </div>
                      <div className="bg-purple-900/20 border border-purple-500/20 rounded-lg px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <CreditCard size={14} className="text-purple-400" />
                          <p className="text-xs text-white/40">Links de Pago</p>
                        </div>
                        <p className="text-base font-bold text-purple-400">{fmt(summary.directoCompania.link_pago)}</p>
                      </div>
                    </div>
                    <div className="mt-2 bg-orange-900/10 border border-orange-500/10 rounded-lg px-4 py-2 flex justify-between items-center">
                      <p className="text-xs text-white/40">Total directo a compañía</p>
                      <p className="text-sm font-bold text-orange-300">{fmt(summary.directoCompania.total)}</p>
                    </div>
                  </div>
                )}

                {/* ── Totales del período seleccionado ──────────────────────── */}
                {summary.periodo && (
                  <div className="mt-5 border-t border-white/10 pt-5">
                    <p className="text-xs text-white/30 uppercase tracking-wider mb-3 font-medium">
                      Período: {summary.periodo.from} → {summary.periodo.to}
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Cobrado en el período</p>
                        <p className="text-lg font-bold text-white">{fmt(summary.periodo.cobrado)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Rendido en el período</p>
                        <p className="text-lg font-bold text-orange-400">{fmt(summary.periodo.rendido)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Gastos en el período</p>
                        <p className="text-lg font-bold text-red-400">-{fmt(summary.periodo.gastos)}</p>
                      </div>
                      <div className={`rounded-xl p-4 border ${summary.periodo.flujoNeto >= 0 ? "bg-emerald-900/20 border-emerald-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                        <p className="text-xs text-white/40 mb-1">Flujo neto del período</p>
                        <p className={`text-lg font-bold ${summary.periodo.flujoNeto >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {fmt(summary.periodo.flujoNeto)}
                        </p>
                        <p className="text-xs text-white/30 mt-1">
                          Puede incluir rendiciones de cobros realizados en períodos anteriores.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 text-center text-white/30 text-sm">Cargando...</div>
            )}
          </Section>

          {/* ─── Resumen Caja Propia ───────────────────────────────────────── */}
          <Section
            title="Resumen — Caja Propia"
            open={sections.cajaPropia}
            onToggle={() => toggleSection("cajaPropia")}
            action={
              <span className="text-xs text-white/30 font-normal">período: {periodoMes}</span>
            }
          >
            {summary?.cajaPropia ? (
              <div className="p-5 space-y-4">
                <div>
                  <p className="text-xs text-white/30 uppercase tracking-wider mb-2 font-medium">Histórico acumulado</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Comisiones</p>
                      <p className="text-lg font-bold text-emerald-400">{fmt(summary.cajaPropia.historico.comisiones)}</p>
                    </div>
                    <div className="bg-blue-900/20 border border-blue-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Aportes</p>
                      <p className="text-lg font-bold text-blue-400">{fmt(summary.cajaPropia.historico.aportes)}</p>
                    </div>
                    <div className="bg-orange-900/20 border border-orange-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Gastos operativos</p>
                      <p className="text-lg font-bold text-orange-400">−{fmt(summary.cajaPropia.historico.gastosOperativos)}</p>
                    </div>
                    <div className="bg-purple-900/20 border border-purple-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Sueldos</p>
                      <p className="text-lg font-bold text-purple-400">−{fmt(summary.cajaPropia.historico.sueldos)}</p>
                    </div>
                    <div className="bg-red-900/20 border border-red-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Reintegros</p>
                      <p className="text-lg font-bold text-red-400">−{fmt(summary.cajaPropia.historico.reintegros)}</p>
                    </div>
                    <div className={`rounded-xl p-4 border ${summary.cajaPropia.historico.resultadoOperativo >= 0 ? "bg-emerald-900/20 border-emerald-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                      <p className="text-xs text-white/40 mb-1">Resultado operativo</p>
                      <p className={`text-base font-bold ${summary.cajaPropia.historico.resultadoOperativo >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(summary.cajaPropia.historico.resultadoOperativo)}</p>
                      <p className="text-xs text-white/30 mt-0.5">comisiones − gastos − sueldos</p>
                    </div>
                    <div className={`rounded-xl p-4 border ${summary.cajaPropia.historico.saldoPropio >= 0 ? "bg-blue-900/20 border-blue-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                      <p className="text-xs text-white/40 mb-1">Saldo propio</p>
                      <p className={`text-base font-bold ${summary.cajaPropia.historico.saldoPropio >= 0 ? "text-blue-400" : "text-red-400"}`}>{fmt(summary.cajaPropia.historico.saldoPropio)}</p>
                      <p className="text-xs text-white/30 mt-0.5">comisiones + aportes − gastos − reintegros</p>
                    </div>
                    <div className="bg-yellow-900/20 border border-yellow-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Aportes pendientes</p>
                      <p className="text-lg font-bold text-yellow-400">{fmt(summary.cajaPropia.historico.aportesPendientes)}</p>
                      <p className="text-xs text-white/30 mt-0.5">aportes − reintegros</p>
                    </div>
                  </div>
                </div>

                {summary.cajaPropia.periodo && (
                  <div className="border-t border-white/10 pt-4">
                    <p className="text-xs text-white/30 uppercase tracking-wider mb-2 font-medium">
                      Período: {summary.cajaPropia.periodo.from} → {summary.cajaPropia.periodo.to}
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Comisiones</p>
                        <p className="text-lg font-bold text-emerald-400">{fmt(summary.cajaPropia.periodo.comisiones)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Aportes</p>
                        <p className="text-lg font-bold text-blue-400">{fmt(summary.cajaPropia.periodo.aportes)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Gastos operativos</p>
                        <p className="text-lg font-bold text-orange-400">−{fmt(summary.cajaPropia.periodo.gastosOperativos)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Sueldos</p>
                        <p className="text-lg font-bold text-purple-400">−{fmt(summary.cajaPropia.periodo.sueldos)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Reintegros</p>
                        <p className="text-lg font-bold text-red-400">−{fmt(summary.cajaPropia.periodo.reintegros)}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-4">
                        <p className="text-xs text-white/40 mb-1">Resultado operativo</p>
                        <p className={`text-lg font-bold ${summary.cajaPropia.periodo.resultadoOperativo >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(summary.cajaPropia.periodo.resultadoOperativo)}</p>
                      </div>
                      <div className={`md:col-span-2 rounded-xl p-4 border ${summary.cajaPropia.periodo.flujoPropio >= 0 ? "bg-emerald-900/20 border-emerald-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                        <p className="text-xs text-white/40 mb-1">Flujo propio del período</p>
                        <p className={`text-xl font-bold ${summary.cajaPropia.periodo.flujoPropio >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(summary.cajaPropia.periodo.flujoPropio)}</p>
                        <p className="text-xs text-white/30 mt-0.5">comisiones + aportes − gastos − sueldos − reintegros</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 text-center text-white/30 text-sm">Cargando...</div>
            )}
          </Section>

          {/* ─── Cobros pendientes de rendición ────────────────────────────── */}
          {/* Lista fija en rendered=0 (ver filterPendingCashItems) — el estado
              rendered se gestiona únicamente vía el flujo real de Rendiciones,
              nunca desde un toggle manual acá. Los totales históricos
              (totalRendido/rendidoPorMetodo/período rendido) siguen viniendo
              de summary, sin cambios — esta lista es solo lo operativo. */}
          <Section
            title="Cobros pendientes de rendición"
            badge={summary ? cobradosSource.length : undefined}
            open={sections.cobrados}
            onToggle={() => toggleSection("cobrados")}
            action={
              tab === "manual" ? (
                <button
                  onClick={() => setModals((m) => ({ ...m, addEntry: true }))}
                  className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg"
                >
                  <Plus size={13} /> Agregar
                </button>
              ) : undefined
            }
          >
            <div className="p-4">
              <p className="text-xs text-white/40 mb-3">Solo se muestran operaciones que todavía están en cartera.</p>

              {/* Tab */}
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="flex bg-white/5 rounded-lg p-0.5 text-xs">
                  <button
                    onClick={() => setTab("cobranzas")}
                    className={`px-3 py-1.5 rounded-md transition-colors ${tab === "cobranzas" ? "bg-blue-600 text-white" : "text-white/50 hover:text-white"}`}
                  >
                    Desde Cobranzas
                  </button>
                  <button
                    onClick={() => setTab("manual")}
                    className={`px-3 py-1.5 rounded-md transition-colors ${tab === "manual" ? "bg-blue-600 text-white" : "text-white/50 hover:text-white"}`}
                  >
                    Manual
                  </button>
                </div>
              </div>

              {cobradosSource.length === 0 ? (
                <div className="text-center py-8 text-white/30 text-sm">
                  {tab === "manual" ? "No hay cobros manuales pendientes de rendición." : "No hay cobros desde Cobranzas pendientes de rendición."}
                </div>
              ) : (
                <div className="space-y-2">
                  {cobradosSource.map((item: any) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-white/10 bg-white/5 transition-colors"
                    >
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white truncate">
                            {tab === "manual"
                              ? item.clientName
                              : item.insuredName || item.manualPayer || "—"}
                          </span>
                          {(item.policyNumber || item.manualPolicyNumber) && (
                            <span className="text-xs text-white/30">
                              #{item.policyNumber || item.manualPolicyNumber}
                            </span>
                          )}
                          {(item.companyName || item.manualCompany) && (
                            <span className="text-xs text-white/30">
                              · {item.companyName || item.manualCompany}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs text-white/40">{item.paymentDate}</span>
                          {item.dueDate && <span className="text-xs text-white/30">Venc: {item.dueDate}</span>}
                          <span className="flex items-center gap-1 text-xs text-white/40">
                            {methodIcon(item.paymentMethod)}
                            {methodLabel(item.paymentMethod)}
                          </span>
                        </div>
                      </div>

                      {/* Importe */}
                      <span className="text-sm font-bold text-white shrink-0">{fmt(item.amount)}</span>

                      {/* Acciones solo para manual */}
                      {tab === "manual" && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => setModals((m) => ({ ...m, editEntry: item }))}
                            className="p-1.5 text-white/30 hover:text-white rounded"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => deleteEntry(item.id)}
                            className="p-1.5 text-white/30 hover:text-red-400 rounded"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          {/* ─── Comisiones ────────────────────────────────────────────────── */}
          <Section
            title="Comisiones"
            badge={commissions.filter((c: any) => c.status !== "anulado").length || undefined}
            badgeColor="bg-emerald-600"
            open={sections.comisiones}
            onToggle={() => toggleSection("comisiones")}
          >
            <div className="p-4 space-y-4">
              {/* Resumen */}
              {summary && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Comisiones del mes</p>
                    <p className="text-lg font-bold text-emerald-400">{fmt(summary.comisiones?.totalMes ?? 0)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Acumulado anual</p>
                    <p className="text-lg font-bold text-white">{fmt(summary.comisiones?.totalAnio ?? 0)}</p>
                  </div>
                  <div className={`rounded-xl p-4 border ${(summary.gananciaNeta ?? 0) >= 0 ? "bg-emerald-900/20 border-emerald-500/20" : "bg-red-900/20 border-red-500/20"}`}>
                    <p className="text-xs text-white/40 mb-1">Ganancia neta del mes</p>
                    <p className={`text-lg font-bold ${(summary.gananciaNeta ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(summary.gananciaNeta ?? 0)}</p>
                    <p className="text-xs text-white/30 mt-0.5">comisiones − gastos</p>
                  </div>
                </div>
              )}

              {/* Form nuevo/editar */}
              <div className="bg-white/5 rounded-xl p-4">
                <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{editingComm ? "Editar comisión" : "Nueva comisión"}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Compañía</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.companyId ?? "" : commForm.companyId}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, companyId: e.target.value }) : setCommForm((f) => ({ ...f, companyId: e.target.value }))}
                    >
                      <option value="">Sin especificar</option>
                      {companiesList.map((c: any) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Fecha *</label>
                    <input
                      type="date"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.date : commForm.date}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, date: e.target.value }) : setCommForm((f) => ({ ...f, date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Período (AAAA-MM)</label>
                    <input
                      type="month"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.periodMonth ?? "" : commForm.periodMonth}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, periodMonth: e.target.value }) : setCommForm((f) => ({ ...f, periodMonth: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Importe *</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.amount : commForm.amount}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, amount: e.target.value }) : setCommForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Medio de pago</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.paymentMethod ?? "transferencia" : commForm.paymentMethod}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, paymentMethod: e.target.value }) : setCommForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                    >
                      <option value="transferencia">Transferencia</option>
                      <option value="efectivo">Efectivo</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Estado</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.status ?? "registrado" : commForm.status}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, status: e.target.value }) : setCommForm((f) => ({ ...f, status: e.target.value }))}
                    >
                      <option value="registrado">Registrado</option>
                      <option value="anulado">Anulado</option>
                    </select>
                  </div>
                  <div className="md:col-span-3">
                    <label className="text-xs text-white/40 mb-1 block">Notas</label>
                    <input
                      placeholder="Opcional"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
                      value={editingComm ? editingComm.notes ?? "" : commForm.notes}
                      onChange={(e) => editingComm ? setEditingComm({ ...editingComm, notes: e.target.value }) : setCommForm((f) => ({ ...f, notes: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-3 justify-end">
                  {editingComm && (
                    <button onClick={() => setEditingComm(null)} className="px-4 py-2 text-xs text-white/50 hover:text-white">
                      Cancelar
                    </button>
                  )}
                  <button
                    onClick={saveComm}
                    disabled={!(editingComm ? editingComm.amount : commForm.amount)}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg font-medium"
                  >
                    <Plus size={13} /> {editingComm ? "Actualizar" : "Guardar"}
                  </button>
                </div>
              </div>

              {/* Tabla historial */}
              {commissions.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">No hay comisiones registradas.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-white/40 border-b border-white/10">
                        <th className="text-left py-2 pr-3">Fecha</th>
                        <th className="text-left py-2 pr-3">Compañía</th>
                        <th className="text-left py-2 pr-3">Período</th>
                        <th className="text-left py-2 pr-3">Medio</th>
                        <th className="text-left py-2 pr-3">Estado</th>
                        <th className="text-left py-2 pr-3">Notas</th>
                        <th className="text-right py-2 pr-3">Importe</th>
                        <th className="text-right py-2">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commissions.map((c: any) => (
                        <tr key={c.id} className={`border-b border-white/5 hover:bg-white/3 ${c.status === "anulado" ? "opacity-50" : ""}`}>
                          <td className="py-2 pr-3 text-white/70">{c.date}</td>
                          <td className="py-2 pr-3 text-white/70">{c.companyName || "—"}</td>
                          <td className="py-2 pr-3 text-white/50">{c.periodMonth || "—"}</td>
                          <td className="py-2 pr-3 text-white/50 capitalize">{c.paymentMethod || "—"}</td>
                          <td className="py-2 pr-3">
                            {c.status === "anulado"
                              ? <span className="bg-red-900/40 text-red-400 text-xs px-2 py-0.5 rounded-full">Anulada</span>
                              : <span className="bg-emerald-900/40 text-emerald-400 text-xs px-2 py-0.5 rounded-full">Registrada</span>
                            }
                          </td>
                          <td className="py-2 pr-3 text-white/50">{c.notes || "—"}</td>
                          <td className="py-2 pr-3 text-right font-bold text-emerald-400">{fmt(c.amount)}</td>
                          <td className="py-2 text-right">
                            {c.status !== "anulado" && (
                              <div className="flex items-center gap-1 justify-end">
                                <button onClick={() => setEditingComm({ ...c, companyId: c.companyId ?? "", periodMonth: c.periodMonth ?? "", status: c.status ?? "registrado", paymentMethod: c.paymentMethod ?? "transferencia" })} className="p-1 text-white/30 hover:text-white rounded"><Pencil size={13} /></button>
                                <button onClick={() => deleteComm(c.id)} className="p-1 text-white/30 hover:text-red-400 rounded"><Trash2 size={13} /></button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>

          {/* ─── Gastos y Sueldos ──────────────────────────────────────────── */}
          <Section
            title="Gastos y Sueldos"
            badge={expenses.filter((e: any) => e.status !== "anulado").length || undefined}
            badgeColor="bg-orange-600"
            open={sections.gastos}
            onToggle={() => toggleSection("gastos")}
          >
            <div className="p-4 space-y-4">
              {/* Resumen chips */}
              {expenses.length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="bg-orange-900/30 border border-orange-500/20 text-orange-400 px-3 py-1 rounded-full">
                    Gastos: {expenses.filter((e: any) => e.type === "gasto_operativo" && e.status !== "anulado").length}
                    {" · "}{fmt(expenses.filter((e: any) => e.type === "gasto_operativo" && e.status !== "anulado").reduce((s: number, e: any) => s + e.amount, 0))}
                  </span>
                  <span className="bg-purple-900/30 border border-purple-500/20 text-purple-400 px-3 py-1 rounded-full">
                    Sueldos: {expenses.filter((e: any) => e.type === "sueldo" && e.status !== "anulado").length}
                    {" · "}{fmt(expenses.filter((e: any) => e.type === "sueldo" && e.status !== "anulado").reduce((s: number, e: any) => s + e.amount, 0))}
                  </span>
                  {expenses.some((e: any) => e.status === "conciliado") && (
                    <span className="bg-teal-900/30 border border-teal-500/20 text-teal-400 px-3 py-1 rounded-full">
                      Conciliados: {expenses.filter((e: any) => e.status === "conciliado").length}
                    </span>
                  )}
                  {expenses.some((e: any) => e.status === "anulado") && (
                    <span className="bg-red-900/30 border border-red-500/20 text-red-400 px-3 py-1 rounded-full">
                      Anulados: {expenses.filter((e: any) => e.status === "anulado").length}
                    </span>
                  )}
                </div>
              )}

              {/* Error */}
              {expError && (
                <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  <AlertTriangle size={15} />
                  {expError}
                  <button onClick={() => setExpError(null)} className="ml-auto text-red-400/60 hover:text-red-400"><X size={14} /></button>
                </div>
              )}

              {/* Form */}
              <div className="bg-white/5 rounded-xl p-4">
                <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{editingExp ? "Editar gasto / sueldo" : "Nuevo gasto / sueldo"}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Tipo</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.type : expForm.type}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, type: e.target.value }) : setExpForm((f) => ({ ...f, type: e.target.value }))}
                    >
                      <option value="gasto_operativo">Gasto operativo</option>
                      <option value="sueldo">Sueldo</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Fecha *</label>
                    <input
                      type="date"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.date : expForm.date}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, date: e.target.value }) : setExpForm((f) => ({ ...f, date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Importe *</label>
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.amount : expForm.amount}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, amount: e.target.value }) : setExpForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs text-white/40 mb-1 block">Descripción *</label>
                    <input
                      placeholder="Descripción del gasto"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.description : expForm.description}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, description: e.target.value }) : setExpForm((f) => ({ ...f, description: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Categoría</label>
                    <input
                      placeholder="Opcional"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.category ?? "" : expForm.category}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, category: e.target.value }) : setExpForm((f) => ({ ...f, category: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Medio de pago</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.paymentMethod : expForm.paymentMethod}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, paymentMethod: e.target.value }) : setExpForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                    >
                      <option value="efectivo">Efectivo</option>
                      <option value="transferencia">Transferencia</option>
                      <option value="cheque">Cheque</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Estado</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.status : expForm.status}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, status: e.target.value }) : setExpForm((f) => ({ ...f, status: e.target.value }))}
                    >
                      <option value="registrado">Registrado</option>
                      <option value="conciliado">Conciliado</option>
                    </select>
                  </div>
                  {(editingExp ? editingExp.type : expForm.type) === "sueldo" && (
                    <>
                      <div>
                        <label className="text-xs text-white/40 mb-1 block">Beneficiario *</label>
                        <input
                          placeholder="Nombre del empleado"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                          value={editingExp ? editingExp.payeeName ?? "" : expForm.payeeName}
                          onChange={(e) => editingExp ? setEditingExp({ ...editingExp, payeeName: e.target.value }) : setExpForm((f) => ({ ...f, payeeName: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-white/40 mb-1 block">Período salarial * (AAAA-MM)</label>
                        <input
                          type="month"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                          value={editingExp ? editingExp.salaryPeriod ?? "" : expForm.salaryPeriod}
                          onChange={(e) => editingExp ? setEditingExp({ ...editingExp, salaryPeriod: e.target.value }) : setExpForm((f) => ({ ...f, salaryPeriod: e.target.value }))}
                        />
                      </div>
                    </>
                  )}
                  <div className="md:col-span-3">
                    <label className="text-xs text-white/40 mb-1 block">Notas</label>
                    <input
                      placeholder="Opcional"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
                      value={editingExp ? editingExp.notes ?? "" : expForm.notes}
                      onChange={(e) => editingExp ? setEditingExp({ ...editingExp, notes: e.target.value }) : setExpForm((f) => ({ ...f, notes: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-3 justify-end">
                  {editingExp && (
                    <button onClick={() => setEditingExp(null)} className="px-4 py-2 text-xs text-white/50 hover:text-white">Cancelar</button>
                  )}
                  <button
                    onClick={saveExp}
                    disabled={!(editingExp ? editingExp.amount && editingExp.description : expForm.amount && expForm.description)}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white rounded-lg font-medium"
                  >
                    <Plus size={13} /> {editingExp ? "Actualizar" : "Guardar"}
                  </button>
                </div>
              </div>

              {/* Tabla */}
              {expenses.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">No hay gastos ni sueldos registrados.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-white/40 border-b border-white/10">
                        <th className="text-left py-2 pr-3">Tipo</th>
                        <th className="text-left py-2 pr-3">Fecha</th>
                        <th className="text-left py-2 pr-3">Descripción</th>
                        <th className="text-left py-2 pr-3">Categoría</th>
                        <th className="text-left py-2 pr-3">Medio</th>
                        <th className="text-left py-2 pr-3">Estado</th>
                        <th className="text-right py-2 pr-3">Importe</th>
                        <th className="text-right py-2">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenses.map((e: any) => (
                        <tr key={e.id} className={`border-b border-white/5 hover:bg-white/3 ${e.status === "anulado" ? "opacity-50" : ""}`}>
                          <td className="py-2 pr-3">
                            {e.type === "sueldo"
                              ? <span className="bg-purple-900/40 text-purple-400 text-xs px-2 py-0.5 rounded-full">Sueldo</span>
                              : <span className="bg-orange-900/40 text-orange-400 text-xs px-2 py-0.5 rounded-full">Gasto</span>
                            }
                          </td>
                          <td className="py-2 pr-3 text-white/70">{e.date}</td>
                          <td className="py-2 pr-3 text-white/70">
                            {e.description}
                            {e.payeeName && <span className="text-white/40 ml-1">· {e.payeeName}</span>}
                            {e.salaryPeriod && <span className="text-white/40 ml-1">({e.salaryPeriod})</span>}
                          </td>
                          <td className="py-2 pr-3 text-white/50">{e.category || "—"}</td>
                          <td className="py-2 pr-3 text-white/50 capitalize">{e.paymentMethod}</td>
                          <td className="py-2 pr-3">
                            {e.status === "anulado" && <span className="bg-red-900/40 text-red-400 text-xs px-2 py-0.5 rounded-full">Anulado</span>}
                            {e.status === "conciliado" && <span className="bg-teal-900/40 text-teal-400 text-xs px-2 py-0.5 rounded-full">Conciliado</span>}
                            {e.status === "registrado" && <span className="text-white/30 text-xs">Registrado</span>}
                          </td>
                          <td className="py-2 pr-3 text-right font-bold text-orange-400">{fmt(e.amount)}</td>
                          <td className="py-2 text-right">
                            {e.status !== "anulado" && (
                              <div className="flex items-center gap-1 justify-end">
                                <button onClick={() => setEditingExp({ ...e, category: e.category ?? "", payeeName: e.payeeName ?? "", salaryPeriod: e.salaryPeriod ?? "", notes: e.notes ?? "" })} className="p-1 text-white/30 hover:text-white rounded"><Pencil size={13} /></button>
                                <button onClick={() => anularExp(e.id)} className="p-1 text-white/30 hover:text-red-400 rounded"><Trash2 size={13} /></button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>

          {/* ─── IVA ───────────────────────────────────────────────────────── */}
          <Section
            title="IVA"
            badge={ivaList.length || undefined}
            badgeColor="bg-violet-600"
            open={sections.iva}
            onToggle={() => toggleSection("iva")}
          >
            <div className="p-4 space-y-4">
              {/* Resumen */}
              {summary && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-violet-900/20 border border-violet-500/20 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">IVA del mes</p>
                    <p className="text-lg font-bold text-violet-400">{fmt(summary.iva?.totalMes ?? 0)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Acumulado anual</p>
                    <p className="text-lg font-bold text-white">{fmt(summary.iva?.totalAnio ?? 0)}</p>
                  </div>
                </div>
              )}

              {/* Form nuevo/editar */}
              <div className="bg-white/5 rounded-xl p-4">
                <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{editingIva ? "Editar registro IVA" : "Nuevo registro IVA"}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Compañía</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-violet-500"
                      value={editingIva ? editingIva.companyId ?? "" : ivaForm.companyId}
                      onChange={(e) => editingIva ? setEditingIva({ ...editingIva, companyId: e.target.value }) : setIvaForm((f) => ({ ...f, companyId: e.target.value }))}
                    >
                      <option value="">Sin especificar</option>
                      {companiesList.map((c: any) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Fecha *</label>
                    <input
                      type="date"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-violet-500"
                      value={editingIva ? editingIva.date : ivaForm.date}
                      onChange={(e) => editingIva ? setEditingIva({ ...editingIva, date: e.target.value }) : setIvaForm((f) => ({ ...f, date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Importe *</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-violet-500"
                      value={editingIva ? editingIva.amount : ivaForm.amount}
                      onChange={(e) => editingIva ? setEditingIva({ ...editingIva, amount: e.target.value }) : setIvaForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Notas</label>
                    <input
                      placeholder="Opcional"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-violet-500"
                      value={editingIva ? editingIva.notes ?? "" : ivaForm.notes}
                      onChange={(e) => editingIva ? setEditingIva({ ...editingIva, notes: e.target.value }) : setIvaForm((f) => ({ ...f, notes: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-3 justify-end">
                  {editingIva && (
                    <button onClick={() => setEditingIva(null)} className="px-4 py-2 text-xs text-white/50 hover:text-white">
                      Cancelar
                    </button>
                  )}
                  <button
                    onClick={saveIva}
                    disabled={!(editingIva ? editingIva.amount : ivaForm.amount)}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg font-medium"
                  >
                    <Plus size={13} /> {editingIva ? "Actualizar" : "Guardar"}
                  </button>
                </div>
              </div>

              {/* Tabla historial */}
              {ivaList.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">No hay registros de IVA cargados.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-white/40 border-b border-white/10">
                        <th className="text-left py-2 pr-4">Fecha</th>
                        <th className="text-left py-2 pr-4">Compañía</th>
                        <th className="text-left py-2 pr-4">Notas</th>
                        <th className="text-right py-2 pr-4">Importe</th>
                        <th className="text-right py-2">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ivaList.map((iv: any) => (
                        <tr key={iv.id} className="border-b border-white/5 hover:bg-white/3">
                          <td className="py-2 pr-4 text-white/70">{iv.date}</td>
                          <td className="py-2 pr-4 text-white/70">{iv.companyName || "—"}</td>
                          <td className="py-2 pr-4 text-white/50">{iv.notes || "—"}</td>
                          <td className="py-2 pr-4 text-right font-bold text-violet-400">{fmt(iv.amount)}</td>
                          <td className="py-2 text-right">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => setEditingIva({ ...iv, companyId: iv.companyId ?? "" })} className="p-1 text-white/30 hover:text-white rounded"><Pencil size={13} /></button>
                              <button onClick={() => deleteIvaEntry(iv.id)} className="p-1 text-white/30 hover:text-red-400 rounded"><Trash2 size={13} /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>

          {/* ─── Adeudados ─────────────────────────────────────────────────── */}
          {/* Detalle fila por fila de summary.adeudadosDetalle — misma fuente
              que ya calcula totalAdeudado en el backend (ver src/lib/payments/
              caja-summary.ts), sin una segunda consulta que reconstruya el
              total. "Marcar cobrado"/editar/eliminar solo aplican a
              origen='cash_debt_legacy' (las únicas filas que corresponden a
              una fila real y editable de cash_debts) — instalments/manual_debt
              de rendiciones se resuelven desde Cobranzas, no desde acá. */}
          <Section
            title="Adeudados"
            badge={summary?.adeudadosDetalle.length || undefined}
            badgeColor="bg-red-600"
            open={sections.adeudados}
            onToggle={() => toggleSection("adeudados")}
            action={
              <button
                onClick={() => setModals((m) => ({ ...m, addDebt: true }))}
                className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg"
              >
                <Plus size={13} /> Agregar
              </button>
            }
          >
            <div className="p-4">
              {!summary || summary.adeudadosDetalle.length === 0 ? (
                <div className="text-center py-8 text-white/30 text-sm">No hay adeudados pendientes.</div>
              ) : (
                <div className="space-y-2">
                  {summary.adeudadosDetalle.map((item) => (
                    <div
                      key={`${item.origen}-${item.id}`}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-red-500/20 bg-red-900/10 transition-colors"
                    >
                      <AlertCircle size={16} className="text-red-400 shrink-0" />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white truncate">{item.deudor}</span>
                          {item.polizaODescripcion && (
                            <span className="text-xs text-white/30">#{item.polizaODescripcion}</span>
                          )}
                          {item.compania && (
                            <span className="text-xs text-white/30">· {item.compania}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs text-white/40">{item.fecha}</span>
                          <span className="text-xs text-white/30">{formatAdeudadoOrigin(item.origen)}</span>
                          <span className="text-xs text-red-400/70">Pendiente</span>
                        </div>
                      </div>

                      <span className="text-sm font-bold text-red-400 shrink-0">{fmt(item.importe)}</span>

                      {item.origen === "cash_debt_legacy" && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            title="Marcar cobrado"
                            onClick={() => markDebtCobrado({ id: item.id, status: "pendiente" })}
                            className="p-1.5 text-red-400/60 hover:text-green-400 rounded"
                          >
                            <CheckCircle2 size={16} />
                          </button>
                          <button
                            onClick={() => setModals((m) => ({ ...m, editDebt: { id: item.id, clientName: item.deudor, policyNumber: item.polizaODescripcion, companyName: item.compania, amount: item.importe } }))}
                            className="p-1.5 text-white/30 hover:text-white rounded"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => deleteDebt(item.id)}
                            className="p-1.5 text-white/30 hover:text-red-400 rounded"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>
          {/* ─── Movimientos propios ───────────────────────────────────────── */}
          <Section
            title="Movimientos propios"
            badge={ownMovements.filter((m: any) => m.status === "registrado").length || undefined}
            badgeColor="bg-blue-600"
            open={sections.movimientosPropios}
            onToggle={() => toggleSection("movimientosPropios")}
          >
            <div className="p-4 space-y-4">
              {/* Balance */}
              {(() => {
                const aportes = ownMovements.filter((m: any) => m.type === "aporte" && m.status === "registrado").reduce((s: number, m: any) => s + m.amount, 0);
                const reintegros = ownMovements.filter((m: any) => m.type === "reintegro" && m.status === "registrado").reduce((s: number, m: any) => s + m.amount, 0);
                const saldo = aportes - reintegros;
                return (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-blue-900/20 border border-blue-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Aportes registrados</p>
                      <p className="text-lg font-bold text-blue-400">{fmt(aportes)}</p>
                    </div>
                    <div className="bg-red-900/20 border border-red-500/20 rounded-xl p-4">
                      <p className="text-xs text-white/40 mb-1">Reintegros registrados</p>
                      <p className="text-lg font-bold text-red-400">{fmt(reintegros)}</p>
                    </div>
                    <div className={`rounded-xl p-4 border ${saldo >= 0 ? "bg-emerald-900/20 border-emerald-500/30" : "bg-red-900/20 border-red-500/30"}`}>
                      <p className="text-xs text-white/40 mb-1">Aportes pendientes</p>
                      <p className={`text-lg font-bold ${saldo >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(saldo)}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Error */}
              {ownError && (
                <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  <AlertTriangle size={15} />
                  {ownError}
                  <button onClick={() => setOwnError(null)} className="ml-auto text-red-400/60 hover:text-red-400"><X size={14} /></button>
                </div>
              )}

              {/* Form */}
              <div className="bg-white/5 rounded-xl p-4">
                <p className="text-xs text-white/40 uppercase tracking-wider mb-3">{editingOwn ? "Editar movimiento" : "Nuevo movimiento"}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Tipo</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      value={editingOwn ? editingOwn.type : ownForm.type}
                      onChange={(e) => editingOwn ? setEditingOwn({ ...editingOwn, type: e.target.value }) : setOwnForm((f) => ({ ...f, type: e.target.value }))}
                    >
                      <option value="aporte">Aporte</option>
                      <option value="reintegro">Reintegro</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Fecha *</label>
                    <input
                      type="date"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      value={editingOwn ? editingOwn.date : ownForm.date}
                      onChange={(e) => editingOwn ? setEditingOwn({ ...editingOwn, date: e.target.value }) : setOwnForm((f) => ({ ...f, date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Importe *</label>
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      value={editingOwn ? editingOwn.amount : ownForm.amount}
                      onChange={(e) => editingOwn ? setEditingOwn({ ...editingOwn, amount: e.target.value }) : setOwnForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/40 mb-1 block">Medio de pago</label>
                    <select
                      className="w-full bg-[#111827] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      value={editingOwn ? editingOwn.paymentMethod : ownForm.paymentMethod}
                      onChange={(e) => editingOwn ? setEditingOwn({ ...editingOwn, paymentMethod: e.target.value }) : setOwnForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                    >
                      <option value="efectivo">Efectivo</option>
                      <option value="transferencia">Transferencia</option>
                    </select>
                  </div>
                  <div className="md:col-span-4">
                    <label className="text-xs text-white/40 mb-1 block">Notas</label>
                    <input
                      placeholder="Opcional"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                      value={editingOwn ? editingOwn.notes ?? "" : ownForm.notes}
                      onChange={(e) => editingOwn ? setEditingOwn({ ...editingOwn, notes: e.target.value }) : setOwnForm((f) => ({ ...f, notes: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="flex gap-2 mt-3 justify-end">
                  {editingOwn && (
                    <button onClick={() => setEditingOwn(null)} className="px-4 py-2 text-xs text-white/50 hover:text-white">Cancelar</button>
                  )}
                  <button
                    onClick={saveOwn}
                    disabled={!(editingOwn ? editingOwn.amount : ownForm.amount)}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-medium"
                  >
                    <Plus size={13} /> {editingOwn ? "Actualizar" : "Guardar"}
                  </button>
                </div>
              </div>

              {/* Tabla */}
              {ownMovements.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">No hay movimientos propios registrados.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-white/40 border-b border-white/10">
                        <th className="text-left py-2 pr-3">Tipo</th>
                        <th className="text-left py-2 pr-3">Fecha</th>
                        <th className="text-left py-2 pr-3">Medio</th>
                        <th className="text-left py-2 pr-3">Estado</th>
                        <th className="text-left py-2 pr-3">Notas</th>
                        <th className="text-right py-2 pr-3">Importe</th>
                        <th className="text-right py-2">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ownMovements.map((m: any) => (
                        <tr key={m.id} className={`border-b border-white/5 hover:bg-white/3 ${m.status === "anulado" ? "opacity-50" : ""}`}>
                          <td className="py-2 pr-3">
                            {m.type === "aporte"
                              ? <span className="bg-blue-900/40 text-blue-400 text-xs px-2 py-0.5 rounded-full">Aporte</span>
                              : <span className="bg-red-900/40 text-red-400 text-xs px-2 py-0.5 rounded-full">Reintegro</span>
                            }
                          </td>
                          <td className="py-2 pr-3 text-white/70">{m.date}</td>
                          <td className="py-2 pr-3 text-white/50 capitalize">{m.paymentMethod}</td>
                          <td className="py-2 pr-3">
                            {m.status === "anulado"
                              ? <span className="bg-red-900/40 text-red-400 text-xs px-2 py-0.5 rounded-full">Anulado</span>
                              : <span className="text-white/30 text-xs">Registrado</span>
                            }
                          </td>
                          <td className="py-2 pr-3 text-white/50">{m.notes || "—"}</td>
                          <td className="py-2 pr-3 text-right font-bold text-white">{fmt(m.amount)}</td>
                          <td className="py-2 text-right">
                            {m.status !== "anulado" && (
                              <div className="flex items-center gap-1 justify-end">
                                <button onClick={() => setEditingOwn({ ...m, notes: m.notes ?? "" })} className="p-1 text-white/30 hover:text-white rounded"><Pencil size={13} /></button>
                                <button onClick={() => anularOwn(m.id)} className="p-1 text-white/30 hover:text-red-400 rounded"><Trash2 size={13} /></button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>

        </div>
      </div>

      {/* ─── Modales ──────────────────────────────────────────────────────── */}
      {(modals.addEntry || modals.editEntry) && (
        <Modal
          title={modals.editEntry ? "Editar cobro" : "Nuevo cobro manual"}
          onClose={() => setModals((m) => ({ ...m, addEntry: false, editEntry: null }))}
        >
          <EntryForm
            initial={modals.editEntry}
            onSave={saveEntry}
            onClose={() => setModals((m) => ({ ...m, addEntry: false, editEntry: null }))}
          />
        </Modal>
      )}
      {(modals.addDebt || modals.editDebt) && (
        <Modal
          title={modals.editDebt ? "Editar adeudado" : "Nuevo adeudado"}
          onClose={() => setModals((m) => ({ ...m, addDebt: false, editDebt: null }))}
        >
          <DebtForm
            initial={modals.editDebt}
            onSave={saveDebt}
            onClose={() => setModals((m) => ({ ...m, addDebt: false, editDebt: null }))}
          />
        </Modal>
      )}
    </div>
    </AppLayout>
  );
}
