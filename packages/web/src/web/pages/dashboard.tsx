import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { formatCurrency, POLICY_TYPES } from "@/lib/utils";
import { Link } from "wouter";
import {
  FileText, AlertTriangle, CheckCircle2, XCircle, TrendingUp,
  Car, Home, ShieldCheck, Briefcase, ArrowRight, Clock, Bike, HeartPulse, Zap, Scale, HardHat, Flame
} from "lucide-react";

interface Stats {
  total: number;
  activas: number;
  vencidas: number;
  porVencer: number;
  canceladas: number;
  byType: Record<string, number>;
  byCompany: Record<string, { count: number; premium: number }>;
  totalPremium: number;
  upcoming: number;
}

const typeIcons: Record<string, any> = {
  automotor: Car,
  motovehiculo: Bike,
  ecomovilidad: Zap,
  hogar: Home,
  accidentes: ShieldCheck,
  art: HeartPulse,
  comercial: Briefcase,
  responsabilidad_civil: Scale,
  cascos: HardHat,
  incendio: Flame,
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/stats").then(setStats).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <AppLayout>
      <div className="flex items-center justify-center h-full min-h-screen">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </AppLayout>
  );

  const topCompanies = stats ? Object.entries(stats.byCompany)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5) : [];

  return (
    <AppLayout>
      <div className="p-4 lg:p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Resumen general de pólizas activas</p>
        </div>

        {/* Alertas */}
        {(stats?.porVencer || 0) > 0 && (
          <div className="mb-6 bg-amber-500/10 border border-amber-500/20 rounded-xl px-5 py-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-amber-400 text-sm font-medium">
                {stats?.porVencer} póliza{stats?.porVencer !== 1 ? "s" : ""} próxima{stats?.porVencer !== 1 ? "s" : ""} a vencer en los próximos 30 días
              </p>
            </div>
            <Link href="/polizas?status=por_vencer">
              <a className="text-amber-400 text-xs font-medium flex items-center gap-1 hover:text-amber-300 transition-colors">
                Ver pólizas <ArrowRight className="w-3 h-3" />
              </a>
            </Link>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard icon={FileText} label="Total Pólizas" value={stats?.total ?? 0} iconColor="text-blue-400" bg="bg-blue-500/10" />
          <StatCard icon={CheckCircle2} label="Activas" value={stats?.activas ?? 0} iconColor="text-emerald-400" bg="bg-emerald-500/10" />
          <StatCard icon={Clock} label="Por Vencer" value={stats?.porVencer ?? 0} iconColor="text-amber-400" bg="bg-amber-500/10" />
          <StatCard icon={XCircle} label="Vencidas" value={stats?.vencidas ?? 0} iconColor="text-red-400" bg="bg-red-500/10" />
        </div>

        {/* Premium total */}
        <div className="mb-8 bg-gradient-to-r from-blue-600/20 to-blue-800/10 border border-blue-600/20 rounded-xl p-5 lg:p-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-gray-400 text-sm">Prima total (cartera activa)</p>
            <p className="text-2xl lg:text-3xl font-bold text-white mt-1 font-mono truncate" style={{ fontFamily: "JetBrains Mono, monospace" }}>
              {formatCurrency(stats?.totalPremium)}
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-blue-600/20 flex items-center justify-center shrink-0">
            <TrendingUp className="w-6 h-6 text-blue-400" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* By type */}
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6">
            <h3 className="text-sm font-semibold text-white mb-4" style={{ fontFamily: "Syne, sans-serif" }}>Pólizas por Tipo</h3>
            <div className="space-y-3">
              {Object.entries(stats?.byType || {}).map(([type, count]) => {
                const Icon = typeIcons[type] || FileText;
                const info = POLICY_TYPES[type];
                const pct = stats?.total ? Math.round((count / stats.total) * 100) : 0;
                return (
                  <div key={type} className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${info?.color || ""}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-gray-300">{info?.label || type}</span>
                        <span className="text-sm font-medium text-white">{count}</span>
                      </div>
                      <div className="h-1.5 bg-[#1f2937] rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* By company */}
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6">
            <h3 className="text-sm font-semibold text-white mb-4" style={{ fontFamily: "Syne, sans-serif" }}>Top Compañías Aseguradoras</h3>
            <div className="space-y-3">
              {topCompanies.map(([name, data], i) => (
                <div key={name} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-[#1f2937] flex items-center justify-center text-xs font-bold text-gray-400">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 truncate">{name}</p>
                    <p className="text-xs text-gray-500">{data.count} póliza{data.count !== 1 ? "s" : ""} · {formatCurrency(data.premium)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function StatCard({ icon: Icon, label, value, iconColor, bg }: {
  icon: any; label: string; value: number; iconColor: string; bg: string;
}) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400">{label}</p>
        <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
      </div>
      <p className="text-2xl font-bold text-white" style={{ fontFamily: "JetBrains Mono, monospace" }}>{value}</p>
    </div>
  );
}
