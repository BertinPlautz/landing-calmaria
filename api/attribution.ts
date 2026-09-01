/**
 * Simbas Pet — Attribution API (Gate 9.1D)
 * =========================================
 * Vercel Serverless Function — recebe eventos do tracker,
 * valida, deduplica, e armazena no Vercel KV.
 *
 * Endpoint: POST /api/attribution
 * Body:     { session: {...}, events: [...], sent_at: "..." }
 *
 * IDEMPOTÊNCIA:
 *   Cada evento tem um idempotency_key único
 *   (event_type + event_time + session_id).
 *   Eventos duplicados são ignorados.
 *
 * SEGURANÇA:
 *   - KV_REST_API_URL e KV_REST_API_TOKEN são server-side (nunca expostos)
 *   - CORS restrito a simbaspet.com.br
 *   - Rate limit: Vercel function timeout (10s)
 *
 * NÃO MODIFICA:
 *   - Meta Pixel
 *   - Kirvano redirects
 *   - Quiz behavior
 *
 * @version 1.0.0
 * @date    2026-09-01
 * @gate    9.1D
 */

import { kv } from '@vercel/kv';

// ── Config ──
const PENDING_KEY = 'queue:pending';
const EVENT_PREFIX = 'event:';
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dias
const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB
const ALLOWED_ORIGIN = 'https://simbaspet.com.br';

// ── Types ──
interface AttributionEvent {
  event_type: 'pageview' | 'cta_click' | 'initiate_checkout' | 'lead' | 'checkout' | 'purchase';
  event_source: 'browser' | 'pixel_meta' | 'manual';
  timestamp: string;
  url?: string;
  attribution_confidence: 'OBSERVED' | 'ATTRIBUTED' | 'ESTIMATED' | 'HYPOTHESIS' | 'UNKNOWN';
  confidence_reason?: string;
  cta_text?: string;
  cta_href?: string;
  [key: string]: unknown;
}

interface SessionData {
  session_id: string;
  timestamp: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
  gclid?: string | null;
  referrer?: string | null;
  landing_page?: string;
  url?: string;
  attribution_confidence: string;
  confidence_reason?: string;
}

interface Payload {
  session: SessionData;
  events: AttributionEvent[];
  sent_at: string;
}

interface IngestResult {
  session: string;
  events: Array<{
    event_type: string;
    status: 'ingested' | 'skipped' | 'error';
    reason?: string;
  }>;
  errors: Array<{
    event_type?: string;
    error: string;
  }>;
}

// ── CORS Headers ──
function corsHeaders(origin: string): Record<string, string> {
  const allowed = origin === ALLOWED_ORIGIN || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Validate Payload ──
function validatePayload(body: unknown): { valid: true; payload: Payload } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Body deve ser JSON object' };
  }

  const p = body as Record<string, unknown>;

  if (!p.session || typeof p.session !== 'object') {
    return { valid: false, error: 'session é obrigatório' };
  }

  const session = p.session as Record<string, unknown>;
  if (!session.session_id || typeof session.session_id !== 'string') {
    return { valid: false, error: 'session.session_id é obrigatório' };
  }

  if (!Array.isArray(p.events)) {
    return { valid: false, error: 'events deve ser array' };
  }

  if (p.events.length === 0) {
    return { valid: false, error: 'events não pode estar vazio' };
  }

  // Validar cada evento
  for (let i = 0; i < p.events.length; i++) {
    const evt = p.events[i] as Record<string, unknown>;
    if (!evt.event_type || typeof evt.event_type !== 'string') {
      return { valid: false, error: `events[${i}].event_type é obrigatório` };
    }
    if (!evt.timestamp || typeof evt.timestamp !== 'string') {
      return { valid: false, error: `events[${i}].timestamp é obrigatório` };
    }
  }

  return {
    valid: true,
    payload: body as Payload,
  };
}

// ── Build idempotency key ──
function buildIdempotencyKey(evt: AttributionEvent, sessionId: string): string {
  const eventType = evt.event_type;
  const eventTime = evt.timestamp;
  return `${eventType}_${eventTime}_${sessionId || 'nosession'}`;
}

// ── Main Handler ──
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin') || '';

  try {
    // ── 1. Size check ──
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Payload muito grande (max 64KB)' }),
        { status: 413, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Parse & Validate ──
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'JSON inválido' }),
        { status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } }
      );
    }

    const validation = validatePayload(body);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({ error: validation.error }),
        { status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } }
      );
    }

    const payload = validation.payload;
    const sid = payload.session.session_id;
    const result: IngestResult = { session: 'new', events: [], errors: [] };

    // ── 3. Store session in KV (upsert) ──
    const sessionKey = `session:${sid}`;
    await kv.set(sessionKey, JSON.stringify(payload.session), { ex: EVENT_TTL_SECONDS });

    // ── 4. Process each event ──
    for (const evt of payload.events) {
      try {
        const idemKey = buildIdempotencyKey(evt, sid);

        // Check if already exists (idempotency)
        const exists = await kv.get(`${EVENT_PREFIX}${idemKey}`);
        if (exists) {
          result.events.push({
            event_type: evt.event_type,
            status: 'skipped',
            reason: 'duplicate',
          });
          continue;
        }

        // Store event in KV (with TTL)
        await kv.set(`${EVENT_PREFIX}${idemKey}`, JSON.stringify({
          session_id: sid,
          event_type: evt.event_type,
          event_source: evt.event_source || 'browser',
          timestamp: evt.timestamp,
          url: evt.url || null,
          attribution_confidence: evt.attribution_confidence || 'UNKNOWN',
          confidence_reason: evt.confidence_reason || '',
          raw_payload: evt,
        }), { ex: EVENT_TTL_SECONDS });

        // Add to pending queue (for VPS sync)
        await kv.rpush(PENDING_KEY, idemKey);

        // Set TTL on the queue key too (renewed each push)
        await kv.expire(PENDING_KEY, EVENT_TTL_SECONDS);

        result.events.push({
          event_type: evt.event_type,
          status: 'ingested',
        });
      } catch (e) {
        result.errors.push({
          event_type: evt.event_type,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // ── 5. Return ──
    const ingested = result.events.filter(e => e.status === 'ingested').length;
    const skipped = result.events.filter(e => e.status === 'skipped').length;

    return new Response(
      JSON.stringify({
        status: 'ok',
        ingested,
        skipped,
        errors: result.errors.length,
        events: result.events,
      }),
      {
        status: 200,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    console.error('[AttributionAPI] Error:', e);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } }
    );
  }
}

// ── OPTIONS (CORS preflight) ──
export async function OPTIONS(request: Request): Promise<Response> {
  const origin = request.headers.get('origin') || '';
  return new Response(null, {
    status: 200,
    headers: corsHeaders(origin),
  });
}