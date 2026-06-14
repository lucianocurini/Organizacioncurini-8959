// Parser El Norte v2 — mejoras sobre el original:
// - Soporte ENDOSO con múltiples IT por PV
// - movType como union type
// - stats en el resultado
// - fixEncoding para latin1

import type { ElNortePolicy } from "./el-norte";
export type { ElNortePolicy } from "./el-norte";

export type MovType =
  | "ALTA"
  | "RENOVACION"
  | "PRORROGA"
  | "ANULACION"
  | "ENDOSO"
  | "NOTA DE CREDITO"
  | (string & {});

export interface ItRow {
  sumInsured: number;
  coverageCode: string;
  coverageLabel: string;
  plate: string;
  engine: string;
  brand: string;
  model: string;
  year: number;
  vehicleType: string;
}

export interface ElNortePolicyV2 extends Omit<ElNortePolicy, "movType"> {
  movType: MovType;
  itRows: ItRow[];
}

export interface ElNorteStats {
  total: number;
  nuevas: number;
  prorrogas: number;
  endosos: number;
  anulaciones: number;
  notasCredito: number;
  otros: number;
}

export interface ElNorteParseResultV2 {
  policies: ElNortePolicyV2[];
  stats: ElNorteStats;
  errors: string[];
}

function parseFecha(s: string): string {
  if (!s || s.length !== 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function fixEncoding(content: string): string {
  return content
    .replace(/�/g, "?")
    .replace(/\xE1/g, "á").replace(/\xE9/g, "é").replace(/\xED/g, "í")
    .replace(/\xF3/g, "ó").replace(/\xFA/g, "ú").replace(/\xF1/g, "ñ")
    .replace(/\xC1/g, "Á").replace(/\xC9/g, "É").replace(/\xCD/g, "Í")
    .replace(/\xD3/g, "Ó").replace(/\xDA/g, "Ú").replace(/\xD1/g, "Ñ");
}

export function parseElNorteTxtV2(rawContent: string): ElNorteParseResultV2 {
  const content = fixEncoding(rawContent);
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const errors: string[] = [];
  const pvMap: Record<string, any> = {};
  const asMap: Record<string, any> = {};
  const itMap: Record<string, ItRow[]> = {};
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
        if (!itMap[key]) itMap[key] = [];
        itMap[key].push({
          sumInsured: parseFloat(cols[6]) || 0,
          coverageCode: cols[8],
          coverageLabel: cols[9],
          plate: cols[16],
          engine: cols[17],
          brand: cols[19],
          model: cols[20],
          year: parseInt(cols[21]) || 0,
          vehicleType: cols[22],
        });
      } else if (type === "PP") {
        const key = `${cols[3]}_${cols[4]}`;
        if (!ppMap[key]) ppMap[key] = [];
        ppMap[key].push({
          number: parseInt(cols[5]) || 0,
          dueDate: parseFecha(cols[7]),
          amount: parseFloat(cols[8]) || 0,
        });
      }
    } catch {
      errors.push(`Error parseando: ${line.slice(0, 60)}`);
    }
  }

  const policies: ElNortePolicyV2[] = [];
  for (const key of Object.keys(pvMap)) {
    const pv = pvMap[key];
    const itRows = itMap[key] || [];
    const it = itRows[0];
    const pp = ppMap[key] || [];
    const as = asMap[pv.insuredId];
    if (!as) {
      errors.push(`Póliza ${pv.policyNumber}: asegurado ${pv.insuredId} no encontrado`);
      continue;
    }

    const mov = (pv.movType || "").toUpperCase();

    policies.push({
      policyNumber: pv.policyNumber,
      endoso: pv.endoso,
      movType: pv.movType as MovType,
      emisionDate: pv.emisionDate,
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
      installments: pp.sort((a: any, b: any) => a.number - b.number),
      itRows,
      _orphan: mov.includes("PRORROGA"),
      _baseStartDate: "",
      _baseEndDate: pv.startDate,
      _basePremium: pv.premium,
      _baseSumInsured: it?.sumInsured || 0,
      _baseCoverage: it?.coverageLabel || "",
      _baseNotes: "",
    });
  }

  const stats: ElNorteStats = {
    total: policies.length,
    nuevas: 0, prorrogas: 0, endosos: 0, anulaciones: 0, notasCredito: 0, otros: 0,
  };
  for (const p of policies) {
    const m = (p.movType || "").toUpperCase();
    if (m.includes("PRORROGA")) stats.prorrogas++;
    else if (m.includes("ENDOSO")) stats.endosos++;
    else if (m.includes("ANULACION")) stats.anulaciones++;
    else if (m.includes("NOTA") && m.includes("CREDITO")) stats.notasCredito++;
    else if (m.includes("ALTA") || m.includes("RENOVACION")) stats.nuevas++;
    else stats.otros++;
  }

  return { policies, stats, errors };
}
