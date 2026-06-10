import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Plus, Edit, Trash2, Building2, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function Companias() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form, setForm] = useState({ name: "", cuit: "", phone: "", email: "" });

  const load = () => {
    setLoading(true);
    api.get("/api/companies").then(setCompanies).finally(() => setLoading(false));
  };
  useEffect(load, []);

  function openCreate() { setEditItem(null); setForm({ name: "", cuit: "", phone: "", email: "" }); setShowModal(true); }
  function openEdit(c: any) { setEditItem(c); setForm({ name: c.name, cuit: c.cuit || "", phone: c.phone || "", email: c.email || "" }); setShowModal(true); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    try {
      if (editItem) {
        await api.put(`/api/companies/${editItem.id}`, form);
        toast.success("Compañía actualizada");
      } else {
        await api.post("/api/companies", form);
        toast.success("Compañía creada");
      }
      setShowModal(false);
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.delete(`/api/companies/${id}`);
      toast.success("Compañía eliminada");
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
    setDeleteId(null);
  }

  const inputClass = "w-full px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-all";

  return (
    <AppLayout>
      <div className="p-4 lg:p-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Compañías Aseguradoras</h1>
            <p className="text-gray-400 text-sm mt-1">{companies.length} compañías registradas</p>
          </div>
          <button onClick={openCreate} className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium transition-all">
            <Plus className="w-4 h-4" /> Nueva Compañía
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {companies.map(c => (
              <div key={c.id} className="bg-[#111827] border border-[#1f2937] rounded-xl p-5 hover:border-blue-500/30 transition-all">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm" style={{ fontFamily: "Syne, sans-serif" }}>{c.name}</p>
                      {c.cuit && <p className="text-xs text-gray-500">CUIT: {c.cuit}</p>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(c)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-[#1f2937] rounded-md transition-all"><Edit className="w-4 h-4" /></button>
                    <button onClick={() => setDeleteId(c.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-[#1f2937] rounded-md transition-all"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {c.phone && <p className="text-xs text-gray-400">📞 {c.phone}</p>}
                  {c.email && <p className="text-xs text-gray-400">✉ {c.email}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1f2937]">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
                {editItem ? "Editar Compañía" : "Nueva Compañía"}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div><label className="block text-xs text-gray-400 mb-1.5">Nombre *</label><input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="La Meridional" /></div>
              <div><label className="block text-xs text-gray-400 mb-1.5">CUIT</label><input className={inputClass} value={form.cuit} onChange={e => setForm(f => ({ ...f, cuit: e.target.value }))} placeholder="30-12345678-9" /></div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Teléfono</label><input className={inputClass} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="0800-222-5683" /></div>
              <div><label className="block text-xs text-gray-400 mb-1.5">Email</label><input className={inputClass} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="contacto@aseguradora.com" /></div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
                <button type="submit" disabled={formLoading} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2">
                  {formLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editItem ? "Guardar" : "Crear"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 max-w-sm w-full">
            <h3 className="text-white font-semibold mb-2">¿Eliminar compañía?</h3>
            <p className="text-gray-400 text-sm mb-5">Esta acción no se puede deshacer.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 py-2 bg-[#1f2937] text-gray-300 text-sm rounded-lg hover:bg-[#374151] transition-all">Cancelar</button>
              <button onClick={() => handleDelete(deleteId)} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-all">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
