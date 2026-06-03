import { Route, Switch, Redirect } from "wouter";
import { Provider } from "./components/provider";
import { AuthProvider, useAuth } from "./lib/auth";
import { AgentFeedback, RunableBadge } from "@runablehq/website-runtime";
import { Toaster } from "./components/ui/sonner";
import { useEffect } from "react";

// Pages
import Login from "./pages/login";
import Dashboard from "./pages/dashboard";
import Polizas from "./pages/polizas";
import PolizaDetail from "./pages/poliza-detail";
import Companias from "./pages/companias";
import Asegurados from "./pages/asegurados";
import Usuarios from "./pages/usuarios";
import Cobranzas from "./pages/cobranzas";
import Envios from "./pages/envios";
import Siniestros from "./pages/siniestros";
import SiniestroDetail from "./pages/siniestro-detail";
import Tareas from "./pages/tareas";
import Importar from "./pages/importar";

function SeedOnMount() {
  useEffect(() => {
    fetch("/api/seed", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}

function ProtectedRoutes() {
  const { user, loading } = useAuth();

  if (loading) return (
    <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!user) return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route>
        <Redirect to="/login" />
      </Route>
    </Switch>
  );

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/polizas" component={Polizas} />
      <Route path="/polizas/:id" component={PolizaDetail} />
      <Route path="/companias" component={Companias} />
      <Route path="/asegurados" component={Asegurados} />
      <Route path="/usuarios" component={Usuarios} />
      <Route path="/cobranzas" component={Cobranzas} />
      <Route path="/envios" component={Envios} />
      <Route path="/siniestros" component={Siniestros} />
      <Route path="/siniestros/:id" component={SiniestroDetail} />
      <Route path="/tareas" component={Tareas} />
      <Route path="/importar" component={Importar} />
      <Route path="/login">
        <Redirect to="/" />
      </Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <Provider>
      <AuthProvider>
        <SeedOnMount />
        <ProtectedRoutes />
        <Toaster theme="dark" position="bottom-right" />
        {import.meta.env.DEV && <AgentFeedback />}
        {<RunableBadge />}
      </AuthProvider>
    </Provider>
  );
}

export default App;
