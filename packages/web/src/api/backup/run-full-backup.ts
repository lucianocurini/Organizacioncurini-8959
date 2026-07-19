/**
 * Entrypoint del backup completo — TRACKEADO a propósito (a diferencia de los
 * scripts de scripts/, que son gitignorados por ser provisioning local
 * sensible: apply-*-prod.ts, backup-prod-before-*.ts históricos,
 * verify-prod-*.ts, etc). Este archivo necesita estar versionado porque un
 * scheduler externo (GitHub Actions, Railway Cron) tiene que poder
 * clonarlo/checkoutearlo para correrlo — no puede depender de que exista en
 * el filesystem local de quien lo escribió.
 *
 * No contiene secretos: todo sale de variables de entorno, con gates
 * explícitos antes de cualquier acción sensible (ver más abajo). Usa el
 * mismo helper que GET /api/backup (./full-backup.ts) — script/endpoint
 * comparten la misma lógica, ninguno mantiene su propia lista de tablas.
 *
 * NOTA: este archivo tiene efectos de lado en el top-level (lee env vars,
 * puede hacer process.exit) — es un entrypoint para correr con `bun
 * run-full-backup.ts`, no un módulo para importar por sus exports (para eso
 * están full-backup.ts / r2-upload.ts).
 *
 * Corre solo lectura sobre la base. Escribe el resultado en <repo>/backups/ y
 * verifica el archivo escrito (existe, size>0, JSON parseable, rowCounts/
 * checksums coinciden, sin tablas *_new ni sessions). Opcionalmente, si se
 * pide con CONFIRM_BACKUP_UPLOAD=1, además sube ese mismo backup a un storage
 * S3-compatible (R2) vía ./r2-upload.ts, promueve a monthly/ si corresponde y
 * calcula (o aplica) retención.
 *
 * Local (dev.db u otra file:), sin restricciones:
 *   cd packages/web
 *   bun src/api/backup/run-full-backup.ts
 *   DATABASE_URL=file:./otra.db bun src/api/backup/run-full-backup.ts
 *
 * Contra Turso producción (libsql://) — exige confirmación explícita,
 * NO ejecutar todavía (fase de diseño/implementación local, sin producción):
 *   cd packages/web
 *   CONFIRM_FULL_BACKUP_PROD=1 bun --env-file=../../.env src/api/backup/run-full-backup.ts
 *
 * Con subida a R2 (además de lo anterior) — NO ejecutar todavía sin
 * credenciales reales confirmadas (Fase 3B):
 *   CONFIRM_BACKUP_UPLOAD=1 R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
 *   bun src/api/backup/run-full-backup.ts
 *   # + CONFIRM_BACKUP_RETENTION_DELETE=1 para que la retención borre de
 *   # verdad — sin esto, solo lista qué borraría (dry-run).
 */

import { createClient } from "@libsql/client";
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import {
  buildFullBackup, validateFullBackup, maskDatabaseUrl, EXPECTED_BUSINESS_TABLES,
} from "./full-backup";
import {
  getR2Config, buildR2Client, maskR2Endpoint, dailyBackupKey, monthlyBackupKey,
  computeMd5Hex, uploadBackupToR2, verifyUploadedBackup, promoteToMonthlyIfNeeded,
  listBackupObjects, computeRetentionPlan, deleteExpiredBackupObjects,
} from "./r2-upload";

console.log("MODE: PROD_BACKUP_FULL");

const url = process.env.DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN;

if (!url) {
  console.error("ERROR: falta DATABASE_URL.");
  process.exit(1);
}

const isProd = url.startsWith("libsql://");
if (isProd && process.env.CONFIRM_FULL_BACKUP_PROD !== "1") {
  console.error(
    "ERROR: DATABASE_URL apunta a Turso (producción). Este script exige " +
    "CONFIRM_FULL_BACKUP_PROD=1 explícito para correr contra producción.\n" +
    "Para pruebas locales usá DATABASE_URL=file:... (ej. file:dev.db)."
  );
  process.exit(1);
}

// Si se pidió subir a R2, se valida la config ANTES de tocar la base — no
// tiene sentido leer 27 tablas para recién ahí descubrir que falta una
// credencial de R2.
const wantsUpload = process.env.CONFIRM_BACKUP_UPLOAD === "1";
const r2ConfigResult = wantsUpload ? getR2Config({
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_PREFIX: process.env.R2_PREFIX,
}) : null;
if (wantsUpload && !r2ConfigResult!.ok) {
  console.error("ERROR: CONFIRM_BACKUP_UPLOAD=1 pero falta configuración de R2:");
  for (const e of r2ConfigResult!.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const client = createClient({ url, authToken });

async function main() {
  console.log("=".repeat(60));
  console.log(`RESPALDO COMPLETO — ${isProd ? "Turso producción" : "local"}`);
  console.log("=".repeat(60));
  console.log(`  DATABASE_URL: ${maskDatabaseUrl(url!)}`);

  const payload = await buildFullBackup(client, {
    environment: isProd ? "production" : "local",
    databaseUrl: url!,
  });

  console.log(`\n  Tablas: ${payload.tableCount}`);
  console.log(`  Filas totales: ${payload.totalRows}`);
  console.log(`  gitCommit: ${payload.gitCommit ?? "(no disponible)"}`);
  console.log(`  foreign_key_check violaciones: ${payload.foreignKeyCheck.violations}`);
  if (payload.foreignKeyCheck.violations > 0) {
    console.log(`  ⚠ detalle: ${JSON.stringify(payload.foreignKeyCheck.details.slice(0, 20))}`);
  }
  for (const [name, t] of Object.entries(payload.tables)) {
    console.log(`  ${name}: ${t.rowCount} filas — checksum ${t.checksum.slice(0, 12)}…`);
  }

  const validation = validateFullBackup(payload, EXPECTED_BUSINESS_TABLES);
  if (!validation.ok) {
    console.error("\n✗ ERROR: el backup generado no pasó la validación:");
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (validation.warnings.length > 0) {
    console.log("\n⚠ Advertencias (no bloquean el backup):");
    for (const w of validation.warnings) console.log(`  - ${w}`);
  }
  console.log("\n✓ Validación en memoria OK (tablas esperadas, sin *_new/sessions, checksums reproducibles)");

  const backupsDir = join(import.meta.dir, "..", "..", "..", "..", "..", "backups");
  mkdirSync(backupsDir, { recursive: true });
  const now = new Date(); // misma fecha para el nombre local, la key diaria/mensual de R2 y el cutoff de retención
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(backupsDir, `organizacion-curini-full-backup-${ts}.json`);
  const fileContent = JSON.stringify(payload, null, 2);

  writeFileSync(outPath, fileContent, "utf-8");

  // ── Verificación posterior a la escritura (relee el archivo del disco) ──
  if (!existsSync(outPath)) {
    console.error("\n✗ ERROR: el archivo de respaldo no se creó.");
    process.exit(1);
  }
  const stat = statSync(outPath);
  if (stat.size <= 0) {
    console.error("\n✗ ERROR: el archivo de respaldo quedó vacío (size=0).");
    process.exit(1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (e: any) {
    console.error(`\n✗ ERROR: el archivo de respaldo no es JSON válido: ${e.message}`);
    process.exit(1);
  }
  const reValidation = validateFullBackup(parsed, EXPECTED_BUSINESS_TABLES);
  if (!reValidation.ok) {
    console.error("\n✗ ERROR: el archivo escrito en disco no pasó la validación:");
    for (const e of reValidation.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const kb = (stat.size / 1024).toFixed(1);
  const fileName = outPath.replace(/\\/g, "/").split("/").slice(-1)[0];

  console.log(`\n✓ Respaldo completado y verificado`);
  console.log(`  Archivo:  ${fileName}`);
  console.log(`  Tamaño:   ${kb} KB`);
  console.log(`  Exportado: ${payload.exportedAt}`);
  console.log("=".repeat(60));

  if (!wantsUpload) {
    console.log("\n(CONFIRM_BACKUP_UPLOAD no está en 1 — no se sube a R2, termina acá)");
    return;
  }

  const r2Config = r2ConfigResult!.config!;
  console.log("\n" + "=".repeat(60));
  console.log("SUBIDA A R2");
  console.log("=".repeat(60));
  console.log(`  Endpoint: ${maskR2Endpoint(r2Config.endpoint)}`);
  console.log(`  Bucket:   ${r2Config.bucket}`);
  console.log(`  Prefix:   ${r2Config.prefix || "(ninguno)"}`);

  const r2Client = buildR2Client(r2Config);
  const dailyKey = dailyBackupKey(r2Config.prefix, now);
  const body = fileContent; // mismo string que se escribió a disco — el MD5 tiene que coincidir con lo subido
  const expectedSize = Buffer.byteLength(body, "utf-8");
  const expectedMd5 = computeMd5Hex(body);

  console.log(`\n→ Subiendo ${dailyKey} (${(expectedSize / 1024).toFixed(1)} KB)...`);
  await uploadBackupToR2(r2Client, r2Config, dailyKey, body);

  console.log("→ Verificando upload (HeadObject)...");
  const verify = await verifyUploadedBackup(r2Client, r2Config, dailyKey, expectedSize, expectedMd5);
  if (verify.warnings.length > 0) {
    console.log("  ⚠ advertencias:");
    for (const w of verify.warnings) console.log(`    - ${w}`);
  }
  if (!verify.ok) {
    console.error("✗ ERROR: la verificación post-upload falló:");
    for (const e of verify.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`  ✓ tamaño OK (${verify.actualSize} bytes)${verify.etagMatches ? ", ETag/MD5 coincide" : ""}`);

  const monthlyKey = monthlyBackupKey(r2Config.prefix, now);
  console.log(`\n→ Promoción a monthly (${monthlyKey})...`);
  const promotion = await promoteToMonthlyIfNeeded(r2Client, r2Config, dailyKey, monthlyKey);
  console.log(`  ${promotion.promoted ? "✓ copiado" : "— sin cambios"}: ${promotion.reason}`);

  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? "35");
  const monthlyRetentionMonths = Number(process.env.BACKUP_MONTHLY_RETENTION_MONTHS ?? "12");
  console.log(`\n→ Calculando retención (diarios: ${retentionDays}d, mensuales: ${monthlyRetentionMonths}m)...`);
  const allObjects = await listBackupObjects(r2Client, r2Config);
  const plan = computeRetentionPlan(allObjects, { prefix: r2Config.prefix, retentionDays, monthlyRetentionMonths, now });
  console.log(`  objetos totales bajo el prefix: ${allObjects.length}`);
  console.log(`  a conservar: ${plan.toKeep.length}`);
  console.log(`  a borrar:    ${plan.toDelete.length}`);
  if (plan.toDelete.length > 0) {
    for (const obj of plan.toDelete) console.log(`    - ${obj.key} (${obj.lastModified.toISOString()})`);
  }

  const confirmDelete = process.env.CONFIRM_BACKUP_RETENTION_DELETE === "1";
  const deleteResult = await deleteExpiredBackupObjects(r2Client, r2Config, plan, confirmDelete);
  if (deleteResult.dryRun) {
    console.log("\n(dry-run: CONFIRM_BACKUP_RETENTION_DELETE no está en 1 — no se borró nada, solo se listó arriba)");
  } else {
    console.log(`\n✓ borrados ${deleteResult.deleted.length} objetos expirados`);
  }

  console.log("\n✓ Subida a R2 completada");
  console.log("=".repeat(60));
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
