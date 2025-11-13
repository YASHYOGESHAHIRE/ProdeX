-- Users (shop owners)
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    shop_name   TEXT NOT NULL,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inventory (one row per product per shop)
CREATE TABLE IF NOT EXISTS inventory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    price       TEXT,               -- keep as text because CSV had "₹499"
    stock       TEXT DEFAULT 'In Stock',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);