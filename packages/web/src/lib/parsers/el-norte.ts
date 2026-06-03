// ── Parser compartido El Norte ────────────────────────────────────────────────
// Usado tanto en el frontend (importar.tsx) como en el backend (batch endpoint)

export interface ElNortePolicy {
  policyNumber: string;
  movType: string;
  endoso: string;
  startDate: string;
  endDate: string;
  emisionDate: string;
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
  // campos para prorroga huérfana (frontend los rellena, batch los deja vacíos)
  _orphan?: boolean;
  _baseStartDate?: string;
  _baseEndDate?: string;
  _basePremium?: number;
  _baseSumInsured?: number;
  _baseCoverage?: string;
  _baseNotes?: string;
}

export interface ElNorteParseResult {
  policies: ElNortePolicy[];
  errors: string[];
}

function parseFecha(s: string): string {
  if (!s || s.length !== 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function parseElNorteTxt(content: string): ElNorteParseResult {
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

  const policies: ElNortePolicy[] = [];
  for (const key of Object.keys(pvMap)) {
    const pv = pvMap[key];
    const it = itMap[key];
    const pp = ppMap[key] || [];
    const as = asMap[pv.insuredId];
    if (!as) { errors.push(`Póliza ${pv.policyNumber}: asegurado ${pv.insuredId} no encontrado`); continue; }

    const mov = (pv.movType || "").toUpperCase();
    const isOrphanProrroga = mov.includes("PRORROGA");

    policies.push({
      policyNumber: pv.policyNumber,
      endoso: pv.endoso,
      movType: pv.movType,
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
      _orphan: isOrphanProrroga,
      _baseStartDate: "",
      _baseEndDate: pv.startDate,
      _basePremium: pv.premium,
      _baseSumInsured: it?.sumInsured || 0,
      _baseCoverage: it?.coverageLabel || "",
      _baseNotes: "",
    });
  }

  return { policies, errors };
}
