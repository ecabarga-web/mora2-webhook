// api/webhook.js
// Vercel Serverless Function
// Recibe pedidos de GHL y los sincroniza con Supabase

const SUPA_URL     = process.env.SUPA_URL;
const SUPA_SERVICE = process.env.SUPA_SERVICE_KEY;

// ─── Helper: fetch a Supabase ─────────────────────────────
async function supa(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        SUPA_SERVICE,
      'Authorization': `Bearer ${SUPA_SERVICE}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
      ...(opts.headers || {})
    },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Descuenta stock en tabla items ──────────────────────
async function descontarStock(sku, qty) {
  // Buscar item por SKU base (sin talla, para agrupar)
  // SKU GHL puede venir como "MR2-RD-BLC-M-D001" o solo nombre
  const items = await supa(`items?sku=eq.${encodeURIComponent(sku)}&select=id,sku,quantity`);
  
  if (!items || items.length === 0) {
    console.warn(`SKU no encontrado: ${sku}`);
    return false;
  }

  const item = items[0];
  const newQty = Math.max(0, (item.quantity || 0) - qty);

  await supa(`items?id=eq.${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity: newQty })
  });

  // Registrar movimiento en inventory_movements si existe
  try {
    await supa('inventory_movements', {
      method: 'POST',
      body: JSON.stringify({
        item_id:   item.id,
        sku:       sku,
        type:      'sale_online',
        qty_change: -qty,
        notes:     'Venta tienda online GHL'
      })
    });
  } catch (e) {
    console.warn('No se pudo registrar movimiento:', e.message);
  }

  return true;
}

// ─── Handler principal ────────────────────────────────────
export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Seguridad: verificar secret token
  const secret = req.headers['x-mora2-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.error('Webhook secret inválido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = req.body;
    console.log('Webhook recibido:', JSON.stringify(payload, null, 2));

    // ── Extraer datos del pedido de GHL ──────────────────
    // GHL manda los datos en diferentes estructuras según la versión
    // Intentamos varias rutas comunes
    const order = payload.order || payload.data || payload;
    
    const orderId       = order.id || order.orderId || order.order_id;
    const customerName  = order.contactName || order.contact_name || 
                          `${order.firstName || ''} ${order.lastName || ''}`.trim();
    const customerEmail = order.email || order.contactEmail;
    const customerPhone = order.phone || order.contactPhone || '';
    const address       = order.address1 || order.shippingAddress?.address1 || '';
    const city          = order.city || order.shippingAddress?.city || '';
    const total         = parseFloat(order.amount || order.total || 0);
    const paymentMethod = order.paymentMethod || order.payment_method || 'ghl';
    const items         = order.items || order.lineItems || order.line_items || [];
    const status        = order.status || 'pending';

    // ── Construir cart para store_orders ─────────────────
    const cart = items.map(item => ({
      sku:       item.sku || item.product?.sku || '',
      name:      item.name || item.product?.name || '',
      qty:       parseInt(item.qty || item.quantity || 1),
      salePrice: parseFloat(item.price || item.unitPrice || 0),
      variant:   item.variant || `${item.options?.Corte || ''} / ${item.options?.Color || ''} / ${item.options?.Talla || ''}`
    }));

    // ── Crear registro en store_orders ───────────────────
    const orderPayload = {
      customer_name:    customerName,
      customer_phone:   customerPhone,
      customer_address: address,
      customer_city:    city,
      cart:             cart,
      subtotal:         total,
      delivery_fee:     0,
      total:            total,
      payment_method:   paymentMethod,
      payment_ref:      String(orderId),
      status:           mapStatus(status),
      notes:            `Pedido GHL #${orderId} | Email: ${customerEmail}`,
      whatsapp_sent:    false
    };

    const [newOrder] = await supa('store_orders', {
      method: 'POST',
      body:   JSON.stringify(orderPayload)
    });

    console.log(`✅ Pedido creado en Supabase: #${newOrder.id}`);

    // ── Descontar stock por cada item ────────────────────
    const stockResults = [];
    for (const item of cart) {
      if (item.sku) {
        const ok = await descontarStock(item.sku, item.qty);
        stockResults.push({ sku: item.sku, qty: item.qty, ok });
        console.log(`📦 Stock: ${item.sku} -${item.qty} → ${ok ? '✅' : '⚠️ no encontrado'}`);
      }
    }

    return res.status(200).json({
      success: true,
      supabase_order_id: newOrder.id,
      stock_updates: stockResults
    });

  } catch (err) {
    console.error('Error procesando webhook:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Mapear status de GHL a mora2 ────────────────────────
function mapStatus(ghlStatus) {
  const map = {
    'pending':    'pendiente_pago',
    'paid':       'pago_recibido',
    'processing': 'en_produccion',
    'shipped':    'enviado',
    'delivered':  'entregado',
    'cancelled':  'cancelado',
    'refunded':   'cancelado',
  };
  return map[ghlStatus?.toLowerCase()] || 'pendiente_pago';
}
