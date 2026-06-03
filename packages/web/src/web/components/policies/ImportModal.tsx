import { useState, useRef } from "react";
import { api } from "@/lib/api";
import {
  X, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  Loader2, Download, ChevronDown, ChevronUp, ArrowRight, Info
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { cn } from "@/lib/utils";

interface Props {
  onClose: () => void;
  onImported: () => void;
}

// ─── Field definitions ────────────────────────────────────────────────────────
const SYSTEM_FIELDS: { key: string; label: string; required: boolean; hint?: string }[] = [
  { key: "policyNumber", label: "N° Póliza",         required: true },
  { key: "company",      label: "Compañía",           required: true },
  { key: "insured",      label: "Asegurado",          required: true },
  { key: "startDate",    label: "Vigencia desde",     required: true,  hint: "DD/MM/YYYY" },
  { key: "endDate",      label: "Vigencia hasta",     required: true,  hint: "DD/MM/YYYY" },
  { key: "type",         label: "Tipo de póliza",     required: false, hint: "automotor, hogar, accidentes…" },
  { key: "dni",          label: "DNI / CUIT",         required: false },
  { key: "phone",        label: "Teléfono",           required: false },
  { key: "email",        label: "Email",              required: false },
  { key: "premium",      label: "Prima",              required: false },
  { key: "sumInsured",   label: "Suma asegurada",     required: false },
  { key: "monthlyFee",   label: "Cuota mensual",      required: false },
  { key: "coverageType", label: "Tipo de cobertura",  required: false },
  { key: "deductible",   label: "Franquicia",         required: false },
  { key: "billingCycle", label: "Refacturación",      required: false },
  { key: "vehicleBrand", label: "Marca vehículo",     required: false },
  { key: "vehicleModel", label: "Modelo vehículo",    required: false },
  { key: "vehicleYear",  label: "Año vehículo",       required: false },
  { key: "vehiclePlate", label: "Patente",            required: false },
  { key: "motoEngine",   label: "Motor / Cilindrada", required: false },
  { key: "propertyAddress", label: "Dirección propiedad", required: false },
  { key: "businessName",    label: "Razón social",    required: false },
  { key: "businessActivity",label: "Actividad",       required: false },
  { key: "notes",        label: "Notas",              required: false },
  { key: "isRebilling",  label: "Es refacturación",   required: false, hint: "1=sí, 0=no" },
];

const REQUIRED_FIELDS = SYSTEM_FIELDS.filter(f => f.required).map(f => f.key);

// ─── Auto-detect mapping ──────────────────────────────────────────────────────
const AUTO_MAP: Record<string, string> = {
  "n° póliza":"policyNumber","n póliza":"policyNumber","nro poliza":"policyNumber",
  "numero poliza":"policyNumber","numero de poliza":"policyNumber","poliza":"policyNumber",
  "nro. poliza":"policyNumber","policy number":"policyNumber","póliza":"policyNumber",
  "tipo":"type","type":"type","tipo de poliza":"type","tipo poliza":"type",
  "tipo de póliza":"type","tipopoliza":"type","tipo_poliza":"type","tipo de seguro":"type","ramo":"type",
  "compañia":"company","compañía":"company","aseguradora":"company","company":"company",
  "nombre compañia":"company","compania":"company",
  "asegurado":"insured","insured":"insured","nombre asegurado":"insured","titular":"insured",
  "nombre":"insured","cliente":"insured",
  "dni":"dni","cuit":"dni","documento":"dni","dni/cuit":"dni",
  "telefono":"phone","teléfono":"phone","phone":"phone","tel":"phone","celular":"phone",
  "email":"email","correo":"email","mail":"email","e-mail":"email",
  "prima":"premium","premium":"premium","prima mensual":"premium","importe prima":"premium",
  "suma asegurada":"sumInsured","sum insured":"sumInsured","capital":"sumInsured","capital asegurado":"sumInsured",
  "vigencia desde":"startDate","inicio":"startDate","fecha inicio":"startDate",
  "start date":"startDate","desde":"startDate","fecha desde":"startDate","fecha de inicio":"startDate",
  "vencimiento":"endDate","vigencia hasta":"endDate","fecha vencimiento":"endDate",
  "end date":"endDate","hasta":"endDate","expiry":"endDate","fecha hasta":"endDate","fecha de vencimiento":"endDate",
  "cobertura":"coverageType","tipo de cobertura":"coverageType","coverage":"coverageType",
  "coverage type":"coverageType","tipo cobertura":"coverageType",
  "cuota mensual":"monthlyFee","cuota":"monthlyFee","monthly fee":"monthlyFee",
  "fee":"monthlyFee","importe cuota":"monthlyFee","valor cuota":"monthlyFee",
  "franquicia":"deductible","deductible":"deductible","valor franquicia":"deductible",
  "refacturacion":"billingCycle","refacturación":"billingCycle","billing cycle":"billingCycle",
  "ciclo facturacion":"billingCycle","ciclo":"billingCycle",
  "cuotas":"installments","cantidad cuotas":"installments","cant cuotas":"installments",
  "marca":"vehicleBrand","vehicle brand":"vehicleBrand","marca vehiculo":"vehicleBrand","marca vehículo":"vehicleBrand",
  "modelo":"vehicleModel","vehicle model":"vehicleModel","modelo vehiculo":"vehicleModel","modelo vehículo":"vehicleModel",
  "año":"vehicleYear","year":"vehicleYear","año vehiculo":"vehicleYear","año vehículo":"vehicleYear",
  "patente":"vehiclePlate","dominio":"vehiclePlate","plate":"vehiclePlate","patente vehículo":"vehiclePlate",
  "motor":"motoEngine","cilindrada":"motoEngine","engine":"motoEngine",
  "direccion propiedad":"propertyAddress","domicilio":"propertyAddress","property address":"propertyAddress",
  "propiedad":"propertyAddress","dirección":"propertyAddress","direccion":"propertyAddress",
  "razon social":"businessName","razón social":"businessName","business name":"businessName","empresa":"businessName",
  "actividad":"businessActivity","rubro":"businessActivity","business activity":"businessActivity",
  "notas":"notes","observaciones":"notes","notes":"notes","comentarios":"notes","obs":"notes",
  "es refacturacion":"isRebilling","es refacturación":"isRebilling","is rebilling":"isRebilling",
  "rebilling":"isRebilling","tipo documento":"isRebilling","is_rebilling":"isRebilling",
};

// ─── Normalize helpers ────────────────────────────────────────────────────────
function normalizeDate(val: any): string {
  if (!val) return "";
  if (typeof val === "number") {
    const d = XLSX.SSF.parse_date_code(val);
    return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const s = String(val).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const y = dmy[3].length === 2 ? "20" + dmy[3] : dmy[3];
    return `${y}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return s;
}

function normalizeType(val: string): string {
  const v = (val||"").toLowerCase().trim();
  // "automotor" contiene "moto" — chequear exacto primero
  if (v === "automotor" || v === "auto") return "automotor";
  if (v === "motovehiculo" || v === "motovehículo" || v === "moto") return "motovehiculo";
  if (v.includes("motoveh")) return "motovehiculo";
  if (v.includes("auto")||v.includes("vehiculo")||v.includes("vehículo")) return "automotor";
  if (v.includes("moto")) return "motovehiculo";
  if (v.includes("hogar")||v.includes("propiedad")||v.includes("inmueble")) return "hogar";
  if (v.includes("accidente")||v.includes("personal")) return "accidentes";
  if (v.includes("art")||v.includes("riesgo trabajo")) return "art";
  if (v.includes("eco")||v.includes("bicicleta")||v.includes("monopatin")) return "ecomovilidad";
  if (v.includes("resp")&&v.includes("civil")) return "responsabilidad_civil";
  if (v.includes("casco")) return "cascos";
  if (v.includes("incendio")&&!v.includes("integral")) return "incendio";
  if (v.includes("integral")||v.includes("comercial")||v.includes("empresa")) return "comercial";
  return v || "automotor";
}

function validateRow(row: any): string[] {
  const errs: string[] = [];
  if (!row.policyNumber) errs.push("Falta N° póliza");
  if (!row.company)      errs.push("Falta compañía");
  if (!row.insured)      errs.push("Falta asegurado");
  if (!row.startDate)    errs.push("Falta fecha inicio");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.startDate)) errs.push("Fecha inicio inválida");
  if (!row.endDate)      errs.push("Falta fecha vencimiento");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.endDate)) errs.push("Fecha vencimiento inválida");
  return errs;
}

type Step = "upload" | "mapping" | "preview" | "result";

export function ImportModal({ onClose, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [parseError, setParseError] = useState("");

  // Raw data from file
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[][]>([]);

  // Column mapping: fileColumnIndex -> systemFieldKey | ""
  const [mapping, setMapping] = useState<Record<number, string>>({});

  // Processed rows after mapping
  const [processedRows, setProcessedRows] = useState<{ data: any; errors: string[] }[]>([]);

  // Import result
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // ─── File reading ───────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    setParseError("");
    setFileName(file.name);
    try {
      let headers: string[] = [];
      let rows: any[][] = [];

      if (file.name.match(/\.(xlsx|xls)$/i)) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array", cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        if (raw.length < 2) { setParseError("El archivo no tiene datos."); return; }
        headers = raw[0].map((h: any) => String(h ?? "").trim());
        rows = raw.slice(1).filter(r => r.some((c: any) => c !== ""));
      } else if (file.name.match(/\.(csv|txt)$/i)) {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { setParseError("El archivo no tiene datos."); return; }
        const delim = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
        const parseLine = (l: string) => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));
        headers = parseLine(lines[0]);
        rows = lines.slice(1).map(parseLine);
      } else {
        setParseError("Formato no soportado. Usá .xlsx, .xls, .csv o .txt");
        return;
      }

      if (!headers.length) { setParseError("No se encontraron encabezados."); return; }

      // Auto-detect mapping
      const autoMapping: Record<number, string> = {};
      headers.forEach((h, i) => {
        const key = AUTO_MAP[h.toLowerCase().trim()];
        if (key) autoMapping[i] = key;
      });

      setRawHeaders(headers);
      setRawRows(rows);
      setMapping(autoMapping);
      setStep("mapping");
    } catch (e: any) {
      setParseError("Error al leer el archivo: " + e.message);
    }
  }

  // ─── Apply mapping & validate ───────────────────────────────────────────────
  function applyMapping() {
    const processed = rawRows.map(row => {
      const data: any = {};
      Object.entries(mapping).forEach(([colIdx, fieldKey]) => {
        if (!fieldKey) return;
        let val = row[Number(colIdx)];
        if (val === undefined || val === null || val === "") return;
        if (fieldKey === "startDate" || fieldKey === "endDate") val = normalizeDate(val);
        else if (fieldKey === "type") val = normalizeType(String(val));
        else if (fieldKey === "isRebilling") val = (String(val).trim() === "1" || String(val).toLowerCase().trim() === "si" || String(val).toLowerCase().trim() === "sí" || String(val).toLowerCase().trim() === "refacturacion") ? "1" : "0";
        else val = String(val).trim();
        data[fieldKey] = val;
      });
      return { data, errors: validateRow(data) };
    }).filter(r => Object.keys(r.data).length > 0);

    setProcessedRows(processed);
    setStep("preview");
  }

  // ─── Import ──────────────────────────────────────────────────────────────────
  async function handleImport() {
    setLoading(true);
    try {
      const rows = processedRows.filter(r => r.errors.length === 0).map(r => r.data);
      const res = await api.post("/api/policies/import", { rows });
      setResult(res);
      setStep("result");
      if (res.imported > 0) toast.success(`${res.imported} póliza${res.imported !== 1 ? "s" : ""} importada${res.imported !== 1 ? "s" : ""}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ─── Template download ───────────────────────────────────────────────────────
  function downloadTemplate() {
    const headers = ["N° Póliza","Tipo","Compañía","Asegurado","DNI","Teléfono","Email",
      "Vigencia Desde","Vigencia Hasta","Prima","Suma Asegurada","Cuota Mensual","Cobertura",
      "Marca","Modelo","Año","Patente","Motor",
      "Direccion Propiedad","Razon Social","Actividad","Notas"];
    const examples = [
      ["AUT-2024-001","automotor","La Meridional","Juan Pérez","25.456.789","011-4523-6789","juan@mail.com",
       "01/01/2024","01/01/2025","45000","2500000","15000","Todo Riesgo",
       "Toyota","Corolla","2021","AB 123 CD","","","","","Cobertura completa"],
      ["MOTO-2024-001","motovehiculo","La Meridional","García Luis","30.111.222","011-1234-5678","luis@mail.com",
       "01/01/2024","01/01/2025","22000","800000","7500","Robo e incendio",
       "Honda","CB500",2020,"ABC 123","250cc","","","",""],
      ["HOG-2024-002","hogar","Sancor Seguros","María González","31.234.567","011-5678-9012","maria@mail.com",
       "15/03/2024","15/03/2025","18000","5000000","6000","Integral Hogar",
       "","","","","","Belgrano 456 Rosario","","",""],
      ["COM-2024-003","comercial","Zurich Argentina","TechBA SRL","30-78901234-5","011-7890-1234","info@techba.com",
       "01/06/2024","01/06/2025","120000","15000000","40000","Integral de Comercio",
       "","","","","","","TechBA SRL","Tecnología","RC + Incendio"],
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);

    // Column widths
    ws["!cols"] = headers.map((_,i) => ({ wch: i < 3 ? 18 : i < 9 ? 14 : 12 }));

    // Header style (green background)
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = XLSX.utils.encode_cell({ r: 0, c });
      if (!ws[cell]) continue;
      ws[cell].s = {
        fill: { fgColor: { rgb: "1E3A5F" } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { horizontal: "center" },
      };
    }

    // Required column highlight (first 5)
    for (let c = 0; c < 5; c++) {
      const cell = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[cell]) ws[cell].s = { ...ws[cell].s, fill: { fgColor: { rgb: "1A4A8A" } } };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pólizas");

    // Instructions sheet
    const instrData = [
      ["INSTRUCCIONES DE IMPORTACIÓN"],
      [""],
      ["COLUMNAS OBLIGATORIAS (azul oscuro):"],
      ["N° Póliza", "Número único de la póliza. Ej: AUT-2024-001"],
      ["Compañía", "Nombre de la aseguradora. Se crea si no existe."],
      ["Asegurado", "Nombre completo del asegurado. Se crea si no existe."],
      ["Vigencia Desde", "Formato: DD/MM/YYYY  Ej: 01/01/2024"],
      ["Vigencia Hasta", "Formato: DD/MM/YYYY  Ej: 31/12/2024"],
      [""],
      ["VALORES VÁLIDOS PARA 'Tipo':"],
      ["automotor", "hogar", "accidentes", "art"],
      ["ecomovilidad", "comercial", "responsabilidad_civil", "cascos", "incendio", "motovehiculo"],
      [""],
      ["NOTAS:"],
      ["- Las columnas opcionales pueden quedar vacías."],
      ["- El sistema auto-detecta el estado según las fechas."],
      ["- Si el asegurado o compañía no existe, se crea automáticamente."],
      ["- Podés renombrar las columnas libremente — en la importación las podés mapear visualmente."],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(instrData);
    ws2["!cols"] = [{ wch: 25 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Instrucciones");

    XLSX.writeFile(wb, "plantilla_polizas_curini.xlsx");
  }

  // ─── Counts ──────────────────────────────────────────────────────────────────
  const validCount = processedRows.filter(r => r.errors.length === 0).length;
  const invalidCount = processedRows.filter(r => r.errors.length > 0).length;
  const unmappedRequired = REQUIRED_FIELDS.filter(f => !Object.values(mapping).includes(f));

  const fieldOptions = [
    { value: "", label: "— No importar —" },
    ...SYSTEM_FIELDS.map(f => ({
      value: f.key,
      label: f.required ? `★ ${f.label}` : f.label,
    })),
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-4xl my-4">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                Importar Pólizas
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {step === "upload"  && "Subí tu archivo Excel o CSV"}
                {step === "mapping" && `Columnas detectadas en "${fileName}"`}
                {step === "preview" && `Vista previa — ${validCount} listas, ${invalidCount} con errores`}
                {step === "result"  && "Importación completada"}
              </p>
            </div>
          </div>
          {/* Step indicator */}
          <div className="hidden sm:flex items-center gap-1 text-xs text-gray-500 mr-4">
            {(["upload","mapping","preview","result"] as Step[]).map((s, i, arr) => (
              <span key={s} className="flex items-center gap-1">
                <span className={cn("w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold",
                  step === s ? "bg-blue-600 text-white" :
                  arr.indexOf(step) > i ? "bg-emerald-600 text-white" :
                  "bg-[#1f2937] text-gray-500")}>
                  {arr.indexOf(step) > i ? "✓" : i+1}
                </span>
                <span className={step === s ? "text-white" : ""}>
                  {s === "upload" ? "Archivo" : s === "mapping" ? "Columnas" : s === "preview" ? "Vista previa" : "Listo"}
                </span>
                {i < arr.length-1 && <ArrowRight className="w-3 h-3 mx-1" />}
              </span>
            ))}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── STEP 1: Upload ─────────────────────────────────────────────────── */}
        {step === "upload" && (
          <div className="p-6 space-y-5">
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if(f) handleFile(f); }}
              onClick={() => fileRef.current?.click()}
              className={cn("border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all",
                dragging ? "border-blue-500 bg-blue-500/10" : "border-[#374151] hover:border-blue-500/50 hover:bg-[#1a2540]/40")}
            >
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <div className="w-12 h-12 rounded-xl bg-emerald-500/15 flex items-center justify-center mx-auto mb-4">
                <FileSpreadsheet className="w-6 h-6 text-emerald-400" />
              </div>
              <p className="text-white font-medium">Arrastrá tu Excel aquí o hacé click para seleccionar</p>
              <p className="text-gray-500 text-sm mt-1">Soporta .xlsx, .xls, .csv, .txt</p>
              <p className="text-gray-600 text-xs mt-1">Podés usar cualquier nombre de columna — las vas a mapear en el siguiente paso</p>
            </div>

            {parseError && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {parseError}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Info className="w-3.5 h-3.5" />
                <span>Necesitás al mínimo: N° Póliza, Compañía, Asegurado, Vigencia Desde, Vigencia Hasta</span>
              </div>
              <button onClick={downloadTemplate}
                className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors whitespace-nowrap">
                <Download className="w-3.5 h-3.5" /> Bajar plantilla
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Column mapping ─────────────────────────────────────────── */}
        {step === "mapping" && (
          <div className="p-6 space-y-5">
            {/* Alert for unmapped required */}
            {unmappedRequired.length > 0 && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 text-amber-400 text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Faltan columnas obligatorias:</p>
                  <p className="text-xs mt-0.5">{unmappedRequired.map(k => SYSTEM_FIELDS.find(f=>f.key===k)?.label).join(", ")}</p>
                </div>
              </div>
            )}

            <div className="text-xs text-gray-400 flex items-center gap-2">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              Se detectaron <strong className="text-white">{rawHeaders.length} columnas</strong> en tu archivo.
              Indicá a qué campo del sistema corresponde cada una. Las columnas reconocidas ya están asignadas.
            </div>

            {/* Mapping grid */}
            <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_1fr] gap-0 text-xs text-gray-500 px-4 py-2 border-b border-[#1f2937]">
                <span>Columna en tu archivo</span>
                <span></span>
                <span>Campo del sistema</span>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-[#1f2937]">
                {rawHeaders.map((header, idx) => {
                  const preview = rawRows.slice(0, 3).map(r => r[idx]).filter(Boolean).join(", ");
                  const mapped = mapping[idx] || "";
                  const isRequired = mapped && REQUIRED_FIELDS.includes(mapped);
                  return (
                    <div key={idx} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5 hover:bg-[#1a2540]/30 transition-colors">
                      <div>
                        <p className="text-white font-medium text-sm">{header || `(Columna ${idx+1})`}</p>
                        {preview && <p className="text-gray-600 text-xs truncate mt-0.5" title={preview}>{preview}</p>}
                      </div>
                      <ArrowRight className={cn("w-3.5 h-3.5 flex-shrink-0", mapped ? "text-blue-400" : "text-gray-700")} />
                      <div className="relative">
                        <select
                          value={mapped}
                          onChange={e => setMapping(m => ({ ...m, [idx]: e.target.value }))}
                          className={cn(
                            "w-full px-2.5 py-1.5 rounded-lg text-xs outline-none border transition-colors appearance-none",
                            isRequired
                              ? "bg-blue-600/15 border-blue-500/40 text-blue-300"
                              : mapped
                              ? "bg-emerald-600/10 border-emerald-500/30 text-emerald-300"
                              : "bg-[#0a0f1e] border-[#2d3748] text-gray-400"
                          )}
                        >
                          {fieldOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-blue-600/30 border border-blue-500/40 inline-block"/> Campo obligatorio</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-600/10 border border-emerald-500/30 inline-block"/> Campo opcional asignado</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#0a0f1e] border border-[#2d3748] inline-block"/> No importar</span>
            </div>

            <div className="flex justify-between pt-1">
              <button onClick={() => setStep("upload")}
                className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                ← Volver
              </button>
              <button
                onClick={applyMapping}
                disabled={unmappedRequired.length > 0}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-all"
              >
                Ver vista previa →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Preview ────────────────────────────────────────────────── */}
        {step === "preview" && (
          <div className="p-6 space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-center">
                <p className="text-2xl font-bold text-emerald-400 font-mono">{validCount}</p>
                <p className="text-xs text-gray-400 mt-0.5">Listas para importar</p>
              </div>
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-center">
                <p className="text-2xl font-bold text-red-400 font-mono">{invalidCount}</p>
                <p className="text-xs text-gray-400 mt-0.5">Con errores (se omiten)</p>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-center">
                <p className="text-2xl font-bold text-blue-400 font-mono">{processedRows.length}</p>
                <p className="text-xs text-gray-400 mt-0.5">Total de filas</p>
              </div>
            </div>

            {/* Table */}
            <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-xs min-w-[700px]">
                  <thead className="border-b border-[#1f2937] sticky top-0 bg-[#0d1424] z-10">
                    <tr>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium w-6">#</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">N° Póliza</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Tipo</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Asegurado</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Compañía</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Desde</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Hasta</th>
                      <th className="text-left text-gray-400 py-2.5 px-3 font-medium">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processedRows.slice(0, 100).map((r, i) => {
                      const ok = r.errors.length === 0;
                      return (
                        <tr key={i} className={cn("border-b border-[#1f2937] transition-colors",
                          ok ? "hover:bg-[#1a2540]/30" : "bg-red-900/10 hover:bg-red-900/20")}>
                          <td className="py-2 px-3 text-gray-600">{i+1}</td>
                          <td className="py-2 px-3">
                            {r.data.policyNumber
                              ? <span className="text-blue-400 font-mono">{r.data.policyNumber}</span>
                              : <span className="text-red-400">—</span>}
                          </td>
                          <td className="py-2 px-3 text-gray-300">
                            {r.data.type || "automotor"}
                            {r.data.isRebilling === "1" && (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-violet-500/15 text-violet-400 border border-violet-500/20">refact.</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-white">{r.data.insured || <span className="text-red-400">—</span>}</td>
                          <td className="py-2 px-3 text-gray-300">{r.data.company || <span className="text-red-400">—</span>}</td>
                          <td className="py-2 px-3 text-gray-400">{r.data.startDate || <span className="text-red-400">—</span>}</td>
                          <td className="py-2 px-3 text-gray-400">{r.data.endDate || <span className="text-red-400">—</span>}</td>
                          <td className="py-2 px-3">
                            {ok ? (
                              <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/>OK</span>
                            ) : (
                              <span className="text-red-400" title={r.errors.join(" · ")}>
                                ✗ {r.errors[0]}{r.errors.length > 1 ? ` +${r.errors.length-1}` : ""}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {processedRows.length > 100 && (
                <p className="text-xs text-gray-500 px-3 py-2 border-t border-[#1f2937]">
                  Mostrando 100 de {processedRows.length} filas
                </p>
              )}
            </div>

            {invalidCount > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2.5 text-amber-400 text-xs">
                {invalidCount} fila{invalidCount !== 1 ? "s" : ""} serán omitidas. Pasá el mouse sobre el error para ver el detalle.
              </div>
            )}

            <div className="flex justify-between pt-1">
              <button onClick={() => setStep("mapping")}
                className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                ← Ajustar columnas
              </button>
              <button onClick={handleImport} disabled={loading || validCount === 0}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                Importar {validCount} póliza{validCount !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Result ─────────────────────────────────────────────────── */}
        {step === "result" && result && (
          <div className="p-6 space-y-5">
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/15 mb-4">
                <CheckCircle2 className="w-7 h-7 text-emerald-400" />
              </div>
              <h3 className="text-xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Importación completada</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-4 text-center">
                <p className="text-3xl font-bold text-emerald-400 font-mono">{result.imported}</p>
                <p className="text-xs text-gray-400 mt-1">Importadas correctamente</p>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-4 text-center">
                <p className="text-3xl font-bold text-amber-400 font-mono">{result.skipped}</p>
                <p className="text-xs text-gray-400 mt-1">Omitidas</p>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="bg-[#0d1424] border border-[#1f2937] rounded-xl overflow-hidden">
                <button onClick={() => setShowErrors(!showErrors)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-400 hover:text-white transition-colors">
                  <span>{result.errors.length} advertencia{result.errors.length !== 1 ? "s" : ""} del servidor</span>
                  {showErrors ? <ChevronUp className="w-4 h-4"/> : <ChevronDown className="w-4 h-4"/>}
                </button>
                {showErrors && (
                  <div className="px-4 pb-4 space-y-1 max-h-40 overflow-y-auto">
                    {result.errors.map((e, i) => <p key={i} className="text-xs text-amber-400">{e}</p>)}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={onClose}
                className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">
                Cerrar
              </button>
              <button onClick={onImported}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-all">
                Ver pólizas
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
