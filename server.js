const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 رمز الأمان الخاص لربط التابلت أو الهاتف عبر الراوتر
const SECRET_TOKEN = "7788"; 

// التحقق من صلاحية الأجهزة الملحقة قبل معالجة أي بيانات
function checkAuth(req, res, next) {
    const deviceToken = req.headers['x-device-token'];
    if (deviceToken === SECRET_TOKEN || req.ip === '::1' || req.ip === '127.0.0.1') {
        return next();
    }
    res.status(401).json({ success: false, message: "⚠️ رمز حماية الراوتر غير صحيح أو غير مدخل!" });
}

// دالة أتمتة النسخ الاحتياطي التلقائي عند كل حركة مالية حية
function autoBackup() {
    const src = path.join(__dirname, 'maktab.db');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}_${now.getHours()}-${now.getMinutes()}`;
    const dest = path.join(__dirname, `backup_${dateStr}.db`);
    
    fs.copyFile(src, dest, (err) => {
        if (!err) console.log(`🛡️ [نسخ احتياطي آلي]: تم حفظ نسخة أمان للمنظومة باسم: backup_${dateStr}.db`);
    });
}

const db = new sqlite3.Database(path.join(__dirname, 'maktab.db'), (err) => {
    if (!err) initializeDatabase();
});

function initializeDatabase() {
    db.serialize(() => {
        // فواتير البيع العامة
        db.run(`CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT UNIQUE, client_name TEXT,
            total_amount REAL, discount REAL DEFAULT 0, final_amount REAL, payment_type TEXT,
            notes TEXT, device_type TEXT DEFAULT 'ملحق', is_printed INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, item_name TEXT, unit_type TEXT, quantity INTEGER, price REAL, row_total REAL
        )`);

        // المنتجات والأسعار
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, box_price REAL, piece_price REAL, stock_qty INTEGER
        )`);

        // الشركات والموزعين
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, goods_type TEXT, current_debts REAL DEFAULT 0
        )`);

        // وصولات تسديد ديون الزبائن
        db.run(`CREATE TABLE IF NOT EXISTS debt_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, client_name TEXT, amount_paid REAL, payment_date DATETIME DEFAULT CURRENT_TIMESTAMP, notes TEXT
        )`);

        // وصولات تسديد ديون الشركات
        db.run(`CREATE TABLE IF NOT EXISTS supplier_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_name TEXT, amount_paid REAL, payment_date DATETIME DEFAULT CURRENT_TIMESTAMP, notes TEXT
        )`);
    });
}

// --- الروابط البرمجية (APIs) ---

app.post('/api/verify-token', (req, res) => {
    if(req.body.token === SECRET_TOKEN) res.json({ success: true });
    else res.json({ success: false });
});

app.get('/api/products/search', checkAuth, (req, res) => {
    db.all("SELECT * FROM products", [], (err, rows) => res.json({ success: true, data: rows || [] }));
});

app.post('/api/invoices', checkAuth, (req, res) => {
    const { client_name, total_amount, discount, final_amount, payment_type, notes, device_type, items } = req.body;
    const invoice_number = 'INV-' + Date.now().toString().slice(-5);

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(`INSERT INTO invoices (invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [invoice_number, client_name, total_amount, discount, final_amount, payment_type, notes, device_type], function(err) {
                if (err) { db.run("ROLLBACK"); return res.json({ success: false }); }
                const invoiceId = this.lastID;
                const stmt = db.prepare(`INSERT INTO invoice_items (invoice_id, item_name, unit_type, quantity, price, row_total) VALUES (?, ?, ?, ?, ?, ?)`);
                items.forEach(item => stmt.run([invoiceId, item.name, item.unit, item.qty, item.price, item.total]));
                stmt.finalize();
                db.run("COMMIT");
                autoBackup(); // نسخ احتياطي فوري بعد الحفظ لسلامة البيانات
                res.json({ success: true, message: `تم إرسال وحفظ القائمة بنجاح برقم: ${invoice_number}` });
            });
    });
});

app.post('/api/payments', checkAuth, (req, res) => {
    db.run(`INSERT INTO debt_payments (client_name, amount_paid, notes) VALUES (?, ?, ?)`, 
        [req.body.client_name, req.body.amount_paid, req.body.notes], () => {
            autoBackup();
            res.json({ success: true, message: 'تم تسجيل واصل تسديد الزبون بنجاح!' });
        });
});

app.get('/api/payments', checkAuth, (req, res) => { 
    db.all("SELECT * FROM debt_payments ORDER BY id DESC", [], (err, rows) => res.json({ success: true, data: rows || [] })); 
});

app.post('/api/supplier-payments', checkAuth, (req, res) => {
    const { supplier_name, amount_paid, notes } = req.body;
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(`INSERT INTO supplier_payments (supplier_name, amount_paid, notes) VALUES (?, ?, ?)`, [supplier_name, amount_paid, notes], function(err) {
            if(err) { db.run("ROLLBACK"); return res.json({ success: false }); }
            db.run(`UPDATE suppliers SET current_debts = MAX(0, current_debts - ?) WHERE name = ?`, [amount_paid, supplier_name], function(err) {
                db.run("COMMIT");
                autoBackup();
                res.json({ success: true, message: "تم تسجيل الحركة وخصم الحساب المتبقي للشركة!" });
            });
        });
    });
});

app.get('/api/supplier-payments', checkAuth, (req, res) => {
    db.all("SELECT * FROM supplier_payments ORDER BY id DESC", [], (err, rows) => res.json({ success: true, data: rows || [] }));
});

app.get('/api/invoices', checkAuth, (req, res) => {
    const search = req.query.search || '';
    db.all("SELECT * FROM invoices WHERE client_name LIKE ? ORDER BY id DESC", [`%${search}%`], (err, rows) => res.json({ success: true, data: rows }));
});

app.get('/api/invoices/:id', checkAuth, (req, res) => {
    db.get("SELECT * FROM invoices WHERE id = ?", [req.params.id], (err, invoice) => {
        db.all("SELECT * FROM invoice_items WHERE invoice_id = ?", [req.params.id], (err, items) => {
            res.json({ success: true, invoice, items });
        });
    });
});

app.post('/api/invoices/print/:id', checkAuth, (req, res) => {
    db.run("UPDATE invoices SET is_printed = 1 WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

app.get('/api/products', checkAuth, (req, res) => { db.all("SELECT * FROM products", [], (err, rows) => res.json({ data: rows })); });
app.post('/api/products', checkAuth, (req, res) => { db.run("INSERT INTO products (name, box_price, piece_price, stock_qty) VALUES (?, ?, ?, ?)", [req.body.name, req.body.box_price, req.body.piece_price, req.body.stock_qty], () => res.json({ success: true })); });
app.get('/api/suppliers', checkAuth, (req, res) => { db.all("SELECT * FROM suppliers", [], (err, rows) => res.json({ data: rows })); });
app.post('/api/suppliers', checkAuth, (req, res) => { db.run("INSERT INTO suppliers (name, goods_type, current_debts) VALUES (?, ?, ?)", [req.body.name, req.body.goods_type, req.body.current_debts], () => res.json({ success: true })); });

app.get('/api/backup', checkAuth, (req, res) => {
    const dest = path.join(__dirname, `backup-manual-${Date.now()}.db`);
    fs.copyFile(path.join(__dirname, 'maktab.db'), dest, () => res.json({ success: true, message: `تم إنشاء نسخة احتياطية يدوية بنجاح: ${path.basename(dest)}` }));
});

app.get('/api/reports', checkAuth, (req, res) => {
    db.get("SELECT SUM(final_amount) as totalSales FROM invoices", [], (err, r1) => {
        db.get("SELECT SUM(amount_paid) as totalReceipts FROM debt_payments", [], (err, r2) => {
            res.json({ success: true, reports: { totalSales: r1?.totalSales || 0, totalDebts: Math.max(0, (r1?.totalSales || 0) - (r2?.totalReceipts || 0)) } });
        });
    });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 النظام يعمل بنجاح ومتاح عبر الراوتر المحتلي!`);
    console.log(`💻 رابط التحكم للرئيسي: http://localhost:${PORT}`);
    console.log(`🔒 رمز الأمان المطلوب لربط الأجهزة الملحقة: ${SECRET_TOKEN}`);
    console.log(`====================================================`);
});