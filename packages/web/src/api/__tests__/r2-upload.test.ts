/**
 * Tests del helper de subida a R2/S3-compatible (packages/web/src/api/backup/r2-upload.ts).
 * Cero red real, cero credenciales reales — las funciones que llaman
 * S3Client.send() se testean contra un fake mínimo (mismo patrón que
 * BackupClient/bun:sqlite en full-backup.test.ts): un objeto que solo
 * implementa send(command) e inspecciona command.constructor.name/command.input.
 */
import { test, expect, describe } from "bun:test";
import {
  buildR2Endpoint, getR2Config, maskR2Endpoint, dailyBackupKey, monthlyBackupKey,
  computeMd5Hex, computeRetentionPlan, uploadBackupToR2, verifyUploadedBackup,
  promoteToMonthlyIfNeeded, listBackupObjects, deleteExpiredBackupObjects,
  type R2Client, type R2Config, type BackupObjectInfo,
} from "../backup/r2-upload";

// ─── Fake S3Client — sin red, sin credenciales ─────────────────────────────

interface FakeCall { command: string; input: any }

function makeFakeClient(handlers: Partial<Record<string, (input: any) => any>>) {
  const calls: FakeCall[] = [];
  const client: R2Client = {
    async send(command: any) {
      const name = command.constructor.name;
      calls.push({ command: name, input: command.input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake client: sin handler para ${name}`);
      return handler(command.input);
    },
  };
  return { client, calls };
}

function notFoundError(): any {
  const err: any = new Error("NotFound");
  err.name = "NotFound";
  return err;
}

const CONFIG: R2Config = {
  endpoint: "https://abcd1234.r2.cloudflarestorage.com",
  accessKeyId: "fake-access-key",
  secretAccessKey: "fake-secret-key",
  bucket: "curini-backups-test",
  prefix: "curini/",
};

function obj(key: string, isoDate: string, size = 100): BackupObjectInfo {
  return { key, lastModified: new Date(isoDate), size };
}

// ─── buildR2Endpoint / getR2Config ──────────────────────────────────────────

describe("buildR2Endpoint", () => {
  test("usa R2_ENDPOINT si está presente, con prioridad sobre R2_ACCOUNT_ID", () => {
    expect(buildR2Endpoint({ R2_ENDPOINT: "https://custom.example.com", R2_ACCOUNT_ID: "abc" }))
      .toBe("https://custom.example.com");
  });
  test("deriva el endpoint desde R2_ACCOUNT_ID si no hay R2_ENDPOINT", () => {
    expect(buildR2Endpoint({ R2_ACCOUNT_ID: "abcd1234" }))
      .toBe("https://abcd1234.r2.cloudflarestorage.com");
  });
  test("null si no hay ninguno de los dos", () => {
    expect(buildR2Endpoint({})).toBeNull();
  });
});

describe("getR2Config", () => {
  test("ok con todas las variables presentes, normaliza el prefix con barra final", () => {
    const result = getR2Config({
      R2_ACCOUNT_ID: "abcd1234", R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "bucket1", R2_PREFIX: "curini",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.config?.prefix).toBe("curini/");
    expect(result.config?.bucket).toBe("bucket1");
  });

  test("prefix vacío se mantiene vacío (no agrega barra de la nada)", () => {
    const result = getR2Config({
      R2_ACCOUNT_ID: "abcd1234", R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk", R2_BUCKET: "bucket1",
    });
    expect(result.config?.prefix).toBe("");
  });

  test("prefix que ya termina en barra no se duplica", () => {
    const result = getR2Config({
      R2_ACCOUNT_ID: "abcd1234", R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "bucket1", R2_PREFIX: "curini/",
    });
    expect(result.config?.prefix).toBe("curini/");
  });

  test("falla si falta bucket/access/secret/endpoint, listando cada uno", () => {
    const result = getR2Config({});
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("R2_ENDPOINT"),
      expect.stringContaining("R2_ACCESS_KEY_ID"),
      expect.stringContaining("R2_SECRET_ACCESS_KEY"),
      expect.stringContaining("R2_BUCKET"),
    ]));
  });

  test("nunca incluye el valor de las credenciales en los mensajes de error", () => {
    const result = getR2Config({ R2_ACCESS_KEY_ID: "should-not-appear-anywhere" });
    const joined = result.errors.join(" ");
    expect(joined).not.toContain("should-not-appear-anywhere");
  });
});

describe("maskR2Endpoint", () => {
  test("enmascara el host, nunca lo devuelve completo", () => {
    const masked = maskR2Endpoint("https://abcd1234567890.r2.cloudflarestorage.com");
    expect(masked.startsWith("https://abcd12")).toBe(true);
    expect(masked).toContain("*");
    expect(masked).not.toContain("1234567890.r2.cloudflarestorage.com");
  });
});

// ─── keys ───────────────────────────────────────────────────────────────────

describe("dailyBackupKey / monthlyBackupKey", () => {
  // fecha fija y sin ambigüedad: 19 de julio de 2026, 20:09:58 UTC
  const fixedDate = new Date(Date.UTC(2026, 6, 19, 20, 9, 58));

  test("daily respeta el formato y el prefix", () => {
    expect(dailyBackupKey("curini/", fixedDate)).toBe("curini/daily/full-backup-prod-2026-07-19T20-09-58.json");
  });
  test("monthly usa YYYY-MM y respeta el prefix", () => {
    expect(monthlyBackupKey("curini/", fixedDate)).toBe("curini/monthly/full-backup-prod-2026-07.json");
  });
  test("prefix vacío no dificulta la key", () => {
    expect(dailyBackupKey("", fixedDate)).toBe("daily/full-backup-prod-2026-07-19T20-09-58.json");
  });
});

// ─── computeMd5Hex ──────────────────────────────────────────────────────────

describe("computeMd5Hex", () => {
  test("determinístico: mismo input, mismo hash", () => {
    expect(computeMd5Hex("hola mundo")).toBe(computeMd5Hex("hola mundo"));
  });
  test("inputs distintos dan hashes distintos", () => {
    expect(computeMd5Hex("a")).not.toBe(computeMd5Hex("b"));
  });
});

// ─── computeRetentionPlan (pura) ───────────────────────────────────────────

describe("computeRetentionPlan", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const opts = { prefix: "curini/", retentionDays: 35, monthlyRetentionMonths: 12, now };

  test("conserva diarios dentro de la ventana de retención", () => {
    const objects = [obj("curini/daily/full-backup-prod-2026-07-01T00-00-00.json", "2026-07-01T00:00:00Z")]; // 18 días
    const plan = computeRetentionPlan(objects, opts);
    expect(plan.toKeep.map((o) => o.key)).toEqual([objects[0]!.key]);
    expect(plan.toDelete).toEqual([]);
  });

  test("borra diarios más viejos que retentionDays", () => {
    const objects = [obj("curini/daily/full-backup-prod-2026-05-01T00-00-00.json", "2026-05-01T00:00:00Z")]; // ~79 días
    const plan = computeRetentionPlan(objects, opts);
    expect(plan.toDelete.map((o) => o.key)).toEqual([objects[0]!.key]);
    expect(plan.toKeep).toEqual([]);
  });

  test("conserva mensuales dentro de su propia ventana, con cutoff independiente del de diarios", () => {
    // 3 meses atrás: fuera de la ventana de daily (35 días) pero dentro de monthly (12 meses)
    const objects = [obj("curini/monthly/full-backup-prod-2026-04.json", "2026-04-19T00:00:00Z")];
    const plan = computeRetentionPlan(objects, opts);
    expect(plan.toKeep.map((o) => o.key)).toEqual([objects[0]!.key]);
    expect(plan.toDelete).toEqual([]);
  });

  test("borra mensuales de más de 12 meses", () => {
    const objects = [obj("curini/monthly/full-backup-prod-2025-01.json", "2025-01-19T00:00:00Z")]; // 18 meses atrás
    const plan = computeRetentionPlan(objects, opts);
    expect(plan.toDelete.map((o) => o.key)).toEqual([objects[0]!.key]);
    expect(plan.toKeep).toEqual([]);
  });

  test("no mezcla daily y monthly: un monthly viejo en días pero joven en meses no se borra", () => {
    const oldDaily = obj("curini/daily/full-backup-prod-2026-04-19T00-00-00.json", "2026-04-19T00:00:00Z"); // 91 días: se borra
    const sameAgeMonthly = obj("curini/monthly/full-backup-prod-2026-04.json", "2026-04-19T00:00:00Z"); // misma fecha, pero es monthly: se conserva
    const plan = computeRetentionPlan([oldDaily, sameAgeMonthly], opts);
    expect(plan.toDelete.map((o) => o.key)).toEqual([oldDaily.key]);
    expect(plan.toKeep.map((o) => o.key)).toEqual([sameAgeMonthly.key]);
  });

  test("respeta el prefix: objetos fuera del prefix se ignoran por completo (ni keep ni delete)", () => {
    const otherProject = obj("otro-proyecto/daily/full-backup-prod-2020-01-01T00-00-00.json", "2020-01-01T00:00:00Z");
    const ours = obj("curini/daily/full-backup-prod-2026-07-18T00-00-00.json", "2026-07-18T00:00:00Z");
    const plan = computeRetentionPlan([otherProject, ours], opts);
    expect(plan.toKeep.map((o) => o.key)).toEqual([ours.key]);
    expect(plan.toDelete).toEqual([]);
  });
});

// ─── uploadBackupToR2 / verifyUploadedBackup ───────────────────────────────

describe("uploadBackupToR2", () => {
  test("llama PutObject con Bucket/Key/Body/ContentType correctos", async () => {
    const { client, calls } = makeFakeClient({
      PutObjectCommand: () => ({ ETag: '"abc123"' }),
    });
    const result = await uploadBackupToR2(client, CONFIG, "curini/daily/x.json", "{\"a\":1}");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("PutObjectCommand");
    expect(calls[0]!.input).toEqual({
      Bucket: CONFIG.bucket, Key: "curini/daily/x.json", Body: "{\"a\":1}", ContentType: "application/json",
    });
    expect(result.etag).toBe('"abc123"');
  });
});

describe("verifyUploadedBackup", () => {
  const body = "contenido de prueba";
  const md5 = computeMd5Hex(body);
  const size = Buffer.byteLength(body, "utf-8");

  test("ok cuando ContentLength y ETag (MD5 simple) coinciden", async () => {
    const { client } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: size, ETag: `"${md5}"` }),
    });
    const result = await verifyUploadedBackup(client, CONFIG, "k", size, md5);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.etagMatches).toBe(true);
  });

  test("error cuando el tamaño no coincide", async () => {
    const { client } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: size + 5, ETag: `"${md5}"` }),
    });
    const result = await verifyUploadedBackup(client, CONFIG, "k", size, md5);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tamaño"))).toBe(true);
  });

  test("error cuando el ETag simple no coincide con el MD5 esperado", async () => {
    const { client } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: size, ETag: '"0000000000000000000000000000000"' }),
    });
    const result = await verifyUploadedBackup(client, CONFIG, "k", size, md5);
    expect(result.ok).toBe(false);
    expect(result.etagMatches).toBe(false);
    expect(result.errors.some((e) => e.includes("ETag"))).toBe(true);
  });

  test("ETag multipart (con guion) es warning, no error — limitación conocida", async () => {
    const { client } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: size, ETag: '"abc123-4"' }),
    });
    const result = await verifyUploadedBackup(client, CONFIG, "k", size, md5);
    expect(result.ok).toBe(true);
    expect(result.etagMatches).toBeNull();
    expect(result.warnings.some((w) => w.includes("multipart"))).toBe(true);
  });

  test("sin ETag en la respuesta es warning, no error", async () => {
    const { client } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: size }),
    });
    const result = await verifyUploadedBackup(client, CONFIG, "k", size, md5);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("ETag"))).toBe(true);
  });
});

// ─── promoteToMonthlyIfNeeded ───────────────────────────────────────────────

describe("promoteToMonthlyIfNeeded", () => {
  test("copia desde el diario si el mensual no existe (HeadObject 404)", async () => {
    const { client, calls } = makeFakeClient({
      HeadObjectCommand: () => { throw notFoundError(); },
      CopyObjectCommand: () => ({}),
    });
    const result = await promoteToMonthlyIfNeeded(client, CONFIG, "curini/daily/d.json", "curini/monthly/m.json");
    expect(result.promoted).toBe(true);
    const copyCall = calls.find((c) => c.command === "CopyObjectCommand");
    expect(copyCall?.input).toEqual({
      Bucket: CONFIG.bucket, Key: "curini/monthly/m.json", CopySource: `${CONFIG.bucket}/curini/daily/d.json`,
    });
  });

  test("no copia si el mensual ya existe", async () => {
    const { client, calls } = makeFakeClient({
      HeadObjectCommand: () => ({ ContentLength: 123 }),
    });
    const result = await promoteToMonthlyIfNeeded(client, CONFIG, "curini/daily/d.json", "curini/monthly/m.json");
    expect(result.promoted).toBe(false);
    expect(calls.some((c) => c.command === "CopyObjectCommand")).toBe(false);
  });
});

// ─── listBackupObjects ──────────────────────────────────────────────────────

describe("listBackupObjects", () => {
  test("pagina con ContinuationToken hasta agotar IsTruncated", async () => {
    let call = 0;
    const { client } = makeFakeClient({
      ListObjectsV2Command: (input) => {
        call += 1;
        if (call === 1) {
          expect(input.ContinuationToken).toBeUndefined();
          return {
            Contents: [{ Key: "curini/daily/a.json", LastModified: new Date("2026-01-01T00:00:00Z"), Size: 10 }],
            IsTruncated: true, NextContinuationToken: "page2",
          };
        }
        expect(input.ContinuationToken).toBe("page2");
        return {
          Contents: [{ Key: "curini/daily/b.json", LastModified: new Date("2026-01-02T00:00:00Z"), Size: 20 }],
          IsTruncated: false,
        };
      },
    });
    const objects = await listBackupObjects(client, CONFIG);
    expect(objects.map((o) => o.key)).toEqual(["curini/daily/a.json", "curini/daily/b.json"]);
  });
});

// ─── deleteExpiredBackupObjects ─────────────────────────────────────────────

describe("deleteExpiredBackupObjects", () => {
  const plan = { toDelete: [obj("curini/daily/old1.json", "2020-01-01"), obj("curini/daily/old2.json", "2020-01-02")], toKeep: [] };

  test("dry-run (confirmDelete=false): no llama a R2 en absoluto", async () => {
    const { client, calls } = makeFakeClient({});
    const result = await deleteExpiredBackupObjects(client, CONFIG, plan, false);
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("confirmDelete=true: borra cada objeto de toDelete", async () => {
    const { client, calls } = makeFakeClient({
      DeleteObjectCommand: () => ({}),
    });
    const result = await deleteExpiredBackupObjects(client, CONFIG, plan, true);
    expect(result.dryRun).toBe(false);
    expect(result.deleted).toEqual(["curini/daily/old1.json", "curini/daily/old2.json"]);
    expect(calls.filter((c) => c.command === "DeleteObjectCommand")).toHaveLength(2);
  });
});
