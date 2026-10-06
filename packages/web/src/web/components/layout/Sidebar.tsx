import type { ReactElement } from "react";
import { Link, useLocation } from "wouter";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { useAuth } from "@/lib/auth";
import { useSidebarCollapsed, type SidebarPreferenceStore } from "@/lib/sidebar-preference";
import {
  LayoutDashboard, FileText, Building2, Users, Car, Home, ShieldCheck, Briefcase,
  LogOut, ChevronRight, Shield, Settings, Bike, HeartPulse, Zap, Scale, HardHat, Flame,
  DollarSign, Send, AlertTriangle, ClipboardList, Upload, X, Wallet, BarChart2,
  PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/polizas", icon: FileText, label: "Pólizas" },
  { href: "/companias", icon: Building2, label: "Compañías" },
  { href: "/asegurados", icon: Users, label: "Asegurados" },
  { href: "/cobranzas", icon: DollarSign, label: "Cobranzas y Rendiciones" },
  { href: "/envios", icon: Send, label: "Envíos y Entregas" },
  { href: "/siniestros", icon: AlertTriangle, label: "Siniestros" },
  { href: "/tareas", icon: ClipboardList, label: "Tareas" },
  { href: "/reporte-mes", icon: BarChart2, label: "Reporte mensual" },
];

const typeItems = [
  { href: "/polizas?type=automotor", icon: Car, label: "Automotor" },
  { href: "/polizas?type=motovehiculo", icon: Bike, label: "Motovehículo" },
  { href: "/polizas?type=hogar", icon: Home, label: "Hogar" },
  { href: "/polizas?type=accidentes", icon: ShieldCheck, label: "Acc. Personales" },
  { href: "/polizas?type=art", icon: HeartPulse, label: "ART" },
  { href: "/polizas?type=ecomovilidad", icon: Zap, label: "Ecomovilidad" },
  { href: "/polizas?type=comercial", icon: Briefcase, label: "Integrales" },
  { href: "/polizas?type=responsabilidad_civil", icon: Scale, label: "Resp. Civil" },
  { href: "/polizas?type=cascos", icon: HardHat, label: "Cascos" },
  { href: "/polizas?type=incendio", icon: Flame, label: "Incendio" },
];

const adminItems = [
  { href: "/importar", icon: Upload, label: "Importar pólizas" },
  { href: "/caja", icon: Wallet, label: "Caja" },
  { href: "/usuarios", icon: Settings, label: "Usuarios" },
];

export const SIDEBAR_ID = "app-sidebar";
export const SIDEBAR_TOGGLE_LABEL_COLLAPSE = "Colapsar menú";
export const SIDEBAR_TOGGLE_LABEL_EXPAND = "Expandir menú";
export const SIDEBAR_LOGOUT_LABEL = "Cerrar sesión";

// Menú colapsado (solo escritorio, clases lg:): solo íconos. El texto queda
// como nombre accesible (lg:sr-only) y se muestra en un tooltip con mouse y
// con foco de teclado. El tooltip se oculta por debajo de lg, donde el drawer
// mobile siempre muestra los textos. El tooltip repite el nombre accesible,
// así que no se enlaza como descripción (aria-describedby): un lector de
// pantalla lo anunciaría dos veces.
function SidebarTooltip({ enabled, label, children }: { enabled: boolean; label: string; children: ReactElement }) {
  if (!enabled) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild aria-describedby={undefined}>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          sideOffset={10}
          data-testid="sidebar-tooltip"
          className="hidden lg:block z-[60] rounded-md border border-[#2d3748] bg-[#1a2540] px-2 py-1 text-xs text-white shadow-lg"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Sidebar({ mobileOpen = false, onClose, preferenceStore }: {
  mobileOpen?: boolean;
  onClose?: () => void;
  /** Solo para tests; por defecto, el store global (localStorage). */
  preferenceStore?: SidebarPreferenceStore;
}) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useSidebarCollapsed(preferenceStore);
  const toggleLabel = collapsed ? SIDEBAR_TOGGLE_LABEL_EXPAND : SIDEBAR_TOGGLE_LABEL_COLLAPSE;

  const handleNav = () => {
    if (onClose) onClose();
  };

  const linkClass = (active: boolean) => cn(
    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
    collapsed && "lg:justify-center lg:px-0",
    active
      ? "bg-blue-600/20 text-blue-400 font-medium"
      : "text-gray-400 hover:text-white hover:bg-[#1a2540]"
  );
  const labelClass = collapsed ? "lg:sr-only" : undefined;
  const sectionTitle = (text: string, first = false) => (
    <>
      {collapsed && !first && <div aria-hidden="true" className="hidden lg:block mx-2 my-3 border-t border-[#1f2937]" />}
      <p className={cn("text-xs text-gray-500 uppercase tracking-widest px-3 mb-2", !first && "mt-5", collapsed && "lg:sr-only")}>{text}</p>
    </>
  );

  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      {/* Overlay mobile */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      <aside
        id={SIDEBAR_ID}
        data-collapsed={collapsed ? "true" : "false"}
        className={cn(
          "w-[216px] flex flex-col border-r border-[#1f2937] bg-[#0d1424]",
          // Desktop: sticky con alto de pantalla (scroll interno en el nav)
          "lg:sticky lg:top-0 lg:h-screen lg:self-start lg:shrink-0 lg:translate-x-0 lg:z-auto lg:transition-[width] lg:duration-200",
          collapsed && "lg:w-16",
          // Mobile: drawer fijo deslizable
          "fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo + colapsar (desktop) + cerrar (mobile) */}
        <div className={cn(
          "px-6 py-5 border-b border-[#1f2937] flex items-center justify-between",
          collapsed && "lg:flex-col lg:gap-3 lg:px-0 lg:py-4"
        )}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <div className={labelClass}>
              <p className="font-bold text-white text-sm leading-tight" style={{ fontFamily: "Syne, sans-serif" }}>Organización</p>
              <p className="font-bold text-blue-400 text-sm leading-tight" style={{ fontFamily: "Syne, sans-serif" }}>Curini</p>
            </div>
          </div>
          {/* Tooltip siempre montado (no `title`, que duplicaría aria-label
              como descripción): el botón no se remonta y conserva el foco. */}
          <SidebarTooltip enabled label={toggleLabel}>
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              aria-controls={SIDEBAR_ID}
              aria-label={toggleLabel}
              data-testid="sidebar-collapse-toggle"
              className="hidden lg:flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-[#1a2540] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
            >
              {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
          </SidebarTooltip>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white p-1" aria-label="Cerrar menú">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className={cn("flex-1 px-3 py-4 space-y-1 overflow-y-auto lg:min-h-0", collapsed && "lg:px-2")}>
          {sectionTitle("Principal", true)}
          {navItems.map((item) => {
            const active = location === item.href;
            return (
              <SidebarTooltip key={item.href} enabled={collapsed} label={item.label}>
                <Link href={item.href} aria-current={active ? "page" : undefined}>
                  <a onClick={handleNav} className={linkClass(active)}>
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    <span className={labelClass}>{item.label}</span>
                    {active && <ChevronRight className={cn("w-3 h-3 ml-auto", collapsed && "lg:hidden")} />}
                  </a>
                </Link>
              </SidebarTooltip>
            );
          })}

          {sectionTitle("Por Tipo")}
          {typeItems.map((item) => {
            return (
              <SidebarTooltip key={item.href} enabled={collapsed} label={item.label}>
                <Link href={item.href}>
                  <a onClick={handleNav} className={linkClass(false)}>
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    <span className={labelClass}>{item.label}</span>
                  </a>
                </Link>
              </SidebarTooltip>
            );
          })}

          {user?.role === "admin" && (
            <>
              {sectionTitle("Admin")}
              {adminItems.map((item) => {
                const active = location === item.href;
                return (
                  <SidebarTooltip key={item.href} enabled={collapsed} label={item.label}>
                    <Link href={item.href} aria-current={active ? "page" : undefined}>
                      <a onClick={handleNav} className={linkClass(active)}>
                        <item.icon className="w-4 h-4" />
                        <span className={labelClass}>{item.label}</span>
                      </a>
                    </Link>
                  </SidebarTooltip>
                );
              })}
            </>
          )}
        </nav>

        {/* User */}
        <div className={cn("px-3 py-4 border-t border-[#1f2937]", collapsed && "lg:px-2")}>
          <div className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1a2540]",
            collapsed && "lg:flex-col lg:gap-2 lg:px-0"
          )}>
            {/* Nombre y rol siguen como texto accesible (lg:sr-only); el
                avatar suma un tooltip con mouse sin volverse enfocable. */}
            <SidebarTooltip enabled={collapsed} label={`${user?.name ?? ""} · ${user?.role ?? ""}`}>
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                {user?.name?.charAt(0).toUpperCase()}
              </div>
            </SidebarTooltip>
            <div className={cn("flex-1 min-w-0", labelClass)}>
              <p className="text-xs font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.role}</p>
            </div>
            {/* aria-label en lugar de `title`: colapsado, el tooltip nativo se
                sumaba al de Radix (dos tooltips con el mismo texto). */}
            <SidebarTooltip enabled={collapsed} label={SIDEBAR_LOGOUT_LABEL}>
              <button onClick={logout} className="text-gray-500 hover:text-red-400 transition-colors" aria-label={SIDEBAR_LOGOUT_LABEL}>
                <LogOut className="w-4 h-4" />
              </button>
            </SidebarTooltip>
          </div>
        </div>
      </aside>
    </TooltipPrimitive.Provider>
  );
}
