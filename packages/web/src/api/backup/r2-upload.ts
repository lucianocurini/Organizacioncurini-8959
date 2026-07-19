/**
 * Subida del backup completo a un storage S3-compatible (Cloudflare R2) +
 * retención — usado opcionalmente por scripts/backup-prod-full.ts. Nada de
 * esto se ejecuta si no se pide explícitamente (CONFIRM_BACKUP_UPLOAD=1): el
 * script sigue funcionando exactamente igual que antes sin estas variables.
 *
 * Funciones puras (testeables sin red): buildR2Endpoint, getR2Config,
 * dailyBackupKey, monthlyBackupKey, computeRetentionPlan, computeMd5Hex,
 * maskR2Endpoint. El resto llama a S3Client.send() — aceptan un R2Client
 * mínimo (misma idea que BackupClient en full-backup.ts) para poder testear
 * con un fake sin tocar R2 real.
 */
import { createHash } from "crypto";
import {
  S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  CopyObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export interface R2Env {
  R2_ENDPOINT?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_PREFIX?: string;
}

export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Normalizado: "" o termina siempre en "/". */
  prefix: string;
}

export interface R2ConfigResult {
  ok: boolean;
  config: R2Config | null;
  errors: string[];
}

/** R2_ENDPOINT explícito gana (útil para apuntar a un endpoint de pruebas); si no, se deriva de R2_ACCOUNT_ID. */
export function buildR2Endpoint(env: R2Env): string | null {
  if (env.R2_ENDPOINT) return env.R2_ENDPOINT;
  if (env.R2_ACCOUNT_ID) return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return null;
}

export function getR2Config(env: R2Env): R2ConfigResult {
  const errors: string[] = [];
  const endpoint = buildR2Endpoint(env);
  if (!endpoint) errors.push("falta R2_ENDPOINT o R2_ACCOUNT_ID");
  if (!env.R2_ACCESS_KEY_ID) errors.push("falta R2_ACCESS_KEY_ID");
  if (!env.R2_SECRET_ACCESS_KEY) errors.push("falta R2_SECRET_ACCESS_KEY");
  if (!env.R2_BUCKET) errors.push("falta R2_BUCKET");

  if (errors.length > 0) return { ok: false, config: null, errors };

  const rawPrefix = env.R2_PREFIX ?? "";
  const prefix = rawPrefix === "" || rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;

  return {
    ok: true,
    errors: [],
    config: {
      endpoint: endpoint!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucket: env.R2_BUCKET!,
      prefix,
    },
  };
}

/** Nunca imprimir accessKeyId/secretAccessKey — esto es lo único seguro de loguear del config. */
export function maskR2Endpoint(endpoint: string): string {
  const withoutScheme = endpoint.replace(/^https?:\/\//, "");
  const host = withoutScheme.split(/[/?]/)[0] ?? "";
  return `https://${host.slice(0, 6)}${"*".repeat(Math.max(host.length - 6, 3))}`;
}

export function buildR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

const TS_FORMAT_LENGTH = 19; // "YYYY-MM-DDTHH-mm-ss"

export function dailyBackupKey(prefix: string, date: Date): string {
  const ts = date.toISOString().replace(/[:.]/g, "-").slice(0, TS_FORMAT_LENGTH);
  return `${prefix}daily/full-backup-prod-${ts}.json`;
}

export function monthlyBackupKey(prefix: string, date: Date): string {
  const yearMonth = date.toISOString().slice(0, 7); // "YYYY-MM"
  return `${prefix}monthly/full-backup-prod-${yearMonth}.json`;
}

export function computeMd5Hex(body: string): string {
  return createHash("md5").update(body, "utf-8").digest("hex");
}

/** Mismo contrato que S3Client (.send(command)) — un fake en tests solo necesita implementar esto. */
export interface R2Client {
  send(command: unknown): Promise<any>;
}

export async function uploadBackupToR2(client: R2Client, config: R2Config, key: string, body: string): Promise<{ etag: string | null }> {
  const res = await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: "application/json",
  }));
  return { etag: res?.ETag ?? null };
}

export interface VerifyUploadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  actualSize: number | null;
  etagMatches: boolean | null; // null = no se pudo comparar (sin ETag o ETag de multipart)
}

/**
 * Compara ContentLength y, si el ETag tiene forma de MD5 simple (PUT no
 * multipart — el único caso posible con el tamaño actual de estos backups,
 * bien por debajo del umbral de multipart), lo compara contra el MD5 local.
 * Un ETag con guion (formato multipart de S3) no es comparable así — se
 * reporta como warning, no como error, porque no es una falla real, es un
 * límite conocido de este chequeo.
 */
export async function verifyUploadedBackup(
  client: R2Client, config: R2Config, key: string, expectedSizeBytes: number, expectedMd5Hex: string
): Promise<VerifyUploadResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const res = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  const actualSize: number | null = res?.ContentLength ?? null;

  if (actualSize === null) errors.push(`HeadObject no devolvió ContentLength para ${key}`);
  else if (actualSize !== expectedSizeBytes) errors.push(`tamaño no coincide para ${key}: esperado ${expectedSizeBytes}, subido ${actualSize}`);

  let etagMatches: boolean | null = null;
  const rawEtag: string | null = res?.ETag ? String(res.ETag).replace(/"/g, "") : null;
  if (!rawEtag) {
    warnings.push(`sin ETag en la respuesta de HeadObject para ${key} — no se pudo verificar integridad por checksum`);
  } else if (rawEtag.includes("-")) {
    warnings.push(`ETag de multipart upload (${rawEtag}) para ${key} — no comparable con MD5 simple (límite conocido, no indica un problema real)`);
  } else if (rawEtag.toLowerCase() !== expectedMd5Hex.toLowerCase()) {
    etagMatches = false;
    errors.push(`ETag no coincide para ${key}: esperado md5=${expectedMd5Hex}, R2 devolvió ${rawEtag}`);
  } else {
    etagMatches = true;
  }

  return { ok: errors.length === 0, errors, warnings, actualSize, etagMatches };
}

export interface PromoteResult {
  promoted: boolean;
  monthlyKey: string;
  reason: string;
}

async function headObjectExists(client: R2Client, config: R2Config, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch (err: any) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

/**
 * Si ya existe un backup mensual para este YYYY-MM, no se toca (idempotente,
 * no depende de que el cron corra exactamente el día 1 — el primer run
 * exitoso del mes lo crea). Si no existe, copia server-side desde el diario
 * recién subido (CopyObjectCommand) — no retransmite el body.
 */
export async function promoteToMonthlyIfNeeded(
  client: R2Client, config: R2Config, dailyKey: string, monthlyKey: string
): Promise<PromoteResult> {
  const exists = await headObjectExists(client, config, monthlyKey);
  if (exists) {
    return { promoted: false, monthlyKey, reason: "ya existe un backup mensual para este mes — no se sobrescribe" };
  }
  await client.send(new CopyObjectCommand({
    Bucket: config.bucket,
    Key: monthlyKey,
    CopySource: `${config.bucket}/${dailyKey}`,
  }));
  return { promoted: true, monthlyKey, reason: "copiado server-side desde el backup diario de hoy" };
}

export interface BackupObjectInfo {
  key: string;
  lastModified: Date;
  size: number;
}

/**
 * Un solo ListObjectsV2 con Prefix=config.prefix cubre daily/ y monthly/ a
 * la vez (paginado si hace falta) — computeRetentionPlan clasifica cada
 * objeto por su key, no hace falta un segundo listado por subcarpeta.
 */
export async function listBackupObjects(client: R2Client, config: R2Config): Promise<BackupObjectInfo[]> {
  const objects: BackupObjectInfo[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: config.prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res?.Contents ?? []) {
      if (obj.Key && obj.LastModified) {
        objects.push({ key: obj.Key, lastModified: new Date(obj.LastModified), size: obj.Size ?? 0 });
      }
    }
    continuationToken = res?.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

export interface RetentionOptions {
  /** Mismo config.prefix usado para las keys — objetos fuera de este prefix (ej. otro proyecto compartiendo el bucket) se ignoran, nunca se tocan. */
  prefix: string;
  retentionDays: number;
  monthlyRetentionMonths: number;
  /** Inyectable para tests deterministas; default new Date(). */
  now?: Date;
}

export interface RetentionPlan {
  toDelete: BackupObjectInfo[];
  toKeep: BackupObjectInfo[];
}

/**
 * Pura — no llama a R2. Clasifica cada objeto por su key (daily/ vs monthly/
 * bajo el prefix dado) y aplica el cutoff correspondiente. Un objeto que no
 * matchea ninguno de los dos subprefijos se ignora por completo (ni se borra
 * ni se cuenta como "keep") — nunca se toca algo que no reconoce.
 */
export function computeRetentionPlan(objects: BackupObjectInfo[], opts: RetentionOptions): RetentionPlan {
  const now = opts.now ?? new Date();
  const dailyPrefix = `${opts.prefix}daily/`;
  const monthlyPrefix = `${opts.prefix}monthly/`;

  const dailyCutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);
  const monthlyCutoff = new Date(now.getTime());
  monthlyCutoff.setMonth(monthlyCutoff.getMonth() - opts.monthlyRetentionMonths);

  const toDelete: BackupObjectInfo[] = [];
  const toKeep: BackupObjectInfo[] = [];

  for (const obj of objects) {
    if (obj.key.startsWith(dailyPrefix)) {
      (obj.lastModified < dailyCutoff ? toDelete : toKeep).push(obj);
    } else if (obj.key.startsWith(monthlyPrefix)) {
      (obj.lastModified < monthlyCutoff ? toDelete : toKeep).push(obj);
    }
  }

  return { toDelete, toKeep };
}

export interface DeleteResult {
  deleted: string[];
  dryRun: boolean;
}

/** Sin confirmDelete=true, no llama a R2 en absoluto — dry-run real, no solo "no debería borrar". */
export async function deleteExpiredBackupObjects(
  client: R2Client, config: R2Config, plan: RetentionPlan, confirmDelete: boolean
): Promise<DeleteResult> {
  if (!confirmDelete) return { deleted: [], dryRun: true };

  const deleted: string[] = [];
  for (const obj of plan.toDelete) {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: obj.key }));
    deleted.push(obj.key);
  }
  return { deleted, dryRun: false };
}
