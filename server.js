const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 إعدادات الاتصال بسحاب Supabase 
const SUPABASE_URL = "https://your-project-id.supabase.co"; 
const SUPABASE_ANON_KEY = "your-actual-anon-key-here"; 

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const invoice_number = 'INV-' + Date.now().toString().slice(-5);

    const { data: invData, error: invError } = await supabase
        .from('invoices')
        .insert([{ invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type }])
        .select();

    if (invError) return res.json({ success: false, message: "فشل حفظ الفاتورة في السحاب" });

    const invoiceId = invData[0].id;
    const bulkItems = items.map(item => ({
        invoice_id: invoiceId, item_name: item.name, unit_type: item.unit, quantity: item.qty, price: item.price, row_total: item.total
    }));

    const { error: itemsError } = await supabase.from('invoice_items').insert(bulkItems);
    
    if (itemsError) res.json({ success: false, message: "فشل حفظ تفاصيل المواد" });
    else res.json({ success: true, message: `تم إرسال وحفظ القائمة بنجاح برقم: ${invoice_number}` });
});

app.post('/api/payments', checkAuth, async (req, res) => {
    const { client_name, amount_paid, notes } = req.body;
    const { error } = await supabase.from('debt_payments').insert([{ client_name, amount_paid, notes }]);
    res.json({ success: !error, message: error ? 'فشل الحفظ' : 'تم تسجيل واصل تسديد الزبون بنجاح!' });
});

app.get('/api/payments', checkAuth, async (req, res) => {
    const { data } = await supabase.from('debt_payments').select('*').order('id', { ascending: false });
    res.json({ success: true, data: data || [] });
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
    res.json({ success: true, invoice, items: items || [] });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل ومفتوح للجميع على منفذ: ${PORT}`);
});