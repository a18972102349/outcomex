const API_BASE = window.OUTCOMEX_API_BASE || 'http://localhost:8787';

const fallbackServices = [
  { id: 'wallet_snapshot', name: 'Wallet Snapshot', description: '在指定区块读取钱包余额和代币持仓。', price: '0.010 USDC', proof: 'Mock / RPC' },
  { id: 'contract_events', name: 'Contract Events', description: '查询合约事件并返回规范化日志。', price: '0.015 USDC', proof: 'Mock only' },
  { id: 'token_price_snapshot', name: 'Token Price Snapshot', description: '从链上池子读取指定区块的价格快照。', price: '0.020 USDC', proof: 'Mock only' }
];

let services = [];
let health = null;
let currentQuote = null;
let currentPayload = null;
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setModes(dataText, paymentText, type = '') {
  const data = $('#data-mode-status');
  const payment = $('#payment-mode-status');
  const pill = $('#mode-pill');
  if (data) { data.textContent = dataText; data.className = type; }
  if (payment) { payment.textContent = paymentText; payment.className = type; }
  if (pill) { pill.textContent = `${dataText} · ${paymentText}`; pill.className = `pill ${type}`; }
}

function renderServices(items) {
  services = Array.isArray(items) && items.length ? items : fallbackServices;
  $('#catalog-count').textContent = `${services.length} 个可调用服务`;
  $('#service-grid').innerHTML = services.map((service, index) => `
    <article class="service-card">
      <div class="service-index">0${index + 1} / SERVICE</div>
      <h3>${escapeHtml(service.name || service.id)}</h3>
      <p>${escapeHtml(service.description || '可复核的链上数据服务。')}</p>
      <div class="service-bottom"><span class="service-price">${escapeHtml(service.price || (service.priceUsdc != null ? `${service.priceUsdc} USDC` : '按次'))}</span><span class="service-proof">${escapeHtml(service.proof || 'Prototype')} ↗</span></div>
    </article>`).join('');
  $('#service-select').innerHTML = services.map((service) => `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name || service.id)}</option>`).join('');
  updateInputFields();
}

function updateInputFields() {
  const id = $('#service-select').value;
  const wallet = id === 'wallet_snapshot';
  const events = id === 'contract_events';
  const price = id === 'token_price_snapshot';
  $('#address-field').hidden = !(wallet || events);
  $('#address-input').required = wallet || events;
  $('#pair-field').hidden = !price;
  $('#pair-input').required = price;
  $('#from-field').hidden = !events;
  $('#to-field').hidden = !events;
  $('#block-field').hidden = events;
  $('#block-input').required = !events;
}

function canSimulate() { return Boolean(health && health.autoSettle !== false && health.paymentMode === 'mock'); }

function buildInput(serviceId) {
  if (serviceId === 'wallet_snapshot') return { address: $('#address-input').value.trim(), block: $('#block-input').value.trim() || 'latest' };
  if (serviceId === 'contract_events') return { address: $('#address-input').value.trim(), fromBlock: Number($('#from-input').value), toBlock: Number($('#to-input').value) };
  return { pair: $('#pair-input').value.trim(), block: $('#block-input').value.trim() || 'latest' };
}

function showPayload(payload) {
  currentPayload = payload;
  $('#receipt-output').textContent = JSON.stringify(payload, null, 2);
  const summary = $('#receipt-summary');
  if (!summary) return;
  const status = payload.status || payload.error?.code || 'response';
  const order = payload.orderId ? `订单 ${payload.orderId}` : '';
  const provider = payload.result?.provider ? `Provider ${payload.result.provider}` : '';
  summary.hidden = false;
  summary.textContent = [status, order, provider].filter(Boolean).join(' · ');
}

async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

async function loadHealth() {
  try {
    health = await readJson(await fetch(`${API_BASE}/health`));
    const dataMode = health.dataMode || 'mock';
    const paymentMode = health.paymentMode || (health.autoSettle ? 'mock' : 'disabled');
    setModes(`数据 ${dataMode}`, `付款 ${paymentMode}`, 'status-online');
    if ($('#execute-button')) $('#execute-button').disabled = !canSimulate();
    if ($('#service-status')) $('#service-status').textContent = canSimulate() ? 'API 在线，当前执行只会生成模拟收据。' : 'API 在线，但付款验证器尚未配置；可以报价，不能执行。';
  } catch (_) {
    health = null;
    setModes('数据离线', '付款不可用', 'status-demo');
    if ($('#service-status')) $('#service-status').textContent = 'API 离线：可查看界面，但不会伪造请求成功。';
  }
}

async function loadServices() {
  try {
    const data = await readJson(await fetch(`${API_BASE}/v1/services`));
    renderServices(data.services || data);
  } catch (_) {
    renderServices(fallbackServices);
    if ($('#service-status') && !health) $('#service-status').textContent = 'API 离线：当前只显示本地服务目录。';
  }
}

async function createQuote(event) {
  event.preventDefault();
  const button = $('#quote-button');
  button.disabled = true;
  button.textContent = '生成中…';
  try {
    const serviceId = $('#service-select').value;
    const body = { serviceId, input: buildInput(serviceId), maxPayment: $('#max-payment').value.trim() };
    currentQuote = await readJson(await fetch(`${API_BASE}/v1/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    showPayload(currentQuote);
    $('#execution-actions').hidden = false;
    $('#execute-button').disabled = !canSimulate();
  } catch (error) {
    currentQuote = null;
    $('#execution-actions').hidden = true;
    showPayload({ status: 'error', message: error.message, note: '报价失败，没有伪造成功收据。' });
  } finally {
    button.disabled = false;
    button.innerHTML = '生成付款报价 <span>→</span>';
  }
}

async function executeQuote() {
  if (!currentQuote) return;
  const button = $('#execute-button');
  button.disabled = true;
  button.textContent = '执行中…';
  try {
    const execution = await readJson(await fetch(`${API_BASE}/v1/orders/${encodeURIComponent(currentQuote.orderId)}/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    showPayload(execution);
  } catch (error) {
    showPayload({ status: 'error', message: error.message, note: '执行失败，没有伪造成功收据。' });
  } finally {
    button.disabled = !canSimulate();
    button.innerHTML = '模拟支付并执行（不转账） <span>→</span>';
  }
}

async function queryOrder() {
  if (!currentQuote) return showPayload({ status: 'error', message: '请先生成报价。' });
  try { showPayload(await readJson(await fetch(`${API_BASE}/v1/orders/${encodeURIComponent(currentQuote.orderId)}`))); }
  catch (error) { showPayload({ status: 'error', message: error.message }); }
}

function downloadReceipt() {
  if (!currentPayload) return showPayload({ status: 'error', message: '暂无收据可下载。' });
  const blob = new Blob([JSON.stringify(currentPayload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `outcomex-${currentPayload.orderId || 'receipt'}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

$('#service-select').addEventListener('change', updateInputFields);
$('#request-form').addEventListener('submit', createQuote);
$('#execute-button').addEventListener('click', executeQuote);
$('#query-button').addEventListener('click', queryOrder);
$('#download-button').addEventListener('click', downloadReceipt);
loadHealth();
loadServices();
