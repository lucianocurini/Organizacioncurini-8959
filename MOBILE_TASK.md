# Optimización Mobile Curini

Patrón: `p-4 lg:p-8`, header `flex-col sm:flex-row`, títulos `text-xl lg:text-2xl`,
botón `justify-center`, tablas `hidden lg:block`/`md:table` + tarjetas mobile `lg:hidden`/`md:hidden divide-y`.
Modales: `max-h-[90vh] overflow-y-auto`. Desktop NO cambia.

## DONE
- AppLayout, Sidebar, polizas, asegurados, dashboard
- envios.tsx ✅
- cobranzas.tsx ✅
- siniestros.tsx ✅ (listado ya muestra nombre asegurado)
- companias.tsx ✅ (header+padding; grid ya responsive)

## TODO
- [x] tareas.tsx (inline styles → grid responsive)
- [x] poliza-detail.tsx (header + tabla cuotas scroll-x)
- [x] siniestro-detail.tsx (header responsive)
- [x] usuarios.tsx (tabla → tarjetas mobile)
- [x] modales policies: RebillingModal arreglado; PolicyModal/ImportModal ya tenían scroll
- [x] screenshot final 390px — todo OK
- (importar.tsx admin, baja prioridad — pendiente si hace falta)

## Server
tmux `dev`, puerto 5576, log /tmp/curini-dev.log. Login lucianocurini@gmail.com / curini2026

## Pendiente funcional (preguntar al user al final)
- siniestros: N° siniestro de compañía, flujo tercero culpable
- envíos manuales
