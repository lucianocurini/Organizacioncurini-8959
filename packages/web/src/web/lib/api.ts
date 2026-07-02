const getSession = () => localStorage.getItem("session_id") || "";

async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-session-id": getSession(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Error de red" }));
    const error: any = new Error(err.error || "Error desconocido");
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export const api = {
  get: (path: string) => apiFetch(path),
  post: (path: string, body: any) => apiFetch(path, { method: "POST", body: JSON.stringify(body) }),
  put: (path: string, body: any) => apiFetch(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: (path: string, body: any) => apiFetch(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string) => apiFetch(path, { method: "DELETE" }),
};
