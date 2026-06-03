# Curini - Estado del Proyecto

## RESUELTO HOY (2026-06-02)

### Bug crítico: gmail-download-attachment → null
**Causa**: El proxy HTTP `/api/cli/connectors/run` strippea el campo `exports` del resultado.
**Solución**: Usar ORPC client directamente (`@orpc/client` con `RPCLink`) igual que el connector CLI.
- El resultado incluye `exports.$filestash_uploads[0].get_url` = URL S3 presignada (30min TTL)
- Descargamos el archivo desde S3 con fetch normal

**Cambios clave**:
- `packages/web/src/api/index.ts`: función `gmailGetAttachmentContent` reescrita para usar ORPC
- `packages/web/src/server.ts`: `idleTimeout: 120` para requests largas
- `packages/web/package.json`: `@orpc/client` agregado

### Importación batch completada
- 100 emails de El Norte (dic 2025 - jun 2026) procesados en ~15min
- **211 pólizas importadas**
- **272 renovaciones** registradas
- **34 anulaciones** aplicadas
- **0 errores**
- **Total en DB: 563 pólizas**

## PENDIENTE

### 1. Password real de lucianocurini@gmail.com
- Actualmente en DB: `test123` (hash bcrypt de test123)
- PENDIENTE: restaurar password real

### 2. Mercantil Andina CSV
- Import pendiente de prueba
- Los emails están en el inbox

### 3. Cron job automático
- El endpoint `/api/gmail/cron-el-norte` existe pero no está programado
- Ejecutar diariamente para importar emails nuevos

### 4. Importación histórica más antigua
- Solo se importó desde dic 2025
- Si hay emails anteriores, repetir batch con rango más amplio

## ARQUITECTURA TÉCNICA

### Stack
- Bun + Hono + Drizzle + Turso (SQLite remoto)
- Puerto: 4200 (producción)

### Env vars críticas
- `CLI_URL=https://api.runable.com/api/cli?key=rk_PIsFh8Y4jgsVFhN3av678`
- DB: Turso remoto

### Connector CLI insight
- `connector run gmail gmail-download-attachment` requiere el `filename` prop
- Sin filename → returns null
- Con filename → returns `{filename, filePath}` + `exports.$filestash_uploads`
- El CLI strips `exports`, por eso parecía null desde código
- ORPC directo expone `exports` completo con la URL S3

## PATTERNS IMPORTANTES

### Auth
- Header: `x-session-id: <sessionId>`
- Login: POST /api/auth/login `{email, password}`

### El Norte TXT parser
- `packages/web/src/lib/parsers/el-norte.ts`
- Campos: tipo movimiento, póliza, cliente, vehículo, fechas, prima
- Encoding: latin1

### Gmail find query
- `from:gestorweb@elnorte.com.ar subject:"Archivo de Emision"`
- `metadataOnly: false` para obtener parts con attachmentId
