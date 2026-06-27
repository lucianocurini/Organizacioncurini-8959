import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { X, Loader2, ListOrdered, Search, RefreshCw, ChevronRight, Plus, Trash2, UserCheck, Car } from "lucide-react";
import { toast } from "sonner";

// ─── Insured Person ───────────────────────────────────────────────────────────
interface InsuredPerson {
  id?: number;
  name: string;
  dni: string;
  birthDate: string;
  relationship: string;
  phone: string;
  email: string;
  notes: string;
}

const EMPTY_PERSON: InsuredPerson = {
  name: "", dni: "", birthDate: "", relationship: "titular",
  phone: "", email: "", notes: "",
};

// ─── Fleet Vehicle ────────────────────────────────────────────────────────────
interface FleetVehicle {
  id?: number;
  brand: string;
  model: string;
  year: string;
  plate: string;
  chasis: string;
  engine: string;
  color: string;
  sumInsured: string;
  notes: string;
}

const EMPTY_VEHICLE: FleetVehicle = {
  brand: "", model: "", year: "", plate: "",
  chasis: "", engine: "", color: "", sumInsured: "", notes: "",
};

// ─── Installment helpers ──────────────────────────────────────────────────────
// Default installment count by vigency period
const VIGENCY_DEFAULT_COUNT: Record<string, number> = { anual: 12, semestral: 6, cuatrimestral: 4 };

// Handles end-of-month overflow: Jan 31 + 1 month → Feb 28/29, not Mar 3
function addMonthsToDate(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.toISOString().split("T")[0];
}

// One installment per month from startDate — billingCycle does not participate
function generateMonthly(startDate: string, count: number, amount: number): InstRow[] {
  if (!startDate || count < 1) return [];
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    dueDate: addMonthsToDate(startDate, i),
    amount: amount || 0,
    notes: "",
  }));
}

function renumber(rows: InstRow[]): InstRow[] {
  return rows.map((r, i) => ({ ...r, number: i + 1 }));
}

// ─── PersonForm sub-component ─────────────────────────────────────────────────
function PersonForm({
  draft, setDraft, inputClass, labelClass, onSave, onCancel,
}: {
  draft: InsuredPerson;
  setDraft: (p: InsuredPerson) => void;
  inputClass: string;
  labelClass: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (k: keyof InsuredPerson, v: string) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className={labelClass}>Nombre completo *</label>
          <input className={inputClass} value={draft.name} onChange={e => set("name", e.target.value)} placeholder="Juan Pérez" />
        </div>
        <div>
          <label className={labelClass}>DNI</label>
          <input className={inputClass} value={draft.dni} onChange={e => set("dni", e.target.value)} placeholder="30123456" />
        </div>
        <div>
          <label className={labelClass}>Fecha de nacimiento</label>
          <input className={inputClass} type="date" value={draft.birthDate} onChange={e => set("birthDate", e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Relación</label>
          <select className={inputClass} value={draft.relationship} onChange={e => set("relationship", e.target.value)}>
            <option value="titular">Titular</option>
            <option value="cónyuge">Cónyuge</option>
            <option value="hijo">Hijo/a</option>
            <option value="empleado">Empleado</option>
            <option value="otro">Otro</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Teléfono</label>
          <input className={inputClass} value={draft.phone} onChange={e => set("phone", e.target.value)} placeholder="+54 11 1234-5678" />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Email</label>
          <input className={inputClass} type="email" value={draft.email} onChange={e => set("email", e.target.value)} placeholder="juan@email.com" />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Notas</label>
          <input className={inputClass} value={draft.notes} onChange={e => set("notes", e.target.value)} placeholder="Opcional..." />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">Cancelar</button>
        <button
          type="button"
          onClick={() => { if (!draft.name.trim()) return; onSave(); }}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >Guardar persona</button>
      </div>
    </div>
  );
}

function VehicleForm({
  draft, setDraft, inputClass, labelClass, onSave, onCancel,
}: {
  draft: FleetVehicle;
  setDraft: (v: FleetVehicle) => void;
  inputClass: string;
  labelClass: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (k: keyof FleetVehicle, v: string) => setDraft({ ...draft, [k]: v });
  return (
    <div className="border border-blue-400/20 rounded-xl p-3 bg-[#0f1623] space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div><label className={labelClass}>Marca</label><input className={inputClass} value={draft.brand} onChange={e => set("brand", e.target.value)} placeholder="Toyota" /></div>
        <div><label className={labelClass}>Modelo</label><input className={inputClass} value={draft.model} onChange={e => set("model", e.target.value)} placeholder="Hilux" /></div>
        <div><label className={labelClass}>Año</label><input className={inputClass} type="number" value={draft.year} onChange={e => set("year", e.target.value)} placeholder="2022" /></div>
        <div><label className={labelClass}>Patente</label><input className={inputClass} value={draft.plate} onChange={e => set("plate", e.target.value)} placeholder="AB 123 CD" /></div>
        <div><label className={labelClass}>N° Chasis</label><input className={inputClass} value={draft.chasis} onChange={e => set("chasis", e.target.value)} placeholder="9BWZZZ377VT004251" /></div>
        <div><label className={labelClass}>N° Motor</label><input className={inputClass} value={draft.engine} onChange={e => set("engine", e.target.value)} placeholder="ABC12345" /></div>
        <div><label className={labelClass}>Color</label><input className={inputClass} value={draft.color} onChange={e => set("color", e.target.value)} placeholder="Blanco" /></div>
        <div><label className={labelClass}>Suma asegurada</label><input className={inputClass} type="number" value={draft.sumInsured} onChange={e => set("sumInsured", e.target.value)} placeholder="0.00" /></div>
        <div className="col-span-2"><label className={labelClass}>Notas</label><input className={inputClass} value={draft.notes} onChange={e => set("notes", e.target.value)} placeholder="Opcional..." /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">Cancelar</button>
        <button
          type="button"
          onClick={() => { if (!draft.brand.trim() && !draft.plate.trim()) return; onSave(); }}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >Guardar vehículo</button>
      </div>
    </div>
  );
}

interface Props {
  initial: { policy: any; company: any; insured: any } | null;
  onClose: () => void;
  onSaved: () => void;
}

// Auto-calculate end date from start + vigency period
function calcEndDate(start: string, period: string): string {
  if (!start || !period || period === "anual") return "";
  const d = new Date(start);
  if (period === "cuatrimestral") d.setMonth(d.getMonth() + 4);
  if (period === "semestral") d.setMonth(d.getMonth() + 6);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

interface InstRow { number: number; dueDate: string; amount: number; notes: string; }

export function PolicyModal({ initial, onClose, onSaved }: Props) {
  const isEdit = !!initial;
  const [companies, setCompanies] = useState<any[]>([]);
  const [insureds, setInsureds] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [insuredQ, setInsuredQ] = useState("");
  const [installmentRows, setInstallmentRows] = useState<InstRow[]>([]);
  const [showInstallments, setShowInstallments] = useState(false);
  const [installmentCount, setInstallmentCount] = useState(!isEdit ? 12 : 0);
  const [installmentsDirty, setInstallmentsDirty] = useState(false);

  // Renewal search state
  const [renewalQ, setRenewalQ] = useState("");
  const [renewalResults, setRenewalResults] = useState<any[]>([]);
  const [renewalSearching, setRenewalSearching] = useState(false);
  const [renewedFrom, setRenewedFrom] = useState<any | null>(null); // póliza seleccionada
  const renewalDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Insured persons (accidentes / ART)
  const [insuredPersons, setInsuredPersons] = useState<InsuredPerson[]>([]);
  const [addingPerson, setAddingPerson] = useState(false);
  const [editingPersonIdx, setEditingPersonIdx] = useState<number | null>(null);
  const [personDraft, setPersonDraft] = useState<InsuredPerson>(EMPTY_PERSON);

  const [fleetVehicles, setFleetVehicles] = useState<FleetVehicle[]>([]);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [editingVehicleIdx, setEditingVehicleIdx] = useState<number | null>(null);
  const [vehicleDraft, setVehicleDraft] = useState<FleetVehicle>(EMPTY_VEHICLE);

  const [form, setForm] = useState({
    policyNumber: "",
    type: "automotor",
    companyId: "",
    insuredId: "",
    // Cobertura y montos
    coverageType: "",
    premium: "",
    sumInsured: "",
    monthlyFee: "",
    deductible: "",
    billingCycle: "",
    installments: "",
    paymentMethod: "",
    // Vigencia
    vigencyPeriod: "anual",
    startDate: new Date().toISOString().split("T")[0],
    endDate: "",
    notes: "",
    // Automotor
    vehicleBrand: "",
    vehicleModel: "",
    vehicleYear: "",
    vehiclePlate: "",
    // Moto
    motoBrand: "",
    motoModel: "",
    motoYear: "",
    motoPlate: "",
    motoEngine: "",
    // Hogar
    propertyAddress: "",
    // Integrales
    businessName: "",
    businessActivity: "",
    isFleet: false,
  });

  useEffect(() => {
    api.get("/api/companies").then(setCompanies);
    api.get("/api/insureds").then(setInsureds);
  }, []);

  // Load insured persons when editing an accidentes/ART policy
  useEffect(() => {
    if (isEdit && (initial.policy.type === "accidentes" || initial.policy.type === "art" || initial.policy.type === "vida")) {
      api.get(`/api/policies/${initial.policy.id}/insured-persons`)
        .then((persons: any[]) => setInsuredPersons(persons || []))
        .catch(() => {});
    }
  }, [isEdit]);

  // Load fleet vehicles when editing an automotor fleet policy
  useEffect(() => {
    if (isEdit && initial.policy.type === "automotor" && initial.policy.isFleet) {
      api.get(`/api/policies/${initial.policy.id}/fleet-vehicles`)
        .then((vs: any[]) => setFleetVehicles((vs || []).map((v: any) => ({
          id: v.id,
          brand: v.brand || "", model: v.model || "",
          year: v.year ? String(v.year) : "", plate: v.plate || "",
          chasis: v.chasis || "", engine: v.engine || "",
          color: v.color || "", sumInsured: v.sumInsured ? String(v.sumInsured) : "",
          notes: v.notes || "",
        }))))
        .catch(() => {});
    }
  }, [isEdit]);

  useEffect(() => {
    if (initial) {
      const p = initial.policy;
      setForm({
        policyNumber: p.policyNumber || "",
        type: p.type || "automotor",
        companyId: String(p.companyId || ""),
        insuredId: String(p.insuredId || ""),
        coverageType: p.coverageType || "",
        premium: String(p.premium || ""),
        sumInsured: String(p.sumInsured || ""),
        monthlyFee: String(p.monthlyFee || ""),
        deductible: String(p.deductible || ""),
        billingCycle: p.billingCycle || "",
        installments: String(p.installments || ""),
        paymentMethod: p.paymentMethod || "",
        vigencyPeriod: p.vigencyPeriod || "anual",
        startDate: p.startDate || "",
        endDate: p.endDate || "",
        notes: p.notes || "",
        vehicleBrand: p.vehicleBrand || "",
        vehicleModel: p.vehicleModel || "",
        vehicleYear: String(p.vehicleYear || ""),
        vehiclePlate: p.vehiclePlate || "",
        motoBrand: p.motoBrand || "",
        motoModel: p.motoModel || "",
        motoYear: String(p.motoYear || ""),
        motoPlate: p.motoPlate || "",
        motoEngine: p.motoEngine || "",
        propertyAddress: p.propertyAddress || "",
        businessName: p.businessName || "",
        businessActivity: p.businessActivity || "",
        isFleet: !!p.isFleet,
      });
    }
  }, [initial]);

  // Renewal search debounce
  useEffect(() => {
    if (!renewalQ.trim() || renewalQ.length < 2) { setRenewalResults([]); return; }
    if (renewalDebounceRef.current) clearTimeout(renewalDebounceRef.current);
    renewalDebounceRef.current = setTimeout(async () => {
      setRenewalSearching(true);
      try {
        const results = await api.get(`/api/policies?q=${encodeURIComponent(renewalQ)}`);
        setRenewalResults(Array.isArray(results) ? results.slice(0, 6) : []);
      } catch {
        setRenewalResults([]);
      }
      setRenewalSearching(false);
    }, 350);
  }, [renewalQ]);

  function applyRenewal(item: any) {
    const p = item.policy;
    // Copy all data except policyNumber and dates (user must fill those for the new policy)
    setForm(f => ({
      ...f,
      type: p.type || f.type,
      companyId: String(p.companyId || f.companyId),
      insuredId: String(p.insuredId || f.insuredId),
      coverageType: p.coverageType || "",
      premium: p.premium ? String(p.premium) : "",
      sumInsured: p.sumInsured ? String(p.sumInsured) : "",
      monthlyFee: p.monthlyFee ? String(p.monthlyFee) : "",
      deductible: p.deductible ? String(p.deductible) : "",
      billingCycle: p.billingCycle || "",
      paymentMethod: p.paymentMethod || "",
      vigencyPeriod: p.vigencyPeriod || "anual",
      notes: p.notes || "",
      vehicleBrand: p.vehicleBrand || "",
      vehicleModel: p.vehicleModel || "",
      vehicleYear: p.vehicleYear ? String(p.vehicleYear) : "",
      vehiclePlate: p.vehiclePlate || "",
      motoBrand: p.motoBrand || "",
      motoModel: p.motoModel || "",
      motoYear: p.motoYear ? String(p.motoYear) : "",
      motoPlate: p.motoPlate || "",
      motoEngine: p.motoEngine || "",
      propertyAddress: p.propertyAddress || "",
      businessName: p.businessName || "",
      businessActivity: p.businessActivity || "",
      isFleet: !!p.isFleet,
      // policyNumber, startDate, endDate: intentionally NOT copied
    }));
    // Set the insured search filter too
    if (item.insured?.name) setInsuredQ(item.insured.name);
    setRenewedFrom(item);
    setRenewalQ("");
    setRenewalResults([]);
    toast.success(`Datos cargados desde póliza ${p.policyNumber}`);
  }

  const set = (key: string, val: string) => {
    setForm(f => {
      const next = { ...f, [key]: val };
      if ((key === "vigencyPeriod" || key === "startDate") && next.vigencyPeriod !== "anual" && next.startDate) {
        next.endDate = calcEndDate(next.startDate, next.vigencyPeriod);
      }
      if (key === "type") next.coverageType = "";
      return next;
    });
    if (!isEdit) {
      if (key === "vigencyPeriod" && !installmentsDirty) {
        const suggested = VIGENCY_DEFAULT_COUNT[val];
        if (suggested) {
          setInstallmentCount(suggested);
          if (form.startDate) setInstallmentRows(generateMonthly(form.startDate, suggested, Number(form.monthlyFee) || 0));
        }
      } else if (key === "startDate" && !installmentsDirty && installmentCount > 0) {
        setInstallmentRows(generateMonthly(val, installmentCount, Number(form.monthlyFee) || 0));
      } else if (key === "monthlyFee" && !installmentsDirty && installmentCount > 0 && form.startDate) {
        setInstallmentRows(generateMonthly(form.startDate, installmentCount, Number(val) || 0));
      }
    }
  };

  // New policy: generate initial installment rows on mount (12 default for anual vigency)
  useEffect(() => {
    if (!isEdit) {
      const today = new Date().toISOString().split("T")[0];
      setInstallmentRows(generateMonthly(today, 12, 0));
    }
  }, []);

  const filteredInsureds = insureds.filter(i =>
    i.name.toLowerCase().includes(insuredQ.toLowerCase()) ||
    (i.dni || "").includes(insuredQ)
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const payload: any = {
        ...form,
        companyId: Number(form.companyId),
        insuredId: Number(form.insuredId),
        premium: form.premium ? Number(form.premium) : null,
        sumInsured: form.sumInsured ? Number(form.sumInsured) : null,
        monthlyFee: form.monthlyFee ? Number(form.monthlyFee) : null,
        deductible: form.deductible ? Number(form.deductible) : null,
        billingCycle: form.billingCycle || null,
        vigencyPeriod: form.vigencyPeriod || null,
        installments: isEdit ? (form.installments ? Number(form.installments) : null) : (installmentRows.length || null),
        vehicleYear: form.vehicleYear ? Number(form.vehicleYear) : null,
        motoYear: form.motoYear ? Number(form.motoYear) : null,
        renewedFromId: renewedFrom ? renewedFrom.policy.id : null,
        isFleet: form.isFleet ? 1 : 0,
      };
      if (isEdit) {
        await api.put(`/api/policies/${initial.policy.id}`, payload);
        // Sync insured persons for accidentes/ART (delete all, re-add)
        if (form.type === "accidentes" || form.type === "art" || form.type === "vida") {
          const existing: any[] = await api.get(`/api/policies/${initial.policy.id}/insured-persons`);
          for (const p of existing) {
            await api.delete(`/api/policies/${initial.policy.id}/insured-persons/${p.id}`);
          }
          for (const p of insuredPersons) {
            const { id: _id, ...rest } = p;
            await api.post(`/api/policies/${initial.policy.id}/insured-persons`, rest);
          }
        }
        // Sync fleet vehicles for automotor fleet (delete all, re-add)
        if (form.type === "automotor" && form.isFleet) {
          const existing: any[] = await api.get(`/api/policies/${initial.policy.id}/fleet-vehicles`);
          for (const v of existing) {
            await api.delete(`/api/policies/${initial.policy.id}/fleet-vehicles/${v.id}`);
          }
          for (const v of fleetVehicles) {
            const { id: _id, ...rest } = v;
            await api.post(`/api/policies/${initial.policy.id}/fleet-vehicles`, {
              ...rest,
              year: rest.year ? Number(rest.year) : null,
              sumInsured: rest.sumInsured ? Number(rest.sumInsured) : null,
            });
          }
        }
        toast.success("Póliza actualizada");
      } else {
        const policy = await api.post("/api/policies", payload);
        // Save installments if any
        if (installmentRows.length > 0 && policy.id) {
          await api.post(`/api/policies/${policy.id}/installments/generate`, { installments: installmentRows });
        }
        // Save insured persons for accidentes/ART
        if ((form.type === "accidentes" || form.type === "art" || form.type === "vida") && policy.id) {
          for (const p of insuredPersons) {
            const { id: _id, ...rest } = p;
            await api.post(`/api/policies/${policy.id}/insured-persons`, rest);
          }
        }
        // Save fleet vehicles for automotor fleet
        if (form.type === "automotor" && form.isFleet && policy.id) {
          for (const v of fleetVehicles) {
            const { id: _id, ...rest } = v;
            await api.post(`/api/policies/${policy.id}/fleet-vehicles`, {
              ...rest,
              year: rest.year ? Number(rest.year) : null,
              sumInsured: rest.sumInsured ? Number(rest.sumInsured) : null,
            });
          }
        }
        toast.success("Póliza creada");
      }
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputClass = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";
  const labelClass = "block text-xs text-gray-400 mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-2xl my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
            {isEdit ? "Editar Póliza" : "Nueva Póliza"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">

          {/* Renewal search — only on new policy */}
          {!isEdit && (
            <div className="border border-[#253050] rounded-xl bg-[#0d1424] p-4">
              <div className="flex items-center gap-2 mb-3">
                <RefreshCw className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Renovación</span>
                {renewedFrom && (
                  <button
                    type="button"
                    onClick={() => { setRenewedFrom(null); setInsuredQ(""); }}
                    className="ml-auto text-xs text-gray-500 hover:text-red-400 transition-colors flex items-center gap-1"
                  >
                    <X className="w-3 h-3" /> Quitar
                  </button>
                )}
              </div>

              {renewedFrom ? (
                // Póliza seleccionada — mostrar resumen
                <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                  <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{renewedFrom.policy.policyNumber}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {renewedFrom.insured?.name} · {renewedFrom.company?.name} · vencía {renewedFrom.policy.endDate}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-blue-400 flex-shrink-0" />
                  <span className="text-xs text-blue-400 font-medium flex-shrink-0">Datos cargados</span>
                </div>
              ) : (
                // Buscador
                <div className="relative">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Buscar por N° de póliza o nombre del asegurado..."
                      value={renewalQ}
                      onChange={e => setRenewalQ(e.target.value)}
                      className="w-full pl-9 pr-4 py-2 bg-[#111827] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-all"
                    />
                    {renewalSearching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-gray-500" />}
                  </div>
                  {renewalResults.length > 0 && (
                    <div className="absolute z-10 top-full mt-1 w-full bg-[#111827] border border-[#253050] rounded-xl shadow-xl overflow-hidden">
                      {renewalResults.map((item: any) => (
                        <button
                          key={item.policy.id}
                          type="button"
                          onClick={() => applyRenewal(item)}
                          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#1a2540] transition-colors text-left border-b border-[#1a2540] last:border-0"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white font-medium truncate">{item.policy.policyNumber}</p>
                            <p className="text-xs text-gray-400 truncate">
                              {item.insured?.name} · {item.company?.name}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-xs text-gray-500">{item.policy.type}</p>
                            <p className="text-xs text-gray-600">vence {item.policy.endDate}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {renewalQ.length >= 2 && !renewalSearching && renewalResults.length === 0 && (
                    <p className="text-xs text-gray-600 mt-2 pl-1">Sin resultados para "{renewalQ}"</p>
                  )}
                  <p className="text-xs text-gray-600 mt-2">Si es renovación, buscá la póliza anterior para pre-cargar sus datos. Si no, dejá vacío.</p>
                </div>
              )}
            </div>
          )}

          {/* N° Póliza + Tipo */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>N° de Póliza *</label>
              <input className={inputClass} value={form.policyNumber} onChange={e => set("policyNumber", e.target.value)} placeholder="AUT-2024-001" required />
            </div>
            <div>
              <label className={labelClass}>Tipo *</label>
              <select className={inputClass} value={form.type} onChange={e => set("type", e.target.value)} required>
                <option value="automotor">Automotor</option>
                <option value="motovehiculo">Motovehículo</option>
                <option value="vida">Vida Obligatorio</option>
                <option value="ecomovilidad">Ecomovilidad</option>
                <option value="hogar">Hogar / Propiedad</option>
                <option value="accidentes">Accidentes Personales</option>
                <option value="art">ART</option>
                <option value="comercial">Integrales</option>
                <option value="responsabilidad_civil">Responsabilidad Civil</option>
                <option value="cascos">Cascos</option>
                <option value="incendio">Incendio</option>
              </select>
            </div>
          </div>

          {/* Compañía + Asegurado */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Compañía Aseguradora *</label>
              <select className={inputClass} value={form.companyId} onChange={e => set("companyId", e.target.value)} required>
                <option value="">Seleccionar...</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Asegurado *</label>
              <input
                className={inputClass + " mb-1"}
                placeholder="Buscar asegurado..."
                value={insuredQ}
                onChange={e => setInsuredQ(e.target.value)}
              />
              <select className={inputClass} value={form.insuredId} onChange={e => set("insuredId", e.target.value)} required>
                <option value="">Seleccionar...</option>
                {filteredInsureds.map(i => <option key={i.id} value={i.id}>{i.name} {i.dni ? `— ${i.dni}` : ""}</option>)}
              </select>
            </div>
          </div>

          {/* Cobertura + Franquicia */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Tipo de Cobertura</label>
              <select className={inputClass} value={form.coverageType} onChange={e => set("coverageType", e.target.value)}>
                <option value="">Seleccionar...</option>
                {(form.type === "automotor" || form.type === "motovehiculo") && <>
                  <option value="responsabilidad_civil">Responsabilidad Civil</option>
                  <option value="terceros_completo">Terceros Completo</option>
                  <option value="terceros_con_incendio_robo">Terceros + Incendio y Robo</option>
                  <option value="todo_riesgo">Todo Riesgo</option>
                  <option value="todo_riesgo_con_franquicia">Todo Riesgo con Franquicia</option>
                </>}
                {form.type === "hogar" && <>
                  <option value="incendio">Incendio</option>
                  <option value="integral_hogar">Integral Hogar</option>
                  <option value="integral_hogar_ampliado">Integral Hogar Ampliado</option>
                  <option value="todo_riesgo">Todo Riesgo</option>
                </>}
                {form.type === "accidentes" && <>
                  <option value="accidentes_personales">Accidentes Personales</option>
                  <option value="accidentes_24hs">Accidentes 24hs</option>
                  <option value="accidentes_laborales">Accidentes Laborales</option>
                </>}
                {form.type === "art" && <>
                  <option value="art_personal_domestico">Personal Doméstico</option>
                  <option value="art_sistema_general">Sistema General</option>
                </>}
                {form.type === "vida" && <>
                  <option value="vida_obligatorio">Vida Obligatorio</option>
                  <option value="vida_colectivo">Vida Colectivo</option>
                  <option value="vida_saldo_deudor">Saldo Deudor</option>
                </>}
                {form.type === "ecomovilidad" && <>
                  <option value="eco_bicicleta">Bicicleta</option>
                  <option value="eco_monopatin">Monopatín</option>
                </>}
                {form.type === "responsabilidad_civil" && <>
                  <option value="rc_general">RC General</option>
                  <option value="rc_productos">RC Productos</option>
                  <option value="rc_locativa">RC Locativa</option>
                  <option value="rc_patronal">RC Patronal</option>
                </>}
                {form.type === "cascos" && <>
                  <option value="cascos_flotante">Casco Flotante</option>
                  <option value="cascos_especifico">Casco Específico</option>
                </>}
                {form.type === "incendio" && <>
                  <option value="incendio_edificio">Incendio Edificio</option>
                  <option value="incendio_contenido">Incendio Contenido</option>
                  <option value="incendio_integral">Incendio Integral</option>
                </>}
                {form.type === "comercial" && <>
                  <option value="integral_comercio">Integral de Comercio</option>
                  <option value="integral_consorcio">Integral de Consorcio</option>
                  <option value="integral_hotelero">Integral Hotelero</option>
                </>}
              </select>
            </div>
            <div>
              <label className={labelClass}>Franquicia (ARS)</label>
              <input
                className={inputClass}
                type="number"
                value={form.deductible}
                onChange={e => set("deductible", e.target.value)}
                placeholder="Ingresá el valor de la franquicia"
              />
            </div>
          </div>

          {/* Montos */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Importe por cuota (ARS)</label>
              <input className={inputClass} type="number" value={form.monthlyFee} onChange={e => set("monthlyFee", e.target.value)} placeholder="4500" />
            </div>
            <div>
              <label className={labelClass}>Prima / Monto Total (ARS)</label>
              <input className={inputClass} type="number" value={form.premium} onChange={e => set("premium", e.target.value)} placeholder="54000" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Suma Asegurada (ARS)</label>
              <input className={inputClass} type="number" value={form.sumInsured} onChange={e => set("sumInsured", e.target.value)} placeholder="2500000" />
            </div>
            {!isEdit && (
              <div>
                <label className={labelClass}>Cantidad de cuotas</label>
                <input
                  className={inputClass}
                  type="number"
                  min="1"
                  value={installmentCount || ""}
                  placeholder="12"
                  onChange={e => {
                    const n = Math.max(1, Number(e.target.value) || 1);
                    setInstallmentCount(n);
                    if (form.startDate) {
                      setInstallmentRows(generateMonthly(form.startDate, n, Number(form.monthlyFee) || 0));
                      setInstallmentsDirty(false);
                    }
                  }}
                />
              </div>
            )}
          </div>

          {/* Refacturación + Tipo de Pago */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Frecuencia de refacturación</label>
              <select className={inputClass} value={form.billingCycle} onChange={e => set("billingCycle", e.target.value)}>
                <option value="">Sin refacturación</option>
                <option value="mensual">Mensual</option>
                <option value="trimestral">Trimestral</option>
                <option value="cuatrimestral">Cuatrimestral</option>
                <option value="semestral">Semestral</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Tipo de Pago</label>
              <select className={inputClass} value={form.paymentMethod} onChange={e => set("paymentMethod", e.target.value)}>
                <option value="">Sin definir</option>
                <option value="manual">Manual</option>
                <option value="cbu">Débito en CBU</option>
                <option value="tarjeta_credito">Débito en Tarjeta de Crédito</option>
              </select>
            </div>
          </div>

          {/* Vigencia */}
          <div className="border border-[#1f2937] rounded-xl p-4 bg-[#0d1424] space-y-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Vigencia</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className={labelClass}>Período</label>
                <select className={inputClass} value={form.vigencyPeriod} onChange={e => set("vigencyPeriod", e.target.value)}>
                  <option value="anual">Anual (12m)</option>
                  <option value="semestral">Semestral (6m)</option>
                  <option value="cuatrimestral">Cuatrimestral (4m)</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Desde *</label>
                <input className={inputClass} type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} required />
              </div>
              <div>
                <label className={labelClass}>Hasta *</label>
                <input className={inputClass} type="date" value={form.endDate} onChange={e => set("endDate", e.target.value)} required />
              </div>
            </div>
            {form.vigencyPeriod !== "anual" && (
              <p className="text-xs text-blue-400">
                La fecha de fin se calculó automáticamente según el período seleccionado.
              </p>
            )}
          </div>

          {/* Automotor fields */}
          {form.type === "automotor" && (
            <div className="border border-blue-500/20 rounded-xl p-4 bg-blue-500/5 space-y-4">
              {/* Fleet toggle */}
              <div className="flex items-center justify-between">
                <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Datos del Vehículo</p>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <span className="text-xs text-gray-400">Póliza de Flota</span>
                  <div
                    onClick={() => { setForm(f => ({ ...f, isFleet: !f.isFleet })); setFleetVehicles([]); setAddingVehicle(false); }}
                    className={`relative w-10 h-5 rounded-full transition-colors ${form.isFleet ? "bg-blue-500" : "bg-gray-600"}`}
                  >
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.isFleet ? "translate-x-5" : "translate-x-0.5"}`} />
                  </div>
                </label>
              </div>

              {/* Individual vehicle fields (shown when NOT fleet) */}
              {!form.isFleet && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={labelClass}>Marca</label><input className={inputClass} value={form.vehicleBrand} onChange={e => set("vehicleBrand", e.target.value)} placeholder="Toyota" /></div>
                  <div><label className={labelClass}>Modelo</label><input className={inputClass} value={form.vehicleModel} onChange={e => set("vehicleModel", e.target.value)} placeholder="Corolla" /></div>
                  <div><label className={labelClass}>Año</label><input className={inputClass} type="number" value={form.vehicleYear} onChange={e => set("vehicleYear", e.target.value)} placeholder="2021" /></div>
                  <div><label className={labelClass}>Patente</label><input className={inputClass} value={form.vehiclePlate} onChange={e => set("vehiclePlate", e.target.value)} placeholder="AB 123 CD" /></div>
                </div>
              )}

              {/* Fleet vehicles section */}
              {form.isFleet && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Car className="w-4 h-4 text-blue-400" />
                      <span className="text-xs text-blue-300 font-medium">{fleetVehicles.length} vehículo{fleetVehicles.length !== 1 ? "s" : ""} en flota</span>
                    </div>
                    {!addingVehicle && editingVehicleIdx === null && (
                      <button
                        type="button"
                        onClick={() => { setVehicleDraft(EMPTY_VEHICLE); setAddingVehicle(true); }}
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-lg px-2.5 py-1.5 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> Agregar vehículo
                      </button>
                    )}
                  </div>

                  {fleetVehicles.length === 0 && !addingVehicle && (
                    <p className="text-xs text-gray-500 text-center py-3">No hay vehículos cargados. Agregá al menos 2 para una flota.</p>
                  )}

                  {/* Existing vehicles list */}
                  {fleetVehicles.map((v, idx) => (
                    editingVehicleIdx === idx ? (
                      <VehicleForm
                        key={idx}
                        draft={vehicleDraft}
                        setDraft={setVehicleDraft}
                        inputClass={inputClass}
                        labelClass={labelClass}
                        onSave={() => {
                          setFleetVehicles(vs => vs.map((v, i) => i === idx ? { ...vehicleDraft, id: v.id } : v));
                          setEditingVehicleIdx(null);
                          setVehicleDraft(EMPTY_VEHICLE);
                        }}
                        onCancel={() => { setEditingVehicleIdx(null); setVehicleDraft(EMPTY_VEHICLE); }}
                      />
                    ) : (
                      <div key={idx} className="flex items-center justify-between bg-[#0f1623] border border-blue-500/10 rounded-lg px-3 py-2">
                        <div>
                          <p className="text-sm text-white font-medium">{[v.brand, v.model, v.year].filter(Boolean).join(" ")} {v.plate && <span className="text-blue-400 ml-1 font-mono text-xs">{v.plate}</span>}</p>
                          <p className="text-xs text-gray-500">{[v.color, v.chasis && `Chasis: ${v.chasis}`, v.engine && `Motor: ${v.engine}`].filter(Boolean).join(" · ")}</p>
                        </div>
                        <div className="flex items-center gap-2 ml-3 shrink-0">
                          <button type="button" onClick={() => { setVehicleDraft({ ...v }); setEditingVehicleIdx(idx); }} className="text-xs text-gray-400 hover:text-blue-400 transition-colors">Editar</button>
                          <button type="button" onClick={() => setFleetVehicles(vs => vs.filter((_, i) => i !== idx))} className="text-gray-500 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    )
                  ))}

                  {/* Add new vehicle form */}
                  {addingVehicle && (
                    <VehicleForm
                      draft={vehicleDraft}
                      setDraft={setVehicleDraft}
                      inputClass={inputClass}
                      labelClass={labelClass}
                      onSave={() => {
                        setFleetVehicles(vs => [...vs, { ...vehicleDraft }]);
                        setVehicleDraft(EMPTY_VEHICLE);
                        setAddingVehicle(false);
                      }}
                      onCancel={() => { setAddingVehicle(false); setVehicleDraft(EMPTY_VEHICLE); }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Motovehiculo fields */}
          {form.type === "motovehiculo" && (
            <div className="border border-cyan-500/20 rounded-xl p-4 bg-cyan-500/5">
              <p className="text-xs text-cyan-400 font-medium mb-3 uppercase tracking-wider">Datos del Motovehículo</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelClass}>Marca</label><input className={inputClass} value={form.motoBrand} onChange={e => set("motoBrand", e.target.value)} placeholder="Honda" /></div>
                <div><label className={labelClass}>Modelo</label><input className={inputClass} value={form.motoModel} onChange={e => set("motoModel", e.target.value)} placeholder="CB 300" /></div>
                <div><label className={labelClass}>Año</label><input className={inputClass} type="number" value={form.motoYear} onChange={e => set("motoYear", e.target.value)} placeholder="2022" /></div>
                <div><label className={labelClass}>Patente</label><input className={inputClass} value={form.motoPlate} onChange={e => set("motoPlate", e.target.value)} placeholder="A 123 BC" /></div>
                <div className="col-span-2"><label className={labelClass}>Motor / Cilindrada</label><input className={inputClass} value={form.motoEngine} onChange={e => set("motoEngine", e.target.value)} placeholder="300cc" /></div>
              </div>
            </div>
          )}

          {/* Hogar fields */}
          {form.type === "hogar" && (
            <div className="border border-emerald-500/20 rounded-xl p-4 bg-emerald-500/5">
              <p className="text-xs text-emerald-400 font-medium mb-3 uppercase tracking-wider">Datos del Inmueble</p>
              <div><label className={labelClass}>Dirección de la Propiedad</label><input className={inputClass} value={form.propertyAddress} onChange={e => set("propertyAddress", e.target.value)} placeholder="Av. Corrientes 1234, CABA" /></div>
            </div>
          )}

          {/* ART fields */}
          {form.type === "art" && (
            <div className="border border-rose-500/20 rounded-xl p-4 bg-rose-500/5">
              <p className="text-xs text-rose-400 font-medium mb-2 uppercase tracking-wider">ART</p>
              <p className="text-xs text-gray-500">Completá el tipo de cobertura en el campo correspondiente (Personal Doméstico o Sistema General).</p>
            </div>
          )}

          {/* Vida Obligatorio fields */}
          {form.type === "vida" && (
            <div className="border border-violet-500/20 rounded-xl p-4 bg-violet-500/5">
              <p className="text-xs text-violet-400 font-medium mb-2 uppercase tracking-wider">Vida Obligatorio</p>
              <p className="text-xs text-gray-500">Podés cargar la nómina completa de personas aseguradas en la sección de abajo.</p>
            </div>
          )}

          {/* Personas aseguradas — Accidentes / ART / Vida */}
          {(form.type === "accidentes" || form.type === "art" || form.type === "vida") && (
            <div className="border border-blue-500/20 rounded-xl p-4 bg-blue-500/5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-blue-400" />
                  <p className="text-xs text-blue-400 font-medium uppercase tracking-wider">Personas Aseguradas</p>
                </div>
                {!addingPerson && editingPersonIdx === null && (
                  <button
                    type="button"
                    onClick={() => { setPersonDraft(EMPTY_PERSON); setAddingPerson(true); }}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Agregar
                  </button>
                )}
              </div>

              {/* Person list */}
              {insuredPersons.length === 0 && !addingPerson && (
                <p className="text-xs text-gray-500 italic">Sin personas cargadas. Usá el botón "Agregar".</p>
              )}
              {insuredPersons.map((person, idx) => (
                <div key={idx} className="bg-[#1f2937] rounded-lg p-3 space-y-2">
                  {editingPersonIdx === idx ? (
                    // Edit inline form
                    <PersonForm
                      draft={personDraft}
                      setDraft={setPersonDraft}
                      inputClass={inputClass}
                      labelClass={labelClass}
                      onSave={() => {
                        setInsuredPersons(ps => ps.map((p, i) => i === idx ? { ...personDraft, id: p.id } : p));
                        setEditingPersonIdx(null);
                      }}
                      onCancel={() => setEditingPersonIdx(null)}
                    />
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-sm text-white font-medium">{person.name || "—"}</p>
                        <p className="text-xs text-gray-400">
                          {person.relationship && <span className="capitalize">{person.relationship}</span>}
                          {person.dni && <span> · DNI {person.dni}</span>}
                          {person.birthDate && <span> · {person.birthDate}</span>}
                        </p>
                        {(person.phone || person.email) && (
                          <p className="text-xs text-gray-500">{person.phone}{person.phone && person.email ? " · " : ""}{person.email}</p>
                        )}
                        {person.notes && <p className="text-xs text-gray-600 italic">{person.notes}</p>}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => { setPersonDraft({ ...person }); setEditingPersonIdx(idx); setAddingPerson(false); }}
                          className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                        >Editar</button>
                        <button
                          type="button"
                          onClick={() => setInsuredPersons(ps => ps.filter((_, i) => i !== idx))}
                          className="text-gray-500 hover:text-red-400 transition-colors"
                        ><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Add new person form */}
              {addingPerson && (
                <div className="bg-[#1f2937] rounded-lg p-3">
                  <PersonForm
                    draft={personDraft}
                    setDraft={setPersonDraft}
                    inputClass={inputClass}
                    labelClass={labelClass}
                    onSave={() => {
                      setInsuredPersons(ps => [...ps, { ...personDraft }]);
                      setAddingPerson(false);
                      setPersonDraft(EMPTY_PERSON);
                    }}
                    onCancel={() => { setAddingPerson(false); setPersonDraft(EMPTY_PERSON); }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Ecomovilidad fields */}
          {form.type === "ecomovilidad" && (
            <div className="border border-teal-500/20 rounded-xl p-4 bg-teal-500/5">
              <p className="text-xs text-teal-400 font-medium mb-3 uppercase tracking-wider">Datos del Vehículo</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelClass}>Marca</label><input className={inputClass} value={form.vehicleBrand} onChange={e => set("vehicleBrand", e.target.value)} placeholder="Totem, Xiaomi..." /></div>
                <div><label className={labelClass}>Modelo</label><input className={inputClass} value={form.vehicleModel} onChange={e => set("vehicleModel", e.target.value)} placeholder="Pro 2, Essential..." /></div>
                <div><label className={labelClass}>Año</label><input className={inputClass} type="number" value={form.vehicleYear} onChange={e => set("vehicleYear", e.target.value)} placeholder="2023" /></div>
                <div><label className={labelClass}>N° de Serie</label><input className={inputClass} value={form.vehiclePlate} onChange={e => set("vehiclePlate", e.target.value)} placeholder="Número de serie" /></div>
              </div>
            </div>
          )}

          {/* Responsabilidad Civil — no extra fields */}
          {form.type === "responsabilidad_civil" && (
            <div className="border border-yellow-500/20 rounded-xl p-4 bg-yellow-500/5">
              <p className="text-xs text-yellow-400 font-medium mb-2 uppercase tracking-wider">Responsabilidad Civil</p>
              <p className="text-xs text-gray-500">Seleccioná el tipo de RC en el campo de cobertura.</p>
            </div>
          )}

          {/* Cascos — no extra fields */}
          {form.type === "cascos" && (
            <div className="border border-indigo-500/20 rounded-xl p-4 bg-indigo-500/5">
              <p className="text-xs text-indigo-400 font-medium mb-2 uppercase tracking-wider">Cascos</p>
              <p className="text-xs text-gray-500">Seleccioná el tipo de casco (Flotante o Específico) en el campo de cobertura.</p>
            </div>
          )}

          {/* Incendio fields */}
          {form.type === "incendio" && (
            <div className="border border-red-500/20 rounded-xl p-4 bg-red-500/5">
              <p className="text-xs text-red-400 font-medium mb-3 uppercase tracking-wider">Datos del Riesgo</p>
              <div><label className={labelClass}>Dirección del Riesgo</label><input className={inputClass} value={form.propertyAddress} onChange={e => set("propertyAddress", e.target.value)} placeholder="Av. Corrientes 1234, CABA" /></div>
            </div>
          )}

          {/* Integrales fields */}
          {form.type === "comercial" && (
            <div className="border border-purple-500/20 rounded-xl p-4 bg-purple-500/5">
              <p className="text-xs text-purple-400 font-medium mb-3 uppercase tracking-wider">Datos del Riesgo</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelClass}>Razón Social</label><input className={inputClass} value={form.businessName} onChange={e => set("businessName", e.target.value)} placeholder="Mi Empresa SRL" /></div>
                <div><label className={labelClass}>Actividad</label><input className={inputClass} value={form.businessActivity} onChange={e => set("businessActivity", e.target.value)} placeholder="Comercio minorista" /></div>
              </div>
            </div>
          )}

          {/* Plan de cuotas — solo pólizas nuevas */}
          {!isEdit && installmentRows.length > 0 && (
            <div className="border border-amber-500/20 rounded-xl bg-amber-500/5">
              <div className="w-full flex items-center justify-between px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowInstallments(!showInstallments)}
                  className="flex items-center gap-2"
                >
                  <ListOrdered className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-medium text-amber-400 uppercase tracking-wider">
                    Plan de cuotas — {installmentRows.length} cuota{installmentRows.length !== 1 ? "s" : ""}
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  {installmentsDirty && (
                    <button
                      type="button"
                      onClick={() => {
                        setInstallmentRows(generateMonthly(form.startDate, installmentCount, Number(form.monthlyFee) || 0));
                        setInstallmentsDirty(false);
                      }}
                      className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
                      title="Regenerar reemplazará las ediciones manuales"
                    >
                      ↺ Regenerar
                    </button>
                  )}
                  <span className="text-xs text-gray-500 select-none">{showInstallments ? "▲ Ocultar" : "▼ Ver"}</span>
                </div>
              </div>
              {installmentsDirty && (
                <p className="px-4 pb-1 text-xs text-orange-400/70">
                  Editadas manualmente · "Regenerar" vuelve al calendario mensual
                </p>
              )}
              {showInstallments && (
                <div className="px-4 pb-4 space-y-2">
                  <div className="grid grid-cols-[28px_1fr_1fr_1fr_28px] gap-2 text-xs text-gray-500 pb-1">
                    <span>#</span>
                    <span>Vencimiento</span>
                    <span>Importe (ARS)</span>
                    <span>Nota</span>
                    <span />
                  </div>
                  {installmentRows.map((row, i) => (
                    <div key={i} className="grid grid-cols-[28px_1fr_1fr_1fr_28px] gap-2 items-center">
                      <span className="text-xs text-gray-500 font-mono text-center">{row.number}</span>
                      <input
                        type="date"
                        value={row.dueDate}
                        onChange={e => {
                          setInstallmentRows(rows => rows.map((r, j) => j === i ? { ...r, dueDate: e.target.value } : r));
                          setInstallmentsDirty(true);
                        }}
                        className="px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500"
                      />
                      <input
                        type="number"
                        value={row.amount}
                        onChange={e => {
                          setInstallmentRows(rows => rows.map((r, j) => j === i ? { ...r, amount: Number(e.target.value) } : r));
                          setInstallmentsDirty(true);
                        }}
                        className="px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500"
                      />
                      <input
                        type="text"
                        value={row.notes}
                        onChange={e => {
                          setInstallmentRows(rows => rows.map((r, j) => j === i ? { ...r, notes: e.target.value } : r));
                          setInstallmentsDirty(true);
                        }}
                        placeholder="Opcional..."
                        className="px-2 py-1.5 bg-[#1f2937] border border-[#374151] rounded text-white text-xs outline-none focus:border-amber-500 placeholder-gray-600"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const newRows = renumber(installmentRows.filter((_, j) => j !== i));
                          setInstallmentRows(newRows);
                          setInstallmentCount(newRows.length);
                          setInstallmentsDirty(true);
                        }}
                        className="text-gray-600 hover:text-red-400 transition-colors flex items-center justify-center"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const last = installmentRows[installmentRows.length - 1];
                      const nextDate = last?.dueDate ? addMonthsToDate(last.dueDate, 1) : (form.startDate || "");
                      const newRow: InstRow = { number: installmentRows.length + 1, dueDate: nextDate, amount: Number(form.monthlyFee) || 0, notes: "" };
                      setInstallmentRows(rows => [...rows, newRow]);
                      setInstallmentCount(c => c + 1);
                      setInstallmentsDirty(true);
                    }}
                    className="flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-400 transition-colors mt-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Agregar cuota
                  </button>
                  {installmentRows.some(r => !r.amount) && (
                    <p className="text-xs text-yellow-500/70 pt-1">Algunas cuotas tienen importe $0. Verificá antes de guardar.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Cuotas existentes — mensaje informativo en modo edición */}
          {isEdit && (
            <div className="border border-[#1f2937] rounded-xl px-4 py-3 bg-[#0d1424]">
              <p className="text-xs text-gray-500">
                Las cuotas existentes se administran por separado y no se modifican al guardar la póliza.
              </p>
            </div>
          )}

          {/* Observaciones */}
          <div>
            <label className={labelClass}>Observaciones</label>
            <textarea className={inputClass} rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Notas adicionales..." />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
              Cancelar
            </button>
            <button type="submit" disabled={loading} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? "Guardar cambios" : "Crear póliza"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
