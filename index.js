import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToUrl } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------- In‑Memory Data Stores ----------
const leads = [];        // { id, name, contact, postalCode, service, city, status, createdAt, highestBid, winner }
const bids = [];         // { id, leadId, contractorId, amount, timestamp }
const contractors = new Map(); // socketId -> { id, city, status, lastSeen }

// Active auctions (same as original but now also references leads)
const auctions = new Map(); // leadId -> { city, status, highestBid, winner, bids, expiresAt }

// Helper: update lead record with latest auction data
function updateLeadFromAuction(leadId) {
  const auction = auctions.get(leadId);
  if (!auction) return;
  const lead = leads.find(l => l.id === leadId);
  if (lead) {
    lead.status = auction.status === "live" ? "active" : "closed";
    lead.highestBid = auction.highestBid;
    lead.winner = auction.winner;
  }
}

function startAuction(leadId, city) {
  const durationMs = 60 * 1000;
  auctions.set(leadId, {
    city,
    status: "live",
    highestBid: 0,
    winner: null,
    bids: [],
    expiresAt: Date.now() + durationMs,
  });
  // Update lead status
  const lead = leads.find(l => l.id === leadId);
  if (lead) lead.status = "active";

  io.to(city).emit("auction_started", { leadId, expiresAt: Date.now() + durationMs });
  setTimeout(() => closeAuction(leadId), durationMs);
}

function closeAuction(leadId) {
  const auction = auctions.get(leadId);
  if (!auction || auction.status !== "live") return;
  auction.status = "closed";
  updateLeadFromAuction(leadId);
  io.to(auction.city).emit("auction_closed", {
    leadId,
    winnerId: auction.winner || "none",
    price: auction.highestBid,
  });
  setTimeout(() => auctions.delete(leadId), 60000);
}

// ---------- REST Endpoints for Admin ----------
// Get all leads
app.get("/api/leads", (req, res) => {
  res.json(leads);
});

// Get all bids
app.get("/api/bids", (req, res) => {
  res.json(bids);
});

// Get online contractors (convert Map to array)
app.get("/api/contractors", (req, res) => {
  const online = Array.from(contractors.values()).filter(c => c.status === "online");
  res.json(online);
});

// Create a new lead (same as original /lead but stores full lead info)
app.post("/api/leads", (req, res) => {
  const { name, contact, postalCode, service = "roof inspection", city = "unknown" } = req.body;
  if (!name || !contact || !postalCode) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const leadId = uuidv4();
  const newLead = {
    id: leadId,
    name,
    contact,
    postalCode,
    service,
    city,
    status: "active",
    createdAt: new Date().toISOString(),
    highestBid: 0,
    winner: null,
  };
  leads.unshift(newLead);
  startAuction(leadId, city);
  res.json({ success: true, leadId });
});

// Force close an auction (admin only)
app.post("/api/auctions/close/:leadId", (req, res) => {
  const { leadId } = req.params;
  const auction = auctions.get(leadId);
  if (!auction) {
    return res.status(404).json({ success: false, error: "Auction not found" });
  }
  if (auction.status !== "live") {
    return res.status(400).json({ success: false, error: "Auction already closed" });
  }
  // Clear the timeout and close immediately
  closeAuction(leadId);
  res.json({ success: true, message: "Auction force closed" });
});

// Legacy endpoint for contractor dashboard (kept for compatibility)
app.post("/lead", (req, res) => {
  const { name, contact, postalCode, service, city } = req.body;
  if (!name || !contact || !postalCode) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const leadId = uuidv4();
  const newLead = {
    id: leadId,
    name,
    contact,
    postalCode,
    service: service || "roof inspection",
    city: city || "unknown",
    status: "active",
    createdAt: new Date().toISOString(),
    highestBid: 0,
    winner: null,
  };
  leads.unshift(newLead);
  startAuction(leadId, newLead.city);
  res.json({ success: true, leadId });
});

// ---------- Socket.io Events ----------
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Register contractor
  socket.on("join_city", (city) => {
    if (!city) return;
    const contractorId = socket.id; // use socket id as unique contractor ID
    contractors.set(socket.id, {
      id: contractorId,
      city,
      status: "online",
      lastSeen: Date.now(),
    });
    socket.join(city);
    socket.emit("joined", { city, contractorId });
  });

  // Place a bid
  socket.on("bid", ({ leadId, contractorId, amount }) => {
    const auction = auctions.get(leadId);
    if (!auction || auction.status !== "live") {
      socket.emit("bid_error", { message: "No active auction for this lead" });
      return;
    }
    if (amount <= auction.highestBid) {
      socket.emit("bid_error", { message: `Bid must be > $${auction.highestBid}` });
      return;
    }
    // Record bid
    auction.highestBid = amount;
    auction.winner = contractorId;
    auction.bids.push({ contractorId, amount, timestamp: Date.now() });
    // Store permanently
    bids.push({
      id: uuidv4(),
      leadId,
      contractorId,
      amount,
      timestamp: Date.now(),
    });
    updateLeadFromAuction(leadId);
    io.to(auction.city).emit("new_bid", { leadId, highestBid: amount, contractorId });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    contractors.delete(socket.id);
  });
});

// Serve static pages
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html")); // contractor dashboard
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html")); // new admin panel
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));