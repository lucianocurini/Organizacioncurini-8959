/**
 * Tests de los endpoints GET/POST/PUT/DELETE /tasks y /task-templates.
 * Cubre la corrección del bug "tarea recurrente borrada vuelve a
 * aparecer" (dismissed, migración 0032) y la condición de carrera de
 * duplicados (índice único, migración 0033) — ver diagnóstico previo.
 *
 * Requiere que dev.db tenga aplicadas las migraciones 0032 y 0033
 * localmente (columna tasks.dismissed + índice
 * idx_tasks_template_month_unique). NO se ejecuta contra Turso.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import app from "../index";
import { database as db } from "../database/index";
import { users, sessions, taskTemplates, tasks } from "../database/schema";
import { eq, inArray, and, gte } from "drizzle-orm";

const SESSION_ID = "test-session-tasks-001";
const USER_EMAIL = "test-tasks@test.local";

// Mes lejano en el futuro → sin colisión con datos reales.
const MONTH = "2027-11";
const OTHER_MONTH = "2027-12";

let userId: number;
const templateIdsToClean: number[] = [];
const taskIdsToClean: number[] = [];

async function callGet(month: string, sid = SESSION_ID) {
  return app.fetch(new Request(`http://localhost/api/tasks?month=${month}`, {
    headers: { "x-session-id": sid },
  }));
}

async function callDelete(id: number, sid = SESSION_ID) {
  return app.fetch(new Request(`http://localhost/api/tasks/${id}`, {
    method: "DELETE",
    headers: { "x-session-id": sid },
  }));
}

async function callPost(body: any, sid = SESSION_ID) {
  return app.fetch(new Request(`http://localhost/api/tasks`, {
    method: "POST",
    headers: { "x-session-id": sid, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function mkTemplate(title: string, opts: { active?: number; dayOfMonth?: number | null } = {}): Promise<number> {
  const [row] = await db.insert(taskTemplates).values({
    title,
    description: null,
    dayOfMonth: opts.dayOfMonth ?? null,
    order: 1,
    active: opts.active ?? 1,
    isAdminOnly: 0,
    createdBy: userId,
  }).returning({ id: taskTemplates.id });
  templateIdsToClean.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  const prevUser = await db.select({ id: users.id }).from(users).where(eq(users.email, USER_EMAIL)).get();
  if (prevUser) {
    const prevTemplates = await db.select({ id: taskTemplates.id }).from(taskTemplates).where(eq(taskTemplates.createdBy, prevUser.id)).all();
    const prevTplIds = prevTemplates.map((t) => t.id);
    if (prevTplIds.length) {
      await db.delete(tasks).where(inArray(tasks.templateId, prevTplIds)).catch(() => {});
      await db.delete(taskTemplates).where(inArray(taskTemplates.id, prevTplIds)).catch(() => {});
    }
    await db.delete(tasks).where(eq(tasks.createdBy, prevUser.id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.userId, prevUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, prevUser.id)).catch(() => {});
  }

  const [u] = await db.insert(users).values({
    name: "Test Tasks",
    email: USER_EMAIL,
    password: "hashed-dummy",
    role: "admin",
    active: 1,
  }).returning({ id: users.id });
  userId = u!.id;

  await db.insert(sessions).values({ id: SESSION_ID, userId, expiresAt: new Date(Date.now() + 86400000) });
});

afterAll(async () => {
  if (taskIdsToClean.length) {
    await db.delete(tasks).where(inArray(tasks.id, taskIdsToClean)).catch(() => {});
  }
  if (templateIdsToClean.length) {
    await db.delete(tasks).where(inArray(tasks.templateId, templateIdsToClean)).catch(() => {});
    await db.delete(taskTemplates).where(inArray(taskTemplates.id, templateIdsToClean)).catch(() => {});
  }
  // GET /tasks auto-genera instancias de CUALQUIER template activo (no solo
  // el creado por este archivo) para los meses que consulta — si en la DB
  // hay otro template ajeno activo (p.ej. una fixture de QA real preexistente),
  // este archivo termina generando instancias colaterales de ese template
  // con createdBy=userId, que taskIdsToClean/templateIdsToClean no cubren
  // porque no son "propias". Se barren acá por createdBy — mismo criterio
  // que el barrido de usuario obsoleto de beforeAll (línea 73) — para no
  // dejar basura en dev.db ni bloquear el DELETE de abajo por la FK
  // tasks.created_by → users.id (foreign_keys=ON en @libsql/client).
  await db.delete(tasks).where(eq(tasks.createdBy, userId)).catch(() => {});
  await db.delete(sessions).where(eq(sessions.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("recurrente borrada — no reaparece (bug corregido)", () => {
  test("DELETE de una tarea recurrente + GET del mismo mes no la regenera", async () => {
    const tplId = await mkTemplate("QA Recurrente A");

    const r1 = await callGet(MONTH);
    expect(r1.status).toBe(200);
    const first = await r1.json();
    const generated = first.find((t: any) => t.templateId === tplId);
    expect(generated).toBeDefined();
    const originalId = generated.id;

    const del = await callDelete(originalId);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const r2 = await callGet(MONTH);
    const second = await r2.json();
    const stillThere = second.find((t: any) => t.templateId === tplId);
    expect(stillThere).toBeUndefined(); // no reaparece, ni con el id original ni con uno nuevo

    // limpieza (la fila dismissed sigue en DB con su id original, se limpia en afterAll vía templateIdsToClean)
    taskIdsToClean.push(originalId);
  });

  test("la fila dismissed permanece en la base (no fue borrada físicamente)", async () => {
    const tplId = await mkTemplate("QA Recurrente B");
    const r1 = await callGet(MONTH);
    const generated = (await r1.json()).find((t: any) => t.templateId === tplId);
    const originalId = generated.id;

    await callDelete(originalId);

    const row = await db.select().from(tasks).where(eq(tasks.id, originalId)).get();
    expect(row).toBeDefined();
    expect(row!.dismissed).toBe(1);
    expect(row!.templateId).toBe(tplId);
    expect(row!.monthYear).toBe(MONTH);
    taskIdsToClean.push(originalId);
  });

  test("GET no devuelve tareas dismissed", async () => {
    const tplId = await mkTemplate("QA Recurrente C");
    const r1 = await callGet(MONTH);
    const generated = (await r1.json()).find((t: any) => t.templateId === tplId);
    const originalId = generated.id;
    await callDelete(originalId);

    const r2 = await callGet(MONTH);
    const list = await r2.json();
    expect(list.some((t: any) => t.id === originalId)).toBe(false);
    expect(list.some((t: any) => t.templateId === tplId)).toBe(false);
    taskIdsToClean.push(originalId);
  });
});

describe("recurrente borrada — corta la recurrencia (desactiva template + oculta futuras)", () => {
  test("DELETE de una instancia recurrente desactiva su task_template (active=0)", async () => {
    const tplId = await mkTemplate("QA Desactiva Template");
    const r1 = await callGet(MONTH);
    const generated = (await r1.json()).find((t: any) => t.templateId === tplId);
    taskIdsToClean.push(generated.id);

    await callDelete(generated.id);

    const tpl = await db.select().from(taskTemplates).where(eq(taskTemplates.id, tplId)).get();
    expect(tpl!.active).toBe(0);
  });

  test("agosto/septiembre/octubre ya generados desaparecen al borrar agosto, noviembre no regenera, julio (histórico) se conserva", async () => {
    const JUL = "2028-07";
    const AUG = "2028-08";
    const SEP = "2028-09";
    const OCT = "2028-10";
    const NOV = "2028-11";

    const tplId = await mkTemplate("QA Cascada Meses");

    // Mes histórico anterior al mes que se va a borrar.
    const julTask = (await (await callGet(JUL)).json()).find((t: any) => t.templateId === tplId);
    taskIdsToClean.push(julTask.id);

    // agosto, septiembre y octubre — generados de antemano, simulando que el
    // usuario ya había navegado esos meses antes de borrar la tarea de agosto.
    const augTask = (await (await callGet(AUG)).json()).find((t: any) => t.templateId === tplId);
    const sepTask = (await (await callGet(SEP)).json()).find((t: any) => t.templateId === tplId);
    const octTask = (await (await callGet(OCT)).json()).find((t: any) => t.templateId === tplId);
    [augTask, sepTask, octTask].forEach((t) => taskIdsToClean.push(t.id));

    const del = await callDelete(augTask.id);
    expect(del.status).toBe(200);

    // agosto, septiembre y octubre dejan de aparecer
    const listAug = await (await callGet(AUG)).json();
    const listSep = await (await callGet(SEP)).json();
    const listOct = await (await callGet(OCT)).json();
    expect(listAug.some((t: any) => t.templateId === tplId)).toBe(false);
    expect(listSep.some((t: any) => t.templateId === tplId)).toBe(false);
    expect(listOct.some((t: any) => t.templateId === tplId)).toBe(false);

    // las filas de septiembre/octubre siguen en la DB, marcadas dismissed=1 (no hard delete)
    const sepRow = await db.select().from(tasks).where(eq(tasks.id, sepTask.id)).get();
    const octRow = await db.select().from(tasks).where(eq(tasks.id, octTask.id)).get();
    expect(sepRow!.dismissed).toBe(1);
    expect(octRow!.dismissed).toBe(1);

    // GET de noviembre (mes nunca consultado) no genera ninguna fila nueva
    const listNov = await (await callGet(NOV)).json();
    expect(listNov.some((t: any) => t.templateId === tplId)).toBe(false);
    const novRows = await db.select().from(tasks).where(and(eq(tasks.templateId, tplId), eq(tasks.monthYear, NOV))).all();
    expect(novRows.length).toBe(0);

    // julio (histórico, anterior al mes borrado) se conserva intacto y visible
    const listJul = await (await callGet(JUL)).json();
    expect(listJul.some((t: any) => t.id === julTask.id)).toBe(true);
    const julRow = await db.select().from(tasks).where(eq(tasks.id, julTask.id)).get();
    expect(julRow!.dismissed).toBe(0);
  });

  test("rollback: si la transacción falla a mitad de camino, ni el template se desactiva ni las instancias quedan dismissed", async () => {
    const tplId = await mkTemplate("QA Rollback Tareas");
    const generated = (await (await callGet(MONTH)).json()).find((t: any) => t.templateId === tplId);
    taskIdsToClean.push(generated.id);

    let threw = false;
    try {
      // Misma forma que el handler real (desactivar template + dismiss en
      // cascada), con una tercera escritura deliberadamente inválida
      // (monthYear NOT NULL) para forzar un fallo real de SQLite a mitad de
      // la transacción — mismo patrón que "23-25. Rollback transaccional
      // real" en payment-batches.test.ts.
      await db.transaction(async (tx) => {
        await tx.update(taskTemplates).set({ active: 0 }).where(eq(taskTemplates.id, tplId));
        await tx.update(tasks).set({ dismissed: 1 }).where(
          and(eq(tasks.templateId, tplId), gte(tasks.monthYear, MONTH))
        );
        await tx.insert(tasks).values({
          templateId: tplId,
          monthYear: null as any,
          title: "no debería insertarse",
          status: "pendiente",
          isRecurring: 1,
          isAdminOnly: 0,
          dismissed: 0,
          createdBy: userId,
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const tpl = await db.select().from(taskTemplates).where(eq(taskTemplates.id, tplId)).get();
    expect(tpl!.active).toBe(1); // no quedó desactivado

    const row = await db.select().from(tasks).where(eq(tasks.id, generated.id)).get();
    expect(row!.dismissed).toBe(0); // no quedó oculta
  });
});

describe("tarea única borrada — sigue siendo DELETE físico", () => {
  test("DELETE de una tarea única la elimina definitivamente de la DB", async () => {
    const post = await callPost({ monthYear: MONTH, title: "QA Única A", description: null, dueDate: null });
    expect(post.status).toBe(201);
    const created = await post.json();
    taskIdsToClean.push(created.id);

    const del = await callDelete(created.id);
    expect(del.status).toBe(200);

    const row = await db.select().from(tasks).where(eq(tasks.id, created.id)).get();
    expect(row).toBeUndefined(); // hard delete real, no dismissed

    const r = await callGet(MONTH);
    const list = await r.json();
    expect(list.some((t: any) => t.id === created.id)).toBe(false);
  });
});

describe("condición de carrera — dos GET concurrentes no duplican", () => {
  test("dos GET del mismo mes en simultáneo generan una sola tarea recurrente", async () => {
    const tplId = await mkTemplate("QA Carrera");

    const [r1, r2] = await Promise.all([callGet(OTHER_MONTH), callGet(OTHER_MONTH)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rowsInDb = await db.select().from(tasks).where(and(eq(tasks.templateId, tplId), eq(tasks.monthYear, OTHER_MONTH))).all();
    expect(rowsInDb.length).toBe(1); // el índice único + onConflictDoNothing evita el duplicado
    taskIdsToClean.push(...rowsInDb.map((r) => r.id));
  });
});

describe("template desactivado — mantiene el comportamiento anterior", () => {
  test("un template inactivo no genera tareas nuevas, pero sus tareas históricas siguen visibles", async () => {
    const tplId = await mkTemplate("QA Inactivo", { active: 0 });
    // Tarea histórica preexistente para ese template (simulando que se generó
    // cuando el template todavía estaba activo).
    const [historical] = await db.insert(tasks).values({
      templateId: tplId,
      monthYear: MONTH,
      title: "QA Inactivo",
      description: null,
      dueDate: null,
      status: "pendiente",
      isRecurring: 1,
      isAdminOnly: 0,
      dismissed: 0,
      createdBy: userId,
    }).returning({ id: tasks.id });
    taskIdsToClean.push(historical!.id);

    const r = await callGet(MONTH);
    const list = await r.json();
    // La histórica sigue visible (dismissed=0, GET no filtra por template.active)
    expect(list.some((t: any) => t.id === historical!.id)).toBe(true);

    // No se generó ninguna OTRA tarea para este template inactivo en otro mes
    const r2 = await callGet(OTHER_MONTH);
    const list2 = await r2.json();
    expect(list2.some((t: any) => t.templateId === tplId)).toBe(false);
  });
});

describe("filas históricas con dismissed=0 — compatibilidad hacia atrás", () => {
  test("una tarea creada antes de esta migración (dismissed=0 por DEFAULT) se comporta con normalidad", async () => {
    const tplId = await mkTemplate("QA Histórica");
    const [historical] = await db.insert(tasks).values({
      templateId: tplId,
      monthYear: MONTH,
      title: "Tarea histórica preexistente",
      description: null,
      dueDate: null,
      status: "pendiente",
      isRecurring: 1,
      isAdminOnly: 0,
      // dismissed omitido a propósito — debe tomar el DEFAULT 0 de la migración 0032
      createdBy: userId,
    }).returning({ id: tasks.id });
    taskIdsToClean.push(historical!.id);

    const row = await db.select().from(tasks).where(eq(tasks.id, historical!.id)).get();
    expect(row!.dismissed).toBe(0);

    const r = await callGet(MONTH);
    const list = await r.json();
    expect(list.some((t: any) => t.id === historical!.id)).toBe(true);

    // Se puede togglear normalmente (PUT), como cualquier tarea no-dismissed
    const put = await app.fetch(new Request(`http://localhost/api/tasks/${historical!.id}`, {
      method: "PUT",
      headers: { "x-session-id": SESSION_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "realizada" }),
    }));
    expect(put.status).toBe(200);
    const updated = await put.json();
    expect(updated.status).toBe("realizada");
  });
});
