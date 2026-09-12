const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');

const app = express();

// Core Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Configuration
app.use(session({
    secret: 'gold-orb-secret-key-abcde',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: false 
    }
}));

// Serve static frontend assets cleanly out of your public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false 
    },
    connectionTimeoutMillis: 10000 
});

// Setup Database & Tables
const initializeDatabase = async () => {
    try {
        const client = await pool.connect();
        console.log("Successfully handshook with PostgreSQL instance.");
        client.release(); 

        // Create Users Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                balance NUMERIC(15, 2) DEFAULT 0.00,
                commission NUMERIC(15, 2) DEFAULT 0.00,
                invitation_code VARCHAR(50)
            )
        `);

        // Create Orders Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_phone VARCHAR(50) NOT NULL,
                product_name VARCHAR(100) NOT NULL,
                price NUMERIC(15, 2) NOT NULL,
                daily_income NUMERIC(15, 2) NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Database tables verified and ready.");
    } catch (err) {
        console.error("CRITICAL DATABASE CONNECTION FAULT:", err.message);
    }
};

initializeDatabase();

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Register Account Pipeline
app.post('/api/auth/register', async (req, res) => {
    let { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ success: false, message: "Phone and password values required." });
    }

    phone = String(phone).trim();
    password = String(password).trim();

    const assignedInviteCode = Math.floor(1000000 + Math.random() * 9000000).toString();
    const query = `INSERT INTO users (phone, password, balance, commission, invitation_code) VALUES ($1, $2, 0, 0, $3)`;
    
    try {
        await pool.query(query, [phone, password, assignedInviteCode]);
        req.session.userPhone = phone;
        return res.json({ success: true, message: "Account created successfully!" });
    } catch (err) {
        console.error("Registration error:", err.message);
        if (err.code === '23505') { 
            return res.json({ success: false, message: "This phone number is already registered!" });
        }
        return res.status(500).json({ success: false, message: "Server connection failed." });
    }
});

// Authenticate Session Access Login
app.post('/api/auth/login', async (req, res) => {
    let { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ success: false, message: "Phone and password required." });
    }

    phone = String(phone).trim();
    password = String(password).trim();

    try {
        const result = await pool.query(`SELECT * FROM users WHERE phone = $1 AND password = $2`, [phone, password]);
        
        if (result.rows.length === 0) {
            return res.json({ success: false, message: "Incorrect phone number or password." });
        }

        req.session.userPhone = result.rows[0].phone;
        return res.json({ success: true, message: "Login successful!" });
    } catch (err) {
        console.error("Login query failure:", err.message);
        return res.status(500).json({ success: false, message: "Database handshake delayed." });
    }
});

// ==========================================
// USER PORTFOLIO ENDPOINTS
// ==========================================

app.get('/api/user/profile', async (req, res) => {
    if (!req.session.userPhone) {
        return res.status(401).json({ success: false, message: "Session unauthorized." });
    }
    const phone = req.session.userPhone;
    try {
        const userResult = await pool.query(`SELECT phone, balance, commission, invitation_code FROM users WHERE phone = $1`, [phone]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Profile matching error." });
        }
        const ordersResult = await pool.query(`SELECT product_name, price, daily_income FROM orders WHERE user_phone = $1`, [phone]);

        return res.json({
            phone: userResult.rows[0].phone,
            balance: parseFloat(userResult.rows[0].balance),
            commission: parseFloat(userResult.rows[0].commission),
            invitation_code: userResult.rows[0].invitation_code,
            orders: ordersResult.rows || []
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Failed to map user profile." });
    }
});

app.post('/api/user/buy-product', async (req, res) => {
    if (!req.session.userPhone) {
        return res.status(401).json({ success: false, message: "Unauthenticated action attempt." });
    }
    const phone = req.session.userPhone;
    const { productName, price, dailyIncome } = req.body;

    try {
        const userResult = await pool.query(`SELECT balance FROM users WHERE phone = $1`, [phone]);
        if (userResult.rows.length === 0) return res.status(500).json({ success: false, message: "Verification processing failed." });

        const currentBalance = parseFloat(userResult.rows[0].balance);
        if (currentBalance < price) {
            return res.json({ success: false, message: "Insufficient balance to lease this machine!" });
        }

        await pool.query('BEGIN');
        await pool.query(`UPDATE users SET balance = balance - $1 WHERE phone = $2`, [price, phone]);
        await pool.query(`INSERT INTO orders (user_phone, product_name, price, daily_income) VALUES ($1, $2, $3, $4)`, 
            [phone, productName, price, dailyIncome]);
        await pool.query('COMMIT');
        return res.json({ success: true, message: "Machine leased successfully!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        return res.status(500).json({ success: false, message: "Hardware binding failure." });
    }
});


// ==========================================
// 🛠️ ADMIN PANEL ENDPOINTS (CRITICAL FIXED)
// ==========================================

// Endpoint 1: Fetch ALL registered users so they display in your admin panel table
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT phone, balance, commission, invitation_code 
            FROM users 
            ORDER BY id DESC
        `);
        
        // Return values clean of postgres types
        const formattedUsers = result.rows.map(user => ({
            phone: user.phone,
            balance: parseFloat(user.balance || 0),
            commission: parseFloat(user.commission || 0),
            invitation_code: user.invitation_code || ''
        }));

        return res.json({ success: true, users: formattedUsers });
    } catch (err) {
        console.error("Admin fetch users error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to fetch user directory." });
    }
});

// Endpoint 2: Handle modifications for balances and commissions
// Endpoint 2: Handle modifications for balances and commissions (Super Compatible)
app.post('/api/admin/update-balance', async (req, res) => {
    // This log helps you see exactly what your HTML page is sending to the backend
    console.log("Admin Modify Request Received. Payload:", req.body);

    const { phone, type } = req.body;
    
    // Fallback search: Accept 'newBalance', 'amount', 'balance', or 'value'
    const rawAmount = req.body.newBalance ?? req.body.amount ?? req.body.balance ?? req.body.value;
    const amount = parseFloat(rawAmount);

    if (!phone) {
        return res.status(400).json({ success: false, message: "User phone number is required." });
    }

    if (isNaN(amount)) {
        return res.status(400).json({ success: false, message: "Invalid money amount value received." });
    }

    let query = ``;
    // Normalize type string to handle different frontend variations
    const actionType = String(type || '').toLowerCase().trim();

    if (actionType === 'balance_add' || actionType === 'add' || actionType === 'deposit') {
        query = `UPDATE users SET balance = balance + $1 WHERE phone = $2`;
    } else if (actionType === 'balance_subtract' || actionType === 'subtract' || actionType === 'withdraw') {
        query = `UPDATE users SET balance = balance - $1 WHERE phone = $2`;
    } else if (actionType === 'commission_add' || actionType === 'commission') {
        query = `UPDATE users SET commission = commission + $1 WHERE phone = $2`;
    } else if (actionType === 'commission_subtract') {
        query = `UPDATE users SET commission = commission - $1 WHERE phone = $2`;
    } else {
        // Safe default: If type is unrecognized, assume we are adding to the balance
        query = `UPDATE users SET balance = balance + $1 WHERE phone = $2`;
    }

    try {
        const result = await pool.query(query, [amount, String(phone).trim()]);
        
        if (result.rowCount === 0) {
            return res.json({ success: false, message: "No user found with that phone number." });
        }
        
        return res.json({ success: true, message: "User ledger adjusted successfully!" });
    } catch (err) {
        console.error("Admin balance modification failure:", err.message);
        return res.status(500).json({ success: false, message: `Database execution error: ${err.message}` });
    }
});

// Catch-all
app.get('/', (req, res) => {
    if (req.session.userPhone) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.redirect('/login.html');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server execution processing safely on port ${PORT}`));
