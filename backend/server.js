const express = require("express");
const cors = require("cors");
const db = require("./config/db");
const {
    startAuctionSettlementWorker
} = require("./services/auctionSettlementService");
const authRoutes = require("./routes/auth");
const vehicleRoutes = require("./routes/vehicles");
const auctionRoutes = require("./routes/auctions");

const authenticateToken = require("./middleware/authMiddleware");

const path = require("path");
const app = express();


// ===============================
// MIDDLEWARE
// ===============================

app.use(cors());

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true }));


// ===============================
// PORT
// ===============================

const PORT = 5000;


// ===============================
// API ROUTES
// ===============================

app.use("/api/auth", authRoutes);
app.use("/api/vehicles", require("./routes/extras"));
app.use("/api/vehicles", vehicleRoutes);
// Rule: a vehicle needs at least 6 photos before it can go to auction
app.use("/api/auctions", (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/") return next();
    db.query("SELECT COUNT(*) c FROM vehicle_images WHERE vehicle_id = ?", [req.body.vehicle_id])
      .then(([[{ c }]]) => c >= 6 ? next() : res.status(400).json({ success: false, message: "This vehicle needs at least 6 photos before it can be listed" }))
      .catch(next);
});
app.use("/api/auctions", auctionRoutes);


// ===============================
// BASIC TEST ROUTE
// ===============================

app.use("/uploads", express.static(path.join(__dirname, "uploads"), { maxAge: "7d", immutable: true }));
app.use(express.static(path.join(__dirname, "..", "frontend")));


// ===============================
// API TEST
// ===============================

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "Bid My Car API is working!"
    });
});


// ===============================
// PROTECTED ROUTE TEST
// ===============================

app.get("/api/protected", authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: "You accessed a protected route!",
        user: req.user
    });
});


// ===============================
// DATABASE TEST
// ===============================

app.get("/api/db-test", async (req, res) => {

    try {

        const [result] = await db.query(
            "SELECT 1 AS test"
        );

        res.json({
            success: true,
            message: "MySQL database connected successfully!",
            result: result
        });

    } catch (error) {

        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed!",
            error: error.message
        });
    }
});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
    console.log("Server started successfully");

    startAuctionSettlementWorker();
});