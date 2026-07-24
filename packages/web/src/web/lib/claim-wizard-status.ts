// Helpers puros del wizard de siniestros (packages/web/src/web/pages/siniestros.tsx
// y siniestro-detail.tsx). Sin React, sin fetch — así se prueban sin infraestructura
// de componentes, mismo estilo que policy-cancellation.ts.
//
// Estado real: "pendiente" ES la previa (con o sin póliza vinculada). Ningún otro
// status del wizard (nuevo, en_curso, reclamo_tercero, resuelto) representa una
// previa. Mientras el flujo esté en modo previa (ver computeIsPreliminaryPath),
// toda escritura de cualquier paso del wizard debe conservar "pendiente" — nunca
// debe haber un salto silencioso a un status definitivo. Esa fue la causa del bug
// de QA 2026-07-24: el checkbox "mantener como previa" solo se leía en el paso 1,
// y los pasos 2-4 pisaban el status con en_curso/resuelto/reclamo_tercero sin
// mirarlo.

export type ClaimStatus = "pendiente" | "nuevo" | "en_curso" | "reclamo_tercero" | "resuelto";

// ─── 1. ¿El flujo está en modo previa? ─────────────────────────────────────────

// Sin póliza real vinculada nunca se puede finalizar — el backend rechaza
// status="nuevo" sin policyId (POST/PUT /claims), así que una carga manual
// siempre queda en modo previa. Con póliza real, el checkbox "Mantener como
// previa de carga" es quien decide.
export function computeIsPreliminaryPath(hasRealPolicy: boolean, keepPreliminary: boolean): boolean {
  return !hasRealPolicy || keepPreliminary;
}

// ─── 2. Decisión de status por paso ────────────────────────────────────────────
//
// Único punto de la regla "mientras isPreliminaryPath, todo se guarda pendiente".
// handleStep1 / handleStep2 / handleStep3 / handleFinish llaman a estas funciones
// en vez de hardcodear el status final, para no duplicar la condición.

function lockedOrTarget(isPreliminaryPath: boolean, target: ClaimStatus): ClaimStatus {
  return isPreliminaryPath ? "pendiente" : target;
}

export function resolveStep1Status(isPreliminaryPath: boolean): ClaimStatus {
  return lockedOrTarget(isPreliminaryPath, "nuevo");
}

export function resolveStep2Status(
  isPreliminaryPath: boolean,
  opts: { hasThirdParty: boolean; insuredAtFault: boolean }
): ClaimStatus {
  return lockedOrTarget(isPreliminaryPath, opts.hasThirdParty && opts.insuredAtFault ? "resuelto" : "en_curso");
}

export function resolveStep3Status(isPreliminaryPath: boolean, opts: { skip: boolean }): ClaimStatus {
  return lockedOrTarget(isPreliminaryPath, opts.skip ? "en_curso" : "reclamo_tercero");
}

export function resolveFinishStatus(isPreliminaryPath: boolean, opts: { resolved: boolean }): ClaimStatus {
  return lockedOrTarget(isPreliminaryPath, opts.resolved ? "resuelto" : "en_curso");
}

// ─── 3. Reapertura de una previa ("Completar siniestro" / "Ingresar siniestro") ─
//
// Todos los nombres de campo son los reales de packages/web/src/api/database/schema.ts
// (tabla `claims`). "responsabilidad" (insuredAtFault) queda afuera a propósito:
// es una bandera efímera de la UI del paso 2 que decide el status final, pero no
// se persiste como columna propia — no hay de dónde reconstruirla al reabrir.
// Las columnas de resolución (resolved/resolvedDate/resolutionNotes/resolutionAmount)
// tampoco se hidratan acá: el wizard (paso 4) nunca las edita, solo decide el status
// final — esos campos solo se editan desde el panel "Resolver" de siniestro-detail.tsx.

export interface ClaimRecord {
  claimNumber?: string | null;
  manualInsured?: string | null;
  manualCompany?: string | null;
  manualPolicyNumber?: string | null;
  manualPolicyType?: string | null;
  manualNotes?: string | null;
  incidentDate?: string | null;
  incidentTime?: string | null;
  incidentLocation?: string | null;
  incidentDescription?: string | null;
  damages?: string | null;
  thirdPartyName?: string | null;
  thirdPartyDni?: string | null;
  thirdPartyPhone?: string | null;
  thirdPartyVehiclePlate?: string | null;
  thirdPartyVehicleBrand?: string | null;
  thirdPartyVehicleModel?: string | null;
  thirdPartyInsurer?: string | null;
  thirdPartyPolicyNumber?: string | null;
  claimFiled?: number | boolean | null;
  claimFiledDate?: string | null;
  claimCompany?: string | null;
  claimNumberThird?: string | null;
  claimNotes?: string | null;
}

// Recorta la parte de fecha por texto — nunca pasa por Date()/timezone, porque
// un valor "YYYY-MM-DD" interpretado como UTC y reformateado en hora local puede
// correrse un día. Los valores ya vienen en este formato (mismo que escribe
// <input type="date">); si llegara un datetime completo, se toma solo la fecha.
export function normalizeDateForInput(value: string | null | undefined): string {
  if (!value) return "";
  const datePart = value.split("T")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : "";
}

// <input type="time"> espera "HH:mm". Si el valor guardado trae segundos
// ("HH:mm:ss") se recorta; si no matchea ese formato, se deja vacío en vez de
// pasarle a React un value que el input no puede representar.
export function normalizeTimeForInput(value: string | null | undefined): string {
  if (!value) return "";
  const match = value.match(/^(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

export interface ClaimWizardResumeState {
  initialStep: 1 | 2;
  initialManualMode: boolean;
  manualInsured: string;
  manualCompany: string;
  manualPolicyNumber: string;
  manualPolicyType: string;
  manualNotes: string;
  claimNumber: string;
  incidentDate: string;
  incidentTime: string;
  incidentLocation: string;
  incidentDescription: string;
  damages: string;
  thirdPartyName: string;
  thirdPartyDni: string;
  thirdPartyPhone: string;
  thirdPartyVehiclePlate: string;
  thirdPartyVehicleBrand: string;
  thirdPartyVehicleModel: string;
  thirdPartyInsurer: string;
  thirdPartyPolicyNumber: string;
  claimFiled: boolean;
  claimFiledDate: string;
  claimCompany: string;
  claimNumberThird: string;
  claimNotes: string;
}

// Con póliza real ya vinculada: entra directo al paso 2 con todo precargado.
// Sin póliza real (incluso si ya había datos manuales cargados): siempre entra
// por el paso 1 para dar la chance de asociar una póliza real ahora. Antes del
// fix saltaba directo al paso 2 y nunca volvía a ofrecer la búsqueda de póliza.
//
// `claim` puede venir undefined (siniestro nuevo, sin retomar nada) — en ese
// caso devuelve el mismo estado "vacío" que ya usaban los useState originales,
// así sirve tanto para hidratar una previa como para inicializar un alta nueva.
export function buildClaimWizardResumeState(
  claim: ClaimRecord | undefined,
  hasRealPolicy: boolean
): ClaimWizardResumeState {
  return {
    initialStep: hasRealPolicy ? 2 : 1,
    initialManualMode: false,
    manualInsured: claim?.manualInsured ?? "",
    manualCompany: claim?.manualCompany ?? "",
    manualPolicyNumber: claim?.manualPolicyNumber ?? "",
    manualPolicyType: claim?.manualPolicyType ?? "",
    manualNotes: claim?.manualNotes ?? "",
    claimNumber: claim?.claimNumber ?? "",
    incidentDate: normalizeDateForInput(claim?.incidentDate),
    incidentTime: normalizeTimeForInput(claim?.incidentTime),
    incidentLocation: claim?.incidentLocation ?? "",
    incidentDescription: claim?.incidentDescription ?? "",
    damages: claim?.damages ?? "",
    thirdPartyName: claim?.thirdPartyName ?? "",
    thirdPartyDni: claim?.thirdPartyDni ?? "",
    thirdPartyPhone: claim?.thirdPartyPhone ?? "",
    thirdPartyVehiclePlate: claim?.thirdPartyVehiclePlate ?? "",
    thirdPartyVehicleBrand: claim?.thirdPartyVehicleBrand ?? "",
    thirdPartyVehicleModel: claim?.thirdPartyVehicleModel ?? "",
    thirdPartyInsurer: claim?.thirdPartyInsurer ?? "",
    thirdPartyPolicyNumber: claim?.thirdPartyPolicyNumber ?? "",
    claimFiled: !!claim?.claimFiled,
    claimFiledDate: claim?.claimFiledDate ?? "",
    claimCompany: claim?.claimCompany ?? "",
    claimNumberThird: claim?.claimNumberThird ?? "",
    claimNotes: claim?.claimNotes ?? "",
  };
}

// ─── 4. Acción "Convertir en reclamo de tercero" (siniestro-detail.tsx) ────────

// Nunca debe ofrecerse para una previa — evita repetir el bug donde un status
// "en_curso" incorrecto habilitaba "Pasar a reclamo" sobre una carga previa.
export function canConvertToThirdPartyClaim(status: ClaimStatus | string): boolean {
  return status === "en_curso";
}
