const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const app = express();

const envPaths = [
    path.join(__dirname, '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : ''
].filter(Boolean);
const envPath = envPaths.find(filePath => fs.existsSync(filePath));
if (envPath) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
        const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 إعدادات الاتصال بسحاب Supabase 
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; 

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase settings are missing. Please set SUPABASE_URL and SUPABASE_ANON_KEY.');
}

const customFetch = (url, options = {}) => {
    const timeout = 3000; // 3 seconds
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal })
        .then(res => {
            clearTimeout(id);
            return res;
        })
        .catch(err => {
            clearTimeout(id);
            throw err;
        });
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
        transport: WebSocket
    },
    global: {
        fetch: customFetch
    }
});

function toNumber(value) {
    return Number(value) || 0;
}

async function getCustomerAccount(clientName) {
    const name = (clientName || '').trim();
    if (!name) return { previousDebt: 0, totalInvoices: 0, totalPayments: 0, balance: 0, operations: [] };

    const { data: invoices } = await supabase
        .from('invoices')
        .select('id, invoice_number, client_name, final_amount, payment_type, notes, created_at')
        .ilike('client_name', name)
        .order('created_at', { ascending: true });

    const { data: payments } = await supabase
        .from('debt_payments')
        .select('id, client_name, amount_paid, notes, payment_date')
        .ilike('client_name', name)
        .order('payment_date', { ascending: true });

    const invoiceRows = invoices || [];
    const paymentRows = payments || [];
    const debtInvoices = invoiceRows.filter(inv => inv.payment_type !== 'cash');
    const totalInvoices = debtInvoices.reduce((sum, inv) => sum + toNumber(inv.final_amount), 0);
    const totalPayments = paymentRows.reduce((sum, pay) => sum + toNumber(pay.amount_paid), 0);
    const balance = Math.max(0, totalInvoices - totalPayments);
    const operations = [
        ...invoiceRows.map(inv => ({
            id: inv.id,
            rawType: 'invoice',
            type: inv.payment_type === 'cash' ? 'فاتورة نقدية' : 'فاتورة دين',
            number: inv.invoice_number,
            debit: inv.payment_type === 'cash' ? 0 : toNumber(inv.final_amount),
            credit: inv.payment_type === 'cash' ? toNumber(inv.final_amount) : 0,
            notes: inv.notes || '',
            date: inv.created_at
        })),
        ...paymentRows.map(pay => ({
            id: pay.id,
            rawType: 'payment',
            type: 'واصل تسديد',
            number: `PAY-${pay.id}`,
            debit: 0,
            credit: toNumber(pay.amount_paid),
            notes: pay.notes || '',
            date: pay.payment_date
        }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    return { previousDebt: balance, totalInvoices, totalPayments, balance, operations };
}

async function getNextInvoiceNumber() {
    const { data } = await supabase
        .from('invoices')
        .select('invoice_number')
        .order('id', { ascending: false })
        .limit(100);

    const maxNumber = (data || []).reduce((max, inv) => {
        const value = parseInt(String(inv.invoice_number || '').replace(/\D/g, ''), 10);
        return Number.isFinite(value) && value > max ? value : max;
    }, 0);

    return String(maxNumber + 1);
}

async function invoiceNumberExists(invoiceNumber, excludeId = null) {
    let query = supabase.from('invoices').select('id').eq('invoice_number', invoiceNumber).limit(1);
    if (excludeId) query = query.neq('id', excludeId);
    const { data } = await query;
    return (data || []).length > 0;
}

// 🔓 تم إلغاء الحماية لفتح النظام مباشرة على Vercel
function checkAuth(req, res, next) {
    return next(); // السماح بالمرور الفوري لجميع الأجهزة دون قيود
}

// --- الروابط البرمجية (APIs) المرتبطة بالسحاب ---

app.post('/api/verify-token', (req, res) => {
    res.json({ success: true });
});

app.get('/api/products/search', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('products').select('*');
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching products/search:", err);
        res.json({ success: false, data: [] });
    }
});

app.get('/api/invoices/next-number', checkAuth, async (req, res) => {
    try {
        const invoice_number = await getNextInvoiceNumber();
        res.json({ success: true, invoice_number });
    } catch (err) {
        console.error("Error fetching next-number:", err);
        res.json({ success: false });
    }
});

app.post('/api/invoices', checkAuth, async (req, res) => {
    const { invoice_number: requestedNumber, client_name, total_amount, discount, final_amount, payment_type, notes, device_type, items } = req.body;
    if (!client_name || !Array.isArray(items) || items.length === 0) {
        return res.json({ success: false, message: "يرجى إدخال اسم العميل وتفاصيل المواد قبل الحفظ" });
    }

    const invoice_number = String(requestedNumber || await getNextInvoiceNumber()).trim();
    if (!invoice_number) return res.json({ success: false, message: 'رقم الفاتورة غير صحيح' });
    if (await invoiceNumberExists(invoice_number)) return res.json({ success: false, message: 'رقم الفاتورة مستخدم سابقاً' });

    const accountBefore = await getCustomerAccount(client_name);
    const previous_balance = accountBefore.balance;
    const paid_amount = payment_type === 'cash' ? final_amount : 0;
    const remaining_balance = payment_type === 'cash' ? previous_balance : previous_balance + toNumber(final_amount);

    const { data: invData, error: invError } = await supabase
        .from('invoices')
        .insert([{ invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type }])
        .select();

    if (invError) return res.json({ success: false, message: "فشل حفظ الفاتورة في السحاب" });

    const invoiceId = invData[0].id;
    const bulkItems = items
        .filter(item => item.name && item.qty && item.price && item.total)
        .map(item => ({
        invoice_id: invoiceId, item_name: item.name, unit_type: item.unit, quantity: item.qty, price: item.price, row_total: item.total
    }));

    if (bulkItems.length === 0) {
        return res.json({ success: false, message: "لا توجد مواد صالحة للحفظ داخل الفاتورة" });
    }

    const { error: itemsError } = await supabase.from('invoice_items').insert(bulkItems);
    
    if (itemsError) res.json({ success: false, message: "فشل حفظ تفاصيل المواد" });
    else res.json({ success: true, message: `تم إرسال وحفظ القائمة بنجاح برقم: ${invoice_number}`, invoiceId, previous_balance, paid_amount, remaining_balance });
});

app.post('/api/payments', checkAuth, async (req, res) => {
    const { client_name, amount_paid, notes } = req.body;
    if (!client_name || !amount_paid) return res.json({ success: false, message: 'أدخل اسم الزبون والمبلغ' });
    const { error } = await supabase.from('debt_payments').insert([{ client_name, amount_paid, notes }]);
    res.json({ success: !error, message: error ? 'فشل الحفظ' : 'تم تسجيل واصل تسديد الزبون بنجاح!' });
});

app.get('/api/payments', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('debt_payments').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching payments:", err);
        res.json({ success: false, data: [] });
    }
});

app.get('/api/payments/:id', checkAuth, async (req, res) => {
    const { data, error } = await supabase.from('debt_payments').select('*').eq('id', req.params.id).single();
    res.json({ success: !error, payment: data });
});

app.put('/api/payments/:id', checkAuth, async (req, res) => {
    const { client_name, amount_paid, notes } = req.body;
    if (!client_name || !amount_paid) return res.json({ success: false, message: 'أدخل اسم الزبون والمبلغ' });
    const { error } = await supabase.from('debt_payments').update({ client_name, amount_paid: toNumber(amount_paid), notes }).eq('id', req.params.id);
    res.json({ success: !error, message: error ? 'فشل تعديل الوصل' : 'تم تعديل وصل القبض بنجاح' });
});

app.delete('/api/payments/:id', checkAuth, async (req, res) => {
    const { error } = await supabase.from('debt_payments').delete().eq('id', req.params.id);
    res.json({ success: !error, message: error ? 'فشل حذف الوصل' : 'تم حذف الوصل بنجاح' });
});

app.get('/api/customers', checkAuth, async (req, res) => {
    try {
        const { data: invoices, error: invError } = await supabase.from('invoices').select('client_name, final_amount, payment_type, created_at');
        if (invError) throw invError;
        const { data: payments, error: payError } = await supabase.from('debt_payments').select('client_name, amount_paid, payment_date');
        if (payError) throw payError;
        const map = new Map();
        function getRow(name) {
            const key = (name || '').trim();
            if (!key) return null;
            if (!map.has(key)) map.set(key, { name: key, invoiceCount: 0, totalInvoices: 0, totalPayments: 0, balance: 0, lastDate: null });
            return map.get(key);
        }
        (invoices || []).forEach(inv => {
            const row = getRow(inv.client_name);
            if (!row) return;
            row.invoiceCount += 1;
            if (inv.payment_type !== 'cash') row.totalInvoices += toNumber(inv.final_amount);
            if (!row.lastDate || new Date(inv.created_at) > new Date(row.lastDate)) row.lastDate = inv.created_at;
        });
        (payments || []).forEach(pay => {
            const row = getRow(pay.client_name);
            if (!row) return;
            row.totalPayments += toNumber(pay.amount_paid);
            if (!row.lastDate || new Date(pay.payment_date) > new Date(row.lastDate)) row.lastDate = pay.payment_date;
        });
        const customers = [...map.values()].map(row => ({
            ...row,
            balance: Math.max(0, row.totalInvoices - row.totalPayments)
        })).sort((a, b) => new Date(b.lastDate || 0) - new Date(a.lastDate || 0));
        res.json({ success: true, data: customers });
    } catch (err) {
        console.error("Error fetching customers:", err);
        res.json({ success: false, data: [] });
    }
});

app.get('/api/customers/:name/account', checkAuth, async (req, res) => {
    try {
        const account = await getCustomerAccount(req.params.name);
        res.json({ success: true, account });
    } catch (err) {
        console.error("Error fetching customer account:", err);
        res.json({ success: false });
    }
});

app.delete('/api/customers/:name', checkAuth, async (req, res) => {
    const name = (req.params.name || '').trim();
    if (!name) return res.json({ success: false, message: 'اسم الزبون غير صحيح' });

    const { data: invoices } = await supabase.from('invoices').select('id').ilike('client_name', name);
    const invoiceIds = (invoices || []).map(inv => inv.id);

    if (invoiceIds.length > 0) {
        await supabase.from('invoice_items').delete().in('invoice_id', invoiceIds);
        await supabase.from('invoices').delete().in('id', invoiceIds);
    }

    await supabase.from('debt_payments').delete().ilike('client_name', name);
    res.json({ success: true, message: 'تم حذف الزبون وجميع فواتيره ووصولاته' });
});

app.post('/api/supplier-payments', checkAuth, async (req, res) => {
    const { supplier_name, amount_paid, notes } = req.body;
    const { error: payError } = await supabase.from('supplier_payments').insert([{ supplier_name, amount_paid, notes }]);
    if (payError) return res.json({ success: false });

    const { data: supData } = await supabase.from('suppliers').select('current_debts').eq('name', supplier_name).single();
    if (supData) {
        const newDebt = Math.max(0, supData.current_debts - amount_paid);
        await supabase.from('suppliers').update({ current_debts: newDebt }).eq('name', supplier_name);
    }
    res.json({ success: true, message: "تم تسجيل الحركة وخصم الحساب المتبقي للشركة!" });
});

app.get('/api/supplier-payments', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('supplier_payments').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching supplier-payments:", err);
        res.json({ success: false, data: [] });
    }
});

app.get('/api/invoices', checkAuth, async (req, res) => {
    try {
        const search = req.query.search || '';
        let query = supabase.from('invoices').select('*').order('id', { ascending: false });
        if(search) query = query.ilike('client_name', `%${search}%`);
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching invoices:", err);
        res.json({ success: false, data: [] });
    }
});

app.get('/api/invoices/:id', checkAuth, async (req, res) => {
    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
    const { data: items } = await supabase.from('invoice_items').select('*').eq('invoice_id', req.params.id);
    const account = await getCustomerAccount(invoice?.client_name);
    res.json({ success: true, invoice, items: items || [], account });
});

app.put('/api/invoices/:id', checkAuth, async (req, res) => {
    const { invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type, items } = req.body;
    if (!invoice_number || !client_name || !Array.isArray(items) || items.length === 0) return res.json({ success: false, message: 'بيانات الفاتورة غير مكتملة' });
    if (await invoiceNumberExists(String(invoice_number).trim(), req.params.id)) return res.json({ success: false, message: 'رقم الفاتورة مستخدم سابقاً' });
    const { error: invError } = await supabase.from('invoices').update({ invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type }).eq('id', req.params.id);
    if (invError) return res.json({ success: false, message: 'فشل تعديل الفاتورة' });
    await supabase.from('invoice_items').delete().eq('invoice_id', req.params.id);
    const bulkItems = items.filter(item => item.name && item.qty && item.price && item.total).map(item => ({
        invoice_id: req.params.id,
        item_name: item.name,
        unit_type: item.unit,
        quantity: item.qty,
        price: item.price,
        row_total: item.total
    }));
    const { error: itemsError } = await supabase.from('invoice_items').insert(bulkItems);
    res.json({ success: !itemsError, message: itemsError ? 'فشل تعديل تفاصيل الفاتورة' : 'تم تعديل الفاتورة بنجاح' });
});

app.delete('/api/invoices/:id', checkAuth, async (req, res) => {
    await supabase.from('invoice_items').delete().eq('invoice_id', req.params.id);
    const { error } = await supabase.from('invoices').delete().eq('id', req.params.id);
    res.json({ success: !error, message: error ? 'فشل حذف الفاتورة' : 'تم حذف الفاتورة' });
});

app.post('/api/invoices/print/:id', checkAuth, async (req, res) => {
    await supabase.from('invoices').update({ is_printed: 1 }).eq('id', req.params.id);
    res.json({ success: true });
});

app.get('/api/products', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('products').select('*');
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching products:", err);
        res.json({ success: false, data: [] });
    }
});
app.post('/api/products', checkAuth, async (req, res) => {
    const { name, box_price, piece_price, stock_qty } = req.body;
    await supabase.from('products').insert([{ name, box_price, piece_price, stock_qty }]);
    res.json({ success: true });
});
app.delete('/api/products/:id', checkAuth, async (req, res) => {
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    res.json({ success: !error, message: error ? 'فشل حذف المنتج' : 'تم حذف المنتج من المخزن' });
});

app.get('/api/suppliers', checkAuth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('suppliers').select('*');
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (err) {
        console.error("Error fetching suppliers:", err);
        res.json({ success: false, data: [] });
    }
});
app.post('/api/suppliers', checkAuth, async (req, res) => {
    const { name, goods_type, current_debts } = req.body;
    await supabase.from('suppliers').insert([{ name, goods_type, current_debts }]);
    res.json({ success: true });
});

app.get('/api/reports', checkAuth, async (req, res) => {
    try {
        const { data: invs, error: invError } = await supabase.from('invoices').select('final_amount');
        if (invError) throw invError;
        const { data: pays, error: payError } = await supabase.from('debt_payments').select('amount_paid');
        if (payError) throw payError;
        const totalSales = invs?.reduce((sum, i) => sum + i.final_amount, 0) || 0;
        const totalReceipts = pays?.reduce((sum, p) => sum + p.amount_paid, 0) || 0;
        res.json({ success: true, reports: { totalSales, totalDebts: Math.max(0, totalSales - totalReceipts) } });
    } catch (err) {
        console.error("Error fetching reports:", err);
        res.json({ success: false, reports: { totalSales: 0, totalDebts: 0 } });
    }
});

app.get('/api/backup', (req, res) => res.json({ success: true, message: "🛡️ نظام السحاب مؤمن تلقائياً!" }));

app.get('/api/backup/export', checkAuth, async (req, res) => {
    const tables = ['products', 'invoices', 'invoice_items', 'debt_payments', 'suppliers', 'supplier_payments'];
    const backup = { exported_at: new Date().toISOString(), tables: {} };
    for (const table of tables) {
        const { data, error } = await supabase.from(table).select('*');
        backup.tables[table] = error ? { error: error.message, data: [] } : { data: data || [] };
    }
    res.setHeader('Content-Disposition', `attachment; filename="smart-maktab-backup-${Date.now()}.json"`);
    res.json(backup);
});

app.post('/api/backup/import', checkAuth, async (req, res) => {
    const tables = ['products', 'invoices', 'invoice_items', 'debt_payments', 'suppliers', 'supplier_payments'];
    const payload = req.body || {};
    const sourceTables = payload.tables || payload;
    const result = {};

    for (const table of tables) {
        const rows = Array.isArray(sourceTables[table]) ? sourceTables[table] : sourceTables[table]?.data;
        if (!Array.isArray(rows) || rows.length === 0) {
            result[table] = { imported: 0 };
            continue;
        }

        const { error } = await supabase.from(table).upsert(rows);
        result[table] = error ? { imported: 0, error: error.message } : { imported: rows.length };
    }

    res.json({ success: true, result });
});

function startServer(port = process.env.PORT || 3000) {
    return app.listen(port, () => {
        console.log('Smart Maktab server is running on port: ' + port);
    });
}

if (require.main === module) {
    startServer();
}

app.startServer = startServer;
module.exports = app;