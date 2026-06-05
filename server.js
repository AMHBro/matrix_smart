const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const app = express();

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
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

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
            type: inv.payment_type === 'cash' ? 'فاتورة نقدية' : 'فاتورة دين',
            number: inv.invoice_number,
            debit: inv.payment_type === 'cash' ? 0 : toNumber(inv.final_amount),
            credit: inv.payment_type === 'cash' ? toNumber(inv.final_amount) : 0,
            notes: inv.notes || '',
            date: inv.created_at
        })),
        ...paymentRows.map(pay => ({
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

// 🔓 تم إلغاء الحماية لفتح النظام مباشرة على Vercel
function checkAuth(req, res, next) {
    return next(); // السماح بالمرور الفوري لجميع الأجهزة دون قيود
}

// --- الروابط البرمجية (APIs) المرتبطة بالسحاب ---

app.post('/api/verify-token', (req, res) => {
    res.json({ success: true });
});

app.get('/api/products/search', checkAuth, async (req, res) => {
    const { data, error } = await supabase.from('products').select('*');
    res.json({ success: !error, data: data || [] });
});

app.post('/api/invoices', checkAuth, async (req, res) => {
    const { client_name, total_amount, discount, final_amount, payment_type, notes, device_type, items } = req.body;
    if (!client_name || !Array.isArray(items) || items.length === 0) {
        return res.json({ success: false, message: "يرجى إدخال اسم العميل وتفاصيل المواد قبل الحفظ" });
    }

    const invoice_number = await getNextInvoiceNumber();

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
    const { data } = await supabase.from('debt_payments').select('*').order('id', { ascending: false });
    res.json({ success: true, data: data || [] });
});

app.get('/api/customers/:name/account', checkAuth, async (req, res) => {
    const account = await getCustomerAccount(req.params.name);
    res.json({ success: true, account });
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
    const { data } = await supabase.from('supplier_payments').select('*').order('id', { ascending: false });
    res.json({ success: true, data: data || [] });
});

app.get('/api/invoices', checkAuth, async (req, res) => {
    const search = req.query.search || '';
    let query = supabase.from('invoices').select('*').order('id', { ascending: false });
    if(search) query = query.ilike('client_name', `%${search}%`);
    const { data } = await query;
    res.json({ success: true, data: data || [] });
});

app.get('/api/invoices/:id', checkAuth, async (req, res) => {
    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
    const { data: items } = await supabase.from('invoice_items').select('*').eq('invoice_id', req.params.id);
    const account = await getCustomerAccount(invoice?.client_name);
    res.json({ success: true, invoice, items: items || [], account });
});

app.post('/api/invoices/print/:id', checkAuth, async (req, res) => {
    await supabase.from('invoices').update({ is_printed: 1 }).eq('id', req.params.id);
    res.json({ success: true });
});

app.get('/api/products', checkAuth, async (req, res) => {
    const { data } = await supabase.from('products').select('*');
    res.json({ data: data || [] });
});
app.post('/api/products', checkAuth, async (req, res) => {
    const { name, box_price, piece_price, stock_qty } = req.body;
    await supabase.from('products').insert([{ name, box_price, piece_price, stock_qty }]);
    res.json({ success: true });
});

app.get('/api/suppliers', checkAuth, async (req, res) => {
    const { data } = await supabase.from('suppliers').select('*');
    res.json({ data: data || [] });
});
app.post('/api/suppliers', checkAuth, async (req, res) => {
    const { name, goods_type, current_debts } = req.body;
    await supabase.from('suppliers').insert([{ name, goods_type, current_debts }]);
    res.json({ success: true });
});

app.get('/api/reports', checkAuth, async (req, res) => {
    const { data: invs } = await supabase.from('invoices').select('final_amount');
    const { data: pays } = await supabase.from('debt_payments').select('amount_paid');
    const totalSales = invs?.reduce((sum, i) => sum + i.final_amount, 0) || 0;
    const totalReceipts = pays?.reduce((sum, p) => sum + p.amount_paid, 0) || 0;
    res.json({ success: true, reports: { totalSales, totalDebts: Math.max(0, totalSales - totalReceipts) } });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل ومفتوح للجميع على منفذ: ${PORT}`);
});