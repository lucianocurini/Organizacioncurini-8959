import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard, FileText, Building2, Users, Car, Home, ShieldCheck, Briefcase,
  LogOut, ChevronRight, Shield, Settings, Bike, HeartPulse, Zap, Scale, HardHat, Flame,
  DollarSign, Send, AlertTriangle, ClipboardList, Upload, X, Wallet, BarChart2
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

export function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const handleNav = () => {
    if (onClose) onClose();
  };

  return (
    <>
      {/* Overlay mobile */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "w-[240px] flex flex-col border-r border-[#1f2937] bg-[#0d1424]",
          // Desktop: fijo dentro del flujo
          "lg:relative lg:translate-x-0 lg:min-h-screen lg:z-auto",
          // Mobile: drawer fijo deslizable
          "fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo + cerrar (mobile) */}
        <div className="px-6 py-5 border-b border-[#1f2937] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="font-bold text-white text-sm leading-tight" style={{ fontFamily: "Syne, sans-serif" }}>Organización</p>
              <p className="font-bold text-blue-400 text-sm leading-tight" style={{ fontFamily: "Syne, sans-serif" }}>Curini</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white p-1" aria-label="Cerrar menú">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <p className="text-xs text-gray-500 uppercase tracking-widest px-3 mb-2">Principal</p>
          {navItems.map((item) => {
            const active = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <a onClick={handleNav} className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                  active
                    ? "bg-blue-600/20 text-blue-400 font-medium"
                    : "text-gray-400 hover:text-white hover:bg-[#1a2540]"
                )}>
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                  {active && <ChevronRight className="w-3 h-3 ml-auto" />}
                </a>
              </Link>
            );
          })}

          <p className="text-xs text-gray-500 uppercase tracking-widest px-3 mb-2 mt-5">Por Tipo</p>
          {typeItems.map((item) => {
            return (
              <Link key={item.href} href={item.href}>
                <a onClick={handleNav} className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                  "text-gray-400 hover:text-white hover:bg-[#1a2540]"
                )}>
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </a>
              </Link>
            );
          })}

          {user?.role === "admin" && (
            <>
              <p className="text-xs text-gray-500 uppercase tracking-widest px-3 mb-2 mt-5">Admin</p>
              <Link href="/importar">
                <a onClick={handleNav} className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                  location === "/importar"
                    ? "bg-blue-600/20 text-blue-400 font-medium"
                    : "text-gray-400 hover:text-white hover:bg-[#1a2540]"
                )}>
                  <Upload className="w-4 h-4" />
                  Importar pólizas
                </a>
              </Link>
              <Link href="/caja">
                <a onClick={handleNav} className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                  location === "/caja"
                    ? "bg-blue-600/20 text-blue-400 font-medium"
                    : "text-gray-400 hover:text-white hover:bg-[#1a2540]"
                )}>
                  <Wallet className="w-4 h-4" />
                  Caja
                </a>
              </Link>
              <Link href="/usuarios">
                <a onClick={handleNav} className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                  location === "/usuarios"
                    ? "bg-blue-600/20 text-blue-400 font-medium"
                    : "text-gray-400 hover:text-white hover:bg-[#1a2540]"
                )}>
                  <Settings className="w-4 h-4" />
                  Usuarios
                </a>
              </Link>
            </>
          )}
        </nav>

        {/* User */}
        <div className="px-3 py-4 border-t border-[#1f2937]">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1a2540]">
            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.name?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.role}</p>
            </div>
            <button onClick={logout} className="text-gray-500 hover:text-red-400 transition-colors" title="Cerrar sesión">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
