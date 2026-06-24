import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  Wallet,
  Plus,
  CheckCircle2,
  Circle,
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
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
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
          <p className="text-xs text-white/40 mb-1">En cartera</p>
          <p className="text-lg font-bold text-blue-400">{enCartera.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0 })}</p>
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

  const [summary, setSummary] = useState<any>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [debts, setDebts] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);

  const [sections, setSections] = useState({
    resumen: true,
    estadisticas: true,
    cobrados: true,
    cartera: false,
    adeudados: true,
    comisiones: true,
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
  const [filterRendered, setFilterRendered] = useState<"all" | "cartera" | "rendidos">("all");

  // ── Comisiones
  const [commissions, setCommissions] = useState<any[]>([]);
  const [commForm, setCommForm] = useState({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
  const [editingComm, setEditingComm] = useState<any>(null);

  // ── IVA
  const [ivaList, setIvaList] = useState<any[]>([]);
  const [ivaForm, setIvaForm] = useState({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
  const [editingIva, setEditingIva] = useState<any>(null);

  // ── Companies
  const [companiesList, setCompaniesList] = useState<any[]>([]);

  const loadAll = useCallback(async () => {
    const [s, e, p, d, st, comm, iva, comp] = await Promise.all([
      api.get(`/api/cash/summary?month=${periodoMes}`),
      api.get("/api/cash/entries"),
      api.get("/api/cash/payments"),
      api.get("/api/cash/debts"),
      api.get("/api/cash/stats"),
      api.get("/api/cash/commissions"),
      api.get("/api/cash/iva"),
      api.get("/api/companies"),
    ]);
    setSummary(s);
    setEntries(Array.isArray(e) ? e : []);
    setPayments(Array.isArray(p) ? p : []);
    setDebts(Array.isArray(d) ? d : []);
    setStats(Array.isArray(st) ? st : []);
    setCommissions(Array.isArray(comm) ? comm : []);
    setIvaList(Array.isArray(iva) ? iva : []);
    setCompaniesList(Array.isArray(comp) ? comp : []);
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

  async function toggleEntryRender(entry: any) {
    await api.patch(`/api/cash/entries/${entry.id}/render`, { rendered: !entry.rendered });
    loadAll();
  }

  async function togglePaymentRender(p: any) {
    await api.patch(`/api/cash/payments/${p.id}/render`, { rendered: !p.rendered });
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
    const data = { ...commForm, amount: parseFloat(commForm.amount), companyId: commForm.companyId ? parseInt(commForm.companyId) : null };
    if (!data.amount || isNaN(data.amount)) return;
    if (editingComm) {
      await api.put(`/api/cash/commissions/${editingComm.id}`, data);
      setEditingComm(null);
    } else {
      await api.post("/api/cash/commissions", data);
    }
    setCommForm({ companyId: "", date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
    loadAll();
  }
  async function deleteComm(id: number) {
    if (!confirm("¿Eliminar esta comisión?")) return;
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

  if (!user || user.role !== "admin") return <AppLayout><div /></AppLayout>;

  // ─── filtered lists
  const filteredEntries = entries.filter((e) => {
    if (filterRendered === "cartera") return !e.rendered;
    if (filterRendered === "rendidos") return e.rendered;
    return true;
  });

  const filteredPayments = payments.filter((p) => {
    if (filterRendered === "cartera") return !p.rendered;
    if (filterRendered === "rendidos") return p.rendered;
    return true;
  });

  const cobradosSource = tab === "manual" ? filteredEntries : filteredPayments;

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
                {/* Diferencia de caja — temporalmente oculto.
                    Mezcla cartera + adeudados + gastos históricos en un solo número;
                    se reemplazará con un indicador de dinero propio en etapa posterior. */}
                {/* <div className={`rounded-xl p-5 mb-5 flex items-center justify-between ${summary.diferencia >= 0 ? "bg-green-900/30 border border-green-500/30" : "bg-red-900/30 border border-red-500/30"}`}>
                  <div>
                    <p className="text-xs text-white/50 mb-1">Diferencia de caja</p>
                    <p className={`text-3xl font-bold ${summary.diferencia >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {fmt(summary.diferencia)}
                    </p>
                    <p className="text-xs text-white/40 mt-1">En cartera − Adeudados</p>
                  </div>
                  <AlertCircle size={36} className={summary.diferencia >= 0 ? "text-green-500/40" : "text-red-500/40"} />
                </div> */}

                {/* Tarjetas detalle */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Total cobrado</p>
                    <p className="text-lg font-bold text-white">{fmt(summary.totalCobrado)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Rendido</p>
                    <p className="text-lg font-bold text-orange-400">{fmt(summary.totalRendido)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-xs text-white/40 mb-1">Pendiente de rendir</p>
                    <p className="text-lg font-bold text-blue-400">{fmt(summary.cajaNeta.total)}</p>
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

          {/* ─── Cobrados ──────────────────────────────────────────────────── */}
          <Section
            title="Cobrados"
            badge={summary ? (tab === "manual" ? entries.length : payments.length) : undefined}
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
              {/* Tab + filtro */}
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
                <div className="flex bg-white/5 rounded-lg p-0.5 text-xs ml-auto">
                  {(["all", "cartera", "rendidos"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilterRendered(f)}
                      className={`px-3 py-1.5 rounded-md transition-colors ${filterRendered === f ? "bg-white/10 text-white" : "text-white/40 hover:text-white"}`}
                    >
                      {f === "all" ? "Todos" : f === "cartera" ? "En cartera" : "Rendidos"}
                    </button>
                  ))}
                </div>
              </div>

              {cobradosSource.length === 0 ? (
                <div className="text-center py-8 text-white/30 text-sm">
                  {tab === "manual" ? "No hay cobros manuales cargados." : "No hay cobros desde Cobranzas."}
                </div>
              ) : (
                <div className="space-y-2">
                  {cobradosSource.map((item: any) => (
                    <div
                      key={item.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${item.rendered ? "bg-white/3 border-white/5 opacity-60" : "bg-white/5 border-white/10"}`}
                    >
                      {/* Render toggle */}
                      <button
                        title={item.rendered ? "Quitar rendición" : "Marcar rendido"}
                        onClick={() => tab === "manual" ? toggleEntryRender(item) : togglePaymentRender(item)}
                        className="shrink-0"
                      >
                        {item.rendered ? (
                          <CheckCircle2 size={18} className="text-orange-400" />
                        ) : (
                          <Circle size={18} className="text-white/30 hover:text-orange-400" />
                        )}
                      </button>

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
                          {item.rendered && <span className="text-xs text-orange-400/70">Rendido</span>}
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
            badge={commissions.length || undefined}
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
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                        <th className="text-left py-2 pr-4">Fecha</th>
                        <th className="text-left py-2 pr-4">Compañía</th>
                        <th className="text-left py-2 pr-4">Notas</th>
                        <th className="text-right py-2 pr-4">Importe</th>
                        <th className="text-right py-2">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commissions.map((c: any) => (
                        <tr key={c.id} className="border-b border-white/5 hover:bg-white/3">
                          <td className="py-2 pr-4 text-white/70">{c.date}</td>
                          <td className="py-2 pr-4 text-white/70">{c.companyName || "—"}</td>
                          <td className="py-2 pr-4 text-white/50">{c.notes || "—"}</td>
                          <td className="py-2 pr-4 text-right font-bold text-emerald-400">{fmt(c.amount)}</td>
                          <td className="py-2 text-right">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => setEditingComm({ ...c, companyId: c.companyId ?? "" })} className="p-1 text-white/30 hover:text-white rounded"><Pencil size={13} /></button>
                              <button onClick={() => deleteComm(c.id)} className="p-1 text-white/30 hover:text-red-400 rounded"><Trash2 size={13} /></button>
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
          <Section
            title="Adeudados por asegurados"
            badge={debts.filter((d) => d.status === "pendiente").length || undefined}
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
              {debts.length === 0 ? (
                <div className="text-center py-8 text-white/30 text-sm">No hay adeudados registrados.</div>
              ) : (
                <div className="space-y-2">
                  {debts.map((debt: any) => (
                    <div
                      key={debt.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${debt.status === "cobrado" ? "bg-white/3 border-white/5 opacity-60" : "bg-red-900/10 border-red-500/20"}`}
                    >
                      <button
                        title={debt.status === "cobrado" ? "Marcar pendiente" : "Marcar cobrado"}
                        onClick={() => markDebtCobrado(debt)}
                        className="shrink-0"
                      >
                        {debt.status === "cobrado" ? (
                          <CheckCircle2 size={18} className="text-green-400" />
                        ) : (
                          <Circle size={18} className="text-red-400/60 hover:text-green-400" />
                        )}
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white truncate">{debt.clientName}</span>
                          {debt.policyNumber && (
                            <span className="text-xs text-white/30">#{debt.policyNumber}</span>
                          )}
                          {debt.companyName && (
                            <span className="text-xs text-white/30">· {debt.companyName}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {debt.dueDate && <span className="text-xs text-white/40">Venc: {debt.dueDate}</span>}
                          {debt.notes && <span className="text-xs text-white/30">{debt.notes}</span>}
                          {debt.status === "cobrado" && (
                            <span className="text-xs text-green-400/70">Cobrado</span>
                          )}
                        </div>
                      </div>

                      <span className="text-sm font-bold text-red-400 shrink-0">{fmt(debt.amount)}</span>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => setModals((m) => ({ ...m, editDebt: debt }))}
                          className="p-1.5 text-white/30 hover:text-white rounded"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => deleteDebt(debt.id)}
                          className="p-1.5 text-white/30 hover:text-red-400 rounded"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
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
