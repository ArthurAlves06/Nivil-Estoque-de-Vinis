require('dotenv').config();
// Alguns DNS locais recusam consultas SRV (mongodb+srv). Em ambiente local usamos DNS públicos.
if (!process.env.VERCEL) require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão reutilizada entre invocações (necessário em ambiente serverless como a Vercel)
let conn = null;
app.use('/api', async (req, res, next) => {
  try {
    conn ??= mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/estoque-vinil', { serverSelectionTimeoutMS: 8000 });
    await conn;
    next();
  } catch (e) {
    conn = null;
    res.status(500).json({ error: 'Falha ao conectar no MongoDB: ' + e.message });
  }
});

const DEFAULT_MIN_STOCK = 2;

const Vinyl = mongoose.model('Vinyl', new mongoose.Schema({
  title:     { type: String, required: true, trim: true },
  artist:    { type: String, required: true, trim: true },
  year:      { type: Number },
  genre:     { type: String, trim: true },
  label:     { type: String, trim: true },
  format:    { type: String, trim: true, default: 'LP' },
  condition: { type: String, trim: true, default: 'Near Mint (NM)' },
  price:     { type: Number, min: 0, default: 0 },
  quantity:  { type: Number, min: 0, default: 1 },
  minStock:  { type: Number, min: 0, default: DEFAULT_MIN_STOCK },
  cover:     { type: String, trim: true },
  color:     { type: String, default: '#1a1a1a' },
  notes:     { type: String, trim: true },
  tracks:    [{ _id: false, title: { type: String, trim: true }, duration: { type: String, trim: true } }]
}, { timestamps: true }));

const Movement = mongoose.model('Movement', new mongoose.Schema({
  vinyl:     { type: mongoose.Schema.Types.ObjectId, ref: 'Vinyl', index: true },
  title:     String,
  artist:    String,
  type:      { type: String, enum: ['entrada', 'venda', 'ajuste'], required: true },
  quantity:  { type: Number, required: true },   // variação com sinal (+/-)
  unitPrice: { type: Number, default: 0 },
  total:     { type: Number, default: 0 },       // receita (apenas vendas)
  balance:   { type: Number, default: 0 },       // estoque após a movimentação
  note:      { type: String, trim: true }
}, { timestamps: true }));

const FIELDS = ['title', 'artist', 'year', 'genre', 'label', 'format', 'condition', 'price', 'minStock', 'cover', 'color', 'notes', 'tracks'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const rx = s => new RegExp(String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));

// Registra uma movimentação e atualiza o estoque de forma atômica
async function move(id, type, qty, { unitPrice, note } = {}) {
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty === 0) throw new Error('Quantidade inválida');
  let delta;
  if (type === 'entrada') { if (qty < 0) throw new Error('Quantidade inválida'); delta = qty; }
  else if (type === 'venda') { if (qty < 0) throw new Error('Quantidade inválida'); delta = -qty; }
  else if (type === 'ajuste') delta = qty;
  else throw new Error('Tipo de movimentação inválido');

  const filter = { _id: id };
  if (delta < 0) filter.quantity = { $gte: -delta };
  const v = await Vinyl.findOneAndUpdate(filter, { $inc: { quantity: delta } }, { new: true });
  if (!v) throw new Error((await Vinyl.exists({ _id: id })) ? 'Estoque insuficiente' : 'Disco não encontrado');

  const price = unitPrice !== undefined && unitPrice !== '' && unitPrice !== null ? Number(unitPrice) : v.price;
  await Movement.create({
    vinyl: v._id, title: v.title, artist: v.artist, type, quantity: delta,
    unitPrice: price, total: type === 'venda' ? -delta * price : 0, balance: v.quantity, note
  });
  return v;
}

const SORTS = {
  recent: { createdAt: -1 }, title: { title: 1 }, artist: { artist: 1, title: 1 },
  priceAsc: { price: 1 }, priceDesc: { price: -1 }, stock: { quantity: 1 }, year: { year: -1 }
};
const lowExpr = { $lte: ['$quantity', { $ifNull: ['$minStock', DEFAULT_MIN_STOCK] }] };

// ---------- Discos ----------
app.get('/api/vinyls', wrap(async (req, res) => {
  const { q, genre, format, minPrice, maxPrice, low, sort } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(60, parseInt(req.query.limit) || 12);
  const f = {};
  if (q && q.trim()) { const r = rx(q); f.$or = [{ title: r }, { artist: r }, { genre: r }, { label: r }]; }
  if (genre) f.genre = genre;
  if (format) f.format = format;
  if (minPrice || maxPrice) {
    f.price = {};
    if (minPrice) f.price.$gte = Number(minPrice);
    if (maxPrice) f.price.$lte = Number(maxPrice);
  }
  if (low === '1') f.$expr = lowExpr;
  const [items, total] = await Promise.all([
    Vinyl.find(f).sort(SORTS[sort] || SORTS.recent).skip((page - 1) * limit).limit(limit),
    Vinyl.countDocuments(f)
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

app.get('/api/vinyls/:id', wrap(async (req, res) => {
  const v = await Vinyl.findById(req.params.id);
  if (!v) return res.status(404).json({ error: 'Não encontrado' });
  res.json(v);
}));

app.post('/api/vinyls', wrap(async (req, res) => {
  const v = await Vinyl.create({ ...pick(req.body, FIELDS), quantity: Math.max(0, Number(req.body.quantity) || 0) });
  if (v.quantity > 0) {
    await Movement.create({ vinyl: v._id, title: v.title, artist: v.artist, type: 'entrada', quantity: v.quantity, unitPrice: v.price, balance: v.quantity, note: 'Cadastro inicial' });
  }
  res.status(201).json(v);
}));

app.put('/api/vinyls/:id', wrap(async (req, res) => {
  let v = await Vinyl.findByIdAndUpdate(req.params.id, pick(req.body, FIELDS), { new: true, runValidators: true });
  if (!v) return res.status(404).json({ error: 'Não encontrado' });
  if (req.body.quantity !== undefined) {
    const delta = Number(req.body.quantity) - v.quantity;
    if (delta !== 0) v = await move(v._id, 'ajuste', delta, { note: 'Ajuste manual na edição' });
  }
  res.json(v);
}));

app.post('/api/vinyls/:id/move', wrap(async (req, res) => {
  const { type, quantity, unitPrice, note } = req.body;
  res.json(await move(req.params.id, type, quantity, { unitPrice, note }));
}));

app.delete('/api/vinyls/:id', wrap(async (req, res) => {
  await Vinyl.findByIdAndDelete(req.params.id);
  res.status(204).end();
}));

// ---------- Movimentações ----------
app.get('/api/movements', wrap(async (req, res) => {
  const { type, vinyl } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 15);
  const f = {};
  if (type) f.type = type;
  if (vinyl) f.vinyl = vinyl;
  const [items, total] = await Promise.all([
    Movement.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Movement.countDocuments(f)
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

// ---------- Resumo e relatórios ----------
app.get('/api/stats', wrap(async (req, res) => {
  const [agg] = await Vinyl.aggregate([{ $group: {
    _id: null, titles: { $sum: 1 }, units: { $sum: '$quantity' },
    value: { $sum: { $multiply: ['$quantity', '$price'] } },
    low: { $sum: { $cond: [lowExpr, 1, 0] } }
  } }]);
  const [genres, formats] = await Promise.all([Vinyl.distinct('genre'), Vinyl.distinct('format')]);
  res.json({
    titles: agg?.titles || 0, units: agg?.units || 0, value: agg?.value || 0, low: agg?.low || 0,
    genres: genres.filter(Boolean).sort(), formats: formats.filter(Boolean).sort()
  });
}));

app.get('/api/reports', wrap(async (req, res) => {
  const days = Math.min(365, parseInt(req.query.days) || 30);
  const since = new Date(Date.now() - days * 864e5);
  const units = { $sum: { $multiply: ['$quantity', -1] } };
  const [sales] = await Movement.aggregate([
    { $match: { type: 'venda', createdAt: { $gte: since } } },
    { $facet: {
      totals: [{ $group: { _id: null, revenue: { $sum: '$total' }, units, count: { $sum: 1 } } }],
      daily: [
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } }, revenue: { $sum: '$total' }, units } },
        { $sort: { _id: 1 } }
      ],
      top: [
        { $group: { _id: '$vinyl', title: { $first: '$title' }, artist: { $first: '$artist' }, units, revenue: { $sum: '$total' } } },
        { $sort: { units: -1, revenue: -1 } }, { $limit: 5 }
      ]
    } }
  ]);
  const byGenre = await Vinyl.aggregate([
    { $group: { _id: { $ifNull: ['$genre', 'Sem gênero'] }, units: { $sum: '$quantity' }, titles: { $sum: 1 } } },
    { $sort: { units: -1 } }
  ]);
  const t = sales.totals[0] || { revenue: 0, units: 0, count: 0 };
  res.json({
    days, revenue: t.revenue, unitsSold: t.units, salesCount: t.count,
    avgTicket: t.count ? t.revenue / t.count : 0,
    daily: sales.daily, top: sales.top, byGenre
  });
}));

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`♪ http://localhost:${port}`));
}
