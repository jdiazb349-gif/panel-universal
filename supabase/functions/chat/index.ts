// Panel Universal · función "chat": puente seguro entre el navegador y el modelo de NVIDIA.
// - La clave NVIDIA_API_KEY vive solo aquí (secreto de Supabase), nunca en el navegador.
// - Exige una sesión válida de un usuario activo y aplica límites de uso por usuario.
// - Desplegar con "Verify JWT" DESACTIVADO: la verificación se hace dentro (admin.auth.getUser).
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const ALLOWED_ORIGINS = ["https://panel-universal.vercel.app", "http://localhost:8080"];
const MAX_BODY = 200_000;      // bytes de texto por solicitud
const LIMIT_10MIN = 20;        // solicitudes por usuario en 10 minutos
const LIMIT_DAY = 300;         // solicitudes por usuario en 24 horas

function corsHeaders(origin: string | null) {
  const ok = !!origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });

// Deja pasar solo los campos y roles esperados de un chat con herramientas.
function sanitizeMessages(input: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 60) return null;
  const out: Record<string, unknown>[] = [];
  for (const m of input) {
    if (!m || typeof m !== "object") return null;
    const { role, content, tool_calls, tool_call_id } = m as Record<string, unknown>;
    if (!["system", "user", "assistant", "tool"].includes(role as string)) return null;
    const msg: Record<string, unknown> = { role };
    if (typeof content === "string") msg.content = content.slice(0, 40_000);
    else if (content === null && role === "assistant") msg.content = "";
    else return null;
    if (role === "assistant" && Array.isArray(tool_calls) && tool_calls.length) {
      msg.tool_calls = tool_calls.slice(0, 8).map((t: any) => ({
        id: String(t?.id ?? ""), type: "function",
        function: { name: String(t?.function?.name ?? ""), arguments: String(t?.function?.arguments ?? "{}") },
      }));
    }
    if (role === "tool") {
      if (typeof tool_call_id !== "string") return null;
      msg.tool_call_id = tool_call_id;
    }
    out.push(msg);
  }
  return out;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origen no permitido" }, 403, origin);

  // 1) Autenticación: sesión válida de un usuario activo
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "No autenticado" }, 401, origin);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "Sesión inválida" }, 401, origin);
  const uid = u.user.id;
  const { data: prof } = await admin.from("profiles").select("status").eq("id", uid).single();
  if (!prof || prof.status !== "active") return json({ error: "Cuenta no activa" }, 403, origin);

  const apiKey = Deno.env.get("NVIDIA_API_KEY");
  if (!apiKey) return json({ error: "El asistente aún no está configurado.", code: "not_configured" }, 503, origin);

  // 2) Cuota por usuario
  const now = Date.now();
  const since = (ms: number) => new Date(now - ms).toISOString();
  const count = (ms: number) => admin.from("ai_usage").select("id", { count: "exact", head: true })
    .eq("user_id", uid).gte("created_at", since(ms));
  const [c10, c24] = await Promise.all([count(10 * 60_000), count(24 * 3_600_000)]);
  if ((c10.count ?? 0) >= LIMIT_10MIN || (c24.count ?? 0) >= LIMIT_DAY) {
    return json({ error: "Alcanzaste el límite de preguntas. Espera unos minutos e inténtalo de nuevo.", code: "rate_limited" }, 429, origin);
  }

  // 3) Validación del cuerpo
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "La solicitud es demasiado grande" }, 413, origin);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "JSON inválido" }, 400, origin); }
  const messages = sanitizeMessages(body?.messages);
  if (!messages) return json({ error: "Mensajes inválidos" }, 400, origin);
  const tools = Array.isArray(body?.tools) ? body.tools.slice(0, 12) : undefined;

  await admin.from("ai_usage").insert({ user_id: uid });

  // 4) Llamada al modelo (el modelo y los límites los fija el servidor, no el cliente)
  const payload: Record<string, unknown> = {
    model: MODEL, messages, temperature: 0.2, top_p: 0.95, max_tokens: 2048, stream: false,
  };
  if (tools?.length) { payload.tools = tools; payload.tool_choice = "auto"; }
  const call = (extra: Record<string, unknown>) => fetch(NVIDIA_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ ...payload, ...extra }),
    signal: AbortSignal.timeout(90_000),
  });
  try {
    let r = await call({ chat_template_kwargs: { enable_thinking: false } });
    if (r.status === 400 || r.status === 422) r = await call({});   // por si el modelo no admite esa opción
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("NVIDIA error", r.status, detail);
      return json({ error: "El modelo no pudo responder en este momento.", status: r.status, detail }, 502, origin);
    }
    const data = await r.json();
    const m = data?.choices?.[0]?.message ?? {};
    const content = String(m.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return json({ message: { role: "assistant", content, tool_calls: m.tool_calls ?? undefined }, usage: data?.usage }, 200, origin);
  } catch (e) {
    console.error("chat error", e);
    return json({ error: "No se pudo contactar al modelo." }, 504, origin);
  }
});
