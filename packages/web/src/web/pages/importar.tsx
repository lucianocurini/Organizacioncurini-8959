import { useState, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { api } from "@/lib/api";
import { Upload, FileText, CheckCircle, AlertTriangle, Loader2, ChevronDown, ChevronUp, Edit2, X } from "lucide-react";
import { toast } from "sonner";

interface ParsedPolicy {
  policyNumber: string;
  movType: string;
  startDate: string;
  endDate: string;
  premium: number;
  sumInsured: number;
  coverageCode: string;
  coverageLabel: string;
  insuredName: string;
  insuredDni: string;
  insuredEmail: string;
  insuredPhone: string;
  insuredAddress: string;
  vehiclePlate: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleYear: number;
  vehicleType: string;
  engineNumber: string;
  installments: { number: number; dueDate: string; amount: number }[];
  // campos editables para prorroga huérfana
  _orphan?: boolean;
  _baseStartDate?: string;
  _baseEndDate?: string;
  _basePremium?: number;
  _baseSumInsured?: number;
  _baseCoverage?: string;
  _baseNotes?: string;
}

interface ImportPreview {
  policies: ParsedPolicy[];
  errors: string[];
  companyName: string;
}

function parseFecha(s: string): string {
  if (!s || s.length !== 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function detectVehicleType(vt: string): string {
  const v = (vt || "").toLowerCase();
  if (v === "motovehiculo" || v === "moto") return "motovehiculo";
  if (v === "accidentes_pasajeros") return "accidentes_pasajeros";
  if (v === "hogar") return "hogar";
  if (v === "cascos") return "cascos";
  if (v === "comercial") return "comercial";
  return "automotor";
}

function parseElNorteTxt(content: string): ImportPreview {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const errors: string[] = [];
  const pvMap: Record<string, any> = {};
  const asMap: Record<string, any> = {};
  const itMap: Record<string, any> = {};
  const ppMap: Record<string, any[]> = {};

  for (const line of lines) {
    try {
      const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g)
        ?.map(c => c.replace(/^"|"$/g, "").trim()) || [];
      const type = cols[0];
      if (type === "PV") {
        const polNum = cols[3];
        const endoso = cols[4];
        const key = `${polNum}_${endoso}`;
        pvMap[key] = {
          policyNumber: polNum, endoso,
          movType: cols[10],
          emisionDate: parseFecha(cols[12]),
          startDate: parseFecha(cols[13]),
          endDate: parseFecha(cols[14]),
          insuredId: cols[15],
          premium: parseFloat(cols[17]) || 0,
        };
      } else if (type === "AS") {
        const insuredId = cols[1];
        asMap[insuredId] = {
          name: cols[4],
          address: `${cols[6]}, ${cols[7]}, ${cols[8]}`.trim(),
          phone: cols[11]?.replace(/[^0-9 \-\+\(\)]/g, "").trim(),
          email: cols[12] === "organizacioncurini@gmail.com" ? "" : cols[12],
          dni: cols[3],
        };
      } else if (type === "IT") {
        const key = `${cols[3]}_${cols[4]}`;
        itMap[key] = {
          sumInsured: parseFloat(cols[6]) || 0,
          coverageCode: cols[8],
          coverageLabel: cols[9],
          plate: cols[16],
          engine: cols[17],
          brand: cols[19],
          model: cols[20],
          year: parseInt(cols[21]) || 0,
          vehicleType: cols[22],
        };
      } else if (type === "PP") {
        const key = `${cols[3]}_${cols[4]}`;
        if (!ppMap[key]) ppMap[key] = [];
        ppMap[key].push({ number: parseInt(cols[5]) || 0, dueDate: parseFecha(cols[7]), amount: parseFloat(cols[8]) || 0 });
      }
    } catch {
      errors.push(`Error parseando: ${line.slice(0, 60)}`);
    }
  }

  const policies: ParsedPolicy[] = [];
  for (const key of Object.keys(pvMap)) {
    const pv = pvMap[key];
    const it = itMap[key];
    const pp = ppMap[key] || [];
    const as = asMap[pv.insuredId];
    if (!as) { errors.push(`Póliza ${pv.policyNumber}: asegurado ${pv.insuredId} no encontrado`); continue; }

    const mov = (pv.movType || "").toUpperCase();
    const isOrphanProrroga = mov.includes("PRORROGA"); // el backend confirmará si realmente es huérfana

    policies.push({
      policyNumber: pv.policyNumber,
      movType: pv.movType,
      startDate: pv.startDate,
      endDate: pv.endDate,
      premium: pv.premium,
      sumInsured: it?.sumInsured || 0,
      coverageCode: it?.coverageCode || "",
      coverageLabel: it?.coverageLabel || "",
      insuredName: as.name,
      insuredDni: as.dni,
      insuredEmail: as.email,
      insuredPhone: as.phone,
      insuredAddress: as.address,
      vehiclePlate: it?.plate || "",
      vehicleBrand: it?.brand || "",
      vehicleModel: it?.model || "",
      vehicleYear: it?.year || 0,
      vehicleType: it?.vehicleType || "",
      engineNumber: it?.engine || "",
      installments: pp.sort((a, b) => a.number - b.number),
      _orphan: isOrphanProrroga,
      // valores default para la póliza base (editables)
      _baseStartDate: "",
      _baseEndDate: pv.startDate, // la base termina donde empieza la prórroga
      _basePremium: pv.premium,
      _baseSumInsured: it?.sumInsured || 0,
      _baseCoverage: it?.coverageLabel || "",
      _baseNotes: "",
    });
  }

  return { policies, errors, companyName: "El Norte" };
}

// ── PARSER RIVADAVIA ──────────────────────────────────────────────────────────
function parseDateDDMMYYYY(s: string): string {
  // "26/05/2026" → "2026-05-26"
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseNumAR(s: string): number {
  // "28563,29" → 28563.29
  return parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
}

function parseRivadaviaTxt(content: string): ImportPreview {
  const errors: string[] = [];
  const policies: ParsedPolicy[] = [];

  // Separar bloques por línea divisoria
  const blocks = content.split(/\-{40,}/).map(b => b.trim()).filter(Boolean);

  for (const block of blocks) {
    try {
      const lines = block.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim());
      if (lines.length < 2) continue;

      const l0 = lines[0]; // EMISION / TIPO / VIGENCIA
      const l1 = lines[1]; // POLIZA / ASOCIADO / ...

      // Línea 1
      const tipoM = l0.match(/TIPO:\s*(\w+)/);
      const vigM = l0.match(/VIGENCIA:\s*(\d{2}\/\d{2}\/\d{4})\s+AL\s+(\d{2}\/\d{2}\/\d{4})/);
      if (!tipoM || !vigM) { errors.push(`Bloque sin TIPO/VIGENCIA: ${l0.slice(0, 60)}`); continue; }

      const rawTipo = tipoM[1].toUpperCase();
      const startDate = parseDateDDMMYYYY(vigM[1]);
      const endDate = parseDateDDMMYYYY(vigM[2]);

      // Mapear tipo Rivadavia → movType interno
      let movType: string;
      if (rawTipo === "PN") movType = "RENOVACION";
      else if (rawTipo === "PRO") movType = "RENOVACION"; // PRO = nueva vigencia del mismo número
      else if (rawTipo === "PR") movType = "PRORROGA";   // PR = prórroga con número nuevo
      else if (rawTipo === "ANU") movType = "ANULACION";
      else if (rawTipo === "RED") movType = "REDUCCION"; // skip
      else movType = rawTipo;

      // Línea 2: POLIZA
      const polM = l1.match(/POLIZA:\s*([\d\-]+)/);
      if (!polM) { errors.push(`Sin número de póliza: ${l1.slice(0, 60)}`); continue; }
      // Normalizar: quitar guiones y ceros iniciales de cada segmento
      // "09-02-903405-003" → guardarlo tal cual (la DB lo busca por número exacto)
      const policyNumber = polM[1];

      // RENOVACION (solo en PR): "09/965982" → número de póliza anterior
      // El backend lo usará para buscar la póliza original si no encuentra por policyNumber
      const renovM = l1.match(/RENOVACION:\s*([\d\/]+)/);
      const renovacionRef = renovM && renovM[1] !== "DOC" ? renovM[1].trim() : "";

      // ASOCIADO
      const asocM = l1.match(/ASOCIADO:\s*(.+?)\s+MATR\./);
      const insuredName = asocM ? asocM[1].trim() : "";

      // DOC
      const docM = l1.match(/DOC\.\s*(\d+)/);
      const insuredDni = docM ? docM[1].trim() : "";

      // DOMICILIO
      const domLine = lines.find(l => l.startsWith("DOMICILIO:"));
      const insuredAddress = domLine ? domLine.replace(/^DOMICILIO:\s*/, "").trim() : "";

      // BIEN A ASEGURAR
      const bienLine = lines.find(l => l.includes("BIEN A ASEGURAR:"));
      let vehicleBrand = "", vehicleModel = "", vehicleYear = 0, vehiclePlate = "", vehicleType = "automotor", engineNumber = "";
      if (bienLine) {
        const marcaM = bienLine.match(/BIEN A ASEGURAR:\s*(.+?)\s+MOD\./);
        const modYearM = bienLine.match(/MOD\.\s*(\d{4})/);
        const patM = bienLine.match(/PAT\.\s*([\w]+)/);
        const motM = bienLine.match(/MOT\.\s*([\w\-\*]+)/);
        if (marcaM) {
          // Separar marca del modelo: primera palabra es marca, resto es modelo
          const full = marcaM[1].trim();
          const spaceIdx = full.indexOf(" ");
          vehicleBrand = spaceIdx > 0 ? full.slice(0, spaceIdx) : full;
          vehicleModel = spaceIdx > 0 ? full.slice(spaceIdx + 1).trim() : "";
        }
        vehicleYear = modYearM ? parseInt(modYearM[1]) : 0;
        vehiclePlate = patM ? patM[1].trim() : "";
        engineNumber = motM ? motM[1].trim() : "";
      }

      // RIESGO A CUBRIR
      const riesgoLine = lines.find(l => l.includes("RIESGO A CUBRIR:"));
      let coverageLabel = "", sumInsured = 0;
      if (riesgoLine) {
        const riesgoM = riesgoLine.match(/RIESGO A CUBRIR:\s*(\S+)/);
        const planM = riesgoLine.match(/PLAN:\s*(\S+)/);
        const sumaM = riesgoLine.match(/SUMA ASEG\.\s*([\d\.,]+)/);
        const riesgoTipo = riesgoM ? riesgoM[1].toUpperCase() : "";
        // "AUTOMOTORES" contiene "MOTO" → comparar explícitamente
        vehicleType = (riesgoTipo === "MOTOVEHICULO" || riesgoTipo === "MOTO" || riesgoTipo.startsWith("MOTOV"))
          ? "motovehiculo"
          : "automotor";
        const planStr = planM ? planM[1] : "";
        coverageLabel = planStr && planStr !== "SUMA" ? `Plan ${planStr}` : riesgoTipo;
        sumInsured = sumaM ? parseNumAR(sumaM[1]) : 0;
      } else {
        // Sin RIESGO A CUBRIR → detectar por prefijo del número de póliza
        if (policyNumber.startsWith("09-20-")) vehicleType = "motovehiculo";
        else if (policyNumber.startsWith("09-10-")) vehicleType = "accidentes_pasajeros";
        else vehicleType = "automotor"; // 09-02-* y default
      }

      // INF. ADICIONAL → prima y premio
      const infLine = lines.find(l => l.includes("INF. ADICIONAL"));
      let premium = 0;
      if (infLine) {
        const premioM = infLine.match(/PREMIO:\s*([\d\.,]+)/);
        premium = premioM ? parseNumAR(premioM[1]) : 0;
      }

      // PLAN DE PAGOS → cuotas
      const installments: { number: number; dueDate: string; amount: number }[] = [];
      let cuotaNum = 1;
      for (const l of lines) {
        // Primera cuota: "PLAN DE PAGOS   VENC.: 25/07/2026 IMP.:     35357,00 ..."
        // Cuotas siguientes: "                       15/07/2026           57371,00 ..."
        const planM = l.match(/VENC\.:\s*(\d{2}\/\d{2}\/\d{4})\s+IMP\.:\s*([\d\.,]+)/);
        if (planM) {
          installments.push({ number: cuotaNum++, dueDate: parseDateDDMMYYYY(planM[1]), amount: parseNumAR(planM[2]) });
          continue;
        }
        // Líneas de cuotas adicionales (solo fecha + importe)
        const extraM = l.match(/^\s+(\d{2}\/\d{2}\/\d{4})\s+([\d\.,]+)\s/);
        if (extraM && installments.length > 0) {
          installments.push({ number: cuotaNum++, dueDate: parseDateDDMMYYYY(extraM[1]), amount: parseNumAR(extraM[2]) });
        }
      }

      const isProrroga = movType === "PRORROGA";

      policies.push({
        policyNumber,
        movType,
        startDate,
        endDate,
        premium,
        sumInsured,
        coverageCode: "",
        coverageLabel,
        insuredName,
        insuredDni,
        insuredEmail: "",
        insuredPhone: "",
        insuredAddress,
        vehiclePlate,
        vehicleBrand,
        vehicleModel,
        vehicleYear,
        vehicleType,
        engineNumber,
        installments,
        _orphan: isProrroga,
        _baseStartDate: "",
        _baseEndDate: startDate,
        _basePremium: premium,
        _baseSumInsured: sumInsured,
        _baseCoverage: coverageLabel,
        _baseNotes: "",
        // Para PR: referencia al número de póliza anterior (ej "09/965982")
        ...(renovacionRef ? { _renovacionRef: renovacionRef } : {}),
      } as any);
    } catch (e: any) {
      errors.push(`Error en bloque: ${e.message}`);
    }
  }

  return { policies, errors, companyName: "Rivadavia" };
}
// ─────────────────────────────────────────────────────────────────────────────

// ── PARSER COOPERACIÓN ───────────────────────────────────────────────────────
// Ramos: 32=auto/moto, 31=hogar, 41=acc.pasajeros, 46=cascos(náutico)
// Subpólizas: prefijo "14-" (ramo 41) o "12-" (ramo 31) → parentPolicyId por número base
// Tipo operación: 2=alta/renovación, pueden existir otros en el futuro
const COOP_MOTO_BRANDS = [
  // Solo marcas que hacen EXCLUSIVAMENTE motos (no autos)
  "YAMAHA", "KAWASAKI", "SUZUKI", "BAJAJ", "ZANELLA", "GILERA", "CORVEN",
  "MOTOMEL", "BETA", "KYMCO", "SYM", "TVS", "LIFAN", "MONDIAL", "KTM",
  "TRIUMPH", "ROYAL ENFIELD", "HARLEY-DAVIDSON",
  // Ducati y BMW también hacen motos pero el prefijo de número es más confiable
];

function parseCooperacionCsv(content: string): ImportPreview {
  const errors: string[] = [];
  const policies: ParsedPolicy[] = [];

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { policies, errors: ["Archivo vacío"], companyName: "Cooperación" };

  // Detectar separador (;)
  const header = lines[0].split(";").map(h => h.trim().replace(/\r/, ""));

  function col(row: string[], name: string): string {
    const idx = header.indexOf(name);
    return idx >= 0 ? (row[idx] || "").trim().replace(/\r/, "") : "";
  }

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(";");
    if (row.length < 5) continue;
    try {
      const ramo = col(row, "Ramo");
      const tipoOp = col(row, "Tipo Operacion");
      const polizaRaw = col(row, "Poliza");
      const nombre = col(row, "Nombre");
      const dni = col(row, "Nro Doc");
      const domicilio = col(row, "Obs Proponente");
      const bienAseg = col(row, "Bien Asegurado");
      const sumaStr = col(row, "Suma Asegurada");
      const desde = col(row, "Cobertura Fecha Desde"); // "2026-05-20"
      const hasta = col(row, "Cobertura Fecha Hasta");

      if (!polizaRaw || !desde || !hasta) { errors.push(`Fila ${i}: sin póliza/fechas`); continue; }

      // Mapear tipo operación
      let movType = "RENOVACION";
      if (tipoOp === "3") movType = "ANULACION";
      else if (tipoOp === "4") movType = "ENDOSO";

      // Detectar si es subpóliza (prefijo 14- o 12-)
      let policyNumber = polizaRaw;
      let isSubPolicy = false;
      let basePolicyNumber = "";
      if (polizaRaw.startsWith("14-") || polizaRaw.startsWith("12-")) {
        isSubPolicy = true;
        basePolicyNumber = polizaRaw.replace(/^(14-|12-)/, "");
      }

      // Determinar tipo por ramo
      let vehicleType = "automotor";
      if (ramo === "31") vehicleType = "hogar";
      else if (ramo === "41") vehicleType = "accidentes_pasajeros";
      else if (ramo === "46") vehicleType = "cascos";
      else if (ramo === "32") {
        // Auto vs moto: por número (empieza con 2=moto, 3=auto) o por marca
        const numBase = basePolicyNumber || policyNumber;
        const firstDigit = numBase.replace(/\D/g, "")[0] || "";
        if (firstDigit === "2") {
          vehicleType = "motovehiculo"; // número empieza con 2 → moto
        } else if (firstDigit === "3") {
          vehicleType = "automotor"; // número empieza con 3 → auto, sin excepción
        } else {
          // Número ambiguo → fallback por marca
          const bienUpper = bienAseg.toUpperCase();
          vehicleType = COOP_MOTO_BRANDS.some(m => bienUpper.startsWith(m)) ? "motovehiculo" : "automotor";
        }
      }

      // Parsear bien asegurado (ramo 32): "TOYOTA COROLLA 1.8 XEI L/17 CUERO AC528TK Cob.: P"
      let vehicleBrand = "", vehicleModel = "", vehiclePlate = "", coverageLabel = "";
      if (ramo === "32") {
        // Cobertura: "Cob.: P" al final
        const cobM = bienAseg.match(/Cob\.:\s*(\S+)\s*$/);
        if (cobM) coverageLabel = `Cob. ${cobM[1]}`;
        // Quitar " Cob.: X" del final
        const bienClean = bienAseg.replace(/\s+Cob\.:\s*\S+\s*$/, "").trim();
        // Patente: último token que parezca patente (AAA000 o AA000AA o similares)
        const platM = bienClean.match(/\b([A-Z]{2,3}[\-]?\d{3}[A-Z]{0,2}|[A-Z]{3}\d{3})\b/g);
        if (platM) vehiclePlate = platM[platM.length - 1];
        // Quitar patente del texto para quedarnos con marca+modelo
        const sinPat = platM ? bienClean.replace(platM[platM.length - 1], "").trim() : bienClean;
        const parts = sinPat.split(/\s+/);
        vehicleBrand = parts[0] || "";
        vehicleModel = parts.slice(1).join(" ").trim();
      } else if (ramo === "41" || ramo === "31" || ramo === "46") {
        coverageLabel = bienAseg;
      }

      const sumInsured = parseFloat(sumaStr.replace(/\./g, "").replace(",", ".")) || 0;

      policies.push({
        policyNumber,
        movType,
        startDate: desde,
        endDate: hasta,
        premium: 0, // el CSV de Cooperación no trae prima
        sumInsured,
        coverageCode: ramo,
        coverageLabel,
        insuredName: nombre,
        insuredDni: dni,
        insuredEmail: "",
        insuredPhone: "",
        insuredAddress: domicilio,
        vehiclePlate,
        vehicleBrand,
        vehicleModel,
        vehicleYear: 0,
        vehicleType,
        engineNumber: "",
        installments: [],
        _orphan: false,
        _baseStartDate: "",
        _baseEndDate: "",
        _basePremium: 0,
        _baseSumInsured: sumInsured,
        _baseCoverage: coverageLabel,
        _baseNotes: "",
        ...(isSubPolicy ? { _parentPolicyNumber: basePolicyNumber } : {}),
      } as any);
    } catch (e: any) {
      errors.push(`Fila ${i}: ${e.message}`);
    }
  }

  return { policies, errors, companyName: "Cooperación" };
}
// ─────────────────────────────────────────────────────────────────────────────

// ── PARSER MERCANTIL ANDINA ───────────────────────────────────────────────────
// Secciones: 5=auto, 35=motovehiculo, 6=acc.personales(subpóliza), 16=hogar
// Operaciones: "póliza nueva" → ALTA, "extensión vigencia" → RENOVACION
// BIEN: "Auto: MARCA MODELO AÑO COB", "Motovehiculos: MOTOCICLETA MARCA ...", etc.
// Encoding: latin1 (caracteres especiales como ó → reemplazados al leer)
function parseMercantilAndinaCsv(content: string): ImportPreview {
  const errors: string[] = [];
  const policies: ParsedPolicy[] = [];

  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { policies, errors: ["Archivo vacío"], companyName: "Mercantil Andina" };

  const header = lines[0].split(";").map(h => h.trim().replace(/"/g, ""));

  function col(row: string[], name: string): string {
    const idx = header.indexOf(name);
    return idx >= 0 ? (row[idx] || "").trim().replace(/"/g, "") : "";
  }

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(";");
    if (row.length < 5) continue;
    try {
      const seccion = col(row, "SECCION");
      const poliza = col(row, "POLIZA");
      const endoso = parseInt(col(row, "ENDOSO") || "0");
      const bien = col(row, "BIEN");
      const nombre = col(row, "ASEGURADO").split(" - ")[0].trim();
      const domicilio = col(row, "ASEGURADO").split(" - ").slice(1).join(" - ").trim();
      const dni = col(row, "DNI_CUIT");
      const desde = col(row, "DESDE"); // ya YYYY-MM-DD
      const hasta = col(row, "HASTA");
      const premioStr = col(row, "PREMIO");
      const sumaStr = col(row, "SUMA");
      const operacion = col(row, "OPERACION").toLowerCase();
      const obs = col(row, "OBSERVACIO");

      if (!poliza || !desde || !hasta) { errors.push(`Fila ${i}: sin póliza/fechas`); continue; }

      // Tipo de movimiento
      let movType = "RENOVACION";
      if (operacion.includes("nueva") || endoso === 0) movType = "ALTA";
      else if (operacion.includes("anulac")) movType = "ANULACION";

      // Tipo de póliza por sección
      let vehicleType = "automotor";
      if (seccion === "35") vehicleType = "motovehiculo";
      else if (seccion === "6") vehicleType = "accidentes_pasajeros";
      else if (seccion === "16") vehicleType = "hogar";
      else if (seccion === "5") vehicleType = "automotor";

      // Parsear BIEN: "Auto: MARCA MODELO AÑO PATENTE COB" / "Motovehiculos: MOTOCICLETA MARCA ..."
      let vehicleBrand = "", vehicleModel = "", vehicleYear = 0, vehiclePlate = "", coverageLabel = "";

      if (seccion === "5" || seccion === "35") {
        // Quitar prefijo "Auto: " o "Motovehiculos: "
        const bienBody = bien.replace(/^[^:]+:\s*/, "").trim();
        // Quitar prefijo de tipo vehículo (motos y autos)
        const bienClean = bienBody.replace(/^(MOTOCICLETA|CICLOMOTOR|CUATRICICLO|PICK UP|CAMIONETA|CAMION|REMOLQUE|ACOPLADO|UTILITARIO|FURGON|MINIBUS|OMNIBUS|TRACTOR)\s+/i, "").trim();

        // Cobertura: separada por último guión largo o el texto de cobertura al final
        // Ejemplo: "CHEVROLET ONIX 1.0T PR 2026 D2- TR F.VAR. 2%"
        // Año: 4 dígitos entre 1950-2030
        const yearM = bienClean.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
        vehicleYear = yearM ? parseInt(yearM[1]) : 0;

        // Patente: patrón argentino
        const platM = bienClean.match(/\b([A-Z]{2,3}[\-]?\d{3}[A-Z]{0,2}|[A-Z]{3}\d{3})\b/g);
        vehiclePlate = platM ? platM[platM.length - 1] : "";

        // Marca y modelo: tokens antes del año
        const beforeYear = yearM ? bienClean.slice(0, yearM.index).trim() : bienClean;
        const parts = beforeYear.split(/\s+/);
        vehicleBrand = parts[0] || "";
        vehicleModel = parts.slice(1).join(" ").trim();

        // Cobertura: lo que queda después del año (y la patente si la hay)
        if (yearM) {
          let afterYear = bienClean.slice((yearM.index || 0) + yearM[0].length).trim();
          if (vehiclePlate) afterYear = afterYear.replace(vehiclePlate, "").trim();
          coverageLabel = afterYear.replace(/^[\s\-]+/, "").trim();
        }
      } else if (seccion === "6") {
        coverageLabel = bien.replace(/^Acc\.Personales:\s*/i, "").trim();
      } else if (seccion === "16") {
        coverageLabel = bien.replace(/^Hogar:\s*/i, "").trim();
      } else {
        coverageLabel = bien;
      }

      const premium = parseFloat(premioStr.replace(",", ".")) || 0;
      const sumInsured = parseFloat(String(sumaStr).replace(/\./g, "").replace(",", ".")) || 0;

      // Acc.Personales → marcar para vincular por DNI al auto activo
      const isAccPas = vehicleType === "accidentes_pasajeros";

      policies.push({
        policyNumber: poliza,
        movType,
        startDate: desde,
        endDate: hasta,
        premium,
        sumInsured,
        coverageCode: seccion,
        coverageLabel,
        insuredName: nombre,
        insuredDni: dni,
        insuredEmail: "",
        insuredPhone: "",
        insuredAddress: domicilio,
        vehiclePlate,
        vehicleBrand,
        vehicleModel,
        vehicleYear,
        vehicleType,
        engineNumber: "",
        installments: [],
        _orphan: false,
        _baseStartDate: "",
        _baseEndDate: "",
        _basePremium: premium,
        _baseSumInsured: sumInsured,
        _baseCoverage: coverageLabel,
        _baseNotes: obs || "",
        ...(isAccPas ? { _linkByDni: true } : {}),
      } as any);
    } catch (e: any) {
      errors.push(`Fila ${i}: ${e.message}`);
    }
  }

  return { policies, errors, companyName: "Mercantil Andina" };
}
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  insuredName: "Asegurado", insuredDni: "DNI", insuredEmail: "Email", insuredPhone: "Teléfono",
  vehiclePlate: "Patente", vehicleBrand: "Marca", vehicleModel: "Modelo", coverageLabel: "Cobertura",
};

export default function Importar() {
  const [company, setCompany] = useState<"el-norte" | "rivadavia" | "cooperacion" | "mercantil-andina">("el-norte");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [policies, setPolicies] = useState<ParsedPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; rebillings: number; cancelled: number; skipped: number; errors: string[] } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setLoading(true);
    setPreview(null);
    setResult(null);
    setPolicies([]);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = company === "rivadavia"
          ? parseRivadaviaTxt(content)
          : company === "cooperacion"
          ? parseCooperacionCsv(content)
          : company === "mercantil-andina"
          ? parseMercantilAndinaCsv(content)
          : parseElNorteTxt(content);
        setPreview(parsed);
        setPolicies(parsed.policies);
      } catch {
        toast.error("No se pudo parsear el archivo");
      } finally {
        setLoading(false);
      }
    };
    reader.readAsText(file, "latin1");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const [gmailLoading, setGmailLoading] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchDesde, setBatchDesde] = useState("2025-12-01");
  const [batchHasta, setBatchHasta] = useState(() => new Date().toISOString().split("T")[0]);
  const [batchPhase, setBatchPhase] = useState("");
  // Resultados acumulados por mes
  const [monthResults, setMonthResults] = useState<Array<{ label: string; imported: number; rebillings: number; skipped: number; cancelled: number; errors: string[] }>>([]);
  const [batchDone, setBatchDone] = useState(false);

  // Genera rangos mensuales entre dos fechas YYYY-MM-DD
  function getMonthRanges(desde: string, hasta: string): Array<{ desde: string; hasta: string; label: string }> {
    const ranges: Array<{ desde: string; hasta: string; label: string }> = [];
    let cur = new Date(desde + "T00:00:00");
    const end = new Date(hasta + "T00:00:00");
    while (cur <= end) {
      const year = cur.getFullYear();
      const month = cur.getMonth(); // 0-based
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 1); // primer día del mes siguiente = before
      const fromStr = firstDay.toISOString().split("T")[0];
      const toStr = lastDay.toISOString().split("T")[0];
      const label = firstDay.toLocaleString("es-AR", { month: "long", year: "numeric" });
      ranges.push({ desde: fromStr, hasta: toStr, label });
      cur = lastDay; // avanzar al mes siguiente
    }
    return ranges;
  }

  async function pollJob(jobId: string, onPhase: (p: string) => void): Promise<any> {
    return new Promise((resolve) => {
      const iv = setInterval(async () => {
        try {
          const s = await api.get(`/api/gmail/import-el-norte-batch/${jobId}`);
          onPhase(s.phase || "Procesando...");
          if (s.status === "done" || s.status === "error") {
            clearInterval(iv);
            resolve(s);
          }
        } catch { /* retry */ }
      }, 3000);
    });
  }

  const handleBatchImport = async () => {
    setBatchLoading(true);
    setMonthResults([]);
    setBatchDone(false);
    setBatchPhase("Calculando rangos...");

    const ranges = getMonthRanges(batchDesde, batchHasta);
    const accumulated: typeof monthResults = [];

    try {
      for (let i = 0; i < ranges.length; i++) {
        const { desde, hasta, label } = ranges[i];
        setBatchPhase(`Mes ${i + 1}/${ranges.length}: ${label}`);

        const { jobId } = await api.post("/api/gmail/import-el-norte-batch", { desde, hasta });
        const result = await pollJob(jobId, (p) => setBatchPhase(`${label} — ${p}`));

        const monthEntry = {
          label,
          imported: result.imported || 0,
          rebillings: result.rebillings || 0,
          skipped: result.skipped || 0,
          cancelled: result.cancelled || 0,
          errors: result.errors || [],
        };
        accumulated.push(monthEntry);
        setMonthResults([...accumulated]);
      }

      const totals = accumulated.reduce((acc, m) => ({
        imported: acc.imported + m.imported,
        rebillings: acc.rebillings + m.rebillings,
        skipped: acc.skipped + m.skipped,
      }), { imported: 0, rebillings: 0, skipped: 0 });

      toast.success(`Completado: ${totals.imported} pólizas nuevas, ${totals.rebillings} prórrogas`);
      setBatchDone(true);
    } catch (e: any) {
      toast.error(e.message || "Error en importación batch");
    } finally {
      setBatchLoading(false);
      setBatchPhase("");
    }
  };

  const handleImportFromGmail = async () => {
    setGmailLoading(true);
    setPreview(null);
    setPolicies([]);
    setResult(null);
    try {
      const res = await api.post("/api/gmail/import-el-norte", {});
      if (!res.content) throw new Error("Sin contenido en la respuesta");
      const parsed = parseElNorteTxt(res.content);
      setPreview(parsed);
      setPolicies(parsed.policies);
      toast.success(`Mail de El Norte cargado: ${res.subject}`);
    } catch (e: any) {
      toast.error(e.message || "Error al importar desde Gmail");
    } finally {
      setGmailLoading(false);
    }
  };

  const updatePolicy = (i: number, field: string, value: any) => {
    setPolicies(prev => prev.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const endpoint = company === "rivadavia"
        ? "/api/import/rivadavia"
        : company === "cooperacion"
        ? "/api/import/cooperacion"
        : company === "mercantil-andina"
        ? "/api/import/mercantil-andina"
        : "/api/import/el-norte";
      const res = await api.post(endpoint, { policies });
      setResult(res);
      toast.success(`Importación completada`);
    } catch (e: any) {
      toast.error(e.message || "Error al importar");
    } finally {
      setImporting(false);
    }
  };

  const reset = () => { setPreview(null); setResult(null); setPolicies([]); if (fileRef.current) fileRef.current.value = ""; };

  const formatCurrency = (n: number) =>
    n ? new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n) : "-";

  const movBadge = (movType: string) => {
    const m = (movType || "").toUpperCase();
    if (m.includes("PRORROGA")) return { label: "PRÓRROGA", cls: "bg-blue-500/15 text-blue-300" };
    if (m.includes("ANULACION")) return { label: "ANULACIÓN", cls: "bg-orange-500/15 text-orange-300" };
    if (m.includes("NOTA DE CREDITO")) return { label: "NOTA CRÉDITO", cls: "bg-gray-500/15 text-gray-400" };
    if (m.includes("REDUCCION")) return { label: "REDUCCIÓN", cls: "bg-gray-500/15 text-gray-400" };
    return { label: "RENOVACIÓN", cls: "bg-green-500/15 text-green-300" };
  };

  const orphanCount = policies.filter(p => p._orphan).length;

  return (
    <AppLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Importar Pólizas</h1>
          <p className="text-sm text-gray-400 mt-1">Subí el archivo TXT de la compañía para cargar pólizas automáticamente</p>
        </div>

        {/* Selector de compañía */}
        {!preview && !result && (
          <div className="flex gap-3">
            {([["el-norte", "El Norte"], ["rivadavia", "Rivadavia"], ["cooperacion", "Cooperación"], ["mercantil-andina", "Mercantil Andina"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setCompany(key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${company === key ? "bg-blue-600 border-blue-600 text-white" : "border-[#1f2937] text-gray-400 hover:text-white hover:border-gray-600"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Upload */}
        {!preview && !result && (
          <div
            className="border-2 border-dashed border-[#1f2937] rounded-xl p-12 text-center hover:border-blue-600/50 transition-colors cursor-pointer"
            onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".txt,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            {loading ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-10 h-10 text-blue-400 animate-spin" />
                <p className="text-gray-400">Procesando archivo...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-xl bg-blue-600/20 flex items-center justify-center">
                  <Upload className="w-7 h-7 text-blue-400" />
                </div>
                <p className="text-white font-medium">Arrastrá el archivo de {company === "el-norte" ? "El Norte" : company === "rivadavia" ? "Rivadavia" : company === "cooperacion" ? "Cooperación" : "Mercantil Andina"} acá</p>
                <p className="text-gray-500 text-sm">o hacé click para seleccionar</p>
              </div>
            )}
          </div>
        )}

        {/* Botón Gmail - solo El Norte */}
        {!preview && !result && company === "el-norte" && (
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t border-[#1f2937]" />
            <span className="text-gray-600 text-sm">o</span>
            <div className="flex-1 border-t border-[#1f2937]" />
          </div>
        )}
        {!preview && !result && company === "el-norte" && (
          <button
            onClick={handleImportFromGmail}
            disabled={gmailLoading}
            className="w-full flex items-center justify-center gap-3 py-4 rounded-xl border border-[#1f2937] text-gray-300 hover:text-white hover:border-blue-600/50 transition-colors disabled:opacity-50"
          >
            {gmailLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
              </svg>
            )}
            <span className="text-sm font-medium">
              {gmailLoading ? "Buscando mail de El Norte..." : "Importar último mail de El Norte (Gmail)"}
            </span>
          </button>
        )}

        {/* Importación histórica batch - solo El Norte */}
        {!preview && !result && company === "el-norte" && (
          <div className="border border-[#1f2937] rounded-xl p-5 space-y-4 bg-[#0d1117]">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 10h16M4 14h8M4 18h8"/>
              </svg>
              <h3 className="text-sm font-semibold text-gray-200">Importar histórico desde Gmail</h3>
            </div>
            <p className="text-xs text-gray-500">
              Procesa todos los mails de El Norte mes por mes. Al terminar, el sistema importa automáticamente cada día a las 8am.
            </p>

            {/* Rango de fechas */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Desde</label>
                <input
                  type="date"
                  value={batchDesde}
                  onChange={e => setBatchDesde(e.target.value)}
                  disabled={batchLoading}
                  className="w-full bg-[#111827] border border-[#1f2937] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Hasta</label>
                <input
                  type="date"
                  value={batchHasta}
                  onChange={e => setBatchHasta(e.target.value)}
                  disabled={batchLoading}
                  className="w-full bg-[#111827] border border-[#1f2937] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 disabled:opacity-50"
                />
              </div>
            </div>

            <button
              onClick={handleBatchImport}
              disabled={batchLoading || !batchDesde || !batchHasta}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {batchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                </svg>
              )}
              {batchLoading ? "Importando..." : "Importar mes a mes"}
            </button>

            {/* Progreso */}
            {batchLoading && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-purple-400">
                  <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                  <span className="truncate">{batchPhase || "Iniciando..."}</span>
                </div>
                {monthResults.length > 0 && (
                  <div className="text-xs text-gray-500">
                    {monthResults.length} mes{monthResults.length !== 1 ? "es" : ""} completado{monthResults.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            )}

            {/* Resultados por mes */}
            {monthResults.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 font-medium">Resultado por mes:</p>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {monthResults.map((m, i) => (
                    <div key={i} className="flex items-center justify-between bg-[#111827] rounded-lg px-3 py-2">
                      <span className="text-xs text-gray-300 capitalize w-36 truncate">{m.label}</span>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-green-400">{m.imported} nuevas</span>
                        <span className="text-blue-400">{m.rebillings} prórr.</span>
                        <span className="text-gray-500">{m.skipped} salt.</span>
                        {m.errors.length > 0 && (
                          <span className="text-red-400">{m.errors.length} err.</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Totales */}
                {!batchLoading && monthResults.length > 0 && (() => {
                  const t = monthResults.reduce((a, m) => ({ imported: a.imported + m.imported, rebillings: a.rebillings + m.rebillings, skipped: a.skipped + m.skipped, cancelled: a.cancelled + m.cancelled }), { imported: 0, rebillings: 0, skipped: 0, cancelled: 0 });
                  return (
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2.5 text-center">
                        <p className="text-lg font-bold text-green-400">{t.imported}</p>
                        <p className="text-xs text-gray-400">Nuevas</p>
                      </div>
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2.5 text-center">
                        <p className="text-lg font-bold text-blue-400">{t.rebillings}</p>
                        <p className="text-xs text-gray-400">Prórrogas</p>
                      </div>
                      <div className="bg-gray-500/10 border border-gray-500/20 rounded-lg p-2.5 text-center">
                        <p className="text-lg font-bold text-gray-400">{t.skipped}</p>
                        <p className="text-xs text-gray-400">Saltadas</p>
                      </div>
                    </div>
                  );
                })()}

                {batchDone && (
                  <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/10 rounded-lg px-3 py-2">
                    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    Histórico importado. El sistema sincronizará automáticamente cada día a las 8am.
                  </div>
                )}

                <button
                  onClick={() => { setMonthResults([]); setBatchDone(false); }}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Limpiar
                </button>
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-6 h-6 text-green-400" />
              <h2 className="text-white font-semibold text-lg">Importación completada</h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-green-400">{result.imported}</p>
                <p className="text-sm text-gray-400 mt-1">Pólizas nuevas</p>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-blue-400">{result.rebillings}</p>
                <p className="text-sm text-gray-400 mt-1">Refacturaciones</p>
              </div>
              <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-orange-400">{result.cancelled}</p>
                <p className="text-sm text-gray-400 mt-1">Anuladas</p>
              </div>
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-red-400">{result.errors?.length || 0}</p>
                <p className="text-sm text-gray-400 mt-1">Errores</p>
              </div>
            </div>
            {result.errors?.length > 0 && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                <p className="text-sm font-medium text-red-400 mb-2">Errores:</p>
                {result.errors.map((e, i) => <p key={i} className="text-xs text-gray-400">{e}</p>)}
              </div>
            )}
            <button onClick={reset} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors">
              Importar otro archivo
            </button>
          </div>
        )}

        {/* Preview */}
        {preview && !result && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-white font-medium">{preview.companyName}</p>
                  <p className="text-sm text-gray-400">
                    {policies.length} registros ·{" "}
                    {policies.filter(p => !p.movType?.toUpperCase().includes("PRORROGA") && !p.movType?.toUpperCase().includes("ANULACION") && !p.movType?.toUpperCase().includes("NOTA DE CREDITO")).length} nuevas ·{" "}
                    {policies.filter(p => p.movType?.toUpperCase().includes("PRORROGA")).length} prórrogas ·{" "}
                    {policies.filter(p => p.movType?.toUpperCase().includes("ANULACION")).length} anulaciones
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={reset} className="px-4 py-2 border border-[#1f2937] text-gray-400 text-sm rounded-lg hover:text-white transition-colors">
                  Cancelar
                </button>
                <button onClick={handleImport} disabled={importing}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors flex items-center gap-2">
                  {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {importing ? "Importando..." : "Confirmar importación"}
                </button>
              </div>
            </div>

            {/* Alerta de prórrogas huérfanas */}
            {orphanCount > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-yellow-400" />
                  <p className="text-sm font-medium text-yellow-400">
                    {orphanCount} prórroga{orphanCount > 1 ? "s" : ""} sin póliza original registrada
                  </p>
                </div>
                <p className="text-xs text-gray-400">
                  Estas pólizas se crearán como nuevas con los datos del TXT. Podés expandirlas y completar los datos de la póliza original antes de importar.
                </p>
              </div>
            )}

            {/* Parse errors */}
            {preview.errors.length > 0 && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <p className="text-sm font-medium text-red-400">{preview.errors.length} errores de parseo</p>
                </div>
                {preview.errors.map((e, i) => <p key={i} className="text-xs text-gray-400">{e}</p>)}
              </div>
            )}

            {/* Policies list */}
            <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-[#1f2937] flex items-center justify-between">
                <p className="text-sm font-semibold text-white">Preview de pólizas</p>
                <p className="text-xs text-gray-500">{policies.length} registros</p>
              </div>
              <div className="divide-y divide-[#1f2937]">
                {policies.map((p, i) => {
                  const badge = movBadge(p.movType);
                  const isExpanded = expanded === i;
                  const isEditing = editing === i;
                  return (
                    <div key={i} className={`px-5 py-3 ${p._orphan ? "border-l-2 border-yellow-500/40" : ""}`}>
                      {/* Row header */}
                      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(isExpanded ? null : i)}>
                        <div className="flex items-center gap-3 flex-wrap">
                          {p._orphan && <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />}
                          <span className="text-xs font-mono text-blue-400 w-20">{p.policyNumber}</span>
                          <span className="text-sm text-white">{p.insuredName}</span>
                          <span className="text-xs text-gray-500 hidden md:block">{p.vehicleBrand} {p.vehicleModel} {p.vehicleYear || ""}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600/15 text-blue-400">{detectVehicleType(p.vehicleType)}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-300 hidden md:block">{formatCurrency(p.premium)}</span>
                          <span className="text-xs text-gray-500">{p.endDate}</span>
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-[#1f2937] space-y-4">
                          {/* Datos del TXT */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div><p className="text-xs text-gray-500">Asegurado</p><p className="text-sm text-white">{p.insuredName}</p></div>
                            <div><p className="text-xs text-gray-500">DNI</p><p className="text-sm text-white">{p.insuredDni || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Email</p><p className="text-sm text-white">{p.insuredEmail || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Teléfono</p><p className="text-sm text-white">{p.insuredPhone || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Vigencia</p><p className="text-sm text-white">{p.startDate} → {p.endDate}</p></div>
                            <div><p className="text-xs text-gray-500">Prima</p><p className="text-sm text-white">{formatCurrency(p.premium)}</p></div>
                            <div><p className="text-xs text-gray-500">Suma asegurada</p><p className="text-sm text-white">{formatCurrency(p.sumInsured)}</p></div>
                            <div><p className="text-xs text-gray-500">Cobertura</p><p className="text-sm text-white">{p.coverageLabel || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Patente</p><p className="text-sm text-white">{p.vehiclePlate || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Vehículo</p><p className="text-sm text-white">{p.vehicleBrand} {p.vehicleModel} {p.vehicleYear || ""}</p></div>
                            <div><p className="text-xs text-gray-500">Motor</p><p className="text-sm text-white">{p.engineNumber || "-"}</p></div>
                            <div><p className="text-xs text-gray-500">Cuotas</p><p className="text-sm text-white">{p.installments.length}</p></div>
                          </div>

                          {/* Cuotas */}
                          {p.installments.length > 0 && (
                            <div>
                              <p className="text-xs text-gray-500 mb-1">Detalle de cuotas</p>
                              <div className="flex flex-wrap gap-2">
                                {p.installments.map((inst) => (
                                  <span key={inst.number} className="text-xs bg-[#1a2540] text-gray-300 px-2 py-1 rounded">
                                    #{inst.number} · {inst.dueDate} · {formatCurrency(inst.amount)}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Panel de póliza original — solo para prórrogas */}
                          {p._orphan && (
                            <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <AlertTriangle className="w-4 h-4 text-yellow-400" />
                                  <p className="text-sm font-medium text-yellow-300">Datos de la póliza original</p>
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setEditing(isEditing ? null : i); }}
                                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded border border-[#1f2937] hover:border-gray-500"
                                >
                                  {isEditing ? <X className="w-3 h-3" /> : <Edit2 className="w-3 h-3" />}
                                  {isEditing ? "Cerrar" : "Editar datos"}
                                </button>
                              </div>
                              <p className="text-xs text-gray-500">
                                Si la póliza original no está cargada en el sistema, completá estos datos para crearla como base antes de registrar la prórroga.
                              </p>

                              {isEditing ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Fecha inicio póliza original</label>
                                    <input type="date" value={p._baseStartDate || ""}
                                      onChange={e => updatePolicy(i, "_baseStartDate", e.target.value)}
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Fecha fin póliza original</label>
                                    <input type="date" value={p._baseEndDate || ""}
                                      onChange={e => updatePolicy(i, "_baseEndDate", e.target.value)}
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Prima original</label>
                                    <input type="number" value={p._basePremium || ""}
                                      onChange={e => updatePolicy(i, "_basePremium", parseFloat(e.target.value) || 0)}
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Suma asegurada original</label>
                                    <input type="number" value={p._baseSumInsured || ""}
                                      onChange={e => updatePolicy(i, "_baseSumInsured", parseFloat(e.target.value) || 0)}
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Cobertura original</label>
                                    <input type="text" value={p._baseCoverage || ""}
                                      onChange={e => updatePolicy(i, "_baseCoverage", e.target.value)}
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">Observaciones</label>
                                    <input type="text" value={p._baseNotes || ""}
                                      onChange={e => updatePolicy(i, "_baseNotes", e.target.value)}
                                      placeholder="Ej: póliza anterior manual"
                                      className="w-full bg-[#0d1424] border border-[#1f2937] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                                  </div>
                                </div>
                              ) : (
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                  <div><p className="text-xs text-gray-500">Inicio original</p><p className="text-sm text-white">{p._baseStartDate || <span className="text-gray-600 italic">no definido</span>}</p></div>
                                  <div><p className="text-xs text-gray-500">Fin original</p><p className="text-sm text-white">{p._baseEndDate || <span className="text-gray-600 italic">no definido</span>}</p></div>
                                  <div><p className="text-xs text-gray-500">Prima original</p><p className="text-sm text-white">{p._basePremium ? formatCurrency(p._basePremium) : <span className="text-gray-600 italic">igual a prórroga</span>}</p></div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
