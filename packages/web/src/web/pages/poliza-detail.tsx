import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatCurrency, formatDate, daysUntil, POLICY_TYPES, STATUS_TYPES, COVERAGE_LABELS, cn, isSafeReturnTo } from "@/lib/utils";
import { Link, useParams } from "wouter";
import { ArrowLeft, Edit, Car, Home, ShieldCheck, Briefcase, FileText, Calendar, Building2, User, Bike, HeartPulse, Zap, Scale, HardHat, Flame, RefreshCw, Plus, Pencil, Trash2, ListOrdered, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { PolicyModal } from "@/components/policies/PolicyModal";
import { RebillingModal } from "@/components/policies/RebillingModal";
import { toast } from "sonner";
import { buildInstallmentPlan, InstallmentPlanError } from "../../lib/installments/plan";

const typeIcons: Record<string, any> = {
  automotor: Car, motovehiculo: Bike, ecomovilidad: Zap, hogar: Home, accidentes: ShieldCheck, art: HeartPulse, comercial: Briefcase, responsabilidad_civil: Scale, cascos: HardHat, incendio: Flame,
};

export default function PolizaDetail() {
  const params = useParams<{ id: string }>();
  const [row, setRow] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [showRebilling, setShowRebilling] = useState(false);
  const [editingRebilling, setEditingRebilling] = useState<any>(null);
  const [editingInstallment, setEditingInstallment] = useState<number | null>(null);
  const [instEdit, setInstEdit] = useState<Record<number, { dueDate: string; amount: number; notes: string; status: string }>>({});
  const [showGenForm, setShowGenForm] = useState(false);
  // Cantidad de cuotas e importe son siempre entradas explícitas — nunca se
  // infieren de billingCycle/vigencyPeriod. El período facturado (periodStart/
  // periodEnd) es el que realmente se está facturando, no necesariamente la
  // vigencia completa de la póliza.
  const [genForm, setGenForm] = useState<{
    rebillingId: string; periodStart: string; periodEnd: string;
    installmentCount: string; amount: string; firstDueDate: string;
  }>({ rebillingId: "", periodStart: "", periodEnd: "", installmentCount: "", amount: "", firstDueDate: "" });

  // Destino del botón "volver": el origen (p.ej. Reporte mensual con sus filtros)
  // si vino con un returnTo interno válido, o el listado general como fallback seguro.
  const [backHref] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("returnTo");
    return isSafeReturnTo(raw) ? raw : "/polizas";
  });

  const load = () => {
    setLoading(true);
    api.get(`/api/policies/${params.id}`).then(setRow).finally(() => setLoading(false));
  };
  useEffect(load, [params.id]);

  if (loading) return (
    <AppLayout>
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </AppLayout>
  );

  if (!row) return (
    <AppLayout>
      <div className="p-8 text-gray-400">No encontrada</div>
    </AppLayout>
  );

  const p = row.policy;
  const subPoliciesList: any[] = row.subPolicies ?? [];
  const rebillingsList: any[] = row.rebillings ?? [];
  const typeInfo = POLICY_TYPES[p.type];
  const statusInfo = STATUS_TYPES[p.status];
  const Icon = typeIcons[p.type] || FileText;
  const days = daysUntil(p.endDate);
  const hasRebilling = true; // todas las pólizas pueden tener refacturaciones

  // Compute next billing start date
  let nextStart = p.startDate;
  if (rebillingsList.length > 0) {
    const last = rebillingsList[0]; // desc order
    const d = new Date(last.billingEnd);
    d.setDate(d.getDate() + 1);
    nextStart = d.toISOString().split("T")[0];
  }

  // Active rebilling: the one whose period includes today
  const today = new Date().toISOString().split("T")[0];
  const activeRebilling = rebillingsList.find(r => r.billingStart <= today && r.billingEnd >= today);

  async function deleteRebilling(id: number) {
    if (!confirm("¿Eliminar esta refacturación y sus cuotas pendientes asociadas?")) return;
    try {
      const result = await api.delete(`/api/rebillings/${id}`);
      const n = result?.deleted?.installments ?? 0;
      toast.success(`Refacturación eliminada. Se eliminaron ${n} cuota${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"}.`);
      load();
    } catch (e: any) {
      const status = e?.status;
      if (status === 400) toast.error("Solicitud inválida.");
      else if (status === 404) toast.error("La refacturación ya no existe.");
      else if (status === 409) toast.error(e.message || "No se puede eliminar la refacturación.");
      else toast.error("No se pudo eliminar la refacturación.");
    }
  }

  return (
    <AppLayout>
      <div className="p-4 lg:p-8 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3 sm:gap-4 mb-6">
          <Link href={backHref}>
            <a className="p-2 text-gray-400 hover:text-white hover:bg-[#1f2937] rounded-lg transition-all flex-shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </a>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                {p.policyNumber}
              </h1>
              <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border", typeInfo?.color)}>
                <Icon className="w-3.5 h-3.5" />{typeInfo?.label}
              </span>
              <span className={cn("inline-flex px-2.5 py-1 rounded-md text-xs font-medium border", statusInfo?.color)}>
                {statusInfo?.label}
              </span>
              {/* Póliza original vs refacturación badge */}
              {hasRebilling && rebillingsList.length === 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border bg-blue-500/10 text-blue-400 border-blue-500/20">
                  <FileText className="w-3 h-3" /> Póliza original
                </span>
              )}
              {activeRebilling && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border bg-violet-500/10 text-violet-400 border-violet-500/20">
                  <RefreshCw className="w-3 h-3" /> Refacturación activa
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowEdit(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all flex-shrink-0"
          >
            <Edit className="w-4 h-4" /> <span className="hidden sm:inline">Editar</span>
          </button>
        </div>

        {/* Vencimiento alert */}
        {days >= 0 && days <= 30 && (
          <div className="mb-5 bg-amber-500/10 border border-amber-500/20 rounded-xl px-5 py-3 text-amber-400 text-sm">
            ⚠ Esta póliza vence {days === 0 ? "hoy" : `en ${days} días`} — {formatDate(p.endDate)}
          </div>
        )}
        {days < 0 && (
          <div className="mb-5 bg-red-500/10 border border-red-500/20 rounded-xl px-5 py-3 text-red-400 text-sm">
            Esta póliza venció hace {Math.abs(days)} días — {formatDate(p.endDate)}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Asegurado */}
          <InfoCard icon={User} title="Asegurado">
            <InfoRow label="Nombre" value={row.insured?.name} />
            <InfoRow label="DNI / CUIT" value={row.insured?.dni} />
            <InfoRow label="Teléfono" value={row.insured?.phone} />
            <InfoRow label="Email" value={row.insured?.email} />
            <InfoRow label="Dirección" value={row.insured?.address} />
          </InfoCard>

          {/* Compañía */}
          <InfoCard icon={Building2} title="Compañía Aseguradora">
            <InfoRow label="Nombre" value={row.company?.name} />
            <InfoRow label="CUIT" value={row.company?.cuit} />
            <InfoRow label="Teléfono" value={row.company?.phone} />
            <InfoRow label="Email" value={row.company?.email} />
          </InfoCard>

          {/* Vigencia y cobertura — valores base de la póliza original */}
          <InfoCard icon={Calendar} title="Póliza Original">
            <InfoRow label="Tipo de cobertura" value={p.coverageType ? (COVERAGE_LABELS[p.coverageType] || p.coverageType) : undefined} highlight />
            <InfoRow label="Cuota mensual" value={p.monthlyFee ? formatCurrency(p.monthlyFee) : undefined} mono highlight="green" />
            <InfoRow label="Prima / Monto total" value={p.premium ? formatCurrency(p.premium) : undefined} mono />
            <InfoRow label="Suma asegurada" value={p.sumInsured ? formatCurrency(p.sumInsured) : undefined} mono />
            <InfoRow label="Franquicia" value={p.deductible ? formatCurrency(p.deductible) : undefined} mono />
            <div className="border-t border-[#1f2937] my-2" />
            <InfoRow label="Período" value={
              p.vigencyPeriod === "semestral" ? "Semestral (6 meses)" :
              p.vigencyPeriod === "cuatrimestral" ? "Cuatrimestral (4 meses)" : "Anual"
            } />
            <InfoRow label="Vigencia desde" value={formatDate(p.startDate)} />
            <InfoRow label="Vigencia hasta" value={formatDate(p.endDate)} />
            <InfoRow label="Próxima refacturación" value={p.nextRebillingDate ? formatDate(p.nextRebillingDate) : undefined} />
            {hasRebilling && (
              <>
                <div className="border-t border-[#1f2937] my-2" />
                <InfoRow label="Ciclo refacturación" value={
                  p.billingCycle === "mensual" ? "Mensual" :
                  p.billingCycle === "trimestral" ? "Trimestral" :
                  p.billingCycle === "cuatrimestral" ? "Cuatrimestral" :
                  p.billingCycle === "semestral" ? "Semestral" :
                  p.billingCycle === "anual" ? "Anual" : undefined
                } />
              </>
            )}
            <InfoRow label="Tipo de pago" value={
              p.paymentMethod === "manual" ? "Manual" :
              p.paymentMethod === "cbu" ? "Débito en CBU" :
              p.paymentMethod === "tarjeta_credito" ? "Débito en Tarjeta de Crédito" : undefined
            } />
            <InfoRow label="Cant. cuotas" value={p.installments ? `${p.installments} cuotas` : undefined} />
          </InfoCard>

          {/* Datos específicos */}
          {p.type === "automotor" && (
            <InfoCard icon={Car} title="Vehículo">
              <InfoRow label="Marca" value={p.vehicleBrand} />
              <InfoRow label="Modelo" value={p.vehicleModel} />
              <InfoRow label="Año" value={p.vehicleYear ? String(p.vehicleYear) : undefined} />
              <InfoRow label="Patente" value={p.vehiclePlate} mono />
            </InfoCard>
          )}
          {p.type === "motovehiculo" && (
            <InfoCard icon={Bike} title="Motovehículo">
              <InfoRow label="Marca" value={p.motoBrand} />
              <InfoRow label="Modelo" value={p.motoModel} />
              <InfoRow label="Año" value={p.motoYear ? String(p.motoYear) : undefined} />
              <InfoRow label="Patente" value={p.motoPlate} mono />
              <InfoRow label="Motor / Cilindrada" value={p.motoEngine} />
            </InfoCard>
          )}
          {p.type === "hogar" && (
            <InfoCard icon={Home} title="Propiedad">
              <InfoRow label="Dirección" value={p.propertyAddress} />
            </InfoCard>
          )}
          {p.type === "comercial" && (
            <InfoCard icon={Briefcase} title="Datos del Riesgo">
              <InfoRow label="Razón Social" value={p.businessName} />
              <InfoRow label="Actividad" value={p.businessActivity} />
            </InfoCard>
          )}
        </div>

        {p.notes && (
          <div className="mt-5 bg-[#111827] border border-[#1f2937] rounded-xl p-5">
            <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Observaciones</p>
            <p className="text-gray-300 text-sm">{p.notes}</p>
          </div>
        )}

        {/* ─── Refacturaciones ──────────────────────────────────────────────── */}
        {/* ─── Cuotas ──────────────────────────────────────────────────────── */}
        {(() => {
          const installmentsList: any[] = row.installments ?? [];
          const STATUS_COLOR: Record<string, string> = {
            pendiente: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
            pagada: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
            vencida: "bg-red-500/20 text-red-400 border-red-500/30",
          };
          const STATUS_ICON: Record<string, any> = {
            pendiente: Clock, pagada: CheckCircle2, vencida: AlertCircle,
          };

          // Precarga el período desde la refacturación activa (si existe), o desde
          // la vigencia de la póliza. Cantidad de cuotas e importe quedan vacíos:
          // son siempre una entrada explícita, nunca un valor sugerido/automático.
          const openGenForm = () => {
            const source = activeRebilling ?? null;
            setGenForm({
              rebillingId: source ? String(source.id) : "",
              periodStart: source?.billingStart || p.startDate || "",
              periodEnd: source?.billingEnd || p.endDate || "",
              installmentCount: "",
              amount: source?.monthlyFee ? String(source.monthlyFee) : (p.monthlyFee ? String(p.monthlyFee) : ""),
              firstDueDate: "",
            });
            setShowGenForm(true);
          };

          // Única función de cálculo (buildInstallmentPlan): el período facturado
          // (periodStart/periodEnd) es el que se está facturando de verdad, no
          // necesariamente la vigencia completa de la póliza.
          const doGenerate = async () => {
            const count = Number(genForm.installmentCount);
            const fee = Number(genForm.amount);
            if (!genForm.periodStart || !genForm.periodEnd || !count || !fee) {
              toast.error("Completá período, cantidad de cuotas e importe.");
              return;
            }
            let plan;
            try {
              plan = buildInstallmentPlan({
                periodStart: genForm.periodStart,
                periodEnd: genForm.periodEnd,
                periodAmount: fee * count,
                installmentCount: count,
                firstDueDate: genForm.firstDueDate || undefined,
              });
            } catch (e: any) {
              toast.error(e instanceof InstallmentPlanError ? e.message : "Datos de período inválidos.");
              return;
            }
            for (const w of plan.warnings) toast.warning(w);
            try {
              // rebillingId sólo se usa localmente para precargar el período/importe
              // desde el desplegable — no viaja al backend (fuera de alcance de Etapa 2).
              await api.post(`/api/policies/${p.id}/installments/generate`, {
                installments: plan.installments,
              });
              toast.success("Cuotas generadas");
              setShowGenForm(false);
              load();
            } catch (e: any) {
              toast.error(e?.message || "Error al generar cuotas");
            }
          };

          return (
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-3">
                <ListOrdered className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Cuotas</h2>
                {installmentsList.length > 0 && (
                  <span className="text-xs text-gray-500 bg-[#1f2937] px-2 py-0.5 rounded-full">{installmentsList.length}</span>
                )}
                {installmentsList.length > 0 && (
                  <span className="text-xs text-gray-600 ml-2">
                    {installmentsList.filter((i: any) => i.status === "pagada").length} pagadas ·{" "}
                    {installmentsList.filter((i: any) => i.status === "pendiente").length} pendientes ·{" "}
                    {installmentsList.filter((i: any) => i.status === "vencida").length} vencidas
                  </span>
                )}
                {installmentsList.length === 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={openGenForm}
                      className="text-xs px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-all flex items-center gap-1.5"
                    >
                      <Plus className="w-3 h-3" /> Generar cuotas
                    </button>
                  </div>
                )}
              </div>

              {installmentsList.length > 0 && (
                <p className="text-xs text-gray-600 mb-3">
                  Esta póliza ya tiene cuotas cargadas — no se generan ni se borran automáticamente para no afectar
                  pagos y rendiciones existentes. Para agregar cuotas de una nueva refacturación, hacelo desde la
                  administración de cuotas.
                </p>
              )}

              {/* Formulario de generación: período facturado explícito, cantidad de cuotas explícita */}
              {showGenForm && (
                <div className="mb-3 bg-[#111827] border border-amber-500/20 rounded-xl p-4">
                  <p className="text-xs text-amber-400 font-medium mb-3">Período a facturar</p>
                  {rebillingsList.length > 0 && (
                    <div className="mb-3">
                      <label className="text-xs text-gray-500 block mb-1">Refacturación asociada</label>
                      <select
                        value={genForm.rebillingId}
                        onChange={e => {
                          const id = e.target.value;
                          const reb = rebillingsList.find((r: any) => String(r.id) === id);
                          setGenForm(f => ({
                            ...f,
                            rebillingId: id,
                            periodStart: reb?.billingStart ?? f.periodStart,
                            periodEnd: reb?.billingEnd ?? f.periodEnd,
                            amount: reb?.monthlyFee ? String(reb.monthlyFee) : f.amount,
                          }));
                        }}
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500"
                      >
                        <option value="">Cuotas base (sin refacturación)</option>
                        {rebillingsList.map((r: any) => (
                          <option key={r.id} value={r.id}>{formatDate(r.billingStart)} → {formatDate(r.billingEnd)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Período desde *</label>
                      <input type="date" value={genForm.periodStart} onChange={e => setGenForm(f => ({ ...f, periodStart: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Período hasta *</label>
                      <input type="date" value={genForm.periodEnd} onChange={e => setGenForm(f => ({ ...f, periodEnd: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Cantidad de cuotas *</label>
                      <input type="number" min="1" value={genForm.installmentCount}
                        onChange={e => setGenForm(f => ({ ...f, installmentCount: e.target.value }))}
                        placeholder="Ej: 3"
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">Importe por cuota (ARS) *</label>
                      <input type="number" value={genForm.amount} onChange={e => setGenForm(f => ({ ...f, amount: e.target.value }))}
                        placeholder="0.00"
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-gray-500 block mb-1">Fecha primera cuota (opcional)</label>
                      <input type="date" value={genForm.firstDueDate}
                        onChange={e => setGenForm(f => ({ ...f, firstDueDate: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                      <p className="text-[11px] text-gray-600 mt-1">
                        Si se deja vacío, se usa el inicio del período{genForm.periodStart ? ` (${formatDate(genForm.periodStart)})` : ""}.
                      </p>
                    </div>
                  </div>
                  {genForm.installmentCount && genForm.amount && (
                    <p className="text-xs text-gray-500 mb-3">
                      Total a facturar en el período: <span className="text-white font-medium">
                        {formatCurrency(Number(genForm.amount) * Number(genForm.installmentCount || 0))}
                      </span>
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button onClick={doGenerate}
                      className="text-xs px-3 py-1.5 bg-amber-500 text-black font-medium rounded-lg hover:bg-amber-400 transition-all"
                    >Generar</button>
                    <button onClick={() => setShowGenForm(false)}
                      className="text-xs px-3 py-1.5 bg-[#1f2937] text-gray-400 rounded-lg hover:bg-[#374151] transition-all"
                    >Cancelar</button>
                  </div>
                </div>
              )}

              {installmentsList.length === 0 ? (
                <div className="bg-[#111827] border border-[#1f2937] rounded-xl px-6 py-8 text-center">
                  <ListOrdered className="w-8 h-8 text-gray-600 mx-auto mb-3" />
                  <p className="text-sm text-gray-500 mb-1">No hay cuotas generadas</p>
                  <p className="text-xs text-gray-600">Hacé clic en "Generar cuotas" para crear el plan de pagos.</p>
                </div>
              ) : (
              <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-[#1f2937]">
                      <th className="text-left px-4 py-2.5 font-medium">#</th>
                      <th className="text-left px-3 py-2.5 font-medium">Vencimiento</th>
                      <th className="text-left px-3 py-2.5 font-medium">Importe</th>
                      <th className="text-left px-3 py-2.5 font-medium">Estado</th>
                      <th className="text-left px-3 py-2.5 font-medium">Nota</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {installmentsList.map((inst: any) => {
                      const StatusIcon = STATUS_ICON[inst.status] || Clock;
                      const isEditing = editingInstallment === inst.id;
                      const editData = instEdit[inst.id] || { dueDate: inst.dueDate, amount: inst.amount, notes: inst.notes || "", status: inst.status };
                      return (
                        <tr key={inst.id} className="border-b border-[#1f2937] last:border-0 hover:bg-[#1a2540]/20 transition-colors">
                          <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{inst.number}</td>
                          <td className="px-3 py-2.5">
                            {isEditing ? (
                              <input type="date" value={editData.dueDate}
                                onChange={e => setInstEdit(d => ({ ...d, [inst.id]: { ...editData, dueDate: e.target.value } }))}
                                className="px-2 py-1 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500 w-36" />
                            ) : (
                              <span className="text-gray-300 text-xs">{formatDate(inst.dueDate)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {isEditing ? (
                              <input type="number" value={editData.amount}
                                onChange={e => setInstEdit(d => ({ ...d, [inst.id]: { ...editData, amount: Number(e.target.value) } }))}
                                className="px-2 py-1 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500 w-28" />
                            ) : (
                              <span className="text-white font-mono font-medium">{formatCurrency(inst.amount)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {isEditing ? (
                              <select value={editData.status}
                                onChange={e => setInstEdit(d => ({ ...d, [inst.id]: { ...editData, status: e.target.value } }))}
                                className="px-2 py-1 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500">
                                <option value="pendiente">Pendiente</option>
                                <option value="pagada">Pagada</option>
                                <option value="vencida">Vencida</option>
                              </select>
                            ) : (
                              <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border", STATUS_COLOR[inst.status] || "text-gray-400 border-gray-500/30")}>
                                <StatusIcon className="w-3 h-3" />
                                {inst.status.charAt(0).toUpperCase() + inst.status.slice(1)}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {isEditing ? (
                              <input type="text" value={editData.notes}
                                onChange={e => setInstEdit(d => ({ ...d, [inst.id]: { ...editData, notes: e.target.value } }))}
                                placeholder="Nota..."
                                className="px-2 py-1 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500 w-full" />
                            ) : (
                              <span className="text-gray-500 text-xs">{inst.notes || "—"}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={async () => {
                                    try {
                                      await api.put(`/api/installments/${inst.id}`, editData);
                                      toast.success("Cuota actualizada");
                                      setEditingInstallment(null);
                                      load();
                                    } catch { toast.error("Error al guardar"); }
                                  }}
                                  className="text-xs px-2 py-1 bg-emerald-600/20 text-emerald-400 rounded hover:bg-emerald-600/30 transition-all"
                                >Guardar</button>
                                <button
                                  onClick={() => setEditingInstallment(null)}
                                  className="text-xs px-2 py-1 bg-[#1f2937] text-gray-400 rounded hover:bg-[#374151] transition-all"
                                >Cancelar</button>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setEditingInstallment(inst.id); setInstEdit(d => ({ ...d, [inst.id]: { dueDate: inst.dueDate, amount: inst.amount, notes: inst.notes || "", status: inst.status } })); }}
                                className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-all"
                                title="Editar"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          );
        })()}

        {hasRebilling && (
          <div className="mt-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                  Refacturaciones
                </h2>
                {rebillingsList.length > 0 && (
                  <span className="text-xs text-gray-500 bg-[#1f2937] px-2 py-0.5 rounded-full">{rebillingsList.length}</span>
                )}
              </div>
              <button
                onClick={() => { setEditingRebilling(null); setShowRebilling(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600/20 hover:bg-violet-600/30 text-violet-400 text-xs font-medium rounded-lg border border-violet-500/20 transition-all"
              >
                <Plus className="w-3.5 h-3.5" /> Nueva refacturación
              </button>
            </div>

            {rebillingsList.length === 0 ? (
              <div className="bg-[#111827] border border-[#1f2937] border-dashed rounded-xl px-5 py-8 text-center">
                <RefreshCw className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-500 text-sm">Sin refacturaciones todavía</p>
                <p className="text-gray-600 text-xs mt-1">La póliza tiene ciclo {p.billingCycle} — registrá la primera refacturación cuando corresponda</p>
              </div>
            ) : (
              <div className="space-y-2">
                {rebillingsList.map((r, idx) => {
                  const isActive = r.billingStart <= today && r.billingEnd >= today;
                  const isPast = r.billingEnd < today;
                  return (
                    <div key={r.id} className={cn(
                      "bg-[#111827] border rounded-xl px-5 py-4 flex items-start justify-between gap-4",
                      isActive ? "border-violet-500/30 bg-violet-500/5" : "border-[#1f2937]"
                    )}>
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5",
                          isActive ? "bg-violet-600/20 text-violet-400" :
                          isPast ? "bg-[#1f2937] text-gray-500" :
                          "bg-blue-600/20 text-blue-400"
                        )}>
                          {rebillingsList.length - idx}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-sm text-white font-medium">
                              {formatDate(r.billingStart)} → {formatDate(r.billingEnd)}
                            </span>
                            {isActive && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-500/20">activa</span>
                            )}
                            {isPast && !isActive && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-500 border border-gray-700">vencida</span>
                            )}
                            {!isPast && !isActive && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">próxima</span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap">
                            {r.monthlyFee && <span>Cuota: <span className="text-emerald-400 font-mono font-medium">{formatCurrency(r.monthlyFee)}</span></span>}
                            {r.premium && <span>Prima: <span className="text-gray-200 font-mono">{formatCurrency(r.premium)}</span></span>}
                            {r.sumInsured && <span>Suma: <span className="text-gray-200 font-mono">{formatCurrency(r.sumInsured)}</span></span>}
                          </div>
                          {r.notes && <p className="text-xs text-gray-500 mt-1 truncate">{r.notes}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => { setEditingRebilling(r); setShowRebilling(true); }}
                          className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all"
                          title="Editar"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteRebilling(r.id)}
                          className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                          title="Eliminar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subpólizas accesoria (ej: accidentes_pasajeros vinculadas) */}
      {subPoliciesList.length > 0 && (
        <div className="mt-6 bg-[#111827] border border-[#1f2937] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck className="w-4 h-4 text-amber-400" />
            <p className="text-sm font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
              Pólizas accesorias
              <span className="ml-2 text-xs text-gray-500 font-normal bg-[#1f2937] px-2 py-0.5 rounded-full">{subPoliciesList.length}</span>
            </p>
          </div>
          <div className="space-y-2">
            {subPoliciesList.map((sub: any) => {
              const sp = sub.policy;
              const spStatus = STATUS_TYPES[sp.status] ?? { label: sp.status, color: "text-gray-400" };
              return (
                <Link key={sp.id} href={`/polizas/${sp.id}`}>
                  <div className="flex items-center justify-between p-3 bg-[#0d1117] border border-[#1f2937] rounded-lg hover:border-amber-700 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <ShieldCheck className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm text-white font-medium">{sp.policyNumber}</p>
                        <p className="text-xs text-gray-500">{sp.type.replace(/_/g, " ")}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs font-medium ${spStatus.color}`}>{spStatus.label}</span>
                      <p className="text-xs text-gray-500 mt-0.5">{formatDate(sp.startDate)} – {formatDate(sp.endDate)}</p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {showEdit && (
        <PolicyModal
          initial={row}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); load(); }}
        />
      )}

      {showRebilling && (
        <RebillingModal
          policy={{ ...p, _nextStart: nextStart }}
          initial={editingRebilling}
          onClose={() => { setShowRebilling(false); setEditingRebilling(null); }}
          onSaved={() => { setShowRebilling(false); setEditingRebilling(null); load(); }}
        />
      )}
    </AppLayout>
  );
}

function InfoCard({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-blue-400" />
        <p className="text-sm font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{title}</p>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, mono, highlight }: { label: string; value?: string | null; mono?: boolean; highlight?: boolean | "green" }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-0.5">
      <span className="text-xs text-gray-500 flex-shrink-0">{label}</span>
      <span className={cn(
        "text-sm text-right",
        mono && "font-mono",
        highlight === "green" ? "text-emerald-400 font-semibold" :
        highlight ? "text-blue-300 font-medium" :
        "text-gray-200"
      )}>{value}</span>
    </div>
  );
}
