// api/webhook.js
const SUPA_URL     = process.env.SUPA_URL;
const SUPA_SERVICE = process.env.SUPA_SERVICE_KEY;

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

async function descontarStock(sku, qty) {
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
  try {
    await supa('inventory_movements', {
      method: 'POST',
      body: JSON.stringify({
        item_id:    item.id,
        sku:        sku,
        type:       'sale_online',
        qty_change: -qty,
        notes:      'Venta tienda online GHL'
      })
    });
  } catch (e) {
    console.warn('No se pudo registrar movimiento:', e.message);
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-mora2-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.error('Webhook secret inválido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const p = req.body;
    console.log('Webhook recibido:', JSON.stringify(p, null, 2));

    // ── Extraer datos usando la estructura real del payload de GHL ──
    const order = p.order || {};
    const customer = order.customer || {};

    // ID de la orden — viene en line_items[0].meta.order_id
    const orderId = order.line_items?.[0]?.meta?.order_id
                 || order.id
                 || p.contact_id
                 || 'sin-id';

    // Datos del cliente — vienen en order.customer y también en raíz del payload
    const customerName  = customer.name  || p.full_name  || `${p.first_name || ''} ${p.last_name || ''}`.trim();
    const customerEmail = customer.email || p.email || '';
    const customerPhone = customer.phone || p.phone || '';
    const address       = customer.full_address || p.full_address || p.address1 || '';
    const city          = customer.city || p.city || '';

    // Totales
    const total = parseFloat(order.total_price || order.total_cart_price || 0);

    // Método de pago
    const paymentMethod = order.payment_gateway || 'manual';

    // Line items
    const lineItems = order.line_items || [];
    const cart = lineItems.map(item => ({
      sku:       item.sku || item.id || '',
      name:      item.title || item.name || '',
      qty:       parseInt(item.quantity || 1),
      salePrice: parseFloat(item.price || 0),
      variant:   item.title || ''   // GHL incluye variante en el title: "Soft Angel - Blanco / L / Fit"
    }));

    // ── Insertar en store_orders ──────────────────────────
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
      payment_ref:      orderId,
      status:           'pendiente_pago',
      notes:            `Pedido GHL #${orderId} | Email: ${customerEmail} | Fecha: ${order.created_on || ''}`,
      whatsapp_sent:    false
    };

    const [newOrder] = await supa('store_orders', {
      method: 'POST',
      body:   JSON.stringify(orderPayload)
    });

    console.log(`✅ Pedido creado en Supabase: #${newOrder.id}`);

    // ── Descontar stock ───────────────────────────────────
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
    console.error('Error procesando webhook:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
