import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { cn, formatCurrency, formatDate, POLICY_TYPES } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, AlertTriangle, Car, Bike, FileText, Calendar, MapPin, User,
  ShieldAlert, CheckCircle, Clock, Edit, Save, X, CheckSquare, Building2, Inbox, Link2
} from "lucide-react";

const CLAIM_STATUS: Record<string, { label: string; color: string }> = {
  pendiente:       { label: "Pendiente",       color: "bg-gray-500/15 text-gray-400 border-gray-500/20" },
  nuevo:           { label: "Nuevo",           color: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  en_curso:        { label: "En curso",        color: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  reclamo_tercero: { label: "Reclamo tercero", color: "bg-violet-500/15 text-violet-400 border-violet-500/20" },
  resuelto:        { label: "Resuelto",        color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
};

const inp = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";
const lbl = "block text-xs text-gray-400 mb-1.5";

function Section({ title, icon: Icon, children, action }: any) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-blue-400" />
          <p className="text-sm font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{title}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-0.5">
      <span className="text-xs text-gray-500 flex-shrink-0">{label}</span>
      <span className={cn("text-sm text-right text-gray-200", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export default function SiniestroDetail() {
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editSection, setEditSection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<any>({});

  const load = () => {
    setLoading(true);
    api.get(`/api/claims/${id}`).then(data => { setRow(data); setForm(data.claim); }).finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  async function save(extraFields?: any) {
    setSaving(true);
    try {
      const payload = { ...form, ...extraFields };
      await api.put(`/api/claims/${id}`, payload);
      toast.success("Guardado");
      setEditSection(null);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  async function markResolved() {
    await save({ status: "resuelto", resolved: 1, resolvedDate: resolvedDate || new Date().toISOString().split("T")[0] });
  }

  const [resolvedDate, setResolvedDate] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [resolutionAmount, setResolutionAmount] = useState("");

  if (loading) return (
    <AppLayout>
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-6 h-6 border-2 border-orange-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </AppLayout>
  );

  if (!row) return <AppLayout><div className="p-8 text-gray-400">No encontrado</div></AppLayout>;

  const c = row.claim;
  const p = row.policy;
  const statusInfo = CLAIM_STATUS[c.status];
  const typeInfo = POLICY_TYPES[p?.type];
  const hasThirdParty = p?.type === "automotor" || p?.type === "motovehiculo";
  const isEditing = (s: string) => editSection === s;

  const startEdit = (section: string) => {
    setForm({ ...c });
    setEditSection(section);
  };
  const cancelEdit = () => setEditSection(null);

  const editBtn = (section: string) => (
    <button onClick={() => isEditing(section) ? cancelEdit() : startEdit(section)}
      className={cn("p-1.5 rounded-lg transition-all text-xs flex items-center gap-1",
        isEditing(section) ? "text-gray-400 hover:text-white hover:bg-[#1f2937]" : "text-gray-500 hover:text-blue-400 hover:bg-blue-500/10"
      )}>
      {isEditing(section) ? <><X className="w-3.5 h-3.5" /> Cancelar</> : <><Edit className="w-3.5 h-3.5" /> Editar</>}
    </button>
  );

  const saveBtn = (section: string, extra?: any) => (
    <button onClick={() => save(extra)} disabled={saving}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-all">
      {saving ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-3 h-3" />}
      Guardar
    </button>
  );

  return (
    <AppLayout>
      <div className="p-4 lg:p-8 max-w-4xl">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 mb-6">
          <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
          <Link href="/siniestros">
            <a className="p-2 text-gray-400 hover:text-white hover:bg-[#1f2937] rounded-lg transition-all flex-shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </a>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-orange-400" />
              </div>
              <h1 className="text-xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                Siniestro #{c.id}
              </h1>
              {c.claimNumber && <span className="text-gray-500 font-mono text-sm">{c.claimNumber}</span>}
              <span className={cn("inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border", statusInfo?.color)}>
                {statusInfo?.label}
              </span>
            </div>
          </div>
          </div>

          {/* Cambio de estado rápido */}
          {c.status !== "resuelto" && (
            <div className="flex items-center gap-2">
              {c.status === "en_curso" && (
                <button onClick={() => save({ status: "reclamo_tercero" })}
                  className="px-3 py-2 bg-violet-600/20 border border-violet-500/30 text-violet-400 text-xs font-medium rounded-lg hover:bg-violet-600/30 transition-all flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5" /> Pasar a reclamo
                </button>
              )}
              <button onClick={() => setEditSection(editSection === "resolver" ? null : "resolver")}
                className="px-3 py-2 bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 text-xs font-medium rounded-lg hover:bg-emerald-600/30 transition-all flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5" /> Resolver
              </button>
            </div>
          )}
        </div>

        {/* Panel de resolución inline */}
        {editSection === "resolver" && (
          <div className="mb-5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-5 space-y-3">
            <p className="text-sm font-semibold text-emerald-400">Marcar como resuelto</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Fecha de resolución</label>
                <input type="date" className={inp} value={resolvedDate}
                  onChange={e => setResolvedDate(e.target.value)}
                  defaultValue={new Date().toISOString().split("T")[0]} />
              </div>
              <div>
                <label className={lbl}>Monto de liquidación (ARS)</label>
                <input type="number" className={inp} value={resolutionAmount}
                  onChange={e => setResolutionAmount(e.target.value)} placeholder="0" />
              </div>
              <div className="col-span-2">
                <label className={lbl}>Notas de resolución</label>
                <textarea className={inp + " resize-none"} rows={2} value={resolutionNotes}
                  onChange={e => setResolutionNotes(e.target.value)} placeholder="Cómo se resolvió el siniestro..." />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={cancelEdit} className="px-3 py-1.5 bg-[#1f2937] text-gray-300 text-xs rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
              <button onClick={() => save({
                status: "resuelto", resolved: 1,
                resolvedDate: resolvedDate || new Date().toISOString().split("T")[0],
                resolutionNotes: resolutionNotes || null,
                resolutionAmount: resolutionAmount ? Number(resolutionAmount) : null,
              })} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-all">
                {saving && <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                <CheckCircle className="w-3.5 h-3.5" /> Confirmar resolución
              </button>
            </div>
          </div>
        )}

        {/* Resolución display */}
        {c.status === "resuelto" && (
          <div className="mb-5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-5 py-4 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-400">Siniestro resuelto</p>
              {c.resolvedDate && <p className="text-xs text-gray-400 mt-0.5">Fecha de resolución: {formatDate(c.resolvedDate)}</p>}
              {c.resolutionAmount && <p className="text-xs text-emerald-300 mt-0.5">Monto liquidado: {formatCurrency(c.resolutionAmount)}</p>}
              {c.resolutionNotes && <p className="text-xs text-gray-400 mt-1">{c.resolutionNotes}</p>}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

          {/* Póliza */}
          <Section icon={Building2} title="Póliza vinculada">
            {p ? (
              <>
                <Link href={`/polizas/${p.id}`}>
                  <a className="flex items-center gap-2 hover:text-blue-400 transition-colors group">
                    <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0", typeInfo?.color || "bg-gray-500/10 text-gray-400 border border-gray-500/20")}>
                      {p.type === "automotor" ? <Car className="w-3.5 h-3.5" /> : p.type === "motovehiculo" ? <Bike className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                    </div>
                    <div>
                      <p className="text-sm font-mono font-medium text-white group-hover:text-blue-400">{p.policyNumber}</p>
                      <p className="text-xs text-gray-400">{row.insured?.name} · {row.company?.name}</p>
                    </div>
                  </a>
                </Link>
                <div className="mt-3 space-y-1.5 border-t border-[#1f2937] pt-3">
                  <Row label="Tipo" value={typeInfo?.label} />
                  <Row label="Vigencia" value={p.startDate ? `${formatDate(p.startDate)} → ${formatDate(p.endDate)}` : null} />
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-2 bg-gray-500/10 border border-dashed border-gray-500/20 rounded-xl p-3">
                  <Inbox className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 font-medium">Sin póliza vinculada</p>
                    <p className="text-xs text-gray-600 mt-0.5">Datos cargados manualmente</p>
                  </div>
                </div>
                {(row.claim?.manualInsured || row.claim?.manualCompany || row.claim?.manualPolicyNumber) && (
                  <div className="space-y-1.5">
                    {row.claim.manualInsured && <Row label="Asegurado (manual)" value={row.claim.manualInsured} />}
                    {row.claim.manualCompany && <Row label="Compañía (manual)" value={row.claim.manualCompany} />}
                    {row.claim.manualPolicyNumber && <Row label="N° póliza (aprox.)" value={row.claim.manualPolicyNumber} />}
                    {row.claim.manualPolicyType && POLICY_TYPES[row.claim.manualPolicyType] && (
                      <Row label="Tipo" value={POLICY_TYPES[row.claim.manualPolicyType].label} />
                    )}
                    {row.claim.manualNotes && <Row label="Notas" value={row.claim.manualNotes} />}
                  </div>
                )}
                <Link href="/siniestros">
                  <a className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 transition-colors">
                    <Link2 className="w-3.5 h-3.5" /> Ingresar siniestro desde lista de pendientes
                  </a>
                </Link>
              </div>
            )}
          </Section>

          {/* Datos del siniestro */}
          <Section icon={Calendar} title="Datos del siniestro"
            action={<div className="flex items-center gap-2">{editBtn("siniestro")}{isEditing("siniestro") && saveBtn("siniestro")}</div>}>
            {isEditing("siniestro") ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={lbl}>Fecha *</label>
                    <input type="date" className={inp} value={form.incidentDate || ""} onChange={e => set("incidentDate", e.target.value)} />
                  </div>
                  <div>
                    <label className={lbl}>Hora</label>
                    <input type="time" className={inp} value={form.incidentTime || ""} onChange={e => set("incidentTime", e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className={lbl}>N° de siniestro</label>
                  <input type="text" className={inp} value={form.claimNumber || ""} onChange={e => set("claimNumber", e.target.value)} placeholder="Asignado por la compañía" />
                </div>
                <div>
                  <label className={lbl}>Lugar</label>
                  <input type="text" className={inp} value={form.incidentLocation || ""} onChange={e => set("incidentLocation", e.target.value)} />
                </div>
                <div>
                  <label className={lbl}>Descripción</label>
                  <textarea className={inp + " resize-none"} rows={3} value={form.incidentDescription || ""} onChange={e => set("incidentDescription", e.target.value)} />
                </div>
                <div>
                  <label className={lbl}>Daños</label>
                  <textarea className={inp + " resize-none"} rows={2} value={form.damages || ""} onChange={e => set("damages", e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Row label="Fecha" value={c.incidentDate ? formatDate(c.incidentDate) : null} />
                <Row label="Hora" value={c.incidentTime} />
                <Row label="N° siniestro" value={c.claimNumber} mono />
                <Row label="Lugar" value={c.incidentLocation} />
                {!c.incidentDate && !c.incidentLocation && (
                  <p className="text-xs text-gray-600 italic">Sin datos cargados — editá para completar</p>
                )}
                {c.incidentDescription && (
                  <div className="pt-2 border-t border-[#1f2937]">
                    <p className="text-xs text-gray-500 mb-1">Descripción</p>
                    <p className="text-sm text-gray-300">{c.incidentDescription}</p>
                  </div>
                )}
                {c.damages && (
                  <div className="pt-2 border-t border-[#1f2937]">
                    <p className="text-xs text-gray-500 mb-1">Daños</p>
                    <p className="text-sm text-gray-300">{c.damages}</p>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Tercero */}
          {hasThirdParty && (
            <Section icon={User} title="Datos del tercero"
              action={<div className="flex items-center gap-2">{editBtn("tercero")}{isEditing("tercero") && saveBtn("tercero")}</div>}>
              {isEditing("tercero") ? (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={lbl}>Nombre y apellido</label><input type="text" className={inp} value={form.thirdPartyName || ""} onChange={e => set("thirdPartyName", e.target.value)} /></div>
                  <div><label className={lbl}>DNI / CUIT</label><input type="text" className={inp} value={form.thirdPartyDni || ""} onChange={e => set("thirdPartyDni", e.target.value)} /></div>
                  <div><label className={lbl}>Teléfono</label><input type="text" className={inp} value={form.thirdPartyPhone || ""} onChange={e => set("thirdPartyPhone", e.target.value)} /></div>
                  <div><label className={lbl}>Patente</label><input type="text" className={inp} value={form.thirdPartyVehiclePlate || ""} onChange={e => set("thirdPartyVehiclePlate", e.target.value)} /></div>
                  <div><label className={lbl}>Marca</label><input type="text" className={inp} value={form.thirdPartyVehicleBrand || ""} onChange={e => set("thirdPartyVehicleBrand", e.target.value)} /></div>
                  <div><label className={lbl}>Modelo</label><input type="text" className={inp} value={form.thirdPartyVehicleModel || ""} onChange={e => set("thirdPartyVehicleModel", e.target.value)} /></div>
                  <div><label className={lbl}>Aseguradora</label><input type="text" className={inp} value={form.thirdPartyInsurer || ""} onChange={e => set("thirdPartyInsurer", e.target.value)} /></div>
                  <div><label className={lbl}>N° póliza tercero</label><input type="text" className={inp} value={form.thirdPartyPolicyNumber || ""} onChange={e => set("thirdPartyPolicyNumber", e.target.value)} /></div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {!c.thirdPartyName && !c.thirdPartyVehiclePlate ? (
                    <p className="text-xs text-gray-600 italic">Sin tercero involucrado</p>
                  ) : (
                    <>
                      <Row label="Nombre" value={c.thirdPartyName} />
                      <Row label="DNI / CUIT" value={c.thirdPartyDni} />
                      <Row label="Teléfono" value={c.thirdPartyPhone} />
                      <Row label="Patente" value={c.thirdPartyVehiclePlate} mono />
                      <Row label="Vehículo" value={[c.thirdPartyVehicleBrand, c.thirdPartyVehicleModel].filter(Boolean).join(" ") || null} />
                      <Row label="Aseguradora" value={c.thirdPartyInsurer} />
                      <Row label="N° póliza" value={c.thirdPartyPolicyNumber} mono />
                    </>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Reclamo */}
          <Section icon={ShieldAlert} title="Reclamo a compañía del tercero"
            action={<div className="flex items-center gap-2">{editBtn("reclamo")}{isEditing("reclamo") && saveBtn("reclamo")}</div>}>
            {isEditing("reclamo") ? (
              <div className="space-y-3">
                <div className="flex gap-3">
                  <button onClick={() => set("claimFiled", 1)}
                    className={cn("flex-1 py-2 rounded-lg border text-xs font-medium transition-all",
                      form.claimFiled ? "bg-violet-600/20 border-violet-500/40 text-violet-300" : "bg-[#0d1424] border-[#1f2937] text-gray-400")}>
                    <CheckSquare className="w-3.5 h-3.5 inline mr-1" /> Sí
                  </button>
                  <button onClick={() => set("claimFiled", 0)}
                    className={cn("flex-1 py-2 rounded-lg border text-xs font-medium transition-all",
                      !form.claimFiled ? "bg-gray-600/20 border-gray-500/40 text-gray-300" : "bg-[#0d1424] border-[#1f2937] text-gray-400")}>
                    <X className="w-3.5 h-3.5 inline mr-1" /> No
                  </button>
                </div>
                {!!form.claimFiled && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className={lbl}>Fecha presentación</label><input type="date" className={inp} value={form.claimFiledDate || ""} onChange={e => set("claimFiledDate", e.target.value)} /></div>
                      <div><label className={lbl}>Compañía</label><input type="text" className={inp} value={form.claimCompany || ""} onChange={e => set("claimCompany", e.target.value)} /></div>
                    </div>
                    <div><label className={lbl}>N° expediente / siniestro</label><input type="text" className={inp} value={form.claimNumberThird || ""} onChange={e => set("claimNumberThird", e.target.value)} /></div>
                    <div><label className={lbl}>Notas</label><textarea className={inp + " resize-none"} rows={2} value={form.claimNotes || ""} onChange={e => set("claimNotes", e.target.value)} /></div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {!c.claimFiled ? (
                  <p className="text-xs text-gray-600 italic">Sin reclamo presentado</p>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 mb-2">
                      <CheckSquare className="w-3.5 h-3.5 text-violet-400" />
                      <span className="text-xs text-violet-400 font-medium">Reclamo presentado</span>
                    </div>
                    <Row label="Fecha" value={c.claimFiledDate ? formatDate(c.claimFiledDate) : null} />
                    <Row label="Compañía" value={c.claimCompany} />
                    <Row label="N° expediente" value={c.claimNumberThird} mono />
                    {c.claimNotes && <p className="text-xs text-gray-400 pt-1">{c.claimNotes}</p>}
                  </>
                )}
              </div>
            )}
          </Section>

        </div>
      </div>
    </AppLayout>
  );
}
