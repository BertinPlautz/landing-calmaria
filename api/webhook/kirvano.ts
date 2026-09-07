/**
 * Simbas Pet — Kirvano Webhook Receiver (Gate 9.1F-C)
 * =====================================================
 * Recebe POST da Kirvano com eventos de venda.
 * Apenas SALE_APPROVED + status=APPROVED registra Purchase.
 *
 * AUTENTICAÇÃO:
 *   Token via query string: ?token=KIRVANO_WEBHOOK_SECRET
 *   (mecanismo padrão de webhook — a Kirvano configura o token no campo "Token" da UI
 *    e o envia como parte da URL. Ajustar se a Kirvano usar header diferente.)
 *
 * MAPPING DETERMINÍSTICO:
 *   payload.utm.src = session_id (enviado via query string do checkout)
 *   A sessão é validada no KV antes de marcar a venda como ATTRIBUTED.
 *
 * IDEMPOTÊNCIA:
 *   sale_id como chave única: event:purchase:{sale_id}
 *
 * @version 1.1.0
 * @date    2026-09-07
 * @gate    9.1F-C
 */

import { kv } from '@vercel/kv';

// Vercel disponibiliza process.env em runtime.
declare const process: {
  env: Record<string, string | undefined>;
};

// ── Config ──
const EVENT_PREFIX = 'event:';
const PENDING_KEY = 'queue:pending';
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias (vendas são importantes)
const WEBHOOK_SECRET = process.env.KIRVANO_WEBHOOK_SECRET || '';

// ── Helpers ──

function parseBRL(value: string): number {
  const cleaned = value.replace(/[^0-9,]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

function formatTimestamp(dateStr: string): string {
  // "2023-12-18 16:40:06" → ISO 8601
  return dateStr.replace(' ', 'T') + '.000Z';
}

// ── CORS ──
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Validate ──
interface KirvanoWebhook {
  event: string;
  event_description?: string;
  checkout_id: string;
  sale_id: string;
  payment_method?: string;
  total_price?: string;
  type?: string;
  status: string;
  created_at: string;
  customer?: {
    name?: string;
    document?: string;
    email?: string;
    phone_number?: string;
  };
  payment?: {
    method?: string;
    brand?: string;
    installments?: number;
    finished_at?: string;
  };
  products?: Array<{
    id?: string;
    name?: string;
    offer_id?: string;
    offer_name?: string;
    price?: string;
    is_order_bump?: boolean;
  }>;
  utm?: {
    src?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
  };
}

// ── Main Handler ──
export async function POST(request: Request): Promise<Response> {
  const headers = corsHeaders();

  try {
    // ── 1. Autenticação ──
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';

    if (!WEBHOOK_SECRET) {
      console.error('[KirvanoWebhook] KIRVANO_WEBHOOK_SECRET não configurado');
      return new Response(
        JSON.stringify({ error: 'Server misconfigured' }),
        { status: 500, headers }
      );
    }

    if (token !== WEBHOOK_SECRET) {
      console.warn(
        '[KirvanoWebhook] Token inválido:',
        token.substring(0, 8) + '...'
      );

      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers }
      );
    }

    // ── 2. Parse ──
    let payload: KirvanoWebhook;

    try {
      payload = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers }
      );
    }

    // ── 3. Validar campos obrigatórios ──
    if (!payload.event || !payload.sale_id || !payload.status) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields: event, sale_id, status',
        }),
        { status: 400, headers }
      );
    }

    // ── 4. Só processa SALE_APPROVED ──
    if (
      payload.event !== 'SALE_APPROVED' ||
      payload.status !== 'APPROVED'
    ) {
      return new Response(
        JSON.stringify({
          status: 'ignored',
          reason: `Event '${payload.event}' with status '${payload.status}' is not a confirmed purchase`,
        }),
        { status: 200, headers }
      );
    }

    // ── 5. Idempotência ──
    const idemKey = `purchase_${payload.sale_id}`;

    try {
      const exists = await kv.get(`${EVENT_PREFIX}${idemKey}`);

      if (exists) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            detail: 'duplicate',
            sale_id: payload.sale_id,
          }),
          { status: 200, headers }
        );
      }
    } catch (e) {
      console.error(
        '[KirvanoWebhook] KV error checking idempotency:',
        e
      );

      // Continue — better to risk duplicate than lose a sale
    }

    // ── 6. Extrair session_id via utm.src ──
    const sessionId = payload.utm?.src || null;

    // ── 6.1 Validar sessão e recuperar origem ──
    let storedSession: Record<string, unknown> | null = null;

    if (sessionId) {
      try {
        const rawSession = await kv.get<string>(
          `session:${sessionId}`
        );

        if (rawSession) {
          storedSession = JSON.parse(rawSession) as Record<
            string,
            unknown
          >;
        }
      } catch (e) {
        console.warn(
          '[KirvanoWebhook] Erro ao recuperar sessão:',
          e
        );
      }
    }

    // Só consideramos a venda realmente atribuída
    // quando a sessão original foi encontrada no KV.
    const confidence = storedSession
      ? 'ATTRIBUTED'
      : 'UNKNOWN';

    const confidenceReason = storedSession
      ? 'Sessão validada no KV via utm.src — origem recuperada da sessão original'
      : sessionId
        ? 'utm.src presente, mas sessão não encontrada no KV — atribuição não validada'
        : 'utm.src ausente no payload do webhook — comprador pode ter chegado sem parâmetros de rastreamento';

    // ── 6.2 Recuperar dados de atribuição ──
    const attributionSource =
      storedSession?.utm_source || null;

    const attributionMedium =
      storedSession?.utm_medium || null;

    const attributionCampaign =
      storedSession?.utm_campaign || null;

    const attributionContent =
      storedSession?.utm_content || null;

    const attributionReferrer =
      storedSession?.referrer || null;

    // ── 7. Construir evento ──
    const primaryProduct = payload.products?.[0];

    const value = payload.total_price
      ? parseBRL(payload.total_price)
      : null;

    const eventTime = formatTimestamp(payload.created_at);

    const eventData = {
      session_id: sessionId,
      event_type: 'purchase',

      // Dados de origem da sessão
      attribution_source: attributionSource,
      attribution_medium: attributionMedium,
      attribution_campaign: attributionCampaign,
      attribution_content: attributionContent,
      attribution_referrer: attributionReferrer,

      event_source: 'kirvano_webhook',
      event_time: eventTime,
      value: value,
      currency: 'BRL',

      product_id: primaryProduct?.id || null,
      product_name: primaryProduct?.name || null,

      url: `https://pay.kirvano.com/checkout/${payload.checkout_id}`,

      attribution_confidence: confidence,
      confidence_reason: confidenceReason,

      idempotency_key: idemKey,
      sale_id: payload.sale_id,
      checkout_id: payload.checkout_id,

      raw_payload: JSON.stringify(payload),

      ingested_at: new Date().toISOString(),
    };

    // ── 8. Armazenar no KV ──
    await kv.set(
      `${EVENT_PREFIX}${idemKey}`,
      JSON.stringify(eventData),
      {
        ex: EVENT_TTL_SECONDS,
      }
    );

    // ── 9. Adicionar à fila do kv_sync ──
    await kv.rpush(PENDING_KEY, idemKey);

    await kv.expire(
      PENDING_KEY,
      EVENT_TTL_SECONDS
    );

    // ── 10. Log ──
    console.log(
      `[KirvanoWebhook] ✅ Purchase ingested: sale_id=${payload.sale_id} sid=${sessionId?.substring(0, 12) || 'none'} value=${value} confidence=${confidence} source=${attributionSource || 'none'}`
    );

    // ── 11. Response ──
    return new Response(
      JSON.stringify({
        status: 'ok',
        ingested: true,
        sale_id: payload.sale_id,
        session_id:
          sessionId?.substring(0, 12) + '...' || null,
        confidence,
        value,
        currency: 'BRL',
      }),
      {
        status: 200,
        headers,
      }
    );

  } catch (e) {
    console.error(
      '[KirvanoWebhook] Unhandled error:',
      e instanceof Error
        ? e.message
        : String(e)
    );

    return new Response(
      JSON.stringify({
        error: 'Internal server error',
      }),
      {
        status: 500,
        headers,
      }
    );
  }
}

// ── OPTIONS (CORS preflight) ──
export async function OPTIONS(
  _request: Request
): Promise<Response> {
  return new Response(
    null,
    {
      status: 200,
      headers: corsHeaders(),
    }
  );
}
