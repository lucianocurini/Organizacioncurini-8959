import { Hono } from "hono";
import { eq, like, or, desc, asc, and, inArray, isNull } from "drizzle-orm";
import { database as db } from "./database/index";
import { execSync } from "child_process";
import {
  users,
  companies,
  insureds,
  policies,
  sessions,
  payments,
  deliveries,
  rebillings,
  claims,
  policyInstallments,
  policyInsuredPersons,
  policyFleetVehicles,
  taskTemplates,
  tasks,
} from "./database/schema";
import { nanoid } from "nanoid";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

// ─── Gmail Attachment Helper ──────────────────────────────────────────────────
// Descarga el attachment de Gmail via ORPC (mismo protocolo que el CLI connector).
// El resultado incluye exports.$filestash_uploads con una URL S3 presignada válida 30min.
async function gmailGetAttachmentContent(messageId: string, attachmentId: string, filename?: string): Promise<string> {
  const cliUrl = process.env.CLI_URL || process.env.RUNABLE_URL;
  if (!cliUrl) throw new Error("CLI_URL no configurada");

  const cli: any = createORPCClient(new RPCLink({ url: cliUrl }));

  const safeFilename = filename || `attachment_${messageId}.TXT`;
  const orpcResult: any = await cli.connectors.run({
    appId: "gmail",
    actionId: "gmail-download-attachment",
    props: { messageId, attachmentId, filename: safeFilename },
  });

  // El resultado tiene exports.$filestash_uploads con URL S3 presignada (30min TTL)
  const uploads = orpcResult?.exports?.$filestash_uploads;
  if (uploads && uploads.length > 0 && uploads[0].get_url) {
    const s3Resp = await fetch(uploads[0].get_url);
    if (!s3Resp.ok) throw new Error(`S3 download failed: ${s3Resp.status}`);
    const buf = await s3Resp.arrayBuffer();
    return Buffer.from(buf).toString("latin1");
  }

  // Fallback: si result tiene filePath local (sandbox)
  const result = orpcResult?.result;
  if (result?.filePath) {
    try {
      const { readFileSync } = await import("fs");
      return readFileSync(result.filePath, { encoding: "latin1" });
    } catch (_) {
      // no-op
    }
  }

  // Fallback: data base64 inline
  if (result?.data) {
    const b64 = result.data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("latin1");
  }

  throw new Error(`gmail-download-attachment sin resultado utilizable para messageId=${messageId}`);
}

const app = new Hono().basePath("/api");

// ─── Auth Middleware ───────────────────────────────────────────────────────────
async function getUser(c: any) {
  const sessionId = c.req.header("x-session-id");
  if (!sessionId) return null;
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .get();
  return user || null;
}

function requireAuth(handler: Function) {
  return async (c: any) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: "No autorizado" }, 401);
    c.set("user", user);
    return handler(c);
  };
}

// ─── Normalize policy type ─────────────────────────────────────────────────────
function serverNormalizeType(val: string): string {
  const v = (val || "").toLowerCase().trim();
  if (v === "automotor" || v === "auto") return "automotor";
  if (v === "motovehiculo" || v === "motovehículo" || v === "moto") return "motovehiculo";
  if (v.includes("motoveh")) return "motovehiculo";
  if (v.includes("auto") || v.includes("vehiculo") || v.includes("vehículo")) return "automotor";
  if (v.includes("moto")) return "motovehiculo";
  if (v.includes("hogar") || v.includes("propiedad") || v.includes("inmueble")) return "hogar";
  if (v.includes("accidente") || v.includes("personal")) return "accidentes";
  if (v.includes("art") || v.includes("riesgo trabajo")) return "art";
  if (v.includes("eco") || v.includes("bicicleta") || v.includes("monopatin")) return "ecomovilidad";
  if (v.includes("resp") && v.includes("civil")) return "responsabilidad_civil";
  if (v.includes("casco")) return "cascos";
  if (v.includes("incendio") && !v.includes("integral")) return "incendio";
  if (v.includes("integral") || v.includes("comercial") || v.includes("empresa")) return "comercial";
  return v || "automotor";
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
app.post("/auth/login", async (c) => {
  const body = await c.req.json();
  const { email, password } = body;
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user) return c.json({ error: "Credenciales inválidas" }, 401);
  if (user.active === 0) return c.json({ error: "Usuario suspendido. Contactá al administrador." }, 403);
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (user.password !== hash) return c.json({ error: "Credenciales inválidas" }, 401);
  const sessionId = nanoid(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id: sessionId, userId: user.id, expiresAt });
  return c.json({ sessionId, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 200);
});

app.post("/auth/logout", async (c) => {
  const sessionId = c.req.header("x-session-id");
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  return c.json({ ok: true }, 200);
});

app.get("/auth/me", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "No autorizado" }, 401);
  return c.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 200);
});

// ─── COMPANIES ────────────────────────────────────────────────────────────────
app.get("/companies", requireAuth(async (c: any) => {
  const list = await db.select().from(companies).orderBy(companies.name).all();
  return c.json(list, 200);
}));

app.post("/companies", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [company] = await db.insert(companies).values(body).returning();
  return c.json(company, 201);
}));

app.put("/companies/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [company] = await db.update(companies).set(body).where(eq(companies.id, Number(c.req.param("id")))).returning();
  return c.json(company, 200);
}));

app.delete("/companies/:id", requireAuth(async (c: any) => {
  await db.delete(companies).where(eq(companies.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── INSUREDS ─────────────────────────────────────────────────────────────────
app.get("/insureds", requireAuth(async (c: any) => {
  const q = c.req.query("q");
  if (q) {
    const results = await db
      .select()
      .from(insureds)
      .where(or(like(insureds.name, `%${q}%`), like(insureds.dni, `%${q}%`)))
      .orderBy(insureds.name)
      .all();
    return c.json(results, 200);
  }
  const list = await db.select().from(insureds).orderBy(insureds.name).all();
  return c.json(list, 200);
}));

app.post("/insureds", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [insured] = await db.insert(insureds).values(body).returning();
  return c.json(insured, 201);
}));

app.put("/insureds/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [insured] = await db
    .update(insureds)
    .set(body)
    .where(eq(insureds.id, Number(c.req.param("id"))))
    .returning();
  return c.json(insured, 200);
}));

// ─── POLICIES ─────────────────────────────────────────────────────────────────
app.get("/policies", requireAuth(async (c: any) => {
  const { q, type, status, companyId } = c.req.query();
  let results = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(isNull(policies.parentPolicyId))
    .orderBy(desc(policies.createdAt))
    .all();
  if (q) {
    const lower = q.toLowerCase();
    results = results.filter(
      (r) =>
        r.insured?.name.toLowerCase().includes(lower) ||
        r.company?.name.toLowerCase().includes(lower) ||
        r.policy.policyNumber.toLowerCase().includes(lower)
    );
  }
  if (type) results = results.filter((r) => r.policy.type === type);
  if (status) results = results.filter((r) => r.policy.status === status);
  if (companyId) results = results.filter((r) => r.policy.companyId === Number(companyId));
  return c.json(results, 200);
}));

app.get("/policies/:id", requireAuth(async (c: any) => {
  const id = Number(c.req.param("id"));
  const result = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(eq(policies.id, id))
    .get();
  if (!result) return c.json({ error: "No encontrada" }, 404);
  const policyRebillings = await db
    .select()
    .from(rebillings)
    .where(eq(rebillings.policyId, id))
    .orderBy(desc(rebillings.billingStart));
  const today = new Date().toISOString().split("T")[0];
  const instRows = await db
    .select()
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, id))
    .orderBy(policyInstallments.number);
  // auto-mark vencida
  for (const row of instRows) {
    if (row.status === "pendiente" && row.dueDate < today) {
      await db.update(policyInstallments).set({ status: "vencida" }).where(eq(policyInstallments.id, row.id));
      row.status = "vencida";
    }
  }
  // Subpólizas accesoria (accidentes_pasajeros con parentPolicyId = id)
  const subPolicies = await db
    .select({ policy: policies, company: companies, insured: insureds })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .where(eq(policies.parentPolicyId, id));

  return c.json({ ...result, rebillings: policyRebillings, installments: instRows, subPolicies }, 200);
}));

// ─── Rebillings ───────────────────────────────────────────────────────────────
app.get("/policies/:id/rebillings", requireAuth(async (c: any) => {
  const rows = await db
    .select()
    .from(rebillings)
    .where(eq(rebillings.policyId, Number(c.req.param("id"))))
    .orderBy(desc(rebillings.billingStart));
  return c.json(rows, 200);
}));

app.post("/policies/:id/rebillings", requireAuth(async (c: any) => {
  const user = c.get("user");
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  const [row] = await db
    .insert(rebillings)
    .values({
      policyId,
      billingStart: body.billingStart,
      billingEnd: body.billingEnd,
      premium: body.premium ? Number(body.premium) : null,
      monthlyFee: body.monthlyFee ? Number(body.monthlyFee) : null,
      sumInsured: body.sumInsured ? Number(body.sumInsured) : null,
      notes: body.notes || null,
      createdBy: user.id,
    })
    .returning();
  return c.json(row, 201);
}));

app.put("/rebillings/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const [row] = await db
    .update(rebillings)
    .set({
      billingStart: body.billingStart,
      billingEnd: body.billingEnd,
      premium: body.premium ? Number(body.premium) : null,
      monthlyFee: body.monthlyFee ? Number(body.monthlyFee) : null,
      sumInsured: body.sumInsured ? Number(body.sumInsured) : null,
      notes: body.notes || null,
    })
    .where(eq(rebillings.id, Number(c.req.param("id"))))
    .returning();
  return c.json(row, 200);
}));

app.delete("/rebillings/:id", requireAuth(async (c: any) => {
  await db.delete(rebillings).where(eq(rebillings.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── INSTALLMENTS ─────────────────────────────────────────────────────────────
app.get("/policies/:id/installments", requireAuth(async (c: any) => {
  const rows = await db
    .select()
    .from(policyInstallments)
    .where(eq(policyInstallments.policyId, Number(c.req.param("id"))))
    .orderBy(policyInstallments.number);
  // auto-update vencida status
  const today = new Date().toISOString().split("T")[0];
  for (const row of rows) {
    if (row.status === "pendiente" && row.dueDate < today) {
      await db.update(policyInstallments).set({ status: "vencida" }).where(eq(policyInstallments.id, row.id));
      row.status = "vencida";
    }
  }
  return c.json(rows, 200);
}));

// Generate installments for a policy (replaces existing ones)
app.post("/policies/:id/installments/generate", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  // body.installments = array of { number, dueDate, amount, notes? }
  // Delete existing
  await db.delete(policyInstallments).where(eq(policyInstallments.policyId, policyId));
  if (!body.installments?.length) return c.json([], 200);
  const inserted = await db
    .insert(policyInstallments)
    .values(body.installments.map((inst: any) => ({
      policyId,
      number: inst.number,
      dueDate: inst.dueDate,
      amount: Number(inst.amount),
      status: "pendiente",
      notes: inst.notes || null,
    })))
    .returning();
  return c.json(inserted, 201);
}));

// Update a single installment
app.put("/installments/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("dueDate" in body) update.dueDate = body.dueDate;
  if ("amount" in body) update.amount = Number(body.amount);
  if ("status" in body) update.status = body.status;
  if ("notes" in body) update.notes = body.notes || null;
  const [row] = await db
    .update(policyInstallments)
    .set(update)
    .where(eq(policyInstallments.id, Number(c.req.param("id"))))
    .returning();
  return c.json(row, 200);
}));

app.post("/policies", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const today = new Date().toISOString().split("T")[0];
  const daysToEnd = Math.ceil(
    (new Date(body.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
  );
  let status = "activa";
  if (daysToEnd < 0) status = "vencida";
  else if (daysToEnd <= 30) status = "por_vencer";
  body.status = status;
  body.createdBy = user.id;
  // If renewal, mark previous policy as renovada
  if (body.renewedFromId) {
    await db.update(policies).set({ status: "renovada" }).where(eq(policies.id, Number(body.renewedFromId)));
  }
  const [policy] = await db.insert(policies).values(body).returning();
  return c.json(policy, 201);
}));

app.put("/policies/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const today = new Date().toISOString().split("T")[0];
  const daysToEnd = Math.ceil(
    (new Date(body.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (!body.status || body.status === "activa" || body.status === "por_vencer" || body.status === "vencida") {
    if (daysToEnd < 0) body.status = "vencida";
    else if (daysToEnd <= 30) body.status = "por_vencer";
    else body.status = "activa";
  }
  body.updatedAt = new Date();
  const [policy] = await db
    .update(policies)
    .set(body)
    .where(eq(policies.id, Number(c.req.param("id"))))
    .returning();
  return c.json(policy, 200);
}));

app.delete("/policies/:id", requireAuth(async (c: any) => {
  await db.delete(policies).where(eq(policies.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
app.get("/stats", requireAuth(async (c: any) => {
  const allPolicies = await db
    .select({ policy: policies, company: companies })
    .from(policies)
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(isNull(policies.parentPolicyId))
    .all();
  const total = allPolicies.length;
  const activas = allPolicies.filter((p) => p.policy.status === "activa").length;
  const vencidas = allPolicies.filter((p) => p.policy.status === "vencida").length;
  const porVencer = allPolicies.filter((p) => p.policy.status === "por_vencer").length;
  const canceladas = allPolicies.filter((p) => p.policy.status === "cancelada").length;
  const byType: Record<string, number> = {};
  for (const p of allPolicies) {
    const t = p.policy.type || "otro";
    byType[t] = (byType[t] || 0) + 1;
  }
  const byCompany: Record<string, { count: number; premium: number }> = {};
  for (const p of allPolicies) {
    const cname = p.company?.name || "Sin compañía";
    if (!byCompany[cname]) byCompany[cname] = { count: 0, premium: 0 };
    byCompany[cname].count++;
    byCompany[cname].premium += p.policy.premium || 0;
  }
  const totalPremium = allPolicies.reduce((s, p) => s + (p.policy.premium || 0), 0);
  const today = new Date().toISOString().split("T")[0];
  const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const upcoming = allPolicies.filter((p) => p.policy.endDate >= today && p.policy.endDate <= in30).length;
  return c.json({ total, activas, vencidas, porVencer, canceladas, byType, byCompany, totalPremium, upcoming }, 200);
}));

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────
app.post("/policies/import", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const rows: any[] = body.rows || [];
  if (!rows.length) return c.json({ error: "Sin filas" }, 400);
  const results = { imported: 0, skipped: 0, errors: [] as string[] };
  for (const row of rows) {
    try {
      let companyId: number | null = null;
      if (row.company) {
        const existing = await db.select().from(companies).where(eq(companies.name, row.company)).get();
        if (existing) {
          companyId = existing.id;
        } else {
          const [nc] = await db.insert(companies).values({ name: row.company }).returning({ id: companies.id });
          companyId = nc.id;
        }
      }
      let insuredId: number | null = null;
      if (row.insured) {
        const existing = await db.select().from(insureds).where(eq(insureds.name, row.insured)).get();
        if (existing) {
          insuredId = existing.id;
        } else {
          const [ni] = await db
            .insert(insureds)
            .values({ name: row.insured, dni: row.dni || null, phone: row.phone || null, email: row.email || null })
            .returning({ id: insureds.id });
          insuredId = ni.id;
        }
      }
      if (!companyId || !insuredId || !row.policyNumber || !row.startDate || !row.endDate) {
        results.skipped++;
        results.errors.push(`Fila ${results.imported + results.skipped}: datos incompletos`);
        continue;
      }
      const today = new Date().toISOString().split("T")[0];
      const daysToEnd = Math.ceil(
        (new Date(row.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
      );
      let status = "activa";
      if (daysToEnd < 0) status = "vencida";
      else if (daysToEnd <= 30) status = "por_vencer";
      const normalizedType = serverNormalizeType(row.type || "automotor");
      const isMoto = normalizedType === "motovehiculo";
      await db.insert(policies).values({
        policyNumber: String(row.policyNumber),
        type: normalizedType,
        status,
        companyId,
        insuredId,
        premium: row.premium ? Number(row.premium) : null,
        sumInsured: row.sumInsured ? Number(row.sumInsured) : null,
        startDate: row.startDate,
        endDate: row.endDate,
        notes: row.notes || null,
        vehicleBrand: isMoto ? null : row.vehicleBrand || null,
        vehicleModel: isMoto ? null : row.vehicleModel || null,
        vehicleYear: isMoto ? null : row.vehicleYear ? Number(row.vehicleYear) : null,
        vehiclePlate: isMoto ? null : row.vehiclePlate || null,
        motoBrand: isMoto ? row.vehicleBrand || null : null,
        motoModel: isMoto ? row.vehicleModel || null : null,
        motoYear: isMoto ? (row.vehicleYear ? Number(row.vehicleYear) : null) : null,
        motoPlate: isMoto ? row.vehiclePlate || null : null,
        motoEngine: row.motoEngine || null,
        coverageType: row.coverageType || null,
        monthlyFee: row.monthlyFee ? Number(row.monthlyFee) : null,
        deductible: row.deductible ? Number(row.deductible) : null,
        billingCycle: row.billingCycle || null,
        installments: row.installments ? Number(row.installments) : null,
        vigencyPeriod: row.vigencyPeriod || "anual",
        propertyAddress: row.propertyAddress || null,
        businessName: row.businessName || null,
        businessActivity: row.businessActivity || null,
        isRebilling: row.isRebilling ? 1 : 0,
        createdBy: user.id,
      });
      results.imported++;
    } catch (e: any) {
      results.skipped++;
      results.errors.push(`Error en fila: ${e.message}`);
    }
  }
  return c.json(results, 200);
}));

// ─── POLICY INSURED PERSONS ──────────────────────────────────────────────────
app.get("/policies/:id/insured-persons", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const list = await db.select().from(policyInsuredPersons)
    .where(eq(policyInsuredPersons.policyId, policyId))
    .orderBy(asc(policyInsuredPersons.createdAt));
  return c.json(list, 200);
}));

app.post("/policies/:id/insured-persons", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  const [row] = await db.insert(policyInsuredPersons).values({
    policyId,
    name: body.name,
    dni: body.dni || null,
    birthDate: body.birthDate || null,
    relationship: body.relationship || null,
    phone: body.phone || null,
    email: body.email || null,
    notes: body.notes || null,
  }).returning();
  return c.json(row, 201);
}));

app.put("/policies/:id/insured-persons/:personId", requireAuth(async (c: any) => {
  const personId = Number(c.req.param("personId"));
  const body = await c.req.json();
  const update: any = {};
  if ("name" in body) update.name = body.name;
  if ("dni" in body) update.dni = body.dni || null;
  if ("birthDate" in body) update.birthDate = body.birthDate || null;
  if ("relationship" in body) update.relationship = body.relationship || null;
  if ("phone" in body) update.phone = body.phone || null;
  if ("email" in body) update.email = body.email || null;
  if ("notes" in body) update.notes = body.notes || null;
  const [row] = await db.update(policyInsuredPersons).set(update)
    .where(eq(policyInsuredPersons.id, personId)).returning();
  return c.json(row, 200);
}));

app.delete("/policies/:id/insured-persons/:personId", requireAuth(async (c: any) => {
  const personId = Number(c.req.param("personId"));
  await db.delete(policyInsuredPersons).where(eq(policyInsuredPersons.id, personId));
  return c.json({ ok: true }, 200);
}));

// ─── FLEET VEHICLES ──────────────────────────────────────────────────────────
app.get("/policies/:id/fleet-vehicles", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const list = await db.select().from(policyFleetVehicles)
    .where(eq(policyFleetVehicles.policyId, policyId))
    .orderBy(asc(policyFleetVehicles.createdAt));
  return c.json(list);
}));

app.post("/policies/:id/fleet-vehicles", requireAuth(async (c: any) => {
  const policyId = Number(c.req.param("id"));
  const body = await c.req.json();
  const [row] = await db.insert(policyFleetVehicles).values({
    policyId,
    brand: body.brand || null,
    model: body.model || null,
    year: body.year ? Number(body.year) : null,
    plate: body.plate || null,
    chasis: body.chasis || null,
    engine: body.engine || null,
    color: body.color || null,
    sumInsured: body.sumInsured ? Number(body.sumInsured) : null,
    notes: body.notes || null,
  }).returning();
  return c.json(row, 201);
}));

app.put("/policies/:id/fleet-vehicles/:vehicleId", requireAuth(async (c: any) => {
  const vehicleId = Number(c.req.param("vehicleId"));
  const body = await c.req.json();
  const update: any = {};
  if (body.brand !== undefined) update.brand = body.brand;
  if (body.model !== undefined) update.model = body.model;
  if (body.year !== undefined) update.year = body.year ? Number(body.year) : null;
  if (body.plate !== undefined) update.plate = body.plate;
  if (body.chasis !== undefined) update.chasis = body.chasis;
  if (body.engine !== undefined) update.engine = body.engine;
  if (body.color !== undefined) update.color = body.color;
  if (body.sumInsured !== undefined) update.sumInsured = body.sumInsured ? Number(body.sumInsured) : null;
  if (body.notes !== undefined) update.notes = body.notes;
  const [row] = await db.update(policyFleetVehicles).set(update)
    .where(eq(policyFleetVehicles.id, vehicleId)).returning();
  return c.json(row);
}));

app.delete("/policies/:id/fleet-vehicles/:vehicleId", requireAuth(async (c: any) => {
  const vehicleId = Number(c.req.param("vehicleId"));
  await db.delete(policyFleetVehicles).where(eq(policyFleetVehicles.id, vehicleId));
  return c.json({ ok: true }, 200);
}));

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
app.get("/payments", requireAuth(async (c: any) => {
  const { policyId, method, status, from, to } = c.req.query();
  let results = await db
    .select({ payment: payments, policy: policies, insured: insureds, company: companies, installment: policyInstallments })
    .from(payments)
    .leftJoin(policies, eq(payments.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .leftJoin(policyInstallments, eq(payments.installmentId, policyInstallments.id))
    .orderBy(desc(payments.createdAt))
    .all();
  if (policyId) results = results.filter((r) => r.payment.policyId === Number(policyId));
  if (method) results = results.filter((r) => r.payment.paymentMethod === method);
  if (status) results = results.filter((r) => r.payment.status === status);
  if (from) results = results.filter((r) => r.payment.paymentDate >= from);
  if (to) results = results.filter((r) => r.payment.paymentDate <= to);
  return c.json(results, 200);
}));

app.post("/payments", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const [payment] = await db
    .insert(payments)
    .values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      installmentId: body.installmentId ? Number(body.installmentId) : null,
      manualPayer: body.manualPayer || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualCompany: body.manualCompany || null,
      amount: Number(body.amount),
      paymentMethod: body.paymentMethod,
      paymentDate: body.paymentDate,
      periodMonth: body.periodMonth || null,
      notes: body.notes || null,
      status: body.status || "confirmado",
      createdBy: user.id,
    })
    .returning();
  // If linked to installment, mark it as pagada
  if (body.installmentId && (body.status || "confirmado") === "confirmado") {
    await db.update(policyInstallments).set({ status: "pagada" }).where(eq(policyInstallments.id, Number(body.installmentId)));
  }
  return c.json(payment, 201);
}));

app.put("/payments/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));
  const update: any = {};
  const fields = ["policyId", "installmentId", "manualPayer", "manualPolicyNumber", "manualCompany", "amount", "paymentMethod", "paymentDate", "periodMonth", "notes", "status"];
  for (const f of fields) {
    if (f in body) update[f] = body[f];
  }
  if ("policyId" in update && (update.policyId === "" || update.policyId == null)) {
    update.policyId = null;
  } else if ("policyId" in update) {
    update.policyId = Number(update.policyId);
  }
  if ("installmentId" in update && (update.installmentId === "" || update.installmentId == null)) {
    update.installmentId = null;
  } else if ("installmentId" in update) {
    update.installmentId = Number(update.installmentId);
  }
  const [payment] = await db.update(payments).set(update).where(eq(payments.id, id)).returning();
  return c.json(payment, 200);
}));

app.delete("/payments/:id", requireAuth(async (c: any) => {
  await db.delete(payments).where(eq(payments.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

app.get("/payments/stats", requireAuth(async (c: any) => {
  const all = await db.select({ payment: payments }).from(payments).all();
  const confirmed = all.filter((r) => r.payment.status === "confirmado");
  const total = confirmed.reduce((s, r) => s + r.payment.amount, 0);
  const byMethod: Record<string, number> = {};
  for (const r of confirmed) {
    byMethod[r.payment.paymentMethod] = (byMethod[r.payment.paymentMethod] || 0) + r.payment.amount;
  }
  const byMonth: Record<string, number> = {};
  for (const r of confirmed) {
    const month = r.payment.paymentDate.substring(0, 7);
    byMonth[month] = (byMonth[month] || 0) + r.payment.amount;
  }
  return c.json({ total, count: confirmed.length, byMethod, byMonth }, 200);
}));

// ─── DELIVERIES ───────────────────────────────────────────────────────────────
app.get("/deliveries", requireAuth(async (c: any) => {
  const { policyId, channel, status, documentType } = c.req.query();
  let results = await db
    .select({ delivery: deliveries, policy: policies, insured: insureds, company: companies })
    .from(deliveries)
    .leftJoin(policies, eq(deliveries.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .orderBy(desc(deliveries.createdAt))
    .all();
  if (policyId) results = results.filter((r) => r.delivery.policyId === Number(policyId));
  if (channel) results = results.filter((r) => r.delivery.channel === channel);
  if (status) results = results.filter((r) => r.delivery.status === status);
  if (documentType) results = results.filter((r) => r.delivery.documentType === documentType);
  return c.json(results, 200);
}));

app.post("/deliveries", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const [delivery] = await db
    .insert(deliveries)
    .values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      manualRecipient: body.manualRecipient || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualCompany: body.manualCompany || null,
      documentType: body.documentType,
      channel: body.channel,
      status: body.status || "pendiente",
      scheduledDate: body.scheduledDate || null,
      notes: body.notes || null,
      createdBy: user.id,
    })
    .returning();
  return c.json(delivery, 201);
}));

app.put("/deliveries/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));
  const update: any = {};
  const fields = ["policyId", "manualRecipient", "manualPolicyNumber", "manualCompany", "documentType", "channel", "status", "scheduledDate", "completedDate", "notes"];
  for (const f of fields) {
    if (f in body) update[f] = body[f];
  }
  if ("policyId" in update && (update.policyId === "" || update.policyId == null)) {
    update.policyId = null;
  } else if ("policyId" in update) {
    update.policyId = Number(update.policyId);
  }
  const [delivery] = await db.update(deliveries).set(update).where(eq(deliveries.id, id)).returning();
  return c.json(delivery, 200);
}));

app.patch("/deliveries/:id/complete", requireAuth(async (c: any) => {
  const today = new Date().toISOString().split("T")[0];
  const [delivery] = await db
    .update(deliveries)
    .set({ status: "realizado", completedDate: today })
    .where(eq(deliveries.id, Number(c.req.param("id"))))
    .returning();
  return c.json(delivery, 200);
}));

app.delete("/deliveries/:id", requireAuth(async (c: any) => {
  await db.delete(deliveries).where(eq(deliveries.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── USERS (admin only) ────────────────────────────────────────────────────────
app.get("/users", requireAuth(async (c: any) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const list = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt })
    .from(users)
    .all();
  return c.json(list, 200);
}));

app.post("/users", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json();
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password));
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const [user] = await db
    .insert(users)
    .values({ ...body, password: hash })
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  return c.json(user, 201);
}));

app.put("/users/:id", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const targetId = Number(c.req.param("id"));
  const body = await c.req.json();
  const update: any = {};
  if (body.name) update.name = body.name;
  if (body.email) update.email = body.email;
  if (body.role) update.role = body.role;
  if (typeof body.active === "number") update.active = body.active;
  if (body.password) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password));
    update.password = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const [updated] = await db
    .update(users)
    .set(update)
    .where(eq(users.id, targetId))
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  return c.json(updated, 200);
}));

app.delete("/users/:id", requireAuth(async (c: any) => {
  const actor = c.get("user");
  if (actor.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const targetId = Number(c.req.param("id"));
  if (targetId === actor.id) return c.json({ error: "No podés eliminar tu propio usuario" }, 400);
  await db.delete(sessions).where(eq(sessions.userId, targetId));
  await db.update(policies).set({ createdBy: null }).where(eq(policies.createdBy, targetId));
  await db.update(payments).set({ createdBy: null }).where(eq(payments.createdBy, targetId));
  await db.update(deliveries).set({ createdBy: null }).where(eq(deliveries.createdBy, targetId));
  await db.update(claims).set({ createdBy: null }).where(eq(claims.createdBy, targetId));
  await db.update(rebillings).set({ createdBy: null }).where(eq(rebillings.createdBy, targetId));
  await db.update(insureds).set({ createdBy: null }).where(eq(insureds.createdBy, targetId));
  await db.delete(users).where(eq(users.id, targetId));
  return c.json({ ok: true }, 200);
}));

// ─── CLAIMS (Siniestros) ──────────────────────────────────────────────────────
app.get("/claims", requireAuth(async (c: any) => {
  const q = c.req.query("search") || "";
  const statusFilter = c.req.query("status") || "";
  let result = await db
    .select({ claim: claims, policy: policies, insured: insureds, company: companies })
    .from(claims)
    .leftJoin(policies, eq(claims.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .orderBy(desc(claims.createdAt));
  if (statusFilter) result = result.filter((r) => r.claim.status === statusFilter);
  if (q) {
    const lq = q.toLowerCase();
    result = result.filter(
      (r) =>
        r.policy?.policyNumber?.toLowerCase().includes(lq) ||
        r.insured?.name?.toLowerCase().includes(lq) ||
        r.claim.claimNumber?.toLowerCase().includes(lq) ||
        r.claim.incidentLocation?.toLowerCase().includes(lq)
    );
  }
  return c.json(result, 200);
}));

app.get("/claims/stats", requireAuth(async (c: any) => {
  const all = await db.select({ status: claims.status }).from(claims);
  const stats = { total: all.length, pendiente: 0, nuevo: 0, en_curso: 0, reclamo_tercero: 0, resuelto: 0 };
  for (const r of all) {
    if (r.status in stats) (stats as any)[r.status]++;
  }
  return c.json(stats, 200);
}));

app.get("/claims/:id", requireAuth(async (c: any) => {
  const result = await db
    .select({ claim: claims, policy: policies, insured: insureds, company: companies })
    .from(claims)
    .leftJoin(policies, eq(claims.policyId, policies.id))
    .leftJoin(insureds, eq(policies.insuredId, insureds.id))
    .leftJoin(companies, eq(policies.companyId, companies.id))
    .where(eq(claims.id, Number(c.req.param("id"))))
    .get();
  if (!result) return c.json({ error: "No encontrado" }, 404);
  return c.json(result, 200);
}));

app.post("/claims", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const hasPolicyId = body.policyId != null && body.policyId !== "";
  const [row] = await db
    .insert(claims)
    .values({
      policyId: hasPolicyId ? Number(body.policyId) : null,
      claimNumber: body.claimNumber || null,
      status: hasPolicyId ? "nuevo" : "pendiente",
      manualInsured: body.manualInsured || null,
      manualCompany: body.manualCompany || null,
      manualPolicyNumber: body.manualPolicyNumber || null,
      manualPolicyType: body.manualPolicyType || null,
      manualNotes: body.manualNotes || null,
      createdBy: user.id,
    })
    .returning();
  return c.json(row, 201);
}));

app.put("/claims/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const id = Number(c.req.param("id"));
  const update: any = { updatedAt: new Date() };
  const fields = [
    "policyId", "claimNumber", "status", "incidentDate", "incidentTime", "incidentLocation",
    "incidentDescription", "damages",
    "thirdPartyName", "thirdPartyDni", "thirdPartyPhone", "thirdPartyVehiclePlate",
    "thirdPartyVehicleBrand", "thirdPartyVehicleModel", "thirdPartyInsurer", "thirdPartyPolicyNumber",
    "claimFiled", "claimFiledDate", "claimCompany", "claimNumberThird", "claimNotes",
    "resolved", "resolvedDate", "resolutionNotes", "resolutionAmount",
    "manualInsured", "manualCompany", "manualPolicyNumber", "manualPolicyType", "manualNotes",
  ];
  for (const f of fields) {
    if (f in body) update[f] = body[f];
  }
  const [row] = await db.update(claims).set(update).where(eq(claims.id, id)).returning();
  return c.json(row, 200);
}));

app.delete("/claims/:id", requireAuth(async (c: any) => {
  await db.delete(claims).where(eq(claims.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── TASK TEMPLATES ───────────────────────────────────────────────────────────
app.get("/task-templates", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const all = await db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.active, 1))
    .orderBy(asc(taskTemplates.order), asc(taskTemplates.id));
  // Non-admins don't see admin-only templates
  const list = isAdmin ? all : all.filter(t => !t.isAdminOnly);
  return c.json(list, 200);
}));

app.post("/task-templates", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const all = await db.select({ order: taskTemplates.order }).from(taskTemplates).all();
  const maxOrder = all.length ? Math.max(...all.map((t) => t.order)) : 0;
  const day = body.dayOfMonth ? parseInt(body.dayOfMonth, 10) : null;
  const isAdminOnly = user.role === "admin" && !!body.isAdminOnly ? 1 : 0;
  const [row] = await db
    .insert(taskTemplates)
    .values({ title: body.title, description: body.description || null, dayOfMonth: day, order: maxOrder + 1, isAdminOnly, createdBy: user.id })
    .returning();
  return c.json(row, 201);
}));

app.put("/task-templates/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("title" in body) update.title = body.title;
  if ("description" in body) update.description = body.description || null;
  if ("dayOfMonth" in body) update.dayOfMonth = body.dayOfMonth ? parseInt(body.dayOfMonth, 10) : null;
  if ("order" in body) update.order = body.order;
  if ("active" in body) update.active = body.active;
  if ("isAdminOnly" in body) update.isAdminOnly = body.isAdminOnly ? 1 : 0;
  const [row] = await db.update(taskTemplates).set(update).where(eq(taskTemplates.id, Number(c.req.param("id")))).returning();
  return c.json(row, 200);
}));

app.delete("/task-templates/:id", requireAuth(async (c: any) => {
  // soft-delete
  await db.update(taskTemplates).set({ active: 0 }).where(eq(taskTemplates.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// ─── TASKS ────────────────────────────────────────────────────────────────────
// GET /tasks?month=2026-05  — returns all tasks for that month, auto-generates recurring ones
app.get("/tasks", requireAuth(async (c: any) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const monthYear = c.req.query("month") || new Date().toISOString().substring(0, 7);

  // Auto-generate recurring tasks from active templates if not yet created for this month
  const allTemplates = await db.select().from(taskTemplates).where(eq(taskTemplates.active, 1)).all();
  // Only generate from templates visible to this user
  const visibleTemplates = allTemplates.filter(t => isAdmin || !t.isAdminOnly);
  for (const tpl of visibleTemplates) {
    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.templateId, tpl.id))
      .all();
    const existsForMonth = existing.some((t) => t.monthYear === monthYear);
    if (!existsForMonth) {
      let dueDate: string | null = null;
      if (tpl.dayOfMonth) {
        const [y, m] = monthYear.split("-").map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        const day = Math.min(tpl.dayOfMonth, lastDay);
        dueDate = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      await db.insert(tasks).values({
        templateId: tpl.id,
        monthYear,
        title: tpl.title,
        description: tpl.description,
        dueDate,
        status: "pendiente",
        isRecurring: 1,
        isAdminOnly: tpl.isAdminOnly,
        createdBy: user.id,
      });
    }
  }

  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.monthYear, monthYear))
    .orderBy(desc(tasks.isRecurring), asc(tasks.createdAt));

  // Filter out admin-only tasks for non-admin users
  const list = isAdmin ? allTasks : allTasks.filter(t => !t.isAdminOnly);
  return c.json(list, 200);
}));

app.post("/tasks", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  // Only admins can create admin-only tasks
  const isAdminOnly = user.role === "admin" && !!body.isAdminOnly ? 1 : 0;
  const [row] = await db
    .insert(tasks)
    .values({
      templateId: null,
      monthYear: body.monthYear,
      title: body.title,
      description: body.description || null,
      dueDate: body.dueDate || null,
      status: "pendiente",
      isRecurring: 0,
      isAdminOnly,
      createdBy: user.id,
    })
    .returning();
  return c.json(row, 201);
}));

app.put("/tasks/:id", requireAuth(async (c: any) => {
  const body = await c.req.json();
  const update: any = {};
  if ("status" in body) {
    update.status = body.status;
    update.completedAt = body.status === "realizada" ? new Date() : null;
  }
  if ("title" in body) update.title = body.title;
  if ("description" in body) update.description = body.description || null;
  if ("dueDate" in body) update.dueDate = body.dueDate || null;
  const [row] = await db.update(tasks).set(update).where(eq(tasks.id, Number(c.req.param("id")))).returning();
  return c.json(row, 200);
}));

app.delete("/tasks/:id", requireAuth(async (c: any) => {
  await db.delete(tasks).where(eq(tasks.id, Number(c.req.param("id"))));
  return c.json({ ok: true }, 200);
}));

// GET /backup — full DB dump (admin only)
app.get("/backup", requireAuth(async (c: any) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

  const [
    allUsers,
    allCompanies,
    allInsureds,
    allPolicies,
    allPayments,
    allDeliveries,
    allClaims,
    allInstallments,
    allRebillings,
    allInsuredPersons,
    allFleetVehicles,
    allTaskTemplates,
    allTasks,
  ] = await Promise.all([
    db.select().from(users),
    db.select().from(companies),
    db.select().from(insureds),
    db.select().from(policies),
    db.select().from(payments),
    db.select().from(deliveries),
    db.select().from(claims),
    db.select().from(policyInstallments),
    db.select().from(rebillings),
    db.select().from(policyInsuredPersons),
    db.select().from(policyFleetVehicles),
    db.select().from(taskTemplates),
    db.select().from(tasks),
  ]);

  // Strip passwords from users
  const safeUsers = allUsers.map(({ password, ...u }) => u);

  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      users: safeUsers,
      companies: allCompanies,
      insureds: allInsureds,
      policies: allPolicies,
      payments: allPayments,
      deliveries: allDeliveries,
      claims: allClaims,
      policyInstallments: allInstallments,
      rebillings: allRebillings,
      policyInsuredPersons: allInsuredPersons,
      policyFleetVehicles: allFleetVehicles,
      taskTemplates: allTaskTemplates,
      tasks: allTasks,
    },
  };

  const filename = `curini-backup-${new Date().toISOString().substring(0, 10)}.json`;
  return new Response(JSON.stringify(backup, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}));

app.post("/import/el-norte", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = {
    imported: 0,
    rebillings: 0,
    cancelled: 0,
    skipped: 0,
    errors: [] as string[],
  };

  // Buscar o crear la compañía El Norte
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "El Norte")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  // Helper: buscar o crear asegurado
  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) {
      existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    }
    if (!existing) {
      existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    }
    if (existing) {
      if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
      if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName,
      dni: p.insuredDni || null,
      phone: p.insuredPhone || null,
      email: p.insuredEmail || null,
      address: p.insuredAddress || null,
      createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  // Helper: insertar cuotas
  async function insertInstallments(policyId: number, installments: any[]) {
    for (const inst of installments) {
      await db.insert(policyInstallments).values({
        policyId,
        number: inst.number,
        dueDate: inst.dueDate,
        amount: inst.amount,
        status: "pendiente",
      });
    }
  }

  // Helper: determinar tipo y status
  function resolveTypeAndStatus(p: any) {
    const vt = (p.vehicleType || "").toLowerCase();
    let polType: string;
    if (vt === "motovehiculo" || vt === "moto") polType = "motovehiculo";
    else if (vt.includes("accidentes_pasajeros") || vt.includes("accidente")) polType = "accidentes";
    else polType = "automotor";
    const today = new Date().toISOString().split("T")[0];
    const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
    let status = "activa";
    if (daysToEnd < 0) status = "vencida";
    else if (daysToEnd <= 30) status = "por_vencer";
    return { polType, status };
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // ── ANULACION: cancelar póliza existente ──────────────────────────────
      if (mov.includes("ANULACION")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación El Norte" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── NOTA DE CREDITO: ignorar ──────────────────────────────────────────
      if (mov.includes("NOTA DE CREDITO") || mov.includes("NOTA_DE_CREDITO")) {
        results.skipped++;
        continue;
      }

      // ── PRORROGA: refacturación sobre póliza existente ────────────────────
      if (mov.includes("PRORROGA")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          // Agregar como rebilling
          await db.insert(rebillings).values({
            policyId: existing.id,
            billingStart: p.startDate,
            billingEnd: p.endDate,
            premium: p.premium || null,
            sumInsured: p.sumInsured || null,
            notes: `Importado de El Norte. Prórroga endoso ${p.endoso || ""}`,
            createdBy: user.id,
          });
          // Actualizar cuotas si hay
          if (p.installments?.length > 0) await insertInstallments(existing.id, p.installments);
          // Actualizar endDate y status de la póliza
          const { status } = resolveTypeAndStatus(p);
          await db.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
          results.rebillings++;
          continue;
        }
        // Si no existe la póliza original pero hay datos base del frontend → crear base + rebilling
        if (p._baseStartDate) {
          const insuredId = await resolveInsured(p);
          const { polType } = resolveTypeAndStatus(p);
          const isMoto = polType === "motovehiculo";

          // 1. Crear póliza base con los datos provistos manualmente
          const basePolRows = await db.insert(policies).values({
            policyNumber: String(p.policyNumber),
            type: polType,
            status: "vencida",
            companyId,
            insuredId,
            premium: p._basePremium || p.premium || null,
            sumInsured: p._baseSumInsured || p.sumInsured || null,
            coverageType: p._baseCoverage || p.coverageLabel || null,
            startDate: p._baseStartDate,
            endDate: p._baseEndDate || p.startDate,
            isRebilling: 0,
            vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
            vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
            vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
            vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
            motoBrand: isMoto ? (p.vehicleBrand || null) : null,
            motoModel: isMoto ? (p.vehicleModel || null) : null,
            motoYear: isMoto ? (p.vehicleYear || null) : null,
            motoPlate: isMoto ? (p.vehiclePlate || null) : null,
            motoEngine: isMoto ? (p.engineNumber || null) : null,
            notes: p._baseNotes || "Póliza base creada manualmente al importar prórroga",
            createdBy: user.id,
          }).returning({ id: policies.id });

          // 2. Agregar la prórroga como rebilling encima de la base
          const basePolId = basePolRows[0]!.id;
          const { status } = resolveTypeAndStatus(p);
          await db.insert(rebillings).values({
            policyId: basePolId,
            billingStart: p.startDate,
            billingEnd: p.endDate,
            premium: p.premium || null,
            sumInsured: p.sumInsured || null,
            notes: `Importado de El Norte. Prórroga endoso ${p.endoso || ""}`,
            createdBy: user.id,
          });
          // Actualizar estado de la póliza base con datos de la prórroga
          await db.update(policies).set({ endDate: p.endDate, status, premium: p.premium || null }).where(eq(policies.id, basePolId));
          if (p.installments?.length > 0) await insertInstallments(basePolId, p.installments);
          results.rebillings++;
          continue;
        }
        // Sin datos base → caer en creación marcada como rebilling (huérfana)
      }

      // ── RENOVACION o PRORROGA sin póliza existente: crear nueva ──────────
      const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
      if (existingPol && !mov.includes("PRORROGA")) {
        results.skipped++;
        continue;
      }

      const insuredId = await resolveInsured(p);
      const { polType, status } = resolveTypeAndStatus(p);
      const isMoto = polType === "motovehiculo";
      const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

      const [newPolicy] = await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: polType,
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        installments: p.installments?.length || null,
        isRebilling,
        vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
        vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
        vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
        vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehicleModel || null) : null,
        motoEngine: isMoto ? (p.engineNumber || null) : null,
        notes: `Importado de El Norte. Movimiento: ${p.movType || "RENOVACION"}`,
        createdBy: user.id,
      }).returning({ id: policies.id });

      if (p.installments?.length > 0) await insertInstallments(newPolicy.id, p.installments);

      isRebilling ? results.rebillings++ : results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));

// ── /import/rivadavia ────────────────────────────────────────────────────────
// Misma lógica de inserción que El Norte. El parsing ya viene hecho desde el frontend.
// Diferencias: nombre de compañía "Rivadavia", tipo REDUCCION → skip
app.post("/import/rivadavia", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía Rivadavia
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Rivadavia")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Rivadavia" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
      if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName, dni: p.insuredDni ? String(p.insuredDni) : null,
      email: p.insuredEmail || null, phone: p.insuredPhone || null,
      address: p.insuredAddress || null, createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  async function insertInstallments(policyId: number, installments: any[]) {
    for (const inst of installments) {
      await db.insert(policyInstallments).values({
        policyId, number: inst.number, dueDate: inst.dueDate, amount: inst.amount, status: "pendiente",
      });
    }
  }

  function resolveTypeAndStatus(p: any) {
    const vt = (p.vehicleType || "").toLowerCase();
    let polType: string;
    if (vt === "motovehiculo" || vt === "moto") polType = "motovehiculo";
    else if (vt === "accidentes_pasajeros") polType = "accidentes_pasajeros";
    else polType = "automotor";
    const today = new Date().toISOString().split("T")[0];
    const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
    let status = "activa";
    if (daysToEnd < 0) status = "vencida";
    else if (daysToEnd <= 30) status = "por_vencer";
    return { polType, status };
  }

  // Buscar póliza de auto activa de un asegurado por DNI
  async function findParentAutoPolicyId(insuredDni: string, insuredName: string): Promise<number | null> {
    try {
      // Buscar asegurado por DNI o nombre
      let ins = insuredDni
        ? await db.select().from(insureds).where(eq(insureds.dni, String(insuredDni))).get()
        : null;
      if (!ins && insuredName) ins = await db.select().from(insureds).where(eq(insureds.name, insuredName)).get();
      if (!ins) return null;
      // Buscar la póliza de automotor activa (o por_vencer) de este asegurado en Rivadavia
      const autoPol = await db.select().from(policies)
        .where(and(
          eq(policies.insuredId, ins.id),
          eq(policies.companyId, companyId),
          inArray(policies.type, ["automotor", "motovehiculo"]),
          inArray(policies.status, ["activa", "por_vencer"]),
        ))
        .orderBy(desc(policies.startDate))
        .limit(1)
        .get();
      return autoPol ? autoPol.id : null;
    } catch { return null; }
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // REDUCCION → skip (endoso de reducción, sin acción en la DB)
      if (mov.includes("REDUCCION")) { results.skipped++; continue; }

      // ANULACION
      if (mov.includes("ANULACION")) {
        const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Rivadavia" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // PRORROGA (PR / PRO) con póliza existente
      if (mov.includes("PRORROGA")) {
        // Para PR: policyNumber es el NUEVO número, _renovacionRef apunta al anterior
        // Para PRO: mismo número de póliza con distinto sufijo
        let existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
        // Si no encontró y hay _renovacionRef, buscar por número parcial
        if (!existing && p._renovacionRef) {
          const refNum = String(p._renovacionRef).split("/").pop() || "";
          if (refNum) {
            const candidates = await db.select().from(policies).where(like(policies.policyNumber, `%${refNum}%`)).all();
            if (candidates.length > 0) existing = candidates[0];
          }
        }
        if (existing) {
          await db.insert(rebillings).values({
            policyId: existing.id,
            billingStart: p.startDate, billingEnd: p.endDate,
            premium: p.premium || null, sumInsured: p.sumInsured || null,
            notes: `Importado de Rivadavia`,
            createdBy: user.id,
          });
          if (p.installments?.length > 0) await insertInstallments(existing.id, p.installments);
          const { status } = resolveTypeAndStatus(p);
          await db.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
          results.rebillings++;
          continue;
        }
        // Huérfana con datos base provistos
        if (p._baseStartDate) {
          const insuredId = await resolveInsured(p);
          const { polType } = resolveTypeAndStatus(p);
          const isMoto = polType === "motovehiculo";
          const basePolRows = await db.insert(policies).values({
            policyNumber: String(p.policyNumber), type: polType, status: "vencida",
            companyId, insuredId,
            premium: p._basePremium || p.premium || null,
            sumInsured: p._baseSumInsured || p.sumInsured || null,
            coverageType: p._baseCoverage || p.coverageLabel || null,
            startDate: p._baseStartDate, endDate: p._baseEndDate || p.startDate,
            isRebilling: 0,
            vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
            vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
            vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
            vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
            motoBrand: isMoto ? (p.vehicleBrand || null) : null,
            motoModel: isMoto ? (p.vehicleModel || null) : null,
            motoYear: isMoto ? (p.vehicleYear || null) : null,
            motoPlate: isMoto ? (p.vehiclePlate || null) : null,
            motoEngine: isMoto ? (p.engineNumber || null) : null,
            notes: p._baseNotes || "Póliza base creada manualmente al importar prórroga",
            createdBy: user.id,
          }).returning({ id: policies.id });
          const basePolId = basePolRows[0]!.id;
          const { status } = resolveTypeAndStatus(p);
          await db.insert(rebillings).values({
            policyId: basePolId, billingStart: p.startDate, billingEnd: p.endDate,
            premium: p.premium || null, sumInsured: p.sumInsured || null,
            notes: `Importado de Rivadavia`, createdBy: user.id,
          });
          await db.update(policies).set({ endDate: p.endDate, status, premium: p.premium || null }).where(eq(policies.id, basePolId));
          if (p.installments?.length > 0) await insertInstallments(basePolId, p.installments);
          results.rebillings++;
          continue;
        }
        // Sin datos base → crear como póliza nueva marcada isRebilling
      }

      // PÓLIZA NUEVA / huérfana sin datos base
      const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
      if (existingPol && !mov.includes("PRORROGA")) { results.skipped++; continue; }

      const insuredId = await resolveInsured(p);
      const { polType, status } = resolveTypeAndStatus(p);
      const isMoto = polType === "motovehiculo";
      const isAccidentesPasajeros = polType === "accidentes_pasajeros";
      const isRebilling = mov.includes("PRORROGA") ? 1 : 0;

      // Para accidentes_pasajeros: buscar póliza de auto activa del mismo asegurado
      let parentPolicyId: number | null = null;
      if (isAccidentesPasajeros) {
        parentPolicyId = await findParentAutoPolicyId(p.insuredDni, p.insuredName);
      }

      const [newPolicy] = await db.insert(policies).values({
        policyNumber: String(p.policyNumber), type: polType, status,
        companyId, insuredId,
        premium: p.premium || null, sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate, endDate: p.endDate,
        installments: p.installments?.length || null,
        isRebilling,
        vehicleBrand: (!isMoto && !isAccidentesPasajeros) ? (p.vehicleBrand || null) : null,
        vehicleModel: (!isMoto && !isAccidentesPasajeros) ? (p.vehicleModel || null) : null,
        vehicleYear: (!isMoto && !isAccidentesPasajeros) ? (p.vehicleYear || null) : null,
        vehiclePlate: (!isMoto && !isAccidentesPasajeros) ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        motoEngine: isMoto ? (p.engineNumber || null) : null,
        parentPolicyId,
        notes: `Importado de Rivadavia. Movimiento: ${p.movType || "RENOVACION"}`,
        createdBy: user.id,
      }).returning({ id: policies.id });

      if (p.installments?.length > 0) await insertInstallments(newPolicy.id, p.installments);
      isRebilling ? results.rebillings++ : results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ─────────────────────────────────────────────────────────────────────────────

// ── /import/cooperacion ──────────────────────────────────────────────────────
app.post("/import/cooperacion", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía Cooperación
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Cooperación")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Cooperación" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredAddress && !existing.address) await db.update(insureds).set({ address: p.insuredAddress }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName, dni: p.insuredDni ? String(p.insuredDni) : null,
      address: p.insuredAddress || null, createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  function resolveStatus(endDate: string): string {
    const today = new Date().toISOString().split("T")[0];
    const days = Math.ceil((new Date(endDate).getTime() - new Date(today).getTime()) / 86400000);
    if (days < 0) return "vencida";
    if (days <= 30) return "por_vencer";
    return "activa";
  }

  // Buscar póliza principal por número (para subpólizas con _parentPolicyNumber)
  async function findParentByNumber(policyNumber: string): Promise<number | null> {
    if (!policyNumber) return null;
    const found = await db.select().from(policies)
      .where(and(eq(policies.policyNumber, policyNumber), eq(policies.companyId, companyId)))
      .get();
    return found ? found.id : null;
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();

      // ANULACION
      if (mov === "ANULACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Cooperación" }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ENDOSO → skip por ahora
      if (mov === "ENDOSO") { results.skipped++; continue; }

      // RENOVACION / ALTA: si ya existe actualizar fechas y status, si no crear
      const existing = await db.select().from(policies).where(and(
        eq(policies.policyNumber, String(p.policyNumber)),
        eq(policies.companyId, companyId),
      )).get();

      const vt = (p.vehicleType || "").toLowerCase();
      const isMoto = vt === "motovehiculo";
      const isAccPas = vt === "accidentes_pasajeros";
      const isHogar = vt === "hogar";
      const isCascos = vt === "cascos";
      const status = resolveStatus(p.endDate);

      // Resolver parentPolicyId si es subpóliza
      let parentPolicyId: number | null = null;
      if (p._parentPolicyNumber) {
        parentPolicyId = await findParentByNumber(p._parentPolicyNumber);
      }

      if (existing) {
        // Ya existe → actualizar vigencia
        await db.update(policies).set({
          startDate: p.startDate, endDate: p.endDate, status,
          sumInsured: p.sumInsured || existing.sumInsured,
          coverageType: p.coverageLabel || existing.coverageType,
          parentPolicyId: parentPolicyId ?? existing.parentPolicyId,
          updatedAt: new Date(),
        }).where(eq(policies.id, existing.id));
        results.rebillings++;
        continue;
      }

      // Crear nueva
      const insuredId = await resolveInsured(p);
      await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: vt || "automotor",
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        vigencyPeriod: "cuatrimestral",
        isRebilling: 0,
        vehicleBrand: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehicleBrand || null) : null,
        vehicleModel: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehicleModel || null) : null,
        vehiclePlate: (!isMoto && !isAccPas && !isHogar && !isCascos) ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        parentPolicyId,
        notes: `Importado de Cooperación. Ramo: ${p.coverageCode || ""}`,
        createdBy: user.id,
      });
      results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ── /import/mercantil-andina ──────────────────────────────────────────────────
app.post("/import/mercantil-andina", requireAuth(async (c: any) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsedPolicies: any[] = body.policies || [];
  if (!parsedPolicies.length) return c.json({ error: "Sin pólizas" }, 400);

  const results = { imported: 0, rebillings: 0, cancelled: 0, skipped: 0, errors: [] as string[] };

  // Buscar o crear la compañía
  let companyId: number;
  const existingCompany = await db.select().from(companies).where(eq(companies.name, "Mercantil Andina")).get();
  if (existingCompany) {
    companyId = existingCompany.id;
  } else {
    const [nc] = await db.insert(companies).values({ name: "Mercantil Andina" }).returning({ id: companies.id });
    companyId = nc.id;
  }

  async function resolveInsured(p: any): Promise<number> {
    let existing = null;
    if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
    if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
    if (existing) {
      if (p.insuredAddress && !existing.address)
        await db.update(insureds).set({ address: p.insuredAddress }).where(eq(insureds.id, existing.id));
      return existing.id;
    }
    const [ni] = await db.insert(insureds).values({
      name: p.insuredName,
      dni: p.insuredDni ? String(p.insuredDni) : null,
      address: p.insuredAddress || null,
      createdBy: user.id,
    }).returning({ id: insureds.id });
    return ni.id;
  }

  function resolveStatus(endDate: string): string {
    const today = new Date().toISOString().split("T")[0];
    const days = Math.ceil((new Date(endDate).getTime() - new Date(today).getTime()) / 86400000);
    if (days < 0) return "vencida";
    if (days <= 30) return "por_vencer";
    return "activa";
  }

  // Vigencia dinámica según duración en meses
  function resolveVigencyPeriod(startDate: string, endDate: string): string {
    if (!startDate || !endDate) return "anual";
    const start = new Date(startDate);
    const end = new Date(endDate);
    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (months <= 1) return "mensual";
    if (months <= 4) return "cuatrimestral";
    if (months <= 6) return "semestral";
    return "anual";
  }

  // Para accidentes_pasajeros: buscar auto activo en Mercantil Andina con mismo DNI
  async function findParentByDni(dni: string): Promise<number | null> {
    if (!dni) return null;
    const insured = await db.select().from(insureds).where(eq(insureds.dni, String(dni))).get();
    if (!insured) return null;
    const found = await db.select().from(policies).where(and(
      eq(policies.insuredId, insured.id),
      eq(policies.companyId, companyId),
      eq(policies.type, "automotor"),
    )).get();
    return found ? found.id : null;
  }

  for (const p of parsedPolicies) {
    try {
      const mov = (p.movType || "").toUpperCase();
      const vt = (p.vehicleType || "").toLowerCase();
      const isAccPas = vt === "accidentes_pasajeros";
      const isMoto = vt === "motovehiculo";
      const isHogar = vt === "hogar";
      const status = resolveStatus(p.endDate);

      // ── ANULACION ──
      if (mov === "ANULACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.update(policies).set({
            status: "cancelada",
            notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación Mercantil Andina",
          }).where(eq(policies.id, existing.id));
          results.cancelled++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // ── RENOVACION: extensión vigencia → rebilling sobre póliza existente ──
      if (mov === "RENOVACION") {
        const existing = await db.select().from(policies).where(and(
          eq(policies.policyNumber, String(p.policyNumber)),
          eq(policies.companyId, companyId),
        )).get();
        if (existing) {
          await db.insert(rebillings).values({
            policyId: existing.id,
            billingStart: p.startDate,
            billingEnd: p.endDate,
            premium: p.premium || null,
            sumInsured: p.sumInsured || null,
            notes: `Importado de Mercantil Andina. Extensión de vigencia.`,
            createdBy: user.id,
          });
          // Actualizar endDate y status de la póliza base
          await db.update(policies).set({
            endDate: p.endDate,
            status,
            premium: p.premium || existing.premium,
            updatedAt: new Date(),
          }).where(eq(policies.id, existing.id));
          results.rebillings++;
          continue;
        }
        // Si no existe la póliza aún, caer en creación (ALTA implícita)
      }

      // ── ALTA (o RENOVACION sin póliza existente): crear nueva ──
      // Resolver parentPolicyId
      let parentPolicyId: number | null = null;
      if (isAccPas && p._linkByDni && p.insuredDni) {
        parentPolicyId = await findParentByDni(String(p.insuredDni));
      }

      const insuredId = await resolveInsured(p);
      const vigencyPeriod = resolveVigencyPeriod(p.startDate, p.endDate);

      await db.insert(policies).values({
        policyNumber: String(p.policyNumber),
        type: vt || "automotor",
        status,
        companyId,
        insuredId,
        premium: p.premium || null,
        sumInsured: p.sumInsured || null,
        coverageType: p.coverageLabel || null,
        startDate: p.startDate,
        endDate: p.endDate,
        vigencyPeriod,
        isRebilling: 0,
        vehicleBrand: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleBrand || null) : null,
        vehicleModel: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleModel || null) : null,
        vehicleYear: (!isMoto && !isAccPas && !isHogar) ? (p.vehicleYear || null) : null,
        vehiclePlate: (!isMoto && !isAccPas && !isHogar) ? (p.vehiclePlate || null) : null,
        motoBrand: isMoto ? (p.vehicleBrand || null) : null,
        motoModel: isMoto ? (p.vehicleModel || null) : null,
        motoYear: isMoto ? (p.vehicleYear || null) : null,
        motoPlate: isMoto ? (p.vehiclePlate || null) : null,
        parentPolicyId,
        notes: `Importado de Mercantil Andina. Sec: ${p.coverageCode || ""}`,
        createdBy: user.id,
      });
      results.imported++;

    } catch (e: any) {
      results.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
      results.skipped++;
    }
  }

  return c.json(results, 200);
}));
// ── /gmail/import-el-norte ────────────────────────────────────────────────────
app.post("/gmail/import-el-norte", requireAuth(async (c: any) => {
  try {
    // 1. Buscar el mail más reciente de El Norte
    const searchRaw = execSync(
      `connector run gmail gmail-find-email '{"q":"from:gestorweb@elnorte.com.ar subject:\\"Archivo de Emision\\"","withTextPayload":false,"metadataOnly":false,"maxResults":1}'`,
      { encoding: "utf8", env: process.env }
    );
    const messages = JSON.parse(searchRaw);
    if (!messages || !messages.length) {
      return c.json({ error: "No se encontraron mails de El Norte" }, 404);
    }
    const msg = messages[0];

    // 2. Encontrar el adjunto TXT
    const parts: any[] = msg.payload?.parts || [];
    const attachment = parts.find((p: any) => p.filename && p.filename.toUpperCase().endsWith(".TXT"));
    if (!attachment) {
      return c.json({ error: "El mail no tiene adjunto TXT" }, 404);
    }

    const messageId = msg.id;
    const attachmentId = attachment.body?.attachmentId;
    const filename = attachment.filename;

    if (!attachmentId) {
      return c.json({ error: "No se pudo obtener attachmentId" }, 404);
    }

    // 3. Descargar el adjunto via ORPC + S3 presigned URL
    const content = await gmailGetAttachmentContent(messageId, attachmentId, filename);

    // 4. Devolver el contenido para que el frontend lo parsee y muestre preview
    return c.json({ content, filename, subject: msg.subject, date: msg.date }, 200);

  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
}));
// ── Jobs en memoria para batch ───────────────────────────────────────────────
const batchJobs = new Map<string, {
  status: "running" | "done" | "error";
  phase: string;
  mails: number;
  totalMails: number;
  processed: number;
  imported: number;
  rebillings: number;
  cancelled: number;
  skipped: number;
  parseErrors: number;
  errors: string[];
  startedAt: number;
  finishedAt?: number;
}>();

// GET job status
app.get("/gmail/import-el-norte-batch/:jobId", requireAuth(async (c: any) => {
  const jobId = c.req.param("jobId");
  const job = batchJobs.get(jobId);
  if (!job) return c.json({ error: "Job no encontrado" }, 404);
  return c.json(job, 200);
}));

// ── /gmail/import-el-norte-batch ─────────────────────────────────────────────
// Pagina Gmail desde una fecha dada, baja todos los TXT de El Norte y los importa
// directamente sin preview. Devuelve jobId inmediatamente, procesa en background.
app.post("/gmail/import-el-norte-batch", requireAuth(async (c: any) => {
  try {
    const user = c.get("user");
    const body = await c.req.json();
    const desde: string = body.desde || "2025-12-01";
    const hasta: string | null = body.hasta || null; // null = sin límite superior
    const afterDate = desde.replace(/-/g, "/");
    const beforeDate = hasta ? hasta.replace(/-/g, "/") : null;

    // Crear job
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      status: "running" as const,
      phase: "Buscando mails...",
      mails: 0,
      totalMails: 0,
      processed: 0,
      imported: 0,
      rebillings: 0,
      cancelled: 0,
      skipped: 0,
      parseErrors: 0,
      errors: [] as string[],
      startedAt: Date.now(),
    };
    batchJobs.set(jobId, job);

    // Procesar en background (no awaited)
    (async () => {
      try {
        const { parseElNorteTxt } = await import("../lib/parsers/el-norte");

        // Compañía
        let companyId: number;
        const existingCompany = await db.select().from(companies).where(eq(companies.name, "El Norte")).get();
        if (existingCompany) {
          companyId = existingCompany.id;
        } else {
          const [nc] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
          companyId = nc.id;
        }

        async function resolveInsured(p: any): Promise<number> {
          let existing: any = null;
          if (p.insuredDni) existing = await db.select().from(insureds).where(eq(insureds.dni, String(p.insuredDni))).get();
          if (!existing) existing = await db.select().from(insureds).where(eq(insureds.name, p.insuredName)).get();
          if (existing) {
            if (p.insuredEmail && !existing.email) await db.update(insureds).set({ email: p.insuredEmail }).where(eq(insureds.id, existing.id));
            if (p.insuredPhone && !existing.phone) await db.update(insureds).set({ phone: p.insuredPhone }).where(eq(insureds.id, existing.id));
            return existing.id;
          }
          const [ni] = await db.insert(insureds).values({
            name: p.insuredName, dni: p.insuredDni || null,
            phone: p.insuredPhone || null, email: p.insuredEmail || null,
            address: p.insuredAddress || null, createdBy: user.id,
          }).returning({ id: insureds.id });
          return ni.id;
        }

        async function insertInstallments(policyId: number, installments: any[]) {
          for (const inst of installments) {
            await db.insert(policyInstallments).values({
              policyId, number: inst.number, dueDate: inst.dueDate,
              amount: inst.amount, status: "pendiente",
            });
          }
        }

        function resolveTypeAndStatus(p: any) {
          const vt = (p.vehicleType || "").toLowerCase();
          let polType: string;
          if (vt === "motovehiculo" || vt === "moto") polType = "motovehiculo";
          else if (vt.includes("accidentes_pasajeros") || vt.includes("accidente")) polType = "accidentes";
          else polType = "automotor";
          const today = new Date().toISOString().split("T")[0];
          const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
          let status = "activa";
          if (daysToEnd < 0) status = "vencida";
          else if (daysToEnd <= 30) status = "por_vencer";
          return { polType, status };
        }

        async function importPolicy(p: any) {
          const mov = (p.movType || "").toUpperCase();

          if (mov.includes("ANULACION")) {
            const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
            if (existing) {
              await db.update(policies).set({ status: "cancelada", notes: (existing.notes ? existing.notes + " | " : "") + "Anulada por importación El Norte" }).where(eq(policies.id, existing.id));
              job.cancelled++;
            } else job.skipped++;
            return;
          }

          if (mov.includes("NOTA DE CREDITO") || mov.includes("NOTA_DE_CREDITO")) {
            job.skipped++;
            return;
          }

          if (mov.includes("PRORROGA")) {
            const existing = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
            if (existing) {
              await db.insert(rebillings).values({
                policyId: existing.id, billingStart: p.startDate, billingEnd: p.endDate,
                premium: p.premium || null, sumInsured: p.sumInsured || null,
                notes: `Importado de El Norte (batch). Prórroga endoso ${p.endoso || ""}`,
                createdBy: user.id,
              });
              if (p.installments?.length > 0) await insertInstallments(existing.id, p.installments);
              const { status } = resolveTypeAndStatus(p);
              await db.update(policies).set({ endDate: p.endDate, status, premium: p.premium || existing.premium }).where(eq(policies.id, existing.id));
              job.rebillings++;
              return;
            }
            // Prórroga huérfana
            const insuredId = await resolveInsured(p);
            const { polType, status } = resolveTypeAndStatus(p);
            const isMoto = polType === "motovehiculo";
            const [newPol] = await db.insert(policies).values({
              policyNumber: String(p.policyNumber), type: polType, status, companyId, insuredId,
              premium: p.premium || null, sumInsured: p.sumInsured || null,
              coverageType: p.coverageLabel || null, startDate: p.startDate, endDate: p.endDate,
              installments: p.installments?.length || null, isRebilling: 1,
              vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
              vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
              vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
              vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
              motoBrand: isMoto ? (p.vehicleBrand || null) : null,
              motoModel: isMoto ? (p.vehicleModel || null) : null,
              motoYear: isMoto ? (p.vehicleYear || null) : null,
              motoPlate: isMoto ? (p.vehiclePlate || null) : null,
              motoEngine: isMoto ? (p.engineNumber || null) : null,
              notes: `Importado de El Norte (batch). Prórroga huérfana. Endoso ${p.endoso || ""}`,
              createdBy: user.id,
            }).returning({ id: policies.id });
            if (p.installments?.length > 0) await insertInstallments(newPol.id, p.installments);
            job.rebillings++;
            return;
          }

          // Alta nueva / renovación
          const existingPol = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
          if (existingPol) {
            console.log(`[BATCH] Póliza ${p.policyNumber} ya existe (mov: ${mov}) — skip`);
            job.skipped++; return;
          }

          const insuredId = await resolveInsured(p);
          const { polType, status } = resolveTypeAndStatus(p);
          const isMoto = polType === "motovehiculo";
          const [newPolicy] = await db.insert(policies).values({
            policyNumber: String(p.policyNumber), type: polType, status, companyId, insuredId,
            premium: p.premium || null, sumInsured: p.sumInsured || null,
            coverageType: p.coverageLabel || null, startDate: p.startDate, endDate: p.endDate,
            installments: p.installments?.length || null, isRebilling: 0,
            vehicleBrand: !isMoto ? (p.vehicleBrand || null) : null,
            vehicleModel: !isMoto ? (p.vehicleModel || null) : null,
            vehicleYear: !isMoto ? (p.vehicleYear || null) : null,
            vehiclePlate: !isMoto ? (p.vehiclePlate || null) : null,
            motoBrand: isMoto ? (p.vehicleBrand || null) : null,
            motoModel: isMoto ? (p.vehicleModel || null) : null,
            motoYear: isMoto ? (p.vehicleYear || null) : null,
            motoPlate: isMoto ? (p.vehicleModel || null) : null,
            motoEngine: isMoto ? (p.engineNumber || null) : null,
            notes: `Importado de El Norte (batch). Movimiento: ${p.movType || "RENOVACION"}`,
            createdBy: user.id,
          }).returning({ id: policies.id });
          if (p.installments?.length > 0) await insertInstallments(newPolicy.id, p.installments);
          job.imported++;
        }

        // ── Paginación Gmail ────────────────────────────────────────────────
        job.phase = "Buscando mails en Gmail...";
        const allMessages: any[] = [];
        let pageToken: string | null = null;
        let page = 0;

        do {
          page++;
          const queryObj: any = {
            q: `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision" after:${afterDate}${beforeDate ? ` before:${beforeDate}` : ""}`,
            metadataOnly: false,
            maxResults: 100,
          };
          if (pageToken) queryObj.pageToken = pageToken;

          const raw = execSync(
            `connector run gmail gmail-find-email '${JSON.stringify(queryObj)}'`,
            { encoding: "utf8", env: process.env, maxBuffer: 50 * 1024 * 1024, timeout: 60000 }
          );

          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { break; }

          let msgs: any[] = [];
          if (Array.isArray(parsed)) {
            msgs = parsed;
            pageToken = null;
          } else if (parsed?.messages) {
            msgs = parsed.messages;
            pageToken = parsed.nextPageToken || null;
          } else {
            pageToken = null;
          }

          allMessages.push(...msgs);
          job.phase = `Buscando mails... (${allMessages.length} encontrados)`;

          if (!pageToken || msgs.length === 0) break;
        } while (page < 20);

        if (!allMessages.length) {
          (job as any).status = "error";
          job.phase = "No se encontraron mails en el período indicado";
          (job as any).finishedAt = Date.now();
          return;
        }

        // Ordenar ascendente (más antiguo primero)
        allMessages.sort((a: any, b: any) =>
          parseInt(a.internalDate || "0") - parseInt(b.internalDate || "0")
        );

        job.totalMails = allMessages.length;
        job.mails = allMessages.length;
        job.phase = `Procesando 0 / ${allMessages.length} mails...`;

        // ── Procesar cada mail ──────────────────────────────────────────────
        for (let i = 0; i < allMessages.length; i++) {
          const msg = allMessages[i];
          const subject = msg.subject || "sin-asunto";
          job.phase = `Procesando mail ${i + 1} / ${allMessages.length}: ${subject.slice(0, 50)}`;

          try {
            const parts: any[] = msg.payload?.parts || [];
            const attachment = parts.find((p: any) => p.filename && p.filename.toUpperCase().endsWith(".TXT"));
            if (!attachment) {
              job.errors.push(`Mail "${subject}": sin adjunto TXT`);
              job.skipped++;
              continue;
            }

            const messageId = msg.id;
            const attachmentId = attachment.body?.attachmentId;
            const filename = attachment.filename;

            if (!attachmentId) {
              job.errors.push(`Mail "${subject}": sin attachmentId`);
              job.skipped++;
              continue;
            }

            const uniqueFilename = `elnorte_${messageId}_${filename}`;
            let content: string;
            try {
              content = await gmailGetAttachmentContent(messageId, attachmentId, uniqueFilename);
            } catch (dlErr: any) {
              job.errors.push(`Mail "${subject}": error descargando adjunto - ${dlErr.message}`);
              job.skipped++;
              continue;
            }

            const { policies: parsedPolicies, errors: parseErrs } = parseElNorteTxt(content);
            console.log(`[BATCH] Mail "${subject}": parseó ${parsedPolicies.length} pólizas, ${parseErrs.length} errores de parse`);
            if (parseErrs.length > 0) {
              job.parseErrors += parseErrs.length;
              parseErrs.forEach(pe => console.error(`[BATCH][parseError] ${pe}`));
            }
            if (parsedPolicies.length === 0) {
              console.error(`[BATCH] Mail "${subject}": 0 pólizas parseadas, contenido primeros 500 chars: ${content.slice(0, 500)}`);
            }

            for (const p of parsedPolicies) {
              try {
                await importPolicy(p);
              } catch (e: any) {
                console.error(`[BATCH] Póliza ${p.policyNumber}: ${e.message}`);
                job.errors.push(`Póliza ${p.policyNumber}: ${e.message}`);
                job.skipped++;
              }
            }

            job.processed++;

          } catch (e: any) {
            console.error(`[BATCH] Mail "${subject}": ${e.message}`);
            job.errors.push(`Mail "${subject}": ${e.message}`);
            job.skipped++;
          }
        }

        (job as any).status = "done";
        job.phase = "Completado";
        (job as any).finishedAt = Date.now();

      } catch (e: any) {
        (job as any).status = "error";
        job.phase = `Error: ${e.message}`;
        (job as any).finishedAt = Date.now();
      }
    })();

    // Devolver jobId inmediatamente
    return c.json({ jobId }, 200);

  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
}));
// ─────────────────────────────────────────────────────────────────────────────

// ── Cron diario: importar El Norte automáticamente ───────────────────────────
// Corre una vez al día a las 8am (hora Argentina, UTC-3 = 11:00 UTC)
// Solo activo si hay un admin en la DB
let dailyCronRunning = false;

async function runDailyElNorte() {
  if (dailyCronRunning) return;
  dailyCronRunning = true;
  try {
    const adminUser = await db.select().from(users).limit(1).get();
    if (!adminUser) return;

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const desde = yesterday.toISOString().split("T")[0];
    const hasta = today.toISOString().split("T")[0];

    console.log(`[cron] Importando El Norte del día ${desde}...`);

    const { parseElNorteTxt } = await import("../lib/parsers/el-norte");

    let companyId: number;
    const existingCompany = await db.select().from(companies).where(eq(companies.name, "El Norte")).get();
    if (existingCompany) {
      companyId = existingCompany.id;
    } else {
      const [nc] = await db.insert(companies).values({ name: "El Norte" }).returning({ id: companies.id });
      companyId = nc.id;
    }

    const afterDate = desde.replace(/-/g, "/");
    const beforeDate = hasta.replace(/-/g, "/");
    const q = `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision" after:${afterDate} before:${beforeDate}`;

    const raw = execSync(
      `connector run gmail gmail-find-email '${JSON.stringify({ q, metadataOnly: false, maxResults: 10 })}'`,
      { encoding: "utf8", env: process.env, maxBuffer: 20 * 1024 * 1024, timeout: 60000 }
    );

    let msgs: any[] = [];
    try {
      const parsed = JSON.parse(raw);
      msgs = Array.isArray(parsed) ? parsed : (parsed?.messages || []);
    } catch { return; }

    let imported = 0, rebillings = 0, skipped = 0;

    for (const msg of msgs) {
      try {
        const parts: any[] = msg.payload?.parts || [];
        const attachment = parts.find((p: any) => p.filename?.toUpperCase().endsWith(".TXT"));
        if (!attachment?.body?.attachmentId) continue;

        const uniqueFilename = `elnorte_cron_${msg.id}_${attachment.filename}`;
        const content = await gmailGetAttachmentContent(msg.id, attachment.body.attachmentId, uniqueFilename);
        const { policies: parsed } = parseElNorteTxt(content);

        for (const p of parsed) {
          const mov = (p.movType || "").toUpperCase();
          if (mov.includes("NOTA DE CREDITO")) { skipped++; continue; }
          if (mov.includes("ANULACION")) {
            const ex = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
            if (ex) await db.update(policies).set({ status: "cancelada" }).where(eq(policies.id, ex.id));
            continue;
          }
          if (mov.includes("PRORROGA")) {
            const ex = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
            if (ex) {
              await db.insert(rebillings).values({ policyId: ex.id, billingStart: p.startDate, billingEnd: p.endDate, premium: p.premium || null, sumInsured: p.sumInsured || null, notes: "Cron diario El Norte", createdBy: adminUser.id });
              const daysToEnd = Math.ceil((new Date(p.endDate).getTime() - Date.now()) / 86400000);
              await db.update(policies).set({ endDate: p.endDate, status: daysToEnd < 0 ? "vencida" : daysToEnd <= 30 ? "por_vencer" : "activa", premium: p.premium || ex.premium }).where(eq(policies.id, ex.id));
              rebillings++;
            } else skipped++;
            continue;
          }
          const ex = await db.select().from(policies).where(eq(policies.policyNumber, String(p.policyNumber))).get();
          if (ex) { skipped++; continue; }
          imported++;
        }
      } catch (e: any) {
        console.error(`[cron] Error procesando mail ${msg.id}:`, e.message);
      }
    }

    console.log(`[cron] El Norte: ${imported} nuevas, ${rebillings} prórrogas, ${skipped} saltadas`);
  } catch (e: any) {
    console.error("[cron] Error en cron diario El Norte:", e.message);
  } finally {
    dailyCronRunning = false;
  }
}

// Arrancar el cron: cada hora revisamos si hay que correr
setInterval(() => {
  const now = new Date();
  // Correr a las 8:00 AM hora Argentina (UTC-3 = 11:00 UTC)
  if (now.getUTCHours() === 11 && now.getUTCMinutes() < 5) {
    runDailyElNorte();
  }
}, 5 * 60 * 1000); // check cada 5 minutos

// Endpoint para disparar el cron manualmente
app.post("/gmail/cron-el-norte", requireAuth(async (c: any) => {
  runDailyElNorte(); // fire and forget
  return c.json({ ok: true, message: "Cron iniciado" }, 200);
}));

// ─────────────────────────────────────────────────────────────────────────────

export default app;
export type AppType = typeof app;
