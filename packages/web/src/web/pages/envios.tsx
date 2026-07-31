import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Send, Plus, Search, X, Check, Trash2, Edit2, ExternalLink, AlertCircle,
  MessageCircle, Mail, Copy, Building, ChevronDown, Package, Clock,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import {
  validateLinkedDeliveryForm, buildLinkedDeliveryPayload,
  validateManualDeliveryForm, buildManualDeliveryPayload,
  buildDeliveryEditPayload,
  getAvailableDeliveryTransition, shouldExecuteDeliveryTransition,
  DELIVERY_TRANSITION_ENDPOINT, DELIVERY_TRANSITION_COPY,
  normalizeDeliveryError,
  getDeliveryRowDisplay,
  isChannelPending, DELIVERY_CHANNEL_PENDING_LABEL,
  parseDeliveriesFilters, buildDeliveriesPath,
  DELIVERY_CHANNELS, DELIVERY_DOCUMENT_TYPES,
  type DeliveryTransitionKind, type PolicyDetailForLinkedForm,
} from "@/lib/deliveries-form";

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
// pendiente/enviado/entregado son el flujo vigente (migración 0031).
// "realizado" es el valor legacy — se muestra distinto y nunca ofrece avanzar.
const STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente", enviado: "Enviado", entregado: "Entregado", realizado: "Realizado (legacy)",
};
const STATUS_COLORS: Record<string, string> = {
  pendiente: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  enviado: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  entregado: "bg-green-500/20 text-green-400 border-green-500/30",
  realizado: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

interface DeliveryRow {
  delivery: {
    id: number;
    policyId: number | null;
    rebillingId: number | null;
    manualRecipient: string | null;
    manualPolicyNumber: string | null;
    manualCompany: string | null;
    documentType: string;
    channel: string;
    status: string;
    scheduledDate: string | null;
    sentDate: string | null;
    completedDate: string | null;
    notes: string | null;
  };
  policy: { id: number; policyNumber: string } | null;
  insured: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
  rebilling: { id: number; billingStart: string; billingEnd: string } | null;
}

interface PolicyOption {
  policy: { id: number; policyNumber: string };
  insured: { name: string } | null;
}

// Badge de canal — único punto de la UI que decide entre mostrar el canal
// real o "Datos por completar". El valor interno (DELIVERY_CHANNEL_PENDING)
// nunca se imprime tal cual: una vez que isChannelPending es false, channel
// es garantizado uno de los 4 reales (whitelisteados en deliveries-form.ts),
// así que no hace falta ningún fallback al texto crudo.
function ChannelBadge({ channel, className }: { channel: string; className?: string }) {
  if (isChannelPending(channel)) {
    return (
      <span className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border bg-amber-500/20 text-amber-400 border-amber-500/30", className)}>
        <AlertCircle className="w-3 h-3" /> {DELIVERY_CHANNEL_PENDING_LABEL}
      </span>
    );
  }
  const Icon = CHANNEL_ICONS[channel];
  return (
    <span className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border", CHANNEL_COLORS[channel], className)}>
      <Icon className="w-3 h-3" /> {CHANNEL_LABELS[channel]}
    </span>
  );
}

function DeliveryModal({ open, onClose, onSaved, editing }: {
  open: boolean; onClose: () => void; onSaved: () => void; editing: DeliveryRow | null;
}) {
  const [policies, setPolicies] = useState<PolicyOption[]>([]);
  const [policySearch, setPolicySearch] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualMode, setManualMode] = useState(false);

  // Modo vinculado — selección de póliza real + detalle (asegurado, compañía,
  // n° de póliza y sus refacturaciones) para mostrar "sin retipeo" y poblar
  // el desplegable de refacturación puntual. Alta completa desde /envios —
  // sin relación con el alta rápida desde la póliza (POST /deliveries/quick-add).
  const [selectedPolicyId, setSelectedPolicyId] = useState("");
  const [policyDetail, setPolicyDetail] = useState<PolicyDetailForLinkedForm | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [documentType, setDocumentType] = useState<"poliza" | "refacturacion">("poliza");
  const [rebillingId, setRebillingId] = useState("");

  const [manualRecipient, setManualRecipient] = useState("");
  const [manualPolicyNumber, setManualPolicyNumber] = useState("");
  const [manualCompany, setManualCompany] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [scheduledDate, setScheduledDate] = useState("");
  const [notes, setNotes] = useState("");

  // "Completar datos" — mismo modal de edición, pero con el título/acción
  // adaptados cuando el canal todavía es el sentinel (alta rápida sin
  // completar). El selector de canal, más abajo, arranca sin ningún botón
  // marcado en ese caso: "whatsapp"/etc. nunca calzan contra el valor
  // guardado (DELIVERY_CHANNEL_PENDING), así que ninguno queda seleccionado
  // hasta que el usuario elija uno real.
  const isCompletingPendingData = !!editing && isChannelPending(editing.delivery.channel);

  async function loadPolicyDetail(policyId: number) {
    setLoadingDetail(true);
    try {
      const detail = await api.get(`/api/policies/${policyId}`);
      setPolicyDetail(detail);
    } catch {
      setPolicyDetail(null);
      setSelectedPolicyId("");
      toast.error("No se pudo cargar la póliza indicada. Buscá la póliza manualmente.");
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    api.get("/api/policies").then(setPolicies).catch(() => {});

    if (editing) {
      const isManual = editing.delivery.policyId == null;
      setManualMode(isManual);
      setSelectedPolicyId(editing.delivery.policyId ? String(editing.delivery.policyId) : "");
      setPolicyDetail(null);
      setDocumentType(editing.delivery.documentType as "poliza" | "refacturacion");
      setRebillingId(editing.delivery.rebillingId ? String(editing.delivery.rebillingId) : "");
      setManualRecipient(editing.delivery.manualRecipient || "");
      setManualPolicyNumber(editing.delivery.manualPolicyNumber || "");
      setManualCompany(editing.delivery.manualCompany || "");
      // Si el canal todavía es el sentinel, se deja el selector sin marcar
      // (channel="" no calza contra ningún botón real) — nunca se muestra
      // "sin_definir" preseleccionado como si fuera una elección válida.
      setChannel(isChannelPending(editing.delivery.channel) ? "" : editing.delivery.channel);
      setScheduledDate(editing.delivery.scheduledDate || "");
      setNotes(editing.delivery.notes || "");
      return;
    }

    setManualMode(false);
    setSelectedPolicyId(""); setPolicyDetail(null);
    setDocumentType("poliza"); setRebillingId("");
    setManualRecipient(""); setManualPolicyNumber(""); setManualCompany("");
    setChannel("whatsapp"); setScheduledDate(""); setNotes("");
  }, [open, editing]);

  const filteredPolicies = policies.filter(p =>
    p.policy.policyNumber.toLowerCase().includes(policySearch.toLowerCase()) ||
    (p.insured?.name || "").toLowerCase().includes(policySearch.toLowerCase())
  );
  const selectedPolicyOption = policies.find(p => String(p.policy.id) === selectedPolicyId);
  const selectedRebilling = policyDetail?.rebillings.find(r => String(r.id) === rebillingId) || null;

  function selectPolicy(id: number) {
    setSelectedPolicyId(String(id));
    setRebillingId("");
    setPolicyDetail(null);
    loadPolicyDetail(id);
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (editing) {
        if (isChannelPending(channel)) {
          toast.error("Seleccioná un canal de envío.");
          setSaving(false);
          return;
        }
        const payload = buildDeliveryEditPayload({
          isManual: manualMode, channel, scheduledDate, notes,
          manualRecipient, manualPolicyNumber, manualCompany,
        });
        await api.put(`/api/deliveries/${editing.delivery.id}`, payload);
        toast.success(isCompletingPendingData ? "Datos completados" : "Envío actualizado");
      } else if (manualMode) {
        const form = {
          manualRecipient, manualPolicyNumber, manualCompany,
          documentType, channel: channel as any, scheduledDate, notes,
        };
        const error = validateManualDeliveryForm(form);
        if (error) { toast.error(error); setSaving(false); return; }
        await api.post("/api/deliveries", buildManualDeliveryPayload(form));
        toast.success("Envío registrado");
      } else {
        if (!selectedPolicyId) { toast.error("Seleccioná una póliza o usá registro manual"); setSaving(false); return; }
        const form = {
          policyId: Number(selectedPolicyId), documentType,
          rebillingId: documentType === "refacturacion" && rebillingId ? Number(rebillingId) : null,
          channel: channel as any, scheduledDate, notes,
        };
        const error = validateLinkedDeliveryForm(form);
        if (error) { toast.error(error); setSaving(false); return; }
        await api.post("/api/deliveries", buildLinkedDeliveryPayload(form));
        toast.success("Envío registrado");
      }
      onSaved(); onClose();
    } catch (e: any) {
      toast.error(normalizeDeliveryError(e).message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0d1424] border border-[#1f2937] rounded-2xl shadow-2xl z-10 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <h2 className="text-white font-semibold text-lg">
            {editing ? (isCompletingPendingData ? "Completar datos" : "Editar envío") : "Registrar envío"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">

          {editing ? (
            /* ─── Edición / Completar datos: vínculo/documento SIEMPRE de solo lectura ─── */
            <div className="space-y-3 p-3 bg-[#0a0f1e] border border-[#2d3748] rounded-lg">
              <p className="text-xs text-gray-500">
                El vínculo (póliza / refacturación) no se puede modificar desde acá.
              </p>
              <div className="text-sm text-white space-y-1">
                <p><span className="text-gray-500">Documento:</span> {DOC_LABELS[editing.delivery.documentType] || editing.delivery.documentType}</p>
                {manualMode ? (
                  <>
                    <p><span className="text-gray-500">Destinatario:</span> {editing.delivery.manualRecipient || "—"}</p>
                    <p><span className="text-gray-500">N° póliza:</span> {editing.delivery.manualPolicyNumber || "—"}</p>
                    <p><span className="text-gray-500">Compañía:</span> {editing.delivery.manualCompany || "—"}</p>
                  </>
                ) : (
                  <>
                    <p><span className="text-gray-500">Asegurado:</span> {editing.insured?.name || "—"}</p>
                    <p><span className="text-gray-500">Compañía:</span> {editing.company?.name || "—"}</p>
                    <p><span className="text-gray-500">N° póliza:</span> {editing.policy?.policyNumber || "—"}</p>
                    {editing.rebilling && (
                      <p><span className="text-gray-500">Período:</span> {formatDate(editing.rebilling.billingStart)} → {formatDate(editing.rebilling.billingEnd)}</p>
                    )}
                  </>
                )}
              </div>
              {manualMode && (
                <div className="space-y-3 pt-2 border-t border-[#1f2937]">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Destinatario</label>
                    <input type="text" value={manualRecipient} onChange={e => setManualRecipient(e.target.value)}
                      className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">N° de póliza</label>
                      <input type="text" value={manualPolicyNumber} onChange={e => setManualPolicyNumber(e.target.value)}
                        className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Compañía</label>
                      <input type="text" value={manualCompany} onChange={e => setManualCompany(e.target.value)}
                        className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Toggle manual/póliza — solo en alta */}
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
                <>
                  {/* Póliza selector */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Póliza</label>
                    <div className="relative">
                      <button type="button" onClick={() => setPolicyOpen(!policyOpen)}
                        className="w-full flex items-center justify-between px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-left">
                        <span className={selectedPolicyOption ? "text-white" : "text-gray-500"}>
                          {selectedPolicyOption
                            ? `${selectedPolicyOption.policy.policyNumber} — ${selectedPolicyOption.insured?.name}`
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
                              onClick={() => { selectPolicy(p.policy.id); setPolicyOpen(false); setPolicySearch(""); }}
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

                  {selectedPolicyId && (
                    <div className="p-3 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm space-y-1">
                      {loadingDetail ? (
                        <p className="text-gray-500 text-xs">Cargando datos de la póliza...</p>
                      ) : policyDetail ? (
                        <>
                          <p className="text-white"><span className="text-gray-500">Asegurado:</span> {policyDetail.insured?.name || "—"}</p>
                          <p className="text-white"><span className="text-gray-500">Compañía:</span> {policyDetail.company?.name || "—"}</p>
                          <p className="text-white"><span className="text-gray-500">N° póliza:</span> {policyDetail.policy.policyNumber}</p>
                          {documentType === "refacturacion" && selectedRebilling && (
                            <p className="text-white"><span className="text-gray-500">Período:</span> {formatDate(selectedRebilling.billingStart)} → {formatDate(selectedRebilling.billingEnd)}</p>
                          )}
                        </>
                      ) : null}
                    </div>
                  )}

                  {/* Tipo documento */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Tipo de documento</label>
                    <div className="grid grid-cols-2 gap-2">
                      {DELIVERY_DOCUMENT_TYPES.map((key) => (
                        <button key={key} type="button" onClick={() => { setDocumentType(key); if (key === "poliza") setRebillingId(""); }}
                          className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                            documentType === key
                              ? "border-blue-500/50 bg-blue-500/20 text-blue-300"
                              : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                          {DOC_LABELS[key]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {documentType === "refacturacion" && (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Refacturación puntual</label>
                      <select value={rebillingId} onChange={e => setRebillingId(e.target.value)}
                        className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500">
                        <option value="">Seleccionar refacturación...</option>
                        {(policyDetail?.rebillings || []).map(r => (
                          <option key={r.id} value={r.id}>{formatDate(r.billingStart)} → {formatDate(r.billingEnd)}</option>
                        ))}
                      </select>
                      {policyDetail && policyDetail.rebillings.length === 0 && (
                        <p className="text-xs text-amber-400 mt-1">Esta póliza no tiene refacturaciones registradas.</p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                /* Campos manuales */
                <div className="space-y-3 p-3 bg-[#0a0f1e] border border-[#2d3748] rounded-lg">
                  <p className="text-xs text-gray-500">Completá los datos del envío sin vincular póliza del sistema</p>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Destinatario</label>
                    <input type="text" value={manualRecipient}
                      onChange={e => setManualRecipient(e.target.value)}
                      placeholder="Nombre completo..."
                      className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">N° de póliza</label>
                      <input type="text" value={manualPolicyNumber}
                        onChange={e => setManualPolicyNumber(e.target.value)}
                        placeholder="Ej: 12345678"
                        className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Compañía</label>
                      <input type="text" value={manualCompany}
                        onChange={e => setManualCompany(e.target.value)}
                        placeholder="Ej: MAPFRE"
                        className="w-full px-3 py-2 bg-[#0d1424] border border-[#2d3748] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Tipo de documento</label>
                    <div className="grid grid-cols-2 gap-2">
                      {DELIVERY_DOCUMENT_TYPES.map((key) => (
                        <button key={key} type="button" onClick={() => setDocumentType(key)}
                          className={cn("py-2 px-3 rounded-lg text-sm border transition-all",
                            documentType === key
                              ? "border-blue-500/50 bg-blue-500/20 text-blue-300"
                              : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                          {DOC_LABELS[key]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Canal */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Método de envío / entrega</label>
            {isCompletingPendingData && (
              <p className="text-xs text-amber-400 mb-2">Elegí un canal real para poder marcar este envío como enviado.</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {DELIVERY_CHANNELS.map((key) => {
                const Icon = CHANNEL_ICONS[key];
                return (
                  <button key={key} type="button" onClick={() => setChannel(key)}
                    className={cn("flex items-center gap-2 py-2 px-3 rounded-lg text-sm border transition-all",
                      channel === key ? CHANNEL_COLORS[key] : "border-[#2d3748] text-gray-400 hover:text-white hover:bg-[#1a2540]")}>
                    <Icon className="w-4 h-4 flex-shrink-0" />{CHANNEL_LABELS[key]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fecha programada */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Fecha programada</label>
            <input type="date" value={scheduledDate}
              onChange={e => setScheduledDate(e.target.value)}
              className="w-full px-3 py-2 bg-[#0a0f1e] border border-[#2d3748] rounded-lg text-sm text-white outline-none focus:border-blue-500" />
          </div>

          {/* Notas */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notas</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
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
            {saving ? "Guardando..." : editing ? (isCompletingPendingData ? "Completar datos" : "Guardar cambios") : "Registrar envío"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Diálogo de confirmación explícita para pendiente→enviado / enviado→entregado.
// Cancelar solo cierra el diálogo — nunca llama a la API (shouldExecuteDeliveryTransition
// exige confirmed=true, y el botón "Cancelar" nunca lo pasa).
function TransitionConfirmDialog({ kind, onConfirm, onCancel, submitting }: {
  kind: DeliveryTransitionKind; onConfirm: () => void; onCancel: () => void; submitting: boolean;
}) {
  const copy = DELIVERY_TRANSITION_COPY[kind];
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
        <h3 className="text-white font-semibold mb-2" style={{ fontFamily: "Syne, sans-serif" }}>{copy.confirmTitle}</h3>
        <p className="text-gray-400 text-sm mb-5">{copy.confirmBody}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={submitting}
            className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all disabled:opacity-50">
            Cancelar
          </button>
          <button onClick={onConfirm} disabled={submitting}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-all disabled:opacity-50">
            {submitting ? "Confirmando..." : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Envios() {
  const [, navigate] = useLocation();

  // Se lee UNA sola vez al montar (mismo patrón que initialFiltersRef en
  // reporte-mes.tsx). El alta rápida desde la póliza ya no navega acá con
  // query params — este es el único estado que se hidrata desde la URL.
  const filtersRef = useRef<ReturnType<typeof parseDeliveriesFilters> | null>(null);
  if (filtersRef.current === null) {
    filtersRef.current = parseDeliveriesFilters(window.location.search);
  }
  const [filters, setFilters] = useState(filtersRef.current);

  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DeliveryRow | null>(null);
  const [transitionTarget, setTransitionTarget] = useState<{ row: DeliveryRow; kind: DeliveryTransitionKind } | null>(null);
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get("/api/deliveries");
      setDeliveries(data);
    } catch { toast.error("Error al cargar envíos"); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Mantiene la query string sincronizada con los filtros (reemplaza la
  // entrada de historial, no la apila).
  useEffect(() => {
    const path = buildDeliveriesPath(filters);
    const currentPath = window.location.pathname + window.location.search;
    if (path !== currentPath) navigate(path, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.channel, filters.documentType, filters.q]);

  function closeModal() {
    setModalOpen(false); setEditing(null);
  }

  async function handleDelete(id: number) {
    if (!confirm("¿Eliminar este envío?")) return;
    await api.delete(`/api/deliveries/${id}`);
    toast.success("Envío eliminado");
    load();
  }

  function openTransition(row: DeliveryRow) {
    const kind = getAvailableDeliveryTransition(row.delivery.status, row.delivery.channel);
    if (!kind) return;
    setTransitionTarget({ row, kind });
  }

  // "Cancelar" en el diálogo llama solo a esto — nunca a la API.
  function cancelTransition() { setTransitionTarget(null); }

  async function confirmTransition() {
    if (!transitionTarget) return;
    const { row, kind } = transitionTarget;
    if (!shouldExecuteDeliveryTransition(kind, true)) return;
    setTransitionSubmitting(true);
    try {
      await api.patch(`/api/deliveries/${row.delivery.id}/${DELIVERY_TRANSITION_ENDPOINT[kind]}`, {});
      toast.success(kind === "send" ? "Marcado como enviado" : "Marcado como entregado");
      setTransitionTarget(null);
      load();
    } catch (e: any) {
      toast.error(normalizeDeliveryError(e).message);
    } finally {
      setTransitionSubmitting(false);
    }
  }

  const currentPath = buildDeliveriesPath(filters);

  const filtered = deliveries.filter(r => {
    if (filters.channel && r.delivery.channel !== filters.channel) return false;
    if (filters.status && r.delivery.status !== filters.status) return false;
    if (filters.documentType && r.delivery.documentType !== filters.documentType) return false;
    if (filters.q) {
      const display = getDeliveryRowDisplay(r);
      const q = filters.q.toLowerCase();
      if (!display.recipientName.toLowerCase().includes(q)
        && !display.policyNumber.toLowerCase().includes(q)
        && !display.companyName.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // El alta rápida crea filas con status="pendiente" igual que cualquier
  // otra — cuentan acá sin ningún caso especial.
  const counts = {
    pendiente: deliveries.filter(r => r.delivery.status === "pendiente").length,
    enviado: deliveries.filter(r => r.delivery.status === "enviado").length,
    entregado: deliveries.filter(r => r.delivery.status === "entregado").length,
    realizado: deliveries.filter(r => r.delivery.status === "realizado").length,
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Envíos y Entregas</h1>
            <p className="text-gray-400 text-sm mt-1">Registro de envíos de pólizas y refacturaciones</p>
          </div>
          <button onClick={() => { setEditing(null); setModalOpen(true); }}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-all">
            <Plus className="w-4 h-4" /> Registrar envío
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
                <Clock className="w-5 h-5 text-yellow-400" />
              </div>
              <div><p className="text-xs text-gray-500">Pendientes</p><p className="text-xl font-bold text-white">{counts.pendiente}</p></div>
            </div>
          </div>
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                <Send className="w-5 h-5 text-blue-400" />
              </div>
              <div><p className="text-xs text-gray-500">Enviados</p><p className="text-xl font-bold text-white">{counts.enviado}</p></div>
            </div>
          </div>
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                <Check className="w-5 h-5 text-green-400" />
              </div>
              <div><p className="text-xs text-gray-500">Entregados</p><p className="text-xl font-bold text-white">{counts.entregado}</p></div>
            </div>
          </div>
          <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gray-500/20 flex items-center justify-center flex-shrink-0">
                <Package className="w-5 h-5 text-gray-400" />
              </div>
              <div><p className="text-xs text-gray-500">Realizados (legacy)</p><p className="text-xl font-bold text-white">{counts.realizado}</p></div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input type="text" placeholder="Buscar destinatario, N° póliza o compañía..." value={filters.q}
              onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
              className="w-full pl-9 pr-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500" />
          </div>
          <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los estados</option>
            <option value="pendiente">Pendiente</option>
            <option value="enviado">Enviado</option>
            <option value="entregado">Entregado</option>
            <option value="realizado">Realizado (legacy)</option>
          </select>
          <select value={filters.channel} onChange={e => setFilters(f => ({ ...f, channel: e.target.value }))}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los canales</option>
            {DELIVERY_CHANNELS.map((k) => <option key={k} value={k}>{CHANNEL_LABELS[k]}</option>)}
          </select>
          <select value={filters.documentType} onChange={e => setFilters(f => ({ ...f, documentType: e.target.value }))}
            className="px-3 py-2 bg-[#0d1424] border border-[#1f2937] rounded-lg text-sm text-gray-300 outline-none">
            <option value="">Todos los documentos</option>
            {DELIVERY_DOCUMENT_TYPES.map((k) => <option key={k} value={k}>{DOC_LABELS[k]}</option>)}
          </select>
          {(filters.channel || filters.status || filters.documentType || filters.q) && (
            <button onClick={() => setFilters({ status: "", channel: "", documentType: "", q: "" })}
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
            <>
            {/* Mobile cards */}
            <div className="lg:hidden divide-y divide-[#1f2937]">
              {filtered.map(r => {
                const display = getDeliveryRowDisplay(r);
                const pending = isChannelPending(r.delivery.channel);
                const transitionKind = getAvailableDeliveryTransition(r.delivery.status, r.delivery.channel);
                const transitionCopy = transitionKind ? DELIVERY_TRANSITION_COPY[transitionKind] : null;
                return (
                  <div key={r.delivery.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-white font-medium">{display.policyNumber}</p>
                          {display.isManual && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/30 bg-orange-500/10 text-orange-400">manual</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate">{display.recipientName} · {display.companyName}</p>
                      </div>
                      <span className={cn("px-2 py-0.5 rounded text-xs border flex-shrink-0", STATUS_COLORS[r.delivery.status])}>
                        {STATUS_LABELS[r.delivery.status] || r.delivery.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="px-2 py-0.5 rounded border border-[#2d3748] text-gray-300">
                        {DOC_LABELS[r.delivery.documentType] || r.delivery.documentType}
                      </span>
                      {display.period && (
                        <span className="px-2 py-0.5 rounded border border-violet-500/30 text-violet-300">
                          {formatDate(display.period.billingStart)} → {formatDate(display.period.billingEnd)}
                        </span>
                      )}
                      <ChannelBadge channel={r.delivery.channel} />
                    </div>
                    <div className="flex items-center gap-3 flex-wrap text-xs text-gray-400">
                      <span>Prog: {r.delivery.scheduledDate ? formatDate(r.delivery.scheduledDate) : "—"}</span>
                      <span>Enviado: {r.delivery.sentDate ? formatDate(r.delivery.sentDate) : "—"}</span>
                      <span>Entregado: {r.delivery.completedDate ? formatDate(r.delivery.completedDate) : "—"}</span>
                    </div>
                    {r.delivery.notes && <p className="text-xs text-gray-400">{r.delivery.notes}</p>}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      {transitionKind && transitionCopy && (
                        <button onClick={() => openTransition(r)}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/40 transition-colors">
                          <Send className="w-3 h-3" /> {transitionCopy.actionLabel}
                        </button>
                      )}
                      {!display.isManual && r.policy && (
                        <Link href={`/polizas/${r.policy.id}?returnTo=${encodeURIComponent(currentPath)}`}>
                          <a className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2d3748] text-gray-300 hover:text-blue-400 transition-colors">
                            <ExternalLink className="w-3 h-3" /> Ver póliza
                          </a>
                        </Link>
                      )}
                      <button onClick={() => { setEditing(r); setModalOpen(true); }}
                        className={cn("flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors",
                          pending
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                            : "border-[#2d3748] text-gray-300 hover:text-blue-400")}>
                        <Edit2 className="w-3 h-3" /> {pending ? "Completar datos" : "Editar"}
                      </button>
                      <button onClick={() => handleDelete(r.delivery.id)}
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
                    <th className="text-left px-5 py-3 font-medium">Destinatario / Asegurado</th>
                    <th className="text-left px-3 py-3 font-medium">Compañía</th>
                    <th className="text-left px-3 py-3 font-medium">N° Póliza</th>
                    <th className="text-left px-3 py-3 font-medium">Documento</th>
                    <th className="text-left px-3 py-3 font-medium">Canal</th>
                    <th className="text-left px-3 py-3 font-medium">Programado</th>
                    <th className="text-left px-3 py-3 font-medium">Enviado</th>
                    <th className="text-left px-3 py-3 font-medium">Entregado</th>
                    <th className="text-left px-3 py-3 font-medium">Estado</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const display = getDeliveryRowDisplay(r);
                    const pending = isChannelPending(r.delivery.channel);
                    const transitionKind = getAvailableDeliveryTransition(r.delivery.status, r.delivery.channel);
                    const transitionCopy = transitionKind ? DELIVERY_TRANSITION_COPY[transitionKind] : null;
                    return (
                      <tr key={r.delivery.id} className="border-b border-[#1f2937] hover:bg-[#1a2540]/30 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{display.recipientName}</p>
                            {display.isManual && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/30 bg-orange-500/10 text-orange-400">manual</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">{display.companyName}</td>
                        <td className="px-3 py-3 text-gray-300 text-xs">{display.policyNumber}</td>
                        <td className="px-3 py-3">
                          <span className="px-2 py-0.5 rounded text-xs border border-[#2d3748] text-gray-300">
                            {DOC_LABELS[r.delivery.documentType] || r.delivery.documentType}
                          </span>
                          {display.period && (
                            <p className="text-[11px] text-violet-300 mt-1">
                              {formatDate(display.period.billingStart)} → {formatDate(display.period.billingEnd)}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <ChannelBadge channel={r.delivery.channel} className="w-fit" />
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.delivery.scheduledDate ? formatDate(r.delivery.scheduledDate) : "—"}
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.delivery.sentDate ? formatDate(r.delivery.sentDate) : "—"}
                        </td>
                        <td className="px-3 py-3 text-gray-300 text-xs">
                          {r.delivery.completedDate ? formatDate(r.delivery.completedDate) : "—"}
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn("px-2 py-0.5 rounded text-xs border", STATUS_COLORS[r.delivery.status])}>
                            {STATUS_LABELS[r.delivery.status] || r.delivery.status}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 justify-end flex-wrap">
                            {transitionKind && transitionCopy && (
                              <button onClick={() => openTransition(r)} title={transitionCopy.actionLabel}
                                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/40 transition-colors whitespace-nowrap">
                                <Send className="w-3 h-3" /> {transitionCopy.actionLabel}
                              </button>
                            )}
                            {!display.isManual && r.policy && (
                              <Link href={`/polizas/${r.policy.id}?returnTo=${encodeURIComponent(currentPath)}`}>
                                <a className="text-gray-400 hover:text-blue-400 transition-colors" title="Ver póliza">
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              </Link>
                            )}
                            {pending ? (
                              <button onClick={() => { setEditing(r); setModalOpen(true); }}
                                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition-colors whitespace-nowrap">
                                <Edit2 className="w-3 h-3" /> Completar datos
                              </button>
                            ) : (
                              <button onClick={() => { setEditing(r); setModalOpen(true); }}
                                className="text-gray-400 hover:text-blue-400 transition-colors" title="Editar">
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
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
            </>
          )}
        </div>
      </div>

      <DeliveryModal open={modalOpen} onClose={closeModal} onSaved={load} editing={editing} />

      {transitionTarget && (
        <TransitionConfirmDialog
          kind={transitionTarget.kind}
          onConfirm={confirmTransition}
          onCancel={cancelTransition}
          submitting={transitionSubmitting}
        />
      )}
    </AppLayout>
  );
}
