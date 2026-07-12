import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatCurrency, formatDate, daysUntil, POLICY_TYPES, STATUS_TYPES, COVERAGE_LABELS, cn, isSafeReturnTo } from "@/lib/utils";
import { Link, useParams } from "wouter";
import { ArrowLeft, Edit, Car, Home, ShieldCheck, Briefcase, FileText, Calendar, Building2, User, Bike, HeartPulse, Zap, Scale, HardHat, Flame, RefreshCw, Plus, Pencil, Trash2, ListOrdered, CheckCircle2, Clock, AlertCircle, Loader2, X, Ban } from "lucide-react";
import { PolicyModal } from "@/components/policies/PolicyModal";
import { RebillingModal } from "@/components/policies/RebillingModal";
import { toast } from "sonner";
import { buildInstallmentPlan, InstallmentPlanError } from "../../lib/installments/plan";
import {
  compareExpectedVsActual, EXPECTED_VS_ACTUAL_LABELS, shouldShowRebuildButton,
  decideRebuildUiAction, buildRebuildRequestBody, summarizeRebuildPlan,
  normalizeRebuildError, canConfirmRebuild,
  type RebuildBlockingInstallment,
} from "@/lib/installments-rebuild";
import { parseRebillingPayload, buildRebillingInstallmentPlan, RebillingPayloadError } from "../../lib/installments/rebilling-plan";
import {
  shouldShowCancelButton, canConfirmCancellation,
  normalizeCancellationError, shouldRefreshAfterCancelResponse, NON_COLLECTIBLE_STATUS_LABEL,
  type CancellationFormInput, type CancellationPreviewSummary,
} from "@/lib/policy-cancellation";
import { groupInstallmentsByRebilling, countLinkedInstallments } from "@/lib/rebilling-groups";

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

  // ─── Subetapa 2B: reconstrucción segura de un plan de cuotas existente ──────
  const [rebuildCheck, setRebuildCheck] = useState<{
    classification: "NO_INSTALLMENTS" | "SAFE_TO_REBUILD" | "REQUIRES_MANUAL_REVIEW";
    expectedCount: number | null;
    actualCount: number;
    mismatched: boolean;
    blockingInstallments: RebuildBlockingInstallment[];
  } | null>(null);
  const [rebuildCheckLoading, setRebuildCheckLoading] = useState(false);
  const [showRebuildBlocked, setShowRebuildBlocked] = useState(false);
  const [showRebuildForm, setShowRebuildForm] = useState(false);
  const [rebuildForm, setRebuildForm] = useState<{
    rebillingId: string; periodStart: string; periodEnd: string;
    periodAmount: string; installmentCount: string; firstDueDate: string; installmentIntervalMonths: string;
  }>({ rebillingId: "", periodStart: "", periodEnd: "", periodAmount: "", installmentCount: "", firstDueDate: "", installmentIntervalMonths: "" });
  const [rebuildConfirmed, setRebuildConfirmed] = useState(false);
  const [rebuildSubmitting, setRebuildSubmitting] = useState(false);

  // ─── Corregir plan de cuotas de UNA refacturación puntual — acción
  // separada de "Editar datos de la refacturación" (RebillingModal). Usa
  // GET/POST /rebillings/:id/installments/rebuild-check|rebuild, nunca PUT
  // /rebillings/:id. Mismo patrón que el rebuild a nivel póliza de arriba,
  // pero acotado a un solo rebillingId — nunca toca la emisión original ni
  // otra refacturación.
  const [rebillingRebuildTarget, setRebillingRebuildTarget] = useState<any>(null);
  const [rebillingRebuildCheck, setRebillingRebuildCheck] = useState<{
    classification: "NO_INSTALLMENTS" | "SAFE_TO_REBUILD" | "REQUIRES_MANUAL_REVIEW";
    currentCount: number; currentTotal: number;
    blockingInstallments: RebuildBlockingInstallment[];
  } | null>(null);
  const [rebillingRebuildCheckLoading, setRebillingRebuildCheckLoading] = useState(false);
  const [showRebillingRebuildBlocked, setShowRebillingRebuildBlocked] = useState(false);
  const [showRebillingRebuildForm, setShowRebillingRebuildForm] = useState(false);
  const [rebillingRebuildForm, setRebillingRebuildForm] = useState<{
    billingStart: string; billingEnd: string; monthlyFee: string; installmentCount: string;
    firstDueDate: string; premium: string; sumInsured: string; deductible: string; notes: string;
  }>({ billingStart: "", billingEnd: "", monthlyFee: "", installmentCount: "", firstDueDate: "", premium: "", sumInsured: "", deductible: "", notes: "" });
  const [rebillingRebuildConfirmed, setRebillingRebuildConfirmed] = useState(false);
  const [rebillingRebuildSubmitting, setRebillingRebuildSubmitting] = useState(false);

  // ─── Anulación manual de póliza ─────────────────────────────────────────────
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelForm, setCancelForm] = useState<CancellationFormInput>({ effectiveDate: "", reason: "", notes: "" });
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [cancelPreview, setCancelPreview] = useState<CancellationPreviewSummary | null>(null);
  const [cancelPreviewLoading, setCancelPreviewLoading] = useState(false);
  const [cancelPreviewError, setCancelPreviewError] = useState<string | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

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

  // Preview de la anulación: se recalcula cada vez que cambia la fecha
  // efectiva mientras el modal está abierto. No escribe nada — solo informa
  // (POST /policies/:id/cancel/preview). El motivo/observaciones no afectan
  // la clasificación de cuotas, así que no disparan un nuevo pedido.
  useEffect(() => {
    if (!showCancelForm || !cancelForm.effectiveDate) {
      setCancelPreview(null);
      setCancelPreviewError(null);
      return;
    }
    let cancelled = false;
    setCancelPreviewLoading(true);
    setCancelPreviewError(null);
    api.post(`/api/policies/${params.id}/cancel/preview`, { effectiveDate: cancelForm.effectiveDate })
      .then((result) => { if (!cancelled) setCancelPreview(result); })
      .catch((e: any) => {
        if (cancelled) return;
        setCancelPreview(null);
        setCancelPreviewError(e?.body?.error || e?.message || "No se pudo calcular la previsualización.");
      })
      .finally(() => { if (!cancelled) setCancelPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [showCancelForm, cancelForm.effectiveDate, params.id]);

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

  // Consulta (o reutiliza) rebuild-check de UNA refacturación al pulsar
  // "Corregir plan de cuotas" — no se dispara automáticamente al cargar la
  // página. reb puede venir de rebillingsList (fila de la lista) o de un
  // group.rebillingId (banner "sin plan" en la sección de Cuotas).
  async function openRebillingRebuildReview(reb: any) {
    setRebillingRebuildTarget(reb);
    setRebillingRebuildCheckLoading(true);
    try {
      const result = await api.get(`/api/rebillings/${reb.id}/installments/rebuild-check`);
      setRebillingRebuildCheck(result);
      if (decideRebuildUiAction(result.classification) === "show_blocked") {
        setShowRebillingRebuildBlocked(true);
        setShowRebillingRebuildForm(false);
      } else {
        setShowRebillingRebuildBlocked(false);
        openRebillingRebuildForm(reb);
      }
    } catch {
      toast.error("No se pudo consultar el estado del plan de esta refacturación.");
    } finally {
      setRebillingRebuildCheckLoading(false);
    }
  }

  // Precarga con los datos actuales de la refacturación — nunca se infiere
  // nada nuevo, es la misma metadata que ya tiene guardada.
  function openRebillingRebuildForm(reb: any) {
    setRebillingRebuildForm({
      billingStart: reb.billingStart ?? "",
      billingEnd: reb.billingEnd ?? "",
      monthlyFee: reb.monthlyFee != null ? String(reb.monthlyFee) : "",
      installmentCount: reb.installmentCount != null ? String(reb.installmentCount) : "",
      firstDueDate: reb.firstDueDate ?? reb.billingStart ?? "",
      premium: reb.premium != null ? String(reb.premium) : "",
      sumInsured: reb.sumInsured != null ? String(reb.sumInsured) : "",
      deductible: reb.deductible != null ? String(reb.deductible) : "",
      notes: reb.notes ?? "",
    });
    setRebillingRebuildConfirmed(false);
    setShowRebillingRebuildForm(true);
  }

  // Previsualización local — solo para mensajes y resumen inmediatos. La
  // validación definitiva es siempre del backend (reclasifica de nuevo dentro
  // de la transacción antes de borrar).
  let rebillingRebuildPreviewPlan: ReturnType<typeof buildRebillingInstallmentPlan> | null = null;
  let rebillingRebuildPreviewError: string | null = null;
  if (showRebillingRebuildForm && rebillingRebuildForm.billingStart && rebillingRebuildForm.billingEnd
      && rebillingRebuildForm.monthlyFee && rebillingRebuildForm.installmentCount && rebillingRebuildForm.firstDueDate) {
    try {
      const payload = parseRebillingPayload({
        billingStart: rebillingRebuildForm.billingStart,
        billingEnd: rebillingRebuildForm.billingEnd,
        monthlyFee: rebillingRebuildForm.monthlyFee,
        installmentCount: rebillingRebuildForm.installmentCount,
        firstDueDate: rebillingRebuildForm.firstDueDate,
        premium: rebillingRebuildForm.premium || null,
        sumInsured: rebillingRebuildForm.sumInsured || null,
        deductible: rebillingRebuildForm.deductible || null,
        notes: rebillingRebuildForm.notes || null,
      });
      rebillingRebuildPreviewPlan = buildRebillingInstallmentPlan(payload);
    } catch (e: any) {
      rebillingRebuildPreviewError = e instanceof RebillingPayloadError || e instanceof InstallmentPlanError ? e.message : "Datos del plan inválidos.";
    }
  }
  const canConfirmRebillingRebuild = canConfirmRebuild(!!rebillingRebuildPreviewPlan && !rebillingRebuildPreviewError, rebillingRebuildConfirmed);

  async function doRebillingRebuild() {
    if (!rebillingRebuildTarget || !rebillingRebuildPreviewPlan || rebillingRebuildPreviewError) return;
    setRebillingRebuildSubmitting(true);
    try {
      const body = {
        billingStart: rebillingRebuildForm.billingStart,
        billingEnd: rebillingRebuildForm.billingEnd,
        monthlyFee: Number(rebillingRebuildForm.monthlyFee),
        installmentCount: Number(rebillingRebuildForm.installmentCount),
        firstDueDate: rebillingRebuildForm.firstDueDate,
        premium: rebillingRebuildForm.premium !== "" ? Number(rebillingRebuildForm.premium) : null,
        sumInsured: rebillingRebuildForm.sumInsured !== "" ? Number(rebillingRebuildForm.sumInsured) : null,
        deductible: rebillingRebuildForm.deductible !== "" ? Number(rebillingRebuildForm.deductible) : null,
        notes: rebillingRebuildForm.notes || null,
      };
      const result = await api.post(`/api/rebillings/${rebillingRebuildTarget.id}/installments/rebuild`, body);
      toast.success(`Plan de cuotas corregido (${result.previousCount} → ${result.insertedCount} cuotas).`);
      setShowRebillingRebuildForm(false);
      setRebillingRebuildCheck(null);
      setRebillingRebuildTarget(null);
      load();
    } catch (e: any) {
      const normalized = normalizeRebuildError(e);
      if (normalized.kind === "blocked") {
        setRebillingRebuildCheck(rc => rc ? { ...rc, classification: "REQUIRES_MANUAL_REVIEW", blockingInstallments: normalized.blockingInstallments } : rc);
        setShowRebillingRebuildForm(false);
        setShowRebillingRebuildBlocked(true);
      }
      toast.error(normalized.message);
    } finally {
      setRebillingRebuildSubmitting(false);
    }
  }

  const hasValidCancelPreview = !!cancelPreview && !cancelPreviewError;
  const canConfirmCancel = canConfirmCancellation(cancelForm, hasValidCancelPreview, cancelConfirmed);

  async function doCancelPolicy() {
    if (!canConfirmCancel) return;
    setCancelSubmitting(true);
    try {
      const res = await api.post(`/api/policies/${p.id}/cancel`, {
        effectiveDate: cancelForm.effectiveDate,
        reason: cancelForm.reason.trim(),
        notes: cancelForm.notes.trim() || undefined,
      });
      toast.success(`Póliza anulada. ${res.installments.markedNonCollectible} cuota${res.installments.markedNonCollectible === 1 ? "" : "s"} dejaron de ser exigibles.`);
      setShowCancelForm(false);
      if (shouldRefreshAfterCancelResponse(200)) load();
    } catch (e: any) {
      const normalized = normalizeCancellationError(e);
      toast.error(normalized.message);
    } finally {
      setCancelSubmitting(false);
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
          <div className="flex items-center gap-2 flex-shrink-0">
            {shouldShowCancelButton(p.status) && (
              <button
                onClick={() => { setCancelForm({ effectiveDate: "", reason: "", notes: "" }); setCancelConfirmed(false); setCancelPreview(null); setCancelPreviewError(null); setShowCancelForm(true); }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/20 text-sm rounded-lg font-medium transition-all"
              >
                <Ban className="w-4 h-4" /> <span className="hidden sm:inline">Anular póliza</span>
              </button>
            )}
            <button
              onClick={() => setShowEdit(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all"
            >
              <Edit className="w-4 h-4" /> <span className="hidden sm:inline">Editar</span>
            </button>
          </div>
        </div>

        {/* Datos de la anulación, si la póliza está cancelada */}
        {p.status === "cancelada" && (
          <div className="mb-5 bg-gray-500/5 border border-gray-500/20 rounded-xl px-5 py-4 text-sm space-y-1">
            <p className="text-gray-300 font-medium flex items-center gap-2"><Ban className="w-4 h-4 text-gray-400" /> Póliza anulada</p>
            {p.cancellationEffectiveDate && (
              <p className="text-xs text-gray-500">Fecha efectiva: <span className="text-gray-300">{formatDate(p.cancellationEffectiveDate)}</span></p>
            )}
            {p.cancellationReason && (
              <p className="text-xs text-gray-500">Motivo: <span className="text-gray-300">{p.cancellationReason}</span></p>
            )}
            {p.cancellationNotes && (
              <p className="text-xs text-gray-500">Observaciones: <span className="text-gray-300">{p.cancellationNotes}</span></p>
            )}
            {row.cancelledByName && (
              <p className="text-xs text-gray-500">Anulada por: <span className="text-gray-300">{row.cancelledByName}</span></p>
            )}
          </div>
        )}

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
            // La póliza fue anulada con effectiveDate <= dueDate de esta cuota
            // (ver POST /policies/:id/cancel) — visualmente distinto de
            // pagada/vencida, nunca se confirma un pago sobre esta cuota.
            no_exigible: "bg-gray-500/20 text-gray-400 border-gray-500/30",
          };
          const STATUS_ICON: Record<string, any> = {
            pendiente: Clock, pagada: CheckCircle2, vencida: AlertCircle, no_exigible: Ban,
          };
          const STATUS_LABEL: Record<string, string> = { no_exigible: NON_COLLECTIBLE_STATUS_LABEL };

          // Cuotas esperadas (policies.installments) vs. reales (installmentsList).
          // null nunca es "no coincide" — no hay nada contra qué comparar (misma
          // regla que classifyInstallmentsForRebuild en el backend).
          const expectedCount: number | null = p.installments ?? null;
          const comparison = compareExpectedVsActual(expectedCount, installmentsList.length);

          // Esta reconstrucción (Subetapa 2B, /policies/:id/installments/rebuild)
          // es EXCLUSIVA de la emisión original: classifyInstallmentsForRebuild
          // (rebuild.ts) bloquea la póliza entera apenas UNA cuota tenga
          // rebillingId no nulo, sin importar si esa cuota está sana o no — no
          // hay forma de que tenga éxito si existe alguna refacturación con
          // cuotas vinculadas. Mostrar el botón en ese caso solo invita a
          // confundirlo con "Corregir plan de cuotas" de la refacturación
          // puntual (lista de Refacturaciones, más abajo) — que sí es la acción
          // correcta ahí. Se oculta acá, nunca se toca la clasificación del
          // backend.
          const hasAnyRebillingLinkedInstallment = installmentsList.some((i: any) => i.rebillingId !== null);
          const showRebuildButton = shouldShowRebuildButton(installmentsList.length, comparison) && !hasAnyRebillingLinkedInstallment;

          // Consulta (o reutiliza) rebuild-check al pulsar "Corregir plan de
          // cuotas" — no se dispara automáticamente al cargar la página, para
          // evitar una llamada de red innecesaria en pólizas que nadie va a tocar.
          const openRebuildReview = async () => {
            setRebuildCheckLoading(true);
            try {
              const result = await api.get(`/api/policies/${p.id}/installments/rebuild-check`);
              setRebuildCheck(result);
              if (decideRebuildUiAction(result.classification) === "show_blocked") {
                setShowRebuildBlocked(true);
                setShowRebuildForm(false);
              } else {
                setShowRebuildBlocked(false);
                openRebuildForm();
              }
            } catch {
              toast.error("No se pudo consultar el estado del plan de cuotas.");
            } finally {
              setRebuildCheckLoading(false);
            }
          };

          // Precarga segura: período/importe desde la refacturación activa (o la
          // seleccionada en el desplegable) si existe; si no, desde la póliza como
          // sugerencia editable. installmentCount viene de policies.installments
          // si está definido — nunca se infiere de la vigencia ni del período.
          const openRebuildForm = () => {
            const source = activeRebilling ?? null;
            setRebuildForm({
              rebillingId: source ? String(source.id) : "",
              periodStart: source?.billingStart || p.startDate || "",
              periodEnd: source?.billingEnd || p.endDate || "",
              periodAmount: source?.premium ? String(source.premium) : (p.premium ? String(p.premium) : ""),
              installmentCount: p.installments != null ? String(p.installments) : "",
              firstDueDate: "",
              installmentIntervalMonths: "",
            });
            setRebuildConfirmed(false);
            setShowRebuildForm(true);
          };

          // Previsualización local (buildInstallmentPlan) — solo para mensajes y
          // resumen inmediatos. La validación definitiva es siempre del backend
          // (reclasifica de nuevo dentro de la transacción antes de borrar).
          let rebuildPreviewPlan: ReturnType<typeof buildInstallmentPlan> | null = null;
          let rebuildPreviewError: string | null = null;
          if (showRebuildForm && rebuildForm.periodStart && rebuildForm.periodEnd && rebuildForm.periodAmount && rebuildForm.installmentCount) {
            try {
              rebuildPreviewPlan = buildInstallmentPlan({
                periodStart: rebuildForm.periodStart,
                periodEnd: rebuildForm.periodEnd,
                periodAmount: Number(rebuildForm.periodAmount),
                installmentCount: Number(rebuildForm.installmentCount),
                firstDueDate: rebuildForm.firstDueDate || undefined,
                installmentIntervalMonths: rebuildForm.installmentIntervalMonths ? Number(rebuildForm.installmentIntervalMonths) : undefined,
              });
            } catch (e: any) {
              rebuildPreviewError = e instanceof InstallmentPlanError ? e.message : "Datos de período inválidos.";
            }
          }
          const canConfirm = canConfirmRebuild(!!rebuildPreviewPlan && !rebuildPreviewError, rebuildConfirmed);

          const doRebuild = async () => {
            if (!rebuildPreviewPlan || rebuildPreviewError) return;
            setRebuildSubmitting(true);
            try {
              const body = buildRebuildRequestBody(rebuildForm);
              const result = await api.post(`/api/policies/${p.id}/installments/rebuild`, body);
              toast.success(`Plan de cuotas corregido correctamente (${result.previousCount} → ${result.insertedCount} cuotas).`);
              // No hace falta mostrar todo esto en la UI, pero queda disponible
              // para inspección (previousExpectedCount / newExpectedCount incluidos).
              console.info("[rebuild] resultado:", result);
              setShowRebuildForm(false);
              setRebuildCheck(null);
              load();
              api.get(`/api/policies/${p.id}/installments/rebuild-check`).then(setRebuildCheck).catch(() => {});
            } catch (e: any) {
              const normalized = normalizeRebuildError(e);
              if (normalized.kind === "blocked") {
                // No se modifica la lista de cuotas local como si hubiera éxito —
                // solo se muestra el motivo del bloqueo, tal como lo informa el backend.
                setRebuildCheck(rc => rc ? { ...rc, classification: "REQUIRES_MANUAL_REVIEW", blockingInstallments: normalized.blockingInstallments } : rc);
                setShowRebuildForm(false);
                setShowRebuildBlocked(true);
              }
              toast.error(normalized.message);
            } finally {
              setRebuildSubmitting(false);
            }
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
                {(installmentsList.length === 0 || showRebuildButton) && (
                  <div className="ml-auto flex items-center gap-2">
                    {installmentsList.length === 0 && (
                      <button
                        onClick={openGenForm}
                        className="text-xs px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-all flex items-center gap-1.5"
                      >
                        <Plus className="w-3 h-3" /> Generar cuotas
                      </button>
                    )}
                    {showRebuildButton && (
                      <button
                        onClick={openRebuildReview}
                        disabled={rebuildCheckLoading}
                        className="text-xs px-3 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 disabled:opacity-50 transition-all flex items-center gap-1.5"
                      >
                        {rebuildCheckLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Corregir plan de cuotas (emisión original)
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Esperado vs. real — nunca considera expectedCount null como mismatch */}
              <div className="mb-3 flex items-center gap-2 text-xs flex-wrap">
                <span className="text-gray-500">Cuotas esperadas: <span className="text-gray-300">{expectedCount ?? "Sin definir"}</span></span>
                <span className="text-gray-700">·</span>
                <span className="text-gray-500">Cuotas reales: <span className="text-gray-300">{installmentsList.length}</span></span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full border",
                  comparison.status === "no_coincide" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                  comparison.status === "coincide" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                  "bg-gray-500/10 text-gray-500 border-gray-700"
                )}>
                  {comparison.status === "no_coincide" && "⚠ "}{EXPECTED_VS_ACTUAL_LABELS[comparison.status]}
                </span>
              </div>

              {/* Revisión bloqueada: cuotas con actividad — no se modificó nada */}
              {showRebuildBlocked && rebuildCheck?.classification === "REQUIRES_MANUAL_REVIEW" && (
                <div className="mb-3 bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <p className="text-sm text-red-400 font-medium">No se puede reconstruir automáticamente</p>
                  </div>
                  <p className="text-xs text-gray-400 mb-3">
                    No se modificó ninguna cuota. Estas cuotas tienen actividad registrada y requieren revisión manual
                    antes de poder reconstruir el plan:
                  </p>
                  <div className="space-y-2">
                    {rebuildCheck.blockingInstallments.map(b => (
                      <div key={b.id} className="bg-[#111827] border border-red-500/10 rounded-lg px-3 py-2">
                        <p className="text-xs text-white font-medium">Cuota #{b.number} — vence {formatDate(b.dueDate)}</p>
                        <ul className="mt-1 space-y-0.5">
                          {b.reasons.map((r, i) => (
                            <li key={i} className="text-xs text-gray-400">· {r}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setShowRebuildBlocked(false)} className="mt-3 text-xs text-gray-500 hover:text-white transition-colors">
                    Cerrar
                  </button>
                </div>
              )}

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
              ) : (() => {
                // Emisión original + un grupo por cada refacturación, cada uno
                // con su propia numeración 1..N (ver src/web/lib/rebilling-groups.ts).
                // Nunca se oculta ni se reemplaza un grupo anterior.
                const groups = groupInstallmentsByRebilling(installmentsList, rebillingsList);
                return (
                <div className="space-y-4">
                  {groups.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{group.label}</h3>
                        <span className="text-xs text-gray-600">{group.installments.length} cuota{group.installments.length === 1 ? "" : "s"}</span>
                        {group.deductible != null && (
                          <span className="text-xs text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-full px-2 py-0.5">
                            Franquicia: {formatCurrency(group.deductible)}
                          </span>
                        )}
                      </div>
                      {group.installments.length === 0 ? (
                        <div className="bg-[#111827] border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300 flex items-center justify-between gap-3 flex-wrap">
                          <span>Esta refacturación no tiene un plan de cuotas vinculado.</span>
                          {group.rebillingId != null && (
                            <button
                              onClick={() => {
                                const reb = rebillingsList.find((r: any) => r.id === group.rebillingId);
                                if (reb) openRebillingRebuildReview(reb);
                              }}
                              className="text-xs px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 rounded-lg border border-amber-500/30 transition-all whitespace-nowrap"
                            >
                              Crear / corregir plan
                            </button>
                          )}
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
                            {group.installments.map((inst: any) => {
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
                                        {STATUS_LABEL[inst.status] || (inst.status.charAt(0).toUpperCase() + inst.status.slice(1))}
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
                  ))}
                </div>
                );
              })()}

              {/* Corregir plan de cuotas — modal separado del de "Generar cuotas":
                  usa exclusivamente POST /installments/rebuild, nunca el endpoint
                  normal de generación. */}
              {showRebuildForm && (
                <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
                  <div className="bg-[#111827] border border-blue-500/30 rounded-2xl w-full max-w-lg my-4">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
                      <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                        Corregir plan de cuotas (emisión original)
                      </h2>
                      <button onClick={() => setShowRebuildForm(false)} className="text-gray-400 hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="p-6 space-y-4">
                      <p className="text-xs text-gray-500">
                        Esta acción reemplaza el plan de cuotas completo de esta póliza. Usala cuando la cantidad o el
                        calendario de cuotas quedó desactualizado — no para generar cuotas de una póliza nueva (eso se
                        hace con "Generar cuotas").
                      </p>

                      {rebillingsList.length > 0 && (
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Refacturación asociada</label>
                          <select
                            value={rebuildForm.rebillingId}
                            onChange={e => {
                              const id = e.target.value;
                              const reb = rebillingsList.find((r: any) => String(r.id) === id);
                              setRebuildForm(f => ({
                                ...f,
                                rebillingId: id,
                                periodStart: reb?.billingStart ?? f.periodStart,
                                periodEnd: reb?.billingEnd ?? f.periodEnd,
                                periodAmount: reb?.premium ? String(reb.premium) : f.periodAmount,
                              }));
                            }}
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500"
                          >
                            <option value="">Cuotas base (sin refacturación)</option>
                            {rebillingsList.map((r: any) => (
                              <option key={r.id} value={r.id}>{formatDate(r.billingStart)} → {formatDate(r.billingEnd)}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Inicio del período *</label>
                          <input type="date" value={rebuildForm.periodStart}
                            onChange={e => setRebuildForm(f => ({ ...f, periodStart: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Fin del período *</label>
                          <input type="date" value={rebuildForm.periodEnd}
                            onChange={e => setRebuildForm(f => ({ ...f, periodEnd: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Importe total del período (ARS) *</label>
                          <input type="number" value={rebuildForm.periodAmount}
                            onChange={e => setRebuildForm(f => ({ ...f, periodAmount: e.target.value }))}
                            placeholder="0.00"
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Cantidad de cuotas *</label>
                          <input type="number" min="1" value={rebuildForm.installmentCount}
                            onChange={e => setRebuildForm(f => ({ ...f, installmentCount: e.target.value }))}
                            placeholder="Ej: 12"
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Primera cuota (opcional)</label>
                          <input type="date" value={rebuildForm.firstDueDate}
                            onChange={e => setRebuildForm(f => ({ ...f, firstDueDate: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Intervalo en meses (opcional, default 1)</label>
                          <input type="number" min="1" value={rebuildForm.installmentIntervalMonths}
                            onChange={e => setRebuildForm(f => ({ ...f, installmentIntervalMonths: e.target.value }))}
                            placeholder="1"
                            className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-blue-500" />
                        </div>
                      </div>

                      {rebuildPreviewError && (
                        <p className="text-xs text-red-400">{rebuildPreviewError}</p>
                      )}

                      {rebuildPreviewPlan && !rebuildPreviewError && (() => {
                        const summary = summarizeRebuildPlan(installmentsList.length, rebuildPreviewPlan, rebuildForm.periodStart, rebuildForm.periodEnd);
                        return (
                          <div className="bg-[#0d1424] border border-blue-500/20 rounded-xl p-4 space-y-1.5 text-xs">
                            <p className="text-blue-400 font-medium mb-1">Resumen de la reconstrucción</p>
                            <p className="text-gray-400">Cuotas actuales que serán reemplazadas: <span className="text-white">{summary.previousCount}</span></p>
                            <p className="text-gray-400">Cuotas nuevas: <span className="text-white">{summary.newCount}</span></p>
                            <p className="text-gray-400">Importe total: <span className="text-white">{formatCurrency(summary.totalAmount)}</span></p>
                            <p className="text-gray-400">Período: <span className="text-white">{formatDate(summary.periodStart)} → {formatDate(summary.periodEnd)}</span></p>
                            <p className="text-gray-400">
                              Primera cuota: <span className="text-white">{formatDate(summary.firstDueDate)}</span> ·
                              {" "}Última cuota: <span className="text-white">{formatDate(summary.lastDueDate)}</span>
                            </p>
                          </div>
                        );
                      })()}

                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
                        <p className="text-xs text-amber-400/90">
                          Esta acción reemplazará únicamente las cuotas pendientes y sin actividad que el sistema
                          verificó como seguras. No se puede deshacer automáticamente.
                        </p>
                      </div>

                      <label className="flex items-start gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={rebuildConfirmed}
                          onChange={e => setRebuildConfirmed(e.target.checked)}
                          className="mt-0.5" />
                        <span className="text-xs text-gray-300">Confirmo que revisé el nuevo plan de cuotas</span>
                      </label>

                      <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={() => setShowRebuildForm(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={!canConfirm || rebuildSubmitting}
                          onClick={doRebuild}
                          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
                        >
                          {rebuildSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                          Confirmar reconstrucción
                        </button>
                      </div>
                    </div>
                  </div>
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
                  // Grupo REAL por rebilling_id — nunca installmentCount (metadata,
                  // puede ser null aun con cuotas vinculadas, o viceversa en datos
                  // históricos). Se calcula acá porque installmentsList (la
                  // variable equivalente de la sección "Cuotas") vive en un scope
                  // aparte que no se renderiza cuando la póliza tiene 0 cuotas en
                  // total — este banner debe verse igual en ese caso.
                  const linkedInstallmentsCount = countLinkedInstallments((row.installments ?? []) as any[], r.id);
                  return (
                    <div key={r.id} className={cn(
                      "bg-[#111827] border rounded-xl px-5 py-4 flex flex-col gap-3",
                      isActive ? "border-violet-500/30 bg-violet-500/5" : "border-[#1f2937]"
                    )}>
                    <div className="flex items-start justify-between gap-4">
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
                          title="Editar datos"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => openRebillingRebuildReview(r)}
                          disabled={rebillingRebuildCheckLoading && rebillingRebuildTarget?.id === r.id}
                          className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-all disabled:opacity-40"
                          title="Corregir plan de cuotas"
                        >
                          {rebillingRebuildCheckLoading && rebillingRebuildTarget?.id === r.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <ListOrdered className="w-3.5 h-3.5" />}
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

                    {linkedInstallmentsCount === 0 && (
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-xs text-amber-300">Esta refacturación no tiene un plan de cuotas vinculado.</span>
                        <button
                          onClick={() => openRebillingRebuildReview(r)}
                          disabled={rebillingRebuildCheckLoading && rebillingRebuildTarget?.id === r.id}
                          className="text-xs px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 rounded-lg border border-amber-500/30 transition-all disabled:opacity-50 whitespace-nowrap flex items-center gap-1.5"
                        >
                          {rebillingRebuildCheckLoading && rebillingRebuildTarget?.id === r.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          Crear / corregir plan
                        </button>
                      </div>
                    )}
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

      {/* Corregir plan de cuotas — bloqueado: la refacturación tiene cuotas
          con actividad real. No se modificó nada; se muestra el motivo
          exacto por cuota. Acción completamente separada de "Editar datos". */}
      {showRebillingRebuildBlocked && rebillingRebuildCheck?.classification === "REQUIRES_MANUAL_REVIEW" && (
        <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-[#111827] border border-red-500/30 rounded-2xl w-full max-w-lg my-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                No se puede corregir el plan
              </h2>
              <button
                onClick={() => { setShowRebillingRebuildBlocked(false); setRebillingRebuildTarget(null); }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <p className="text-sm text-red-400 font-medium">Esta refacturación tiene actividad real registrada</p>
              </div>
              <p className="text-xs text-gray-400 mb-3">
                No se modificó ninguna cuota. Estas cuotas requieren revisión manual antes de poder corregir el plan:
              </p>
              <div className="space-y-2">
                {rebillingRebuildCheck.blockingInstallments.map(b => (
                  <div key={b.id} className="bg-[#0d1424] border border-red-500/10 rounded-lg px-3 py-2">
                    <p className="text-xs text-white font-medium">Cuota #{b.number} — vence {formatDate(b.dueDate)}</p>
                    <ul className="mt-1 space-y-0.5">
                      {b.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-gray-400">· {r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <button
                onClick={() => { setShowRebillingRebuildBlocked(false); setRebillingRebuildTarget(null); }}
                className="mt-4 text-xs text-gray-500 hover:text-white transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Corregir plan de cuotas — formulario: plan actual vs. propuesto,
          confirmación explícita obligatoria. Usa exclusivamente
          POST /rebillings/:id/installments/rebuild — nunca PUT. */}
      {showRebillingRebuildForm && rebillingRebuildTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-[#111827] border border-amber-500/30 rounded-2xl w-full max-w-lg my-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                Corregir plan de cuotas
              </h2>
              <button onClick={() => setShowRebillingRebuildForm(false)} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-gray-500">
                Esta acción reemplaza ÚNICAMENTE el grupo de cuotas de esta refacturación puntual
                ({formatDate(rebillingRebuildTarget.billingStart)} → {formatDate(rebillingRebuildTarget.billingEnd)}).
                No toca la emisión original ni ninguna otra refacturación.
              </p>

              {rebillingRebuildCheck && (
                <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4 text-xs space-y-1">
                  <p className="text-gray-400 font-medium mb-1">Plan actual</p>
                  <p className="text-gray-400">Cuotas: <span className="text-white">{rebillingRebuildCheck.currentCount}</span></p>
                  <p className="text-gray-400">Importe total: <span className="text-white">{formatCurrency(rebillingRebuildCheck.currentTotal)}</span></p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Inicio período *</label>
                  <input type="date" value={rebillingRebuildForm.billingStart}
                    onChange={e => setRebillingRebuildForm(f => ({ ...f, billingStart: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Fin período *</label>
                  <input type="date" value={rebillingRebuildForm.billingEnd}
                    onChange={e => setRebillingRebuildForm(f => ({ ...f, billingEnd: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Cantidad de cuotas *</label>
                  <input type="number" min="1" value={rebillingRebuildForm.installmentCount}
                    onChange={e => setRebillingRebuildForm(f => ({ ...f, installmentCount: e.target.value }))}
                    placeholder="Ej: 3"
                    className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Primer vencimiento *</label>
                  <input type="date" value={rebillingRebuildForm.firstDueDate}
                    onChange={e => setRebillingRebuildForm(f => ({ ...f, firstDueDate: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 block mb-1">Cuota mensual (ARS) *</label>
                  <input type="number" value={rebillingRebuildForm.monthlyFee}
                    onChange={e => setRebillingRebuildForm(f => ({ ...f, monthlyFee: e.target.value }))}
                    placeholder="0"
                    className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500" />
                </div>
              </div>

              {rebillingRebuildPreviewError && (
                <p className="text-xs text-red-400">{rebillingRebuildPreviewError}</p>
              )}

              {rebillingRebuildPreviewPlan && !rebillingRebuildPreviewError && (
                <div className="bg-[#0d1424] border border-amber-500/20 rounded-xl p-4 space-y-1.5 text-xs">
                  <p className="text-amber-400 font-medium mb-1">Plan propuesto</p>
                  <p className="text-gray-400">Cantidad de cuotas: <span className="text-white">{rebillingRebuildPreviewPlan.installments.length}</span></p>
                  <p className="text-gray-400">Importe total: <span className="text-white">{formatCurrency(rebillingRebuildPreviewPlan.totalAmount)}</span></p>
                  <p className="text-gray-400">
                    Primera cuota: <span className="text-white">{formatDate(rebillingRebuildPreviewPlan.installments[0]?.dueDate ?? "")}</span> ·
                    {" "}Última cuota: <span className="text-white">{formatDate(rebillingRebuildPreviewPlan.installments[rebillingRebuildPreviewPlan.installments.length - 1]?.dueDate ?? "")}</span>
                  </p>
                </div>
              )}

              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
                <p className="text-xs text-amber-400/90">
                  Se reemplazará únicamente el grupo de cuotas de ESTA refacturación. No se puede deshacer automáticamente.
                </p>
              </div>

              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={rebillingRebuildConfirmed}
                  onChange={e => setRebillingRebuildConfirmed(e.target.checked)}
                  className="mt-0.5" />
                <span className="text-xs text-gray-300">Confirmo que revisé el nuevo plan de cuotas de esta refacturación</span>
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowRebillingRebuildForm(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!canConfirmRebillingRebuild || rebillingRebuildSubmitting}
                  onClick={doRebillingRebuild}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
                >
                  {rebillingRebuildSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Confirmar corrección
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Anular póliza — mismo patrón visual que "Corregir plan de cuotas":
          resumen server-side (preview, nunca escribe nada) + advertencia +
          checkbox de confirmación obligatorio. */}
      {showCancelForm && (
        <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-[#111827] border border-red-500/30 rounded-2xl w-full max-w-lg my-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                Anular póliza
              </h2>
              <button onClick={() => setShowCancelForm(false)} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-xs text-gray-500">
                La póliza no se elimina — conserva todo su historial. Las cuotas pagadas, rendidas y la deuda
                anterior a la fecha efectiva no se modifican. Las cuotas posteriores a esa fecha dejan de ser exigibles.
              </p>

              <div>
                <label className="text-xs text-gray-500 block mb-1">Fecha efectiva de anulación *</label>
                <input type="date" value={cancelForm.effectiveDate}
                  onChange={e => setCancelForm(f => ({ ...f, effectiveDate: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-red-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Motivo *</label>
                <input type="text" value={cancelForm.reason}
                  onChange={e => setCancelForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="Ej: venta del vehículo"
                  className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-red-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Observaciones (opcional)</label>
                <textarea value={cancelForm.notes}
                  onChange={e => setCancelForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-red-500" />
              </div>

              {cancelPreviewLoading && (
                <p className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Calculando previsualización…</p>
              )}

              {cancelPreviewError && !cancelPreviewLoading && (
                <p className="text-xs text-red-400">{cancelPreviewError}</p>
              )}

              {cancelPreview && !cancelPreviewError && !cancelPreviewLoading && (
                <div className="bg-[#0d1424] border border-red-500/20 rounded-xl p-4 space-y-1.5 text-xs">
                  <p className="text-red-400 font-medium mb-1">Resumen de la anulación</p>
                  <p className="text-gray-400">Cuotas pagadas (no cambian): <span className="text-white">{cancelPreview.installments.paidUnchanged}</span></p>
                  <p className="text-gray-400">Cuotas rendidas (no cambian): <span className="text-white">{cancelPreview.installments.renderedUnchanged}</span></p>
                  <p className="text-gray-400">Deuda anterior que se conserva exigible: <span className="text-white">{cancelPreview.installments.priorDebtUnchanged}</span></p>
                  <p className="text-gray-400">Cuotas que pasarán a "No exigible": <span className="text-white">{cancelPreview.installments.markedNonCollectible}</span></p>
                  <p className="text-gray-400">Pagos pendientes de rendir (no se ven afectados): <span className="text-white">{cancelPreview.pendingPaymentsToRender}</span></p>
                </div>
              )}

              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3">
                <p className="text-xs text-amber-400/90">
                  Esta acción no tiene rehabilitación automática todavía. Las cuotas futuras marcadas "No exigible"
                  dejan de poder cobrarse hasta que se revise el caso manualmente.
                </p>
              </div>

              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={cancelConfirmed}
                  onChange={e => setCancelConfirmed(e.target.checked)}
                  className="mt-0.5" />
                <span className="text-xs text-gray-300">
                  Confirmo que deseo anular esta póliza y que las cuotas futuras dejarán de ser exigibles.
                </span>
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCancelForm(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!canConfirmCancel || cancelSubmitting}
                  onClick={doCancelPolicy}
                  className="px-5 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
                >
                  {cancelSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Confirmar anulación
                </button>
              </div>
            </div>
          </div>
        </div>
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
