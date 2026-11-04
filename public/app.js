const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { page: 1, mpage: 1, tab: 'stock', stats: null };

const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Erro inesperado');
  return r.status === 204 ? null : r.json();
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = d => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const isLow = v => v.quantity <= (v.minStock ?? 2);

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3000);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- tema ----------
$('#theme').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; localStorage.setItem('theme', t);
};

// ---------- abas ----------
const loaders = { stock: () => loadVinyls(), moves: () => loadMoves(), reports: () => loadReports() };
$$('nav button').forEach(b => b.onclick = guard(async () => {
  state.tab = b.dataset.tab;
  const titles = { stock: ['Coleção', 'Acervo'], moves: ['Histórico', 'Movimentações'], reports: ['Visão geral', 'Relatórios'] };
  [$('#eyebrow').textContent, $('#pageTitle').textContent] = titles[state.tab];
  $$('nav button').forEach(x => x.classList.toggle('on', x === b));
  $$('section.view').forEach(s => s.hidden = s.id !== 'v-' + state.tab);
  await loaders[state.tab]();
}));

// ---------- resumo ----------
async function loadStats() {
  const s = state.stats = await api('/api/stats');
  $('#stats').innerHTML = `
    <div class="stat"><b>${s.titles}</b><span>títulos</span></div>
    <div class="stat"><b>${s.units}</b><span>discos</span></div>
    <div class="stat ${s.low ? 'warn' : ''}"><b>${s.low}</b><span>estoque baixo</span></div>
    <div class="stat"><b>${money(s.value)}</b><span>valor em estoque</span></div>`;
  fillSelect($('#fGenre'), s.genres, 'Todos os gêneros');
  fillSelect($('#fFormat'), s.formats, 'Todos os formatos');
  $('#genres').innerHTML = s.genres.map(g => `<option value="${esc(g)}">`).join('');
}
function fillSelect(sel, list, first) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${first}</option>` + list.map(x => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
}
const refreshAll = () => Promise.all([loadStats(), loaders[state.tab]()]);

// ---------- acervo ----------
function sleeve(v, badge = true) {
  return `<div class="sleeve" style="background:${esc(v.color)}">
    ${badge && v.quantity === 0 ? '<span class="badge out">Esgotado</span>' : badge && isLow(v) ? '<span class="badge">Estoque baixo</span>' : ''}
    <div class="fallback">${esc((v.title || '♪')[0])}</div>
    ${v.cover ? `<img src="${esc(v.cover)}" alt="" onerror="this.remove()">` : ''}
  </div>`;
}

const cover = v => `<div class="cover"><div class="disc" style="--lbl:${esc(v.color)}"></div>${sleeve(v)}</div>`;

async function loadVinyls() {
  if (!$('#grid').children.length) $('#grid').innerHTML = '<div class="skel"></div>'.repeat(6);
  const p = new URLSearchParams({
    q: $('#search').value, genre: $('#fGenre').value, format: $('#fFormat').value,
    minPrice: $('#fMin').value, maxPrice: $('#fMax').value, sort: $('#fSort').value,
    low: $('#fLow').checked ? '1' : '', page: state.page
  });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  const { items, total, page, pages } = await api('/api/vinyls?' + p);
  if (page > pages) { state.page = pages; return loadVinyls(); }
  $('#empty').hidden = items.length > 0;
  $('#grid').innerHTML = items.map((v, i) => `
    <article class="card" data-id="${v._id}" style="--i:${i}">
      ${cover(v)}
      <div class="meta">
        <h3>${esc(v.title)}</h3>
        <div class="artist">${esc(v.artist)}</div>
        <div class="info">${[v.year, v.genre, v.format].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="foot">
          <span class="price">${money(v.price)}</span>
          <span class="qty ${isLow(v) ? 'low' : ''}">${v.quantity} em estoque</span>
        </div>
      </div>
    </article>`).join('');
  pager($('#pager'), page, pages, total, 'p', 'disco(s)');
}

function pager(el, page, pages, total, key, label) {
  el.innerHTML = total ? `<button class="ghost" data-go="${page - 1}" ${page <= 1 ? 'disabled' : ''}>←</button>
    <span>${page} / ${pages} · ${total} ${label}</span>
    <button class="ghost" data-go="${page + 1}" ${page >= pages ? 'disabled' : ''}>→</button>` : '';
  el.onclick = guard(async e => {
    const go = e.target.dataset.go; if (!go) return;
    state[key === 'p' ? 'page' : 'mpage'] = +go;
    await (key === 'p' ? loadVinyls() : loadMoves());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

const reload = guard(() => { state.page = 1; return loadVinyls(); });
let t; $('#search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 250); });
['#fGenre', '#fFormat', '#fSort', '#fLow'].forEach(s => $(s).addEventListener('change', reload));
['#fMin', '#fMax'].forEach(s => $(s).addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 400); }));
$('#fClear').onclick = () => {
  ['#search', '#fGenre', '#fFormat', '#fMin', '#fMax'].forEach(s => $(s).value = '');
  $('#fSort').value = 'recent'; $('#fLow').checked = false; reload();
};

// ---------- detalhes ----------
const detail = $('#detail');
$('#grid').addEventListener('click', guard(async e => {
  const c = e.target.closest('.card'); if (c) await openDetail(c.dataset.id);
}));
detail.addEventListener('click', e => { if (e.target === detail) detail.close(); });

async function openDetail(id) {
  const [v, h] = await Promise.all([api('/api/vinyls/' + id), api(`/api/movements?vinyl=${id}&limit=6`)]);
  $('#detailBody').innerHTML = `
    <div class="d-head">
      ${sleeve(v, false)}
      <div>
        <h2>${esc(v.title)}</h2>
        <div class="muted"><em>${esc(v.artist)}</em></div>
        <div class="chips">${[v.year, v.genre, v.format, v.condition, v.label].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div>
        <div class="bigqty ${isLow(v) ? 'low' : ''}">${v.quantity} em estoque</div>
        <div class="price">${money(v.price)}</div>
      </div>
    </div>
    ${v.tracks?.length ? `<div class="d-sec"><h4>Faixas</h4><ol class="tracks">${v.tracks.map(k => `<li>${esc(k.title)}${k.duration ? `<span>${esc(k.duration)}</span>` : ''}</li>`).join('')}</ol></div>` : ''}
    ${v.notes ? `<div class="d-sec"><h4>Notas</h4><p>${esc(v.notes)}</p></div>` : ''}
    <div class="d-sec">
      <h4>Registrar movimentação</h4>
      <form class="moveform" data-id="${v._id}" data-price="${v.price}">
        <label>Tipo<select name="type"><option value="venda">Venda</option><option value="entrada">Entrada</option><option value="ajuste">Ajuste (+/−)</option></select></label>
        <label>Qtd<input name="quantity" type="number" step="1" value="1" required></label>
        <label>Preço un.<input name="unitPrice" type="number" step="0.01" min="0" placeholder="${v.price}"></label>
        <label class="full">Observação<input name="note" placeholder="opcional"></label>
        <button class="primary full" type="submit">Registrar</button>
      </form>
    </div>
    <div class="d-sec"><h4>Histórico recente</h4><div class="hist">
      ${h.items.length ? h.items.map(m => `<div><span>${esc(m.type)} ${m.quantity > 0 ? '+' : ''}${m.quantity}${m.note ? ` <small>· ${esc(m.note)}</small>` : ''}</span><small>${fmtDate(m.createdAt)}</small></div>`).join('') : '<small>Nada registrado.</small>'}
    </div></div>
    <div class="actions">
      <button class="ghost danger" data-act="del" data-id="${v._id}">Excluir</button>
      <button class="ghost" data-act="edit" data-id="${v._id}">Editar</button>
      <button class="primary" data-act="close">Fechar</button>
    </div>`;
  if (!detail.open) detail.showModal();
}

detail.addEventListener('submit', guard(async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  if (d.unitPrice === '') delete d.unitPrice;
  await api(`/api/vinyls/${f.dataset.id}/move`, { method: 'POST', body: JSON.stringify(d) });
  toast('Movimentação registrada');
  await Promise.all([openDetail(f.dataset.id), loadStats(), loaders[state.tab]()]);
}));
detail.addEventListener('click', guard(async e => {
  const act = e.target.dataset.act; if (!act) return;
  if (act === 'close') return detail.close();
  const id = e.target.dataset.id;
  if (act === 'edit') { const v = await api('/api/vinyls/' + id); detail.close(); return openForm(v); }
  if (act === 'del' && confirm('Excluir este disco? O histórico de movimentações será mantido.')) {
    await api('/api/vinyls/' + id, { method: 'DELETE' });
    detail.close(); toast('Disco excluído'); await refreshAll();
  }
}));

// ---------- formulário ----------
const dialog = $('#dialog'), form = $('#form');
function openForm(v = {}) {
  form.reset();
  $('#dialogTitle').textContent = v._id ? 'Editar disco' : 'Novo disco';
  form.elements.id.value = v._id || '';
  for (const k of ['title', 'artist', 'year', 'genre', 'label', 'format', 'condition', 'price', 'quantity', 'minStock', 'cover', 'color', 'notes'])
    if (v[k] !== undefined && v[k] !== null) form.elements[k].value = v[k];
  form.elements.tracks.value = (v.tracks || []).map(k => k.duration ? `${k.title} | ${k.duration}` : k.title).join('\n');
  dialog.showModal();
}
$('#addBtn').onclick = () => openForm();
$('#cancel').onclick = () => dialog.close();
form.addEventListener('submit', guard(async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  const id = d.id; delete d.id;
  ['year', 'price', 'quantity', 'minStock'].forEach(k => d[k] = d[k] === '' ? undefined : Number(d[k]));
  d.tracks = d.tracks.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [title, duration] = l.split('|').map(s => s.trim());
    return { title, duration };
  });
  await api('/api/vinyls' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(d) });
  dialog.close(); toast(id ? 'Disco atualizado' : 'Disco cadastrado');
  await refreshAll();
}));

// ---------- movimentações ----------
async function loadMoves() {
  const p = new URLSearchParams({ page: state.mpage });
  if ($('#mType').value) p.set('type', $('#mType').value);
  const { items, total, page, pages } = await api('/api/movements?' + p);
  $('#movesEmpty').hidden = items.length > 0;
  $('#movesList').innerHTML = items.map(m => `
    <div class="move">
      <span class="when">${fmtDate(m.createdAt)}</span>
      <span class="tag ${m.type}">${m.type}</span>
      <span class="what"><b>${esc(m.title)}</b><small>${esc(m.artist)}${m.note ? ' · ' + esc(m.note) : ''}</small></span>
      <span class="delta">${m.quantity > 0 ? '+' : ''}${m.quantity}
        <small>${m.type === 'venda' ? money(m.total) + ' · ' : ''}saldo ${m.balance}</small></span>
    </div>`).join('');
  pager($('#mPager'), page, pages, total, 'm', 'movimentação(ões)');
}
$('#mType').addEventListener('change', guard(() => { state.mpage = 1; return loadMoves(); }));

// ---------- relatórios ----------
async function loadReports() {
  const days = +$('#rDays').value;
  const r = await api('/api/reports?days=' + days);
  $('#kpis').innerHTML = `
    <div class="kpi"><b>${money(r.revenue)}</b><span>faturamento</span></div>
    <div class="kpi"><b>${r.unitsSold}</b><span>discos vendidos</span></div>
    <div class="kpi"><b>${r.salesCount}</b><span>vendas</span></div>
    <div class="kpi"><b>${money(r.avgTicket)}</b><span>ticket médio</span></div>`;
  $('#chart').innerHTML = chart(r.daily, days);
  const maxU = Math.max(...r.top.map(x => x.units), 1);
  $('#top').innerHTML = r.top.length ? r.top.map(x => `
    <div class="bar-row"><span>${esc(x.title)} <small>— ${esc(x.artist)}</small></span><b>${x.units} un</b>
      <div class="bar"><i style="width:${x.units / maxU * 100}%"></i></div></div>`).join('') : '<p class="muted">Sem vendas no período.</p>';
  const maxG = Math.max(...r.byGenre.map(x => x.units), 1);
  $('#byGenre').innerHTML = r.byGenre.length ? r.byGenre.map(x => `
    <div class="bar-row"><span>${esc(x._id)} <small>${x.titles} título(s)</small></span><b>${x.units} un</b>
      <div class="bar"><i style="width:${x.units / maxG * 100}%"></i></div></div>`).join('') : '<p class="muted">Sem discos.</p>';
}
function chart(daily, days) {
  const map = Object.fromEntries(daily.map(d => [d._id, d.revenue]));
  const pts = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    pts.push({ k, v: map[k] || 0 });
  }
  const max = Math.max(...pts.map(p => p.v), 1), W = 600, H = 150, bw = W / pts.length;
  const label = k => k.slice(8) + '/' + k.slice(5, 7);
  return `<svg viewBox="0 0 ${W} ${H + 18}">
    ${pts.map((p, i) => `<rect x="${i * bw + 1}" y="${H - p.v / max * H}" width="${Math.max(bw - 2, 1)}" height="${p.v / max * H}"><title>${label(p.k)}: ${money(p.v)}</title></rect>`).join('')}
    <line x1="0" x2="${W}" y1="${H}" y2="${H}"/>
    <text x="0" y="${H + 13}">${label(pts[0].k)}</text>
    <text x="${W}" y="${H + 13}" text-anchor="end">${label(pts[pts.length - 1].k)}</text>
    <text x="${W}" y="10" text-anchor="end">máx ${money(max)}</text>
  </svg>`;
}
$('#rDays').addEventListener('change', guard(loadReports));

guard(async () => { await loadStats(); await loadVinyls(); })();
