/**
 * Simbas Pet — Captura do Teste da Chave (Volto Já)
 * ==================================================
 * POST /api/lead
 *   tipo "resultado" → grava o resultado ANÔNIMO do teste (Radar Coletivo)
 *   tipo "contato"   → grava WhatsApp/e-mail de quem pediu o Plano dos 3 primeiros dias
 *
 * GET /api/lead?token=LEADS_TOKEN&tipo=contatos|resultados|radar[&formato=csv]
 *   Exporta a lista (para o Hermes, para a Abertura do D6) ou o resumo do Radar.
 *
 * Armazenamento: Vercel KV (KV_REST_API_URL / KV_REST_API_TOKEN), o mesmo do /api/attribution.
 * Opcional: N8N_LEAD_WEBHOOK → cada registro também é repassado ao n8n (Hermes).
 *
 * @version 1.0.0
 * @date    2026-10-04
 */

import { kv } from '@vercel/kv';

declare const process: { env: Record<string, string | undefined> };

const LEADS_TOKEN = process.env.LEADS_TOKEN || '';
const N8N_WEBHOOK = process.env.N8N_LEAD_WEBHOOK || '';
const ORIGENS = ['https://simbaspet.com.br', 'https://www.simbaspet.com.br'];
const MAX_BODY = 8 * 1024;
const RODADAS = ['chave', 'tenis', 'bolsa'];

type Obj = Record<string, unknown>;

function cors(origin: string): Record<string, string> {
  const ok = ORIGENS.includes(origin) || origin.endsWith('.vercel.app') || origin.startsWith('http://localhost');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ORIGENS[1],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

function txt(v: unknown, max = 80): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function notasValidas(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const n = v.map((x) => Number(x));
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 3) ? n : null;
}

/** Em qual sinal o pânico começa: primeira rodada com nota 2 ou 3. */
function inicioPanico(notas: number[]): string {
  const i = notas.findIndex((x) => x >= 2);
  return i === -1 ? 'nenhum' : RODADAS[i];
}

function normalizarContato(canal: string, valor: string): string | null {
  if (canal === 'email') {
    const e = valor.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) && e.length <= 120 ? e : null;
  }
  let d = valor.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

function utms(v: unknown): Obj {
  const u = (v && typeof v === 'object' ? v : {}) as Obj;
  const out: Obj = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((k) => {
    const s = txt(u[k], 60);
    if (s) out[k] = s;
  });
  return out;
}

async function repassarN8n(registro: Obj): Promise<void> {
  if (!N8N_WEBHOOK) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registro),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    console.warn('[Lead] n8n indisponível:', e instanceof Error ? e.message : String(e));
  }
}

function parse(v: unknown): Obj | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Obj; } catch { return null; }
  }
  return v as Obj;
}

async function lerTodos(indice: string, prefixo: string): Promise<Obj[]> {
  const ids = (await kv.smembers(indice)) as string[];
  const out: Obj[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    if (!lote.length) continue;
    const vals = await kv.mget(...lote.map((id) => prefixo + id));
    vals.forEach((v) => { const o = parse(v); if (o) out.push(o); });
  }
  return out;
}

function csv(linhas: Obj[], colunas: string[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join('-') : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [colunas.join(','), ...linhas.map((l) => colunas.map((c) => esc(l[c])).join(','))].join('\n');
}

// ── POST: grava resultado ou contato ──
export async function POST(request: Request): Promise<Response> {
  const h = cors(request.headers.get('origin') || '');
  try {
    if (parseInt(request.headers.get('content-length') || '0', 10) > MAX_BODY) {
      return json({ error: 'Payload grande demais' }, 413, h);
    }
    let b: Obj;
    try { b = (await request.json()) as Obj; } catch { return json({ error: 'JSON inválido' }, 400, h); }

    // Honeypot: robôs preenchem o campo escondido "site".
    if (txt(b.site)) return json({ status: 'ok' }, 200, h);

    const sid = txt(b.sid, 40).replace(/[^a-zA-Z0-9_-]/g, '');
    const notas = notasValidas(b.notas);
    if (!sid || !notas) return json({ error: 'sid e notas (3 valores de 0 a 3) são obrigatórios' }, 400, h);

    const agora = new Date().toISOString();
    const base: Obj = {
      sid,
      nome_cao: txt(b.nome_cao, 24),
      notas,
      inicio_panico: inicioPanico(notas),
      nota_max: Math.max(...notas),
      alerta_vet: b.q1 === 'sim' || b.q2 === 'sim',
      perfil: txt(b.perfil, 20),
      ...utms(b.utm),
    };

    if (b.tipo === 'resultado') {
      const registro = { tipo: 'resultado', ...base, em: agora };
      await kv.set('teste:' + sid, registro);
      await kv.sadd('teste:index', sid);
      await repassarN8n(registro);
      return json({ status: 'ok' }, 200, h);
    }

    if (b.tipo === 'contato') {
      const canal = b.canal === 'email' ? 'email' : 'whatsapp';
      const contato = normalizarContato(canal, txt(b.contato, 120));
      if (!contato) {
        return json({ error: canal === 'email' ? 'E-mail inválido' : 'WhatsApp inválido' }, 422, h);
      }
      const anterior = parse(await kv.get('lead:' + contato));
      const registro = {
        tipo: 'contato',
        canal,
        contato,
        ...base,
        criado_em: (anterior && anterior.criado_em) || agora,
        atualizado_em: agora,
        consentimento: 'Plano dos 3 primeiros dias + mensagens do Simbas Pet sobre o treino',
      };
      await kv.set('lead:' + contato, registro);
      await kv.sadd('leads:index', contato);
      await repassarN8n(registro);
      return json({ status: 'ok' }, 200, h);
    }

    return json({ error: 'tipo deve ser "resultado" ou "contato"' }, 400, h);
  } catch (e) {
    console.error('[Lead] Erro:', e instanceof Error ? e.message : String(e));
    return json({ error: 'Erro interno' }, 500, h);
  }
}

// ── GET: exportação protegida por token ──
export async function GET(request: Request): Promise<Response> {
  const h = cors(request.headers.get('origin') || '');
  const url = new URL(request.url);
  if (!LEADS_TOKEN || url.searchParams.get('token') !== LEADS_TOKEN) {
    return json({ error: 'Unauthorized' }, 401, h);
  }
  try {
    const tipo = url.searchParams.get('tipo') || 'radar';
    const formato = url.searchParams.get('formato') || 'json';

    if (tipo === 'contatos') {
      const lista = (await lerTodos('leads:index', 'lead:'))
        .sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)));
      if (formato === 'csv') {
        const cols = ['criado_em', 'canal', 'contato', 'nome_cao', 'notas', 'inicio_panico', 'alerta_vet', 'utm_source', 'utm_medium', 'utm_campaign'];
        return new Response(csv(lista, cols), { status: 200, headers: { ...h, 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      return json({ total: lista.length, contatos: lista }, 200, h);
    }

    const testes = await lerTodos('teste:index', 'teste:');

    if (tipo === 'resultados') {
      if (formato === 'csv') {
        const cols = ['em', 'nome_cao', 'notas', 'inicio_panico', 'nota_max', 'alerta_vet', 'utm_source', 'utm_medium', 'utm_campaign'];
        return new Response(csv(testes, cols), { status: 200, headers: { ...h, 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      return json({ total: testes.length, resultados: testes }, 200, h);
    }

    // Radar Coletivo: números reais para os Reels
    const total = testes.length;
    const conta = (f: (t: Obj) => boolean) => testes.filter(f).length;
    const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
    const porInicio: Obj = {};
    ['chave', 'tenis', 'bolsa', 'nenhum'].forEach((k) => {
      const n = conta((t) => t.inicio_panico === k);
      porInicio[k] = { n, pct: pct(n) };
    });
    const media = (i: number) =>
      total ? Math.round((testes.reduce((s, t) => s + Number((t.notas as number[])[i] || 0), 0) / total) * 100) / 100 : 0;
    const contatos = ((await kv.scard('leads:index')) as number) || 0;
    return json({
      total_testes: total,
      contatos,
      contato_por_teste_pct: pct(contatos),
      inicio_do_panico: porInicio,
      nota_media: { chave: media(0), tenis: media(1), bolsa: media(2) },
      com_nota_3_em_alguma_rodada_pct: pct(conta((t) => Number(t.nota_max) === 3)),
      alerta_veterinario_pct: pct(conta((t) => t.alerta_vet === true)),
      gerado_em: new Date().toISOString(),
    }, 200, h);
  } catch (e) {
    console.error('[Lead] Erro no GET:', e instanceof Error ? e.message : String(e));
    return json({ error: 'Erro interno' }, 500, h);
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, { status: 200, headers: cors(request.headers.get('origin') || '') });
}
