import { ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, Shield } from "lucide-react";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#0a0f1e]">
      {/* Sidebar: fijo en desktop, drawer en mobile */}
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header mobile (solo < lg) */}
        <header className="lg:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 border-b border-[#1f2937] bg-[#0d1424]">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 -ml-2 text-gray-300 hover:text-white"
            aria-label="Abrir menú"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <div className="leading-tight">
              <p className="font-bold text-white text-sm" style={{ fontFamily: "Syne, sans-serif" }}>
                Organización <span className="text-blue-400">Curini</span>
              </p>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
