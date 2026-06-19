const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    // One-time cleanup: an earlier schema version had a unique `username`
    // field that no longer exists. The old index stuck around, and since a
    // unique index only allows ONE document with a missing/null value, it
    // silently blocked every new player after the very first one. Safe to
    // run on every startup — does nothing once the index is already gone.
    try {
      await mongoose.connection.collection('users').dropIndex('username_1');
      console.log('Dropped stale username_1 index');
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') {
        console.error('Index cleanup error:', err.message);
      }
    }
  })
  .catch(err => console.error('Connection error:', err));

// ─── Schemas ────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  phone:        { type: String, required: true, unique: true },
  display_name: String,
  prime_points: { type: Number, default: 0 },
  prime_coins:  { type: Number, default: 0 },
  rank:         { type: String, default: 'Rookie' },
  guild:        { type: String, default: null },
  last_claim:   { type: Date, default: null },
  created_at:   { type: Date, default: Date.now },
  last_active:  { type: Date, default: Date.now }
});

const ppHistorySchema = new mongoose.Schema({
  user_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount:       Number,
  reason:       String,
  balance_after: Number,
  granted_by:   String,
  timestamp:    { type: Date, default: Date.now }
});

const User      = mongoose.model('User', userSchema);
const PPHistory = mongoose.model('PPHistory', ppHistorySchema);

const cashoutSchema = new mongoose.Schema({
  phone:       { type: String, required: true },
  name:        String,
  amount:      { type: Number, required: true },
  note:        String,
  status:      { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewed_by: String,
  created_at:  { type: Date, default: Date.now },
  reviewed_at: Date,
});

const Cashout = mongoose.model('Cashout', cashoutSchema);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Rank thresholds — edit these to suit your community
function calculateRank(points) {
  if (points >= 10000) return 'Legend';
  if (points >= 5000)  return 'Elite';
  if (points >= 2000)  return 'Veteran';
  if (points >= 1000)  return 'Pro';
  if (points >= 500)   return 'Rising';
  return 'Rookie';
}

// Coins earned: 1 coin per 10 PP gained (never deducted)
function coinsForPP(amount) {
  return amount > 0 ? Math.floor(amount / 10) : 0;
}

// Daily claim amount — change this number to adjust how much PP players get per claim
const DAILY_CLAIM_AMOUNT = 50;
const CLAIM_COOLDOWN_MS  = 24 * 60 * 60 * 1000; // 24 hours

// ─── Auth middleware ──────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /users — leaderboard with pagination (?page=1&limit=20)
app.get('/users', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const users = await User.find()
      .sort({ prime_points: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    const total = await User.countDocuments();
    res.json({ users, page, limit, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /users/:phone — single user profile
app.get('/users/:phone', async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.params.phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// GET /users/:phone/ensure — fetch a user, auto-creating a blank PP profile if none exists yet
// Use this from the frontend right after Supabase login so every member has a Mongo PP record.
app.get('/users/:phone/ensure', async (req, res) => {
  try {
    const phone = req.params.phone;
    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, display_name: req.query.name || null } },
      { new: true, upsert: true }
    );
    res.json(user);
  } catch (err) {
    console.error('[ENSURE ERROR]', err);
    res.status(500).json({ error: 'Failed to fetch or create user', detail: err.message });
  }
});

// GET /users/:phone/claim/status — check claim eligibility without granting anything
app.get('/users/:phone/claim/status', async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.params.phone });
    if (!user || !user.last_claim) {
      return res.json({ canClaim: true, msRemaining: 0 });
    }
    const elapsed = Date.now() - new Date(user.last_claim).getTime();
    if (elapsed >= CLAIM_COOLDOWN_MS) {
      return res.json({ canClaim: true, msRemaining: 0 });
    }
    res.json({ canClaim: false, msRemaining: CLAIM_COOLDOWN_MS - elapsed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check claim status' });
  }
});

// POST /users/:phone/claim — claim daily Prime Points (auto-creates user if needed)
app.post('/users/:phone/claim', async (req, res) => {
  try {
    const phone = req.params.phone;
    const name  = req.body?.name || '';

    // Make sure the user exists (same atomic upsert pattern as /ensure)
    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, display_name: name || null } },
      { new: true, upsert: true }
    );

    const now = Date.now();

    if (user.last_claim && (now - new Date(user.last_claim).getTime()) < CLAIM_COOLDOWN_MS) {
      const msRemaining = CLAIM_COOLDOWN_MS - (now - new Date(user.last_claim).getTime());
      return res.json({ claimed: false, msRemaining, prime_points: user.prime_points });
    }

    // Atomic claim — the filter re-checks eligibility at write time, so two
    // rapid clicks (or two tabs) can't both succeed and double-grant PP.
    const cutoff = new Date(now - CLAIM_COOLDOWN_MS);
    const claimed = await User.findOneAndUpdate(
      { phone, $or: [{ last_claim: null }, { last_claim: { $lte: cutoff } }] },
      {
        $inc: { prime_points: DAILY_CLAIM_AMOUNT },
        $set: { last_claim: new Date(now), last_active: new Date(now) }
      },
      { new: true }
    );

    if (!claimed) {
      // Lost the race — someone/something already claimed in the meantime
      const fresh = await User.findOne({ phone });
      const msRemaining = CLAIM_COOLDOWN_MS - (now - new Date(fresh.last_claim).getTime());
      return res.json({ claimed: false, msRemaining, prime_points: fresh.prime_points });
    }

    claimed.rank = calculateRank(claimed.prime_points);
    await claimed.save();

    await PPHistory.create({
      user_id:       claimed._id,
      amount:        DAILY_CLAIM_AMOUNT,
      reason:        'Daily claim',
      balance_after: claimed.prime_points,
      granted_by:    'system'
    });

    res.json({ claimed: true, amount: DAILY_CLAIM_AMOUNT, prime_points: claimed.prime_points, user: claimed });
  } catch (err) {
    console.error('[CLAIM ERROR]', err);
    res.status(500).json({ error: 'Failed to process claim' });
  }
});

// POST /users — create a new user
app.post('/users', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      return res.status(400).json({ error: 'phone is required' });
    }
    const user = new User({ ...req.body, phone: phone.trim() });
    await user.save();
    res.status(201).json(user);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Phone already exists' });
    res.status(400).json({ error: err.message });
  }
});

// POST /users/:phone/pp — grant or deduct PP
app.post('/users/:phone/pp', async (req, res) => {
  try {
    const { amount, reason, granted_by } = req.body;

    if (typeof amount !== 'number' || isNaN(amount)) {
      return res.status(400).json({ error: 'amount must be a number' });
    }
    if (!granted_by) {
      return res.status(400).json({ error: 'granted_by is required' });
    }

    const user = await User.findOne({ phone: req.params.phone });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.prime_points += amount;
    user.prime_coins  += coinsForPP(amount);   // auto-earn coins on PP gain
    user.rank          = calculateRank(user.prime_points);
    user.last_active   = new Date();
    await user.save();

    const log = new PPHistory({
      user_id:       user._id,
      amount,
      reason:        reason || null,
      balance_after: user.prime_points,
      granted_by
    });
    await log.save();

    res.json({ user, log });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update PP' });
  }
});

// GET /users/:phone/pp/history — PP history for a user
app.get('/users/:phone/pp/history', async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.params.phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const history = await PPHistory.find({ user_id: user._id }).sort({ timestamp: -1 });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// POST /users/:phone/coins — spend or add coins directly
app.post('/users/:phone/coins', async (req, res) => {
  try {
    const { amount, reason } = req.body;

    if (typeof amount !== 'number' || isNaN(amount)) {
      return res.status(400).json({ error: 'amount must be a number' });
    }

    const user = await User.findOne({ phone: req.params.phone });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.prime_coins + amount < 0) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    user.prime_coins += amount;
    user.last_active  = new Date();
    await user.save();

    res.json({ phone: user.phone, prime_coins: user.prime_coins, reason });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update coins' });
  }
});

// ─── Cashout Requests ─────────────────────────────────────────────────────────

// POST /cashouts — player submits a withdrawal request (PP deducted immediately so it can't be double-spent)
app.post('/cashouts', async (req, res) => {
  try {
    const { phone, name, amount, note } = req.body;

    if (!phone) return res.status(400).json({ error: 'phone is required' });
    if (typeof amount !== 'number' || isNaN(amount) || amount < 500) {
      return res.status(400).json({ error: 'amount must be a number of at least 500' });
    }

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.prime_points < amount) return res.status(400).json({ error: 'Insufficient Prime Points' });

    // Deduct immediately so the same PP can't be requested twice while pending
    user.prime_points -= amount;
    user.last_active = new Date();
    await user.save();

    await PPHistory.create({
      user_id: user._id,
      amount: -amount,
      reason: 'Cashout request',
      balance_after: user.prime_points,
      granted_by: 'system',
    });

    const cashout = await Cashout.create({ phone, name, amount, note });
    res.status(201).json({ cashout, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit cashout request' });
  }
});

// GET /cashouts — list all cashout requests (?status=pending to filter)
app.get('/cashouts', async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const cashouts = await Cashout.find(filter).sort({ created_at: -1 });
    res.json({ cashouts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch cashouts' });
  }
});

// POST /cashouts/:id/approve — admin marks a request as paid out
app.post('/cashouts/:id/approve', async (req, res) => {
  try {
    const { reviewed_by } = req.body;
    const cashout = await Cashout.findById(req.params.id);
    if (!cashout) return res.status(404).json({ error: 'Cashout request not found' });
    if (cashout.status !== 'pending') return res.status(400).json({ error: 'Request already reviewed' });

    cashout.status = 'approved';
    cashout.reviewed_by = reviewed_by || 'admin';
    cashout.reviewed_at = new Date();
    await cashout.save();

    res.json({ cashout });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve cashout' });
  }
});

// POST /cashouts/:id/reject — admin rejects a request and refunds the PP
app.post('/cashouts/:id/reject', async (req, res) => {
  try {
    const { reviewed_by, reason } = req.body;
    const cashout = await Cashout.findById(req.params.id);
    if (!cashout) return res.status(404).json({ error: 'Cashout request not found' });
    if (cashout.status !== 'pending') return res.status(400).json({ error: 'Request already reviewed' });

    cashout.status = 'rejected';
    cashout.reviewed_by = reviewed_by || 'admin';
    cashout.reviewed_at = new Date();
    await cashout.save();

    // Refund the PP back to the player
    const user = await User.findOne({ phone: cashout.phone });
    if (user) {
      user.prime_points += cashout.amount;
      await user.save();
      await PPHistory.create({
        user_id: user._id,
        amount: cashout.amount,
        reason: reason || 'Cashout rejected — refunded',
        balance_after: user.prime_points,
        granted_by: reviewed_by || 'admin',
      });
    }

    res.json({ cashout });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject cashout' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
