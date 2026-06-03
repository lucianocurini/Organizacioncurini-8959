import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { cn, formatDate, POLICY_TYPES } from "@/lib/utils";
import { toast } from "sonner";
import {
  AlertTriangle, Plus, Search, X, ChevronRight, ChevronLeft,
  Car, Bike, FileText, CheckCircle, Clock, ArrowRight,
  User, MapPin, Calendar, FileSearch, ShieldAlert, CheckSquare, Trash2, Eye,
  Inbox, Building2, ClipboardList,
} from "lucide-react";
import { Link } from "wouter";

// ─── Tipos ────────────────────────────────────────────────────────────────────
const CLAIM_STATUS: Record<string, { label: string; color: string; icon: any }> = {
  pendiente:        { label: "Pendiente",        color: "bg-gray-500/15 text-gray-400 border-gray-500/20",      icon: Inbox },
  nuevo:            { label: "Nuevo",            color: "bg-blue-500/15 text-blue-400 border-blue-500/20",     icon: Plus },
  en_curso:         { label: "En curso",         color: "bg-amber-500/15 text-amber-400 border-amber-500/20",  icon: Clock },
  reclamo_tercero:  { label: "Reclamo tercero",  color: "bg-violet-500/15 text-violet-400 border-violet-500/20", icon: ShieldAlert },
  resuelto:         { label: "Resuelto",         color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20", icon: CheckCircle },
};

const inp = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";
const lbl = "block text-xs text-gray-400 mb-1.5";

// ─── Wizard ───────────────────────────────────────────────────────────────────
interface WizardPrefill {
  claimId?: number;
  manualInsured?: string;
  manualCompany?: string;
  manualPolicyNumber?: string;
  manualPolicyType?: string;
  manualNotes?: string;
}

function NewClaimWizard({ onClose, onSaved, prefill }: {
  onClose: () => void;
  onSaved: () => void;
  prefill?: WizardPrefill;
}) {
  // If prefill has a claimId, we're converting a pending claim — skip to step 1 selector
  const isPendingResume = !!(prefill?.claimId && (prefill.manualInsured || prefill.manualCompany || prefill.manualPolicyNumber));
  const [step, setStep] = useState(isPendingResume ? 2 : 1);
  const [loading, setLoading] = useState(false);
  const [policySearch, setPolicySearch] = useState("");
  const [policyResults, setPolicyResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<any>(null);
  const [claimId, setClaimId] = useState<number | null>(prefill?.claimId ?? null);

  // Manual mode (no policy found)
  const [manualMode, setManualMode] = useState(isPendingResume);
  const [manualInsured, setManualInsured] = useState(prefill?.manualInsured ?? "");
  const [manualCompany, setManualCompany] = useState(prefill?.manualCompany ?? "");
  const [manualPolicyNumber, setManualPolicyNumber] = useState(prefill?.manualPolicyNumber ?? "");
  const [manualPolicyType, setManualPolicyType] = useState(prefill?.manualPolicyType ?? "");
  const [manualNotes, setManualNotes] = useState(prefill?.manualNotes ?? "");



  // Paso 2 — datos del siniestro
  const [claimNumber, setClaimNumber] = useState("");
  const [incidentDate, setIncidentDate] = useState("");
  const [incidentTime, setIncidentTime] = useState("");
  const [incidentLocation, setIncidentLocation] = useState("");
  const [incidentDescription, setIncidentDescription] = useState("");
  const [damages, setDamages] = useState("");
  // Tercero
  const [thirdPartyName, setThirdPartyName] = useState("");
  const [thirdPartyDni, setThirdPartyDni] = useState("");
  const [thirdPartyPhone, setThirdPartyPhone] = useState("");
  const [thirdPartyVehiclePlate, setThirdPartyVehiclePlate] = useState("");
  const [thirdPartyVehicleBrand, setThirdPartyVehicleBrand] = useState("");
  const [thirdPartyVehicleModel, setThirdPartyVehicleModel] = useState("");
  const [thirdPartyInsurer, setThirdPartyInsurer] = useState("");
  const [thirdPartyPolicyNumber, setThirdPartyPolicyNumber] = useState("");

  // Culpabilidad del asegurado (automotor / motovehiculo)
  const [insuredAtFault, setInsuredAtFault] = useState(false);

  // Paso 3 — reclamo tercero
  const [claimFiled, setClaimFiled] = useState(false);
  const [claimFiledDate, setClaimFiledDate] = useState("");
  const [claimCompany, setClaimCompany] = useState("");
  const [claimNumberThird, setClaimNumberThird] = useState("");
  const [claimNotes, setClaimNotes] = useState("");

  // Búsqueda de pólizas
  useEffect(() => {
    if (!policySearch.trim()) { setPolicyResults([]); return; }
    const t = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await api.get(`/api/policies?search=${encodeURIComponent(policySearch)}`);
        setPolicyResults(Array.isArray(res) ? res : []);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [policySearch]);

  const hasThirdParty = selectedPolicy?.policy?.type === "automotor" || selectedPolicy?.policy?.type === "motovehiculo"
    || manualPolicyType === "automotor" || manualPolicyType === "motovehiculo";

  // Paso 1: crear o actualizar siniestro base
  async function handleStep1() {
    if (!manualMode && !selectedPolicy) { toast.error("Seleccioná una póliza o usá el modo manual"); return; }
    if (manualMode && !manualInsured && !manualCompany) {
      toast.error("Completá al menos el nombre del asegurado o la compañía");
      return;
    }
    setLoading(true);
    try {
      if (prefill?.claimId) {
        // Update existing pending claim
        await api.put(`/api/claims/${prefill.claimId}`, {
          policyId: manualMode ? null : selectedPolicy?.policy?.id,
          status: manualMode ? "pendiente" : "nuevo",
          manualInsured: manualMode ? manualInsured : null,
          manualCompany: manualMode ? manualCompany : null,
          manualPolicyNumber: manualMode ? manualPolicyNumber : null,
          manualPolicyType: manualMode ? manualPolicyType : null,
          manualNotes: manualMode ? manualNotes : null,
        });
        setClaimId(prefill.claimId);
      } else {
        const row = await api.post("/api/claims", {
          policyId: manualMode ? null : selectedPolicy?.policy?.id,
          manualInsured: manualMode ? manualInsured : undefined,
          manualCompany: manualMode ? manualCompany : undefined,
          manualPolicyNumber: manualMode ? manualPolicyNumber : undefined,
          manualPolicyType: manualMode ? manualPolicyType : undefined,
          manualNotes: manualMode ? manualNotes : undefined,
        });
        setClaimId(row.id);
      }

      if (manualMode) {
        // Si viene de un pendiente existente, continuar al paso 2 con los datos manuales
        if (prefill?.claimId) {
          setStep(2);
        } else {
          toast.success("Siniestro guardado en lista de pendientes");
          onSaved();
        }
        return;
      }
      setStep(2);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  // Paso 2: guardar datos del siniestro
  async function handleStep2() {
    if (!incidentDate) { toast.error("Ingresá la fecha del siniestro"); return; }
    setLoading(true);
    try {
      // Si el asegurado es culpable en auto/moto → no hay reclamo, pasa directo a resuelto
      const finalStatus = (hasThirdParty && insuredAtFault) ? "resuelto" : "en_curso";
      await api.put(`/api/claims/${claimId}`, {
        status: finalStatus,
        claimNumber: claimNumber || null,
        incidentDate, incidentTime, incidentLocation, incidentDescription, damages,
        ...(hasThirdParty ? {
          thirdPartyName, thirdPartyDni, thirdPartyPhone,
          thirdPartyVehiclePlate, thirdPartyVehicleBrand, thirdPartyVehicleModel,
          thirdPartyInsurer, thirdPartyPolicyNumber,
        } : {}),
        ...(hasThirdParty && insuredAtFault ? {
          resolvedDate: new Date().toISOString().split("T")[0],
          resolutionNotes: "Asegurado responsable — sin reclamo a tercero.",
        } : {}),
      });
      if (hasThirdParty && insuredAtFault) {
        toast.success("Siniestro marcado como resuelto — sin reclamo");
        onSaved();
        return;
      }
      setStep(3);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  // Paso 3: reclamo tercero (o saltar)
  async function handleStep3(skip = false) {
    setLoading(true);
    try {
      if (skip) {
        await api.put(`/api/claims/${claimId}`, { status: "en_curso" });
      } else {
        await api.put(`/api/claims/${claimId}`, {
          status: "reclamo_tercero",
          claimFiled: claimFiled ? 1 : 0,
          claimFiledDate: claimFiled ? claimFiledDate : null,
          claimCompany, claimNumberThird, claimNotes,
        });
      }
      setStep(4);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  // Paso 4: resolución (o terminar sin resolver)
  async function handleFinish(resolved = false) {
    setLoading(true);
    try {
      await api.put(`/api/claims/${claimId}`, { status: resolved ? "resuelto" : "en_curso" });
      toast.success("Siniestro guardado correctamente");
      onSaved();
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  const steps = [
    { n: 1, label: "Póliza" },
    { n: 2, label: "Siniestro" },
    { n: 3, label: "Reclamo" },
    { n: 4, label: "Resolución" },
  ];

  const title = prefill?.claimId ? "Ingresar siniestro pendiente" : "Nuevo Siniestro";

  return (
    <div className="fixed inset-0 bg-black/75 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-2xl my-4">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{title}</h2>
              <p className="text-xs text-gray-500">
                {step === 1 && "Paso 1 — Seleccioná la póliza"}
                {step === 2 && (isPendingResume ? "Datos del siniestro — póliza manual" : "Paso 2 — Datos del siniestro")}
                {step === 3 && "Paso 3 — Reclamo a compañía del tercero"}
                {step === 4 && "Paso 4 — Estado de resolución"}
              </p>
            </div>
          </div>
          {/* Stepper */}
          <div className="hidden sm:flex items-center gap-1 text-xs mr-3">
            {steps.map((s, i) => (
              <span key={s.n} className="flex items-center gap-1">
                <span className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold",
                  step === s.n ? "bg-orange-500 text-white" :
                  step > s.n  ? "bg-emerald-600 text-white" :
                  "bg-[#1f2937] text-gray-500"
                )}>
                  {step > s.n ? "✓" : s.n}
                </span>
                <span className={cn("text-xs", step === s.n ? "text-white" : "text-gray-600")}>{s.label}</span>
                {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-gray-700 mx-0.5" />}
              </span>
            ))}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">

          {/* ── Paso 1: Póliza ── */}
          {step === 1 && (
            <div className="space-y-4">

              {/* Toggle manual/search */}
              <div className="flex gap-2">
                <button
                  onClick={() => setManualMode(false)}
                  className={cn(
                    "flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all flex items-center justify-center gap-2",
                    !manualMode
                      ? "bg-blue-600/20 border-blue-500/40 text-blue-300"
                      : "bg-[#0d1424] border-[#1f2937] text-gray-400 hover:border-blue-500/30"
                  )}>
                  <Search className="w-4 h-4" /> Buscar póliza
                </button>
                <button
                  onClick={() => setManualMode(true)}
                  className={cn(
                    "flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all flex items-center justify-center gap-2",
                    manualMode
                      ? "bg-gray-600/20 border-gray-500/40 text-gray-300"
                      : "bg-[#0d1424] border-[#1f2937] text-gray-400 hover:border-gray-500/30"
                  )}>
                  <ClipboardList className="w-4 h-4" /> Sin póliza (manual)
                </button>
              </div>

              {!manualMode && (
                <>
                  <div>
                    <label className={lbl}>Buscar póliza por número, asegurado o compañía</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                      <input className={inp + " pl-9"} value={policySearch}
                        onChange={e => setPolicySearch(e.target.value)}
                        placeholder="N° póliza, nombre del asegurado..." />
                    </div>
                  </div>

                  {searchLoading && <p className="text-xs text-gray-500 animate-pulse">Buscando...</p>}

                  {policyResults.length > 0 && !selectedPolicy && (
                    <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                      {policyResults.map((r: any) => {
                        const p = r.policy;
                        const typeInfo = POLICY_TYPES[p.type];
                        return (
                          <button key={p.id} onClick={() => { setSelectedPolicy(r); setPolicySearch(""); }}
                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#1a2540] transition-colors border-b border-[#1f2937] last:border-0 text-left">
                            <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs", typeInfo?.color)}>
                              {p.type === "automotor" ? <Car className="w-3.5 h-3.5" /> :
                               p.type === "motovehiculo" ? <Bike className="w-3.5 h-3.5" /> :
                               <FileText className="w-3.5 h-3.5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white font-mono">{p.policyNumber}</p>
                              <p className="text-xs text-gray-400 truncate">{r.insured?.name} — {r.company?.name}</p>
                            </div>
                            <span className={cn("text-xs px-2 py-0.5 rounded-md border flex-shrink-0", typeInfo?.color)}>
                              {typeInfo?.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {selectedPolicy && (
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 flex items-start gap-3">
                      <CheckCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white">{selectedPolicy.policy.policyNumber}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {selectedPolicy.insured?.name} · {selectedPolicy.company?.name} · {POLICY_TYPES[selectedPolicy.policy.type]?.label}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Vigencia: {formatDate(selectedPolicy.policy.startDate)} → {formatDate(selectedPolicy.policy.endDate)}
                        </p>
                      </div>
                      <button onClick={() => setSelectedPolicy(null)} className="text-gray-500 hover:text-white transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {!selectedPolicy && policyResults.length === 0 && policySearch.length > 1 && !searchLoading && (
                    <div className="bg-gray-500/5 border border-dashed border-gray-500/20 rounded-xl p-4 text-center">
                      <p className="text-xs text-gray-500 mb-2">Sin resultados para "{policySearch}"</p>
                      <button onClick={() => setManualMode(true)}
                        className="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition-colors">
                        Cargar manualmente sin póliza →
                      </button>
                    </div>
                  )}
                </>
              )}

              {manualMode && (
                <div className="space-y-3">
                  <div className="bg-gray-500/10 border border-gray-500/20 rounded-xl px-4 py-3 text-xs text-gray-400 flex items-start gap-2">
                    <Inbox className="w-4 h-4 flex-shrink-0 mt-0.5 text-gray-500" />
                    <div>
                      <p className="font-medium text-gray-300">Carga manual — sin póliza vinculada</p>
                      <p className="text-gray-500 mt-0.5">El siniestro quedará en la lista de pendientes. Podés vincularlo a una póliza después.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Nombre del asegurado</label>
                      <input type="text" className={inp} value={manualInsured}
                        onChange={e => setManualInsured(e.target.value)} placeholder="Juan Pérez" />
                    </div>
                    <div>
                      <label className={lbl}>Compañía aseguradora</label>
                      <input type="text" className={inp} value={manualCompany}
                        onChange={e => setManualCompany(e.target.value)} placeholder="La Segunda, Sancor..." />
                    </div>
                    <div>
                      <label className={lbl}>N° de póliza (aproximado)</label>
                      <input type="text" className={inp} value={manualPolicyNumber}
                        onChange={e => setManualPolicyNumber(e.target.value)} placeholder="Número de póliza" />
                    </div>
                    <div>
                      <label className={lbl}>Tipo de póliza</label>
                      <select className={inp} value={manualPolicyType} onChange={e => setManualPolicyType(e.target.value)}>
                        <option value="">Sin especificar</option>
                        {Object.entries(POLICY_TYPES).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className={lbl}>Notas adicionales</label>
                      <textarea className={inp + " resize-none"} rows={2} value={manualNotes}
                        onChange={e => setManualNotes(e.target.value)}
                        placeholder="Cualquier dato relevante que tengas disponible..." />
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button onClick={handleStep1} disabled={loading || (!manualMode && !selectedPolicy)}
                  className="px-5 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {manualMode ? "Guardar pendiente" : "Continuar"}
                  {!manualMode && <ChevronRight className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {/* ── Paso 2: Datos del siniestro ── */}
          {step === 2 && (
            <div className="space-y-4">
              {/* Contexto */}
              <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl px-4 py-3 text-xs flex items-center gap-3">
                <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
                <div>
                  {selectedPolicy ? (
                    <>
                      <span className="text-blue-400 font-mono font-medium">{selectedPolicy.policy.policyNumber}</span>
                      <span className="text-gray-500 ml-2">{selectedPolicy.insured?.name}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-gray-300 font-medium">{manualInsured || "Sin asegurado"}</span>
                      {manualCompany && <span className="text-gray-500 ml-2">· {manualCompany}</span>}
                      {manualPolicyNumber && <span className="text-gray-500 ml-2">· Póliza aprox: {manualPolicyNumber}</span>}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-orange-500/10 border border-orange-500/20 text-orange-400">manual</span>
                    </>
                  )}
                </div>
              </div>

              {/* Cuándo */}
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" /> Fecha y hora
                </p>
                {/* N° de siniestro en la compañía */}
                <div className="mb-3">
                  <label className={lbl}>N° de siniestro en la compañía <span className="text-gray-600">(opcional)</span></label>
                  <input type="text" className={inp} value={claimNumber}
                    onChange={e => setClaimNumber(e.target.value)}
                    placeholder="Número asignado por la aseguradora..." />
                </div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" /> Fecha y hora
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Fecha del siniestro *</label>
                    <input type="date" className={inp} value={incidentDate} onChange={e => setIncidentDate(e.target.value)} required />
                  </div>
                  <div>
                    <label className={lbl}>Hora</label>
                    <input type="time" className={inp} value={incidentTime} onChange={e => setIncidentTime(e.target.value)} />
                  </div>
                </div>
              </div>

              {/* Dónde */}
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" /> Lugar y ocurrencia
                </p>
                <div className="space-y-3">
                  <div>
                    <label className={lbl}>Lugar del siniestro</label>
                    <input type="text" className={inp} value={incidentLocation}
                      onChange={e => setIncidentLocation(e.target.value)}
                      placeholder="Dirección, intersección, localidad..." />
                  </div>
                  <div>
                    <label className={lbl}>Descripción de la ocurrencia</label>
                    <textarea className={inp + " resize-none"} rows={3} value={incidentDescription}
                      onChange={e => setIncidentDescription(e.target.value)}
                      placeholder="Relatá cómo ocurrió el siniestro..." />
                  </div>
                  <div>
                    <label className={lbl}>Daños</label>
                    <textarea className={inp + " resize-none"} rows={2} value={damages}
                      onChange={e => setDamages(e.target.value)}
                      placeholder="Descripción de los daños sufridos..." />
                  </div>
                </div>
              </div>

              {/* Responsabilidad — solo autos y motos */}
              {hasThirdParty && (
                <div>
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" /> Responsabilidad
                  </p>
                  <button
                    type="button"
                    onClick={() => setInsuredAtFault(v => !v)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all text-left",
                      insuredAtFault
                        ? "bg-red-500/10 border-red-500/30 text-red-300"
                        : "bg-[#0d1424] border-[#1f2937] text-gray-400 hover:border-gray-500/40"
                    )}>
                    <div className={cn(
                      "w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all",
                      insuredAtFault ? "bg-red-500 border-red-500" : "border-gray-600"
                    )}>
                      {insuredAtFault && <CheckSquare className="w-3 h-3 text-white" />}
                    </div>
                    <div>
                      <p className={insuredAtFault ? "text-red-300" : "text-gray-300"}>El asegurado es responsable del siniestro</p>
                      {insuredAtFault && (
                        <p className="text-xs text-red-400/70 mt-0.5 font-normal">No corresponde reclamo — el siniestro pasará directamente a <strong>resuelto</strong></p>
                      )}
                    </div>
                  </button>
                </div>
              )}

              {/* Tercero — solo autos y motos */}
              {hasThirdParty && (
                <div>
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" /> Datos del tercero
                    <span className="text-gray-600 lowercase normal-case font-normal">(opcional)</span>
                  </p>
                  <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={lbl}>Nombre y apellido</label>
                        <input type="text" className={inp} value={thirdPartyName}
                          onChange={e => setThirdPartyName(e.target.value)} placeholder="Juan Pérez" />
                      </div>
                      <div>
                        <label className={lbl}>DNI / CUIT</label>
                        <input type="text" className={inp} value={thirdPartyDni}
                          onChange={e => setThirdPartyDni(e.target.value)} placeholder="25.123.456" />
                      </div>
                      <div>
                        <label className={lbl}>Teléfono</label>
                        <input type="text" className={inp} value={thirdPartyPhone}
                          onChange={e => setThirdPartyPhone(e.target.value)} placeholder="011-4567-8901" />
                      </div>
                      <div>
                        <label className={lbl}>Patente del vehículo</label>
                        <input type="text" className={inp} value={thirdPartyVehiclePlate}
                          onChange={e => setThirdPartyVehiclePlate(e.target.value)} placeholder="AB 123 CD" />
                      </div>
                      <div>
                        <label className={lbl}>Marca</label>
                        <input type="text" className={inp} value={thirdPartyVehicleBrand}
                          onChange={e => setThirdPartyVehicleBrand(e.target.value)} placeholder="Ford" />
                      </div>
                      <div>
                        <label className={lbl}>Modelo</label>
                        <input type="text" className={inp} value={thirdPartyVehicleModel}
                          onChange={e => setThirdPartyVehicleModel(e.target.value)} placeholder="Focus" />
                      </div>
                      <div>
                        <label className={lbl}>Compañía aseguradora</label>
                        <input type="text" className={inp} value={thirdPartyInsurer}
                          onChange={e => setThirdPartyInsurer(e.target.value)} placeholder="Nombre aseguradora" />
                      </div>
                      <div>
                        <label className={lbl}>N° póliza del tercero</label>
                        <input type="text" className={inp} value={thirdPartyPolicyNumber}
                          onChange={e => setThirdPartyPolicyNumber(e.target.value)} placeholder="N° de póliza" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button onClick={() => setStep(1)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all flex items-center gap-2">
                  <ChevronLeft className="w-4 h-4" /> Volver
                </button>
                <button onClick={handleStep2} disabled={loading}
                  className="px-5 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  Continuar <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Paso 3: Reclamo tercero ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-sm text-amber-400 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">¿Se presenta reclamo a la compañía del tercero?</p>
                  <p className="text-xs text-amber-400/70 mt-0.5">Podés saltar este paso si el siniestro no tiene terceros o no corresponde reclamo.</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setClaimFiled(true)}
                  className={cn("flex-1 py-3 rounded-xl border text-sm font-medium transition-all flex items-center justify-center gap-2",
                    claimFiled ? "bg-violet-600/20 border-violet-500/40 text-violet-300" : "bg-[#0d1424] border-[#1f2937] text-gray-400 hover:border-violet-500/30"
                  )}>
                  <CheckSquare className="w-4 h-4" /> Sí, se presentó reclamo
                </button>
                <button
                  onClick={() => setClaimFiled(false)}
                  className={cn("flex-1 py-3 rounded-xl border text-sm font-medium transition-all flex items-center justify-center gap-2",
                    !claimFiled ? "bg-gray-600/20 border-gray-500/40 text-gray-300" : "bg-[#0d1424] border-[#1f2937] text-gray-400 hover:border-gray-500/30"
                  )}>
                  <X className="w-4 h-4" /> No hay reclamo
                </button>
              </div>

              {claimFiled && (
                <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Fecha de presentación</label>
                      <input type="date" className={inp} value={claimFiledDate} onChange={e => setClaimFiledDate(e.target.value)} />
                    </div>
                    <div>
                      <label className={lbl}>Compañía del tercero</label>
                      <input type="text" className={inp} value={claimCompany}
                        onChange={e => setClaimCompany(e.target.value)} placeholder="Nombre aseguradora" />
                    </div>
                    <div className="col-span-2">
                      <label className={lbl}>N° de siniestro / expediente</label>
                      <input type="text" className={inp} value={claimNumberThird}
                        onChange={e => setClaimNumberThird(e.target.value)} placeholder="Número asignado por la compañía" />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Notas del reclamo</label>
                    <textarea className={inp + " resize-none"} rows={2} value={claimNotes}
                      onChange={e => setClaimNotes(e.target.value)} placeholder="Observaciones adicionales..." />
                  </div>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button onClick={() => setStep(2)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all flex items-center gap-2">
                  <ChevronLeft className="w-4 h-4" /> Volver
                </button>
                <div className="flex gap-2">
                  <button onClick={() => handleStep3(true)} disabled={loading}
                    className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                    Saltar paso
                  </button>
                  <button onClick={() => handleStep3(false)} disabled={loading}
                    className="px-5 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                    {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                    Continuar <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Paso 4: Resolución ── */}
          {step === 4 && (
            <div className="space-y-5">
              <div className="text-center py-3">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
                  <CheckCircle className="w-7 h-7 text-emerald-400" />
                </div>
                <h3 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                  El siniestro fue registrado
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  ¿El siniestro ya está resuelto y cerrado, o sigue en trámite?
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => handleFinish(false)} disabled={loading}
                  className="py-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 text-sm font-medium hover:bg-amber-500/20 transition-all flex flex-col items-center gap-2">
                  <Clock className="w-5 h-5" />
                  Dejar en trámite
                  <span className="text-xs text-amber-400/60 font-normal">El siniestro sigue en curso</span>
                </button>
                <button onClick={() => handleFinish(true)} disabled={loading}
                  className="py-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-all flex flex-col items-center gap-2">
                  <CheckCircle className="w-5 h-5" />
                  Marcar como resuelto
                  <span className="text-xs text-emerald-400/60 font-normal">Siniestro cerrado y finalizado</span>
                </button>
              </div>

              {loading && (
                <div className="flex justify-center">
                  <span className="w-5 h-5 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Página principal ──────────────────────────────────────────────────────────
export default function Siniestros() {
  const [claims, setClaims] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [wizardPrefill, setWizardPrefill] = useState<WizardPrefill | undefined>(undefined);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);
      const [data, statsData] = await Promise.all([
        api.get(`/api/claims?${params}`),
        api.get("/api/claims/stats"),
      ]);
      setClaims(Array.isArray(data) ? data : []);
      setStats(statsData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [search, statusFilter]);

  async function deleteClaim(id: number) {
    if (!confirm("¿Eliminar este siniestro?")) return;
    try {
      await api.delete(`/api/claims/${id}`);
      toast.success("Siniestro eliminado");
      load();
    } catch (e: any) { toast.error(e.message); }
  }

  function openWizard(prefill?: WizardPrefill) {
    setWizardPrefill(prefill);
    setShowNew(true);
  }

  // Separate pending from the rest
  const pendingClaims = claims.filter((r: any) => r.claim.status === "pendiente");
  const activeClaims = claims.filter((r: any) => r.claim.status !== "pendiente");

  return (
    <AppLayout>
      <div className="p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Siniestros</h1>
            <p className="text-gray-400 text-sm mt-0.5">Gestión de siniestros de todas las ramas</p>
          </div>
          <button onClick={() => openWizard()}
            className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium rounded-lg transition-all">
            <Plus className="w-4 h-4" /> Nuevo siniestro
          </button>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            {Object.entries(CLAIM_STATUS).map(([key, val]) => (
              <button key={key} onClick={() => setStatusFilter(statusFilter === key ? "" : key)}
                className={cn(
                  "bg-[#111827] border rounded-xl px-4 py-3 text-left transition-all hover:border-gray-600",
                  statusFilter === key ? "border-orange-500/40" : "border-[#1f2937]"
                )}>
                <p className="text-xl font-bold text-white font-mono">{(stats as any)[key] ?? 0}</p>
                <p className="text-xs text-gray-400 mt-0.5">{val.label}</p>
              </button>
            ))}
          </div>
        )}

        {/* ── Inbox de pendientes ── */}
        {!statusFilter && pendingClaims.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Inbox className="w-4 h-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-300" style={{ fontFamily: "Syne, sans-serif" }}>
                Lista previa de siniestros
              </h2>
              <span className="px-2 py-0.5 bg-gray-500/15 border border-gray-500/20 text-gray-400 text-xs rounded-full">
                {pendingClaims.length}
              </span>
            </div>
            <div className="bg-[#111827] border border-gray-500/20 rounded-2xl overflow-hidden">
              {pendingClaims.map((r: any, idx: number) => {
                const c = r.claim;
                const hasManual = c.manualInsured || c.manualCompany || c.manualPolicyNumber;
                return (
                  <div key={c.id} className={cn(
                    "flex items-center gap-4 px-5 py-4 hover:bg-[#1a2540]/30 transition-colors group",
                    idx < pendingClaims.length - 1 && "border-b border-[#1f2937]"
                  )}>
                    <div className="w-8 h-8 rounded-lg bg-gray-500/15 border border-gray-500/20 flex items-center justify-center flex-shrink-0">
                      <Inbox className="w-4 h-4 text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {c.manualInsured && (
                          <span className="text-sm text-white font-medium">{c.manualInsured}</span>
                        )}
                        {c.manualCompany && (
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Building2 className="w-3 h-3" />{c.manualCompany}
                          </span>
                        )}
                        {!hasManual && <span className="text-sm text-gray-500 italic">Sin datos</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        {c.manualPolicyNumber && (
                          <span className="text-xs text-gray-500 font-mono">Póliza aprox: {c.manualPolicyNumber}</span>
                        )}
                        {c.manualPolicyType && POLICY_TYPES[c.manualPolicyType] && (
                          <span className={cn("text-xs px-1.5 py-0.5 rounded border", POLICY_TYPES[c.manualPolicyType].color)}>
                            {POLICY_TYPES[c.manualPolicyType].label}
                          </span>
                        )}
                        {c.manualNotes && (
                          <span className="text-xs text-gray-600 truncate max-w-[200px]">{c.manualNotes}</span>
                        )}
                        <span className="text-xs text-gray-600">Cargado {formatDate(c.createdAt)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => openWizard({
                          claimId: c.id,
                          manualInsured: c.manualInsured,
                          manualCompany: c.manualCompany,
                          manualPolicyNumber: c.manualPolicyNumber,
                          manualPolicyType: c.manualPolicyType,
                          manualNotes: c.manualNotes,
                        })}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600/15 border border-orange-500/25 text-orange-400 hover:bg-orange-600/25 text-xs font-medium rounded-lg transition-all">
                        <ArrowRight className="w-3.5 h-3.5" /> Ingresar siniestro
                      </button>
                      <Link href={`/siniestros/${c.id}`}>
                        <a className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all" title="Ver detalle">
                          <Eye className="w-3.5 h-3.5" />
                        </a>
                      </Link>
                      <button onClick={() => deleteClaim(c.id)}
                        className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100" title="Eliminar">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filtros */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input className={inp + " pl-9"} placeholder="Buscar por póliza, asegurado..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {statusFilter && (
            <button onClick={() => setStatusFilter("")}
              className="flex items-center gap-1.5 px-3 py-2 bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs rounded-lg hover:bg-orange-500/20 transition-all">
              {CLAIM_STATUS[statusFilter]?.label} <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Lista activa */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-orange-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : activeClaims.length === 0 && pendingClaims.length === 0 ? (
          <div className="bg-[#111827] border border-[#1f2937] border-dashed rounded-2xl p-16 text-center">
            <AlertTriangle className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-400 font-medium">Sin siniestros</p>
            <p className="text-gray-600 text-sm mt-1">
              {search || statusFilter ? "Probá con otros filtros" : "Registrá el primer siniestro usando el botón de arriba"}
            </p>
          </div>
        ) : activeClaims.length === 0 ? (
          <div className="bg-[#111827] border border-[#1f2937] border-dashed rounded-2xl p-10 text-center">
            <p className="text-gray-500 text-sm">Sin siniestros activos{statusFilter ? ` con estado "${CLAIM_STATUS[statusFilter]?.label}"` : ""}</p>
          </div>
        ) : (
          <div className="bg-[#111827] border border-[#1f2937] rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-[#1f2937]">
                <tr>
                  <th className="text-left text-xs text-gray-500 px-5 py-3 font-medium">Póliza / Asegurado</th>
                  <th className="text-left text-xs text-gray-500 px-5 py-3 font-medium">Fecha siniestro</th>
                  <th className="text-left text-xs text-gray-500 px-5 py-3 font-medium hidden md:table-cell">Lugar</th>
                  <th className="text-left text-xs text-gray-500 px-5 py-3 font-medium">Estado</th>
                  <th className="text-right text-xs text-gray-500 px-5 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f2937]">
                {activeClaims.map((r: any) => {
                  const c = r.claim;
                  const statusInfo = CLAIM_STATUS[c.status];
                  const StatusIcon = statusInfo?.icon || Clock;
                  const typeInfo = POLICY_TYPES[r.policy?.type];
                  return (
                    <tr key={c.id} className="hover:bg-[#1a2540]/30 transition-colors group">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs", typeInfo?.color || "bg-gray-500/10 text-gray-400 border border-gray-500/20")}>
                            {r.policy?.type === "automotor" ? <Car className="w-3.5 h-3.5" /> :
                             r.policy?.type === "motovehiculo" ? <Bike className="w-3.5 h-3.5" /> :
                             <FileText className="w-3.5 h-3.5" />}
                          </div>
                          <div>
                            <p className="text-white font-mono text-xs font-medium">{r.policy?.policyNumber || c.manualPolicyNumber || "—"}</p>
                            <p className="text-gray-400 text-xs">{r.insured?.name || c.manualInsured || <span className="text-gray-600 italic">Sin asegurado</span>}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-gray-300 text-xs">
                        {c.incidentDate ? formatDate(c.incidentDate) : <span className="text-gray-600">Sin fecha</span>}
                        {c.incidentTime && <span className="text-gray-500 ml-1">{c.incidentTime}</span>}
                      </td>
                      <td className="px-5 py-3 text-gray-400 text-xs hidden md:table-cell max-w-[180px] truncate">
                        {c.incidentLocation || <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-5 py-3">
                        <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border", statusInfo?.color)}>
                          <StatusIcon className="w-3 h-3" />{statusInfo?.label}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link href={`/siniestros/${c.id}`}>
                            <a className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-all" title="Ver detalle">
                              <Eye className="w-3.5 h-3.5" />
                            </a>
                          </Link>
                          <button onClick={() => deleteClaim(c.id)}
                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Eliminar">
                            <Trash2 className="w-3.5 h-3.5" />
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

      {showNew && (
        <NewClaimWizard
          prefill={wizardPrefill}
          onClose={() => { setShowNew(false); setWizardPrefill(undefined); }}
          onSaved={() => { setShowNew(false); setWizardPrefill(undefined); load(); }}
        />
      )}
    </AppLayout>
  );
}
